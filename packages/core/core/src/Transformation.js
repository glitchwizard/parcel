// @flow strict-local

import type {
  AST,
  DependencyOptions,
  FilePath,
  FileCreateInvalidation,
  GenerateOutput,
  Transformer,
  TransformerResult,
  PackageName,
} from '@parcel/types';
import type {WorkerApi} from '@parcel/workers';
import type {
  Asset as AssetValue,
  TransformationRequest,
  RequestInvalidation,
  Config,
  DevDepRequest,
  ParcelOptions,
  ReportFn,
  AssetGroup,
  InternalFileCreateInvalidation,
  InternalDevDepOptions,
} from './types';
import type {LoadedPlugin} from './ParcelConfig';

import path from 'path';
import nullthrows from 'nullthrows';
import crypto from 'crypto';
import v8 from 'v8';
import {md5FromOrderedObject, objectSortedEntries} from '@parcel/utils';
import logger, {PluginLogger} from '@parcel/logger';
import {init as initSourcemaps} from '@parcel/source-map';
import ThrowableDiagnostic, {
  errorToDiagnostic,
  escapeMarkdown,
  md,
} from '@parcel/diagnostic';
import {SOURCEMAP_EXTENSIONS} from '@parcel/utils';
import {createDependency} from './Dependency';
import ParcelConfig from './ParcelConfig';
// TODO: eventually call path request as sub requests
import {ResolverRunner} from './requests/PathRequest';
import {
  Asset,
  MutableAsset,
  mutableAssetToUncommittedAsset,
} from './public/Asset';
import UncommittedAsset from './UncommittedAsset';
import {
  createAsset,
  getInvalidationId,
  getInvalidationHash,
} from './assetUtils';
import summarizeRequest from './summarizeRequest';
import PluginOptions from './public/PluginOptions';
import {PARCEL_VERSION, FILE_CREATE} from './constants';
import {optionsProxy} from './utils';
import {createBuildCache} from './buildCache';
import {createConfig} from './InternalConfig';
import PublicConfig from './public/Config';
import {invalidateOnFileCreateToInternal} from './utils';
import {
  type ProjectPath,
  fromProjectPath,
  fromProjectPathRelative,
  toProjectPathUnsafe,
  toProjectPath,
} from './projectPath';

type GenerateFunc = (input: UncommittedAsset) => Promise<GenerateOutput>;

export type TransformationOpts = {|
  options: ParcelOptions,
  config: ParcelConfig,
  report: ReportFn,
  request: TransformationRequest,
  workerApi: WorkerApi,
|};

export type ConfigRequest = {|
  id: string,
  includedFiles: Set<ProjectPath>,
  invalidateOnFileCreate: Array<InternalFileCreateInvalidation>,
  shouldInvalidateOnStartup: boolean,
|};

export type TransformationResult = {|
  assets: Array<AssetValue>,
  configRequests: Array<ConfigRequest>,
  invalidations: Array<RequestInvalidation>,
  invalidateOnFileCreate: Array<InternalFileCreateInvalidation>,
  devDepRequests: Array<DevDepRequest>,
|};

// A cache of plugin dependency hashes that we've already sent to the main thread.
// Automatically cleared before each build.
const pluginCache = createBuildCache();
const invalidatedPlugins = createBuildCache();

export default class Transformation {
  request: TransformationRequest;
  configs: Map<string, Config>;
  devDepRequests: Map<string, DevDepRequest>;
  options: ParcelOptions;
  pluginOptions: PluginOptions;
  workerApi: WorkerApi;
  parcelConfig: ParcelConfig;
  report: ReportFn;
  invalidations: Map<string, RequestInvalidation>;
  invalidateOnFileCreate: Array<InternalFileCreateInvalidation>;

  constructor({
    report,
    request,
    options,
    config,
    workerApi,
  }: TransformationOpts) {
    this.configs = new Map();
    this.parcelConfig = config;
    this.options = options;
    this.report = report;
    this.request = request;
    this.workerApi = workerApi;
    this.invalidations = new Map();
    this.invalidateOnFileCreate = [];
    this.devDepRequests = new Map();

    this.pluginOptions = new PluginOptions(
      optionsProxy(this.options, option => {
        let invalidation: RequestInvalidation = {
          type: 'option',
          key: option,
        };

        this.invalidations.set(getInvalidationId(invalidation), invalidation);
      }),
    );
  }

  async run(): Promise<TransformationResult> {
    await initSourcemaps;

    this.report({
      type: 'buildProgress',
      phase: 'transforming',
      filePath: fromProjectPath(
        this.options.projectRoot,
        this.request.filePath,
      ),
    });

    let asset: UncommittedAsset = await this.loadAsset();

    // Load existing sourcemaps
    if (SOURCEMAP_EXTENSIONS.has(asset.value.type)) {
      try {
        await asset.loadExistingSourcemap();
      } catch (err) {
        let filePath = fromProjectPath(
          this.options.projectRoot,
          this.request.filePath,
        );
        logger.verbose([
          {
            origin: '@parcel/core',
            message: md`Could not load existing source map for ${fromProjectPathRelative(
              asset.value.filePath,
            )}`,
            filePath,
          },
          {
            origin: '@parcel/core',
            message: escapeMarkdown(err.message),
            filePath,
          },
        ]);
      }
    }

    for (let {moduleSpecifier, resolveFrom} of this.request.invalidDevDeps) {
      let key = `${moduleSpecifier}:${fromProjectPathRelative(resolveFrom)}`;
      if (!invalidatedPlugins.has(key)) {
        this.parcelConfig.invalidatePlugin(moduleSpecifier);
        this.options.packageManager.invalidate(
          moduleSpecifier,
          fromProjectPath(this.options.projectRoot, resolveFrom),
        );
        invalidatedPlugins.set(key, true);
      }
    }

    let pipeline = await this.loadPipeline(
      this.request.filePath,
      asset.value.isSource,
      asset.value.pipeline,
    );
    let results = await this.runPipelines(pipeline, asset);
    let assets = results.map(a => a.value);

    let configRequests = [...this.configs.values()]
      .filter(config => {
        // No need to send to the graph if there are no invalidations.
        return (
          config.includedFiles.size > 0 ||
          config.invalidateOnFileCreate.length > 0 ||
          config.shouldInvalidateOnStartup
        );
      })
      .map(config => ({
        id: config.id,
        includedFiles: config.includedFiles,
        invalidateOnFileCreate: config.invalidateOnFileCreate,
        shouldInvalidateOnStartup: config.shouldInvalidateOnStartup,
      }));

    let devDepRequests = [];
    for (let devDepRequest of this.devDepRequests.values()) {
      // If we've already sent a matching transformer + hash to the main thread during this build,
      // there's no need to repeat ourselves.
      let {moduleSpecifier, resolveFrom, hash} = devDepRequest;
      if (hash === pluginCache.get(moduleSpecifier)) {
        devDepRequests.push({moduleSpecifier, resolveFrom, hash});
      } else {
        pluginCache.set(moduleSpecifier, hash);
        devDepRequests.push(devDepRequest);
      }
    }

    return {
      assets,
      configRequests,
      invalidateOnFileCreate: this.invalidateOnFileCreate,
      invalidations: [...this.invalidations.values()],
      devDepRequests,
    };
  }

  async loadAsset(): Promise<UncommittedAsset> {
    let {
      filePath,
      env,
      code,
      pipeline,
      isSource: isSourceOverride,
      sideEffects,
      query,
    } = this.request;
    let {
      content,
      size,
      hash,
      isSource: summarizedIsSource,
    } = await summarizeRequest(this.options.inputFS, {
      filePath: fromProjectPath(this.options.projectRoot, filePath),
      code,
    });

    // Prefer `isSource` originating from the AssetRequest.
    let isSource = isSourceOverride ?? summarizedIsSource;

    // If the transformer request passed code rather than a filename,
    // use a hash as the base for the id to ensure it is unique.
    let idBase = code != null ? hash : fromProjectPathRelative(filePath);
    return new UncommittedAsset({
      idBase,
      value: createAsset({
        idBase,
        filePath,
        isSource,
        type: path.extname(fromProjectPathRelative(filePath)).slice(1),
        hash,
        pipeline,
        env,
        query,
        stats: {
          time: 0,
          size,
        },
        sideEffects,
      }),
      options: this.options,
      content,
      invalidations: this.invalidations,
      fileCreateInvalidations: this.invalidateOnFileCreate,
    });
  }

  async runPipelines(
    pipeline: Pipeline,
    initialAsset: UncommittedAsset,
  ): Promise<Array<UncommittedAsset>> {
    let initialType = initialAsset.value.type;
    let initialPipelineHash = await this.getPipelineHash(pipeline);
    let initialAssetCacheKey = this.getCacheKey(
      [initialAsset],
      await getInvalidationHash(this.request.invalidations, this.options), // TODO: should be per-pipeline
      initialPipelineHash,
    );
    let initialCacheEntry = await this.readFromCache(initialAssetCacheKey);

    let assets: Array<UncommittedAsset> =
      initialCacheEntry || (await this.runPipeline(pipeline, initialAsset));

    // Add dev dep requests for each transformer
    for (let transformer of pipeline.transformers) {
      await this.addDevDependency(
        {
          moduleSpecifier: transformer.name,
          resolveFrom: transformer.resolveFrom,
        },
        transformer,
      );
    }

    if (!initialCacheEntry) {
      let pipelineHash = await this.getPipelineHash(pipeline);
      let resultCacheKey = this.getCacheKey(
        [initialAsset],
        await getInvalidationHash(
          assets.flatMap(asset => asset.getInvalidations()),
          this.options,
        ),
        pipelineHash,
      );
      await this.writeToCache(resultCacheKey, assets, pipelineHash);
    }

    let finalAssets: Array<UncommittedAsset> = [];
    for (let asset of assets) {
      let nextPipeline;
      if (asset.value.type !== initialType) {
        nextPipeline = await this.loadNextPipeline({
          filePath: initialAsset.value.filePath,
          isSource: asset.value.isSource,
          newType: asset.value.type,
          newPipeline: asset.value.pipeline,
          currentPipeline: pipeline,
        });
      }

      if (nextPipeline) {
        let nextPipelineAssets = await this.runPipelines(nextPipeline, asset);
        finalAssets = finalAssets.concat(nextPipelineAssets);
      } else {
        finalAssets.push(asset);
      }
    }

    return finalAssets;
  }

  async getPipelineHash(pipeline: Pipeline): Promise<string> {
    let hash = crypto.createHash('md5');
    for (let transformer of pipeline.transformers) {
      let key = `${transformer.name}:${fromProjectPathRelative(
        transformer.resolveFrom,
      )}`;
      hash.update(
        this.request.devDeps.get(key) ??
          this.devDepRequests.get(key)?.hash ??
          '',
      );

      let config = this.configs.get(transformer.name);
      if (config) {
        hash.update(config.id);

        // If there is no result hash set by the transformer, default to hashing the included
        // files if any, otherwise try to hash the config result itself.
        if (config.resultHash == null) {
          if (config.includedFiles.size > 0) {
            hash.update(
              await getInvalidationHash(
                [...config.includedFiles].map(filePath => ({
                  type: 'file',
                  filePath,
                })),
                this.options,
              ),
            );
          } else if (config.result != null) {
            try {
              // $FlowFixMe
              hash.update(v8.serialize(config.result));
            } catch (err) {
              throw new ThrowableDiagnostic({
                diagnostic: {
                  message:
                    'Config result is not hashable because it contains non-serializable objects. Please use config.setResultHash to set the hash manually.',
                  origin: transformer.name,
                },
              });
            }
          }
        } else {
          hash.update(config.resultHash ?? '');
        }

        for (let devDep of config.devDeps) {
          let key = `${devDep.moduleSpecifier}:${fromProjectPathRelative(
            devDep.resolveFrom,
          )}`;
          hash.update(nullthrows(this.devDepRequests.get(key)).hash);
        }
      }
    }

    return hash.digest('hex');
  }

  async addDevDependency(
    opts: InternalDevDepOptions,
    transformer: LoadedPlugin<Transformer> | TransformerWithNameAndConfig,
  ): Promise<void> {
    let {moduleSpecifier, resolveFrom, invalidateParcelPlugin} = opts;
    let key = `${moduleSpecifier}:${fromProjectPathRelative(resolveFrom)}`;
    if (this.devDepRequests.has(key)) {
      return;
    }

    // If the request sent us a hash, we know the dev dep and all of its dependencies didn't change.
    // Reuse the same hash in the response. No need to send back invalidations as the request won't
    // be re-run anyway.
    let hash = this.request.devDeps.get(key);
    if (hash != null) {
      this.devDepRequests.set(key, {
        moduleSpecifier,
        resolveFrom,
        hash,
      });
      return;
    }

    // Ensure that the package manager has an entry for this resolution.
    await this.options.packageManager.resolve(
      moduleSpecifier,
      fromProjectPath(this.options.projectRoot, opts.resolveFrom),
    );
    let invalidations = this.options.packageManager.getInvalidations(
      moduleSpecifier,
      fromProjectPath(this.options.projectRoot, opts.resolveFrom),
    );

    // It is possible for a transformer to have multiple different hashes due to
    // different dependencies (e.g. conditional requires) so we must always
    // recompute the hash and compare rather than only sending a transformer
    // dev dependency once.
    hash = await getInvalidationHash(
      [...invalidations.invalidateOnFileChange].map(f => ({
        type: 'file',
        filePath: toProjectPath(this.options.projectRoot, f),
      })),
      this.options,
    );

    let devDepRequest: DevDepRequest = {
      moduleSpecifier,
      resolveFrom,
      hash,
      invalidateOnFileCreate: invalidations.invalidateOnFileCreate.map(i =>
        invalidateOnFileCreateToInternal(this.options.projectRoot, i),
      ),
      invalidateOnFileChange: new Set(
        [...invalidations.invalidateOnFileChange].map(f =>
          toProjectPath(this.options.projectRoot, f),
        ),
      ),
    };

    // Optionally also invalidate the parcel plugin that is loading the config
    // when this dev dep changes (e.g. to invalidate local caches).
    if (invalidateParcelPlugin) {
      devDepRequest.additionalInvalidations = [
        {
          moduleSpecifier: transformer.name,
          resolveFrom: transformer.resolveFrom,
        },
      ];
    }

    this.devDepRequests.set(key, devDepRequest);
  }

  async runPipeline(
    pipeline: Pipeline,
    initialAsset: UncommittedAsset,
  ): Promise<Array<UncommittedAsset>> {
    if (pipeline.transformers.length === 0) {
      return [initialAsset];
    }

    let initialType = initialAsset.value.type;
    let inputAssets = [initialAsset];
    let resultingAssets = [];
    let finalAssets = [];
    for (let transformer of pipeline.transformers) {
      resultingAssets = [];
      for (let asset of inputAssets) {
        if (
          asset.value.type !== initialType &&
          (await this.loadNextPipeline({
            filePath: initialAsset.value.filePath,
            isSource: asset.value.isSource,
            newType: asset.value.type,
            newPipeline: asset.value.pipeline,
            currentPipeline: pipeline,
          }))
        ) {
          finalAssets.push(asset);
          continue;
        }

        try {
          let transformerResults = await this.runTransformer(
            pipeline,
            asset,
            transformer.plugin,
            transformer.name,
            transformer.config,
          );

          for (let result of transformerResults) {
            resultingAssets.push(
              asset.createChildAsset(
                result,
                transformer.name,
                this.parcelConfig.filePath,
                transformer.configKeyPath,
              ),
            );
          }
        } catch (e) {
          throw new ThrowableDiagnostic({
            diagnostic: errorToDiagnostic(e, {
              origin: transformer.name,
              filePath: fromProjectPath(
                this.options.projectRoot,
                asset.value.filePath,
              ),
            }),
          });
        }
      }
      inputAssets = resultingAssets;
    }

    // Make assets with ASTs generate unless they are js assets and target uses
    // scope hoisting or we do CSS modules tree shaking. This parallelizes generation
    // and distributes work more evenly across workers than if one worker needed to
    // generate all assets in a large bundle during packaging.
    let generate = pipeline.generate;
    if (generate != null) {
      await Promise.all(
        resultingAssets
          .filter(
            asset =>
              asset.ast != null &&
              !(
                (asset.value.env.shouldScopeHoist &&
                  asset.value.type === 'js') ||
                (this.options.mode === 'production' &&
                  asset.value.type === 'css' &&
                  asset.value.symbols)
              ),
          )
          .map(async asset => {
            if (asset.isASTDirty) {
              let output = await generate(asset);
              asset.content = output.content;
              asset.mapBuffer = output.map?.toBuffer();
            }

            asset.clearAST();
          }),
      );
    }

    return finalAssets.concat(resultingAssets);
  }

  async readFromCache(cacheKey: string): Promise<?Array<UncommittedAsset>> {
    if (
      this.options.shouldDisableCache ||
      this.request.code != null ||
      this.request.invalidateReason & FILE_CREATE
    ) {
      return null;
    }

    let cachedAssets = await this.options.cache.get<Array<AssetValue>>(
      cacheKey,
    );
    if (!cachedAssets) {
      return null;
    }

    return Promise.all(
      cachedAssets.map(async (value: AssetValue) => {
        let content =
          value.contentKey != null
            ? this.options.cache.getStream(value.contentKey)
            : null;
        let mapBuffer =
          value.astKey != null
            ? await this.options.cache.getBlob<Buffer>(value.astKey)
            : null;
        let ast =
          value.astKey != null
            ? await this.options.cache.getBlob<AST>(value.astKey)
            : null;
        return new UncommittedAsset({
          value,
          options: this.options,
          content,
          mapBuffer,
          ast,
        });
      }),
    );
  }

  async writeToCache(
    cacheKey: string,
    assets: Array<UncommittedAsset>,
    pipelineHash: string,
  ): Promise<void> {
    await Promise.all(assets.map(asset => asset.commit(pipelineHash)));

    this.options.cache.set(
      cacheKey,
      assets.map(a => a.value),
    );
  }

  getCacheKey(
    assets: Array<UncommittedAsset>,
    invalidationHash: string,
    pipelineHash: string,
  ): string {
    let assetsKeyInfo = assets.map(a => ({
      filePath: a.value.filePath,
      pipeline: a.value.pipeline,
      hash: a.value.hash,
      uniqueKey: a.value.uniqueKey,
      query: a.value.query ? objectSortedEntries(a.value.query) : '',
    }));

    return md5FromOrderedObject({
      parcelVersion: PARCEL_VERSION,
      assets: assetsKeyInfo,
      env: this.request.env,
      invalidationHash,
      pipelineHash,
    });
  }

  async loadPipeline(
    filePath: ProjectPath,
    isSource: boolean,
    pipeline: ?string,
  ): Promise<Pipeline> {
    let transformers = await this.parcelConfig.getTransformers(
      filePath,
      pipeline,
      this.request.isURL,
    );

    for (let transformer of transformers) {
      let config = await this.loadTransformerConfig(
        filePath,
        transformer,
        isSource,
      );
      if (config) {
        this.configs.set(transformer.name, config);
      }
    }

    return {
      id: transformers.map(t => t.name).join(':'),
      transformers: transformers.map(transformer => ({
        name: transformer.name,
        resolveFrom: transformer.resolveFrom,
        config: this.configs.get(transformer.name)?.result,
        configKeyPath: transformer.keyPath,
        plugin: transformer.plugin,
      })),
      options: this.options,
      resolverRunner: new ResolverRunner({
        config: this.parcelConfig,
        options: this.options,
      }),

      pluginOptions: this.pluginOptions,
      workerApi: this.workerApi,
    };
  }

  async loadNextPipeline({
    filePath,
    isSource,
    newType,
    newPipeline,
    currentPipeline,
  }: {|
    filePath: ProjectPath,
    isSource: boolean,
    newType: string,
    newPipeline: ?string,
    currentPipeline: Pipeline,
  |}): Promise<?Pipeline> {
    let filePathRelative = fromProjectPathRelative(filePath);
    let nextFilePath = toProjectPathUnsafe(
      filePathRelative.slice(0, -path.extname(filePathRelative).length) +
        '.' +
        newType,
    );
    let nextPipeline = await this.loadPipeline(
      nextFilePath,
      isSource,
      newPipeline,
    );

    if (nextPipeline.id === currentPipeline.id) {
      return null;
    }

    return nextPipeline;
  }

  async loadTransformerConfig(
    filePath: ProjectPath,
    transformer: LoadedPlugin<Transformer>,
    isSource: boolean,
  ): Promise<?Config> {
    let loadConfig = transformer.plugin.loadConfig;
    if (!loadConfig) {
      return;
    }

    let config = createConfig({
      plugin: transformer.name,
      isSource,
      searchPath: filePath,
      env: this.request.env,
    });

    try {
      await loadConfig({
        config: new PublicConfig(config, this.options),
        options: new PluginOptions(this.options),
        logger: new PluginLogger({origin: transformer.name}),
      });
    } catch (e) {
      throw new ThrowableDiagnostic({
        diagnostic: errorToDiagnostic(e, {
          origin: transformer.name,
        }),
      });
    }

    for (let devDep of config.devDeps) {
      await this.addDevDependency(devDep, transformer);
    }

    return config;
  }

  async runTransformer(
    pipeline: Pipeline,
    asset: UncommittedAsset,
    transformer: Transformer,
    transformerName: string,
    preloadedConfig: ?Config,
  ): Promise<Array<TransformerResult>> {
    const logger = new PluginLogger({origin: transformerName});

    const resolve = async (from: FilePath, to: string): Promise<FilePath> => {
      let result: {|
        assetGroup: AssetGroup,
        invalidateOnFileCreate?: Array<FileCreateInvalidation>,
        invalidateOnFileChange?: Array<FilePath>,
      |} = nullthrows(
        await pipeline.resolverRunner.resolve(
          createDependency({
            env: asset.value.env,
            moduleSpecifier: to,
            sourcePath: toProjectPath(this.options.projectRoot, from),
          }),
        ),
      );

      if (result.invalidateOnFileCreate) {
        this.invalidateOnFileCreate.push(
          ...result.invalidateOnFileCreate.map(i =>
            invalidateOnFileCreateToInternal(this.options.projectRoot, i),
          ),
        );
      }

      if (result.invalidateOnFileChange) {
        for (let filePath of result.invalidateOnFileChange) {
          let invalidation = {
            type: 'file',
            filePath: toProjectPath(this.options.projectRoot, filePath),
          };

          this.invalidations.set(getInvalidationId(invalidation), invalidation);
        }
      }

      return fromProjectPath(
        this.options.projectRoot,
        result.assetGroup.filePath,
      );
    };

    // If an ast exists on the asset, but we cannot reuse it,
    // use the previous transform to generate code that we can re-parse.
    if (
      asset.ast &&
      asset.isASTDirty &&
      (!transformer.canReuseAST ||
        !transformer.canReuseAST({
          ast: asset.ast,
          options: pipeline.pluginOptions,
          logger,
        })) &&
      pipeline.generate
    ) {
      let output = await pipeline.generate(asset);
      asset.content = output.content;
      asset.mapBuffer = output.map?.toBuffer();
    }

    // Load config for the transformer.
    let config = preloadedConfig;

    // Parse if there is no AST available from a previous transform.
    if (!asset.ast && transformer.parse) {
      let ast = await transformer.parse({
        asset: new MutableAsset(asset),
        config,
        options: pipeline.pluginOptions,
        resolve,
        logger,
      });
      if (ast) {
        asset.setAST(ast);
        asset.isASTDirty = false;
      }
    }

    // Transform.
    let results = await normalizeAssets(
      this.options,
      // $FlowFixMe
      await transformer.transform({
        asset: new MutableAsset(asset),
        ast: asset.ast,
        config,
        options: pipeline.pluginOptions,
        resolve,
        logger,
      }),
    );

    // Create generate function that can be called later
    pipeline.generate = (input: UncommittedAsset): Promise<GenerateOutput> => {
      if (transformer.generate && input.ast) {
        let generated = transformer.generate({
          asset: new Asset(input),
          ast: input.ast,
          options: pipeline.pluginOptions,
          logger,
        });
        input.clearAST();
        return Promise.resolve(generated);
      }

      throw new Error(
        'Asset has an AST but no generate method is available on the transform',
      );
    };

    return results;
  }
}

type Pipeline = {|
  id: string,
  transformers: Array<TransformerWithNameAndConfig>,
  options: ParcelOptions,
  pluginOptions: PluginOptions,
  resolverRunner: ResolverRunner,
  workerApi: WorkerApi,
  generate?: GenerateFunc,
|};

type TransformerWithNameAndConfig = {|
  name: PackageName,
  plugin: Transformer,
  config: ?Config,
  configKeyPath?: string,
  resolveFrom: ProjectPath,
|};

function normalizeAssets(
  options,
  results: Array<TransformerResult | MutableAsset>,
): Promise<Array<TransformerResult>> {
  return Promise.all(
    results.map<Promise<TransformerResult>>(async result => {
      if (!(result instanceof MutableAsset)) {
        return result;
      }

      let internalAsset = mutableAssetToUncommittedAsset(result);
      // $FlowFixMe - ignore id already on env
      return {
        ast: internalAsset.ast,
        content: await internalAsset.content,
        query: internalAsset.value.query,
        dependencies: ([...internalAsset.value.dependencies.values()].map(
          dep => {
            // eslint-disable-next-line no-unused-vars
            let {id, sourceAssetId, sourcePath, resolveFrom, ...rest} = dep;
            // $FlowFixMe this isn't really compatible with DependencyOptions
            return {
              ...rest,
              ...(resolveFrom != null
                ? {
                    resolveFrom: fromProjectPath(
                      options.projectRoot,
                      resolveFrom,
                    ),
                  }
                : null),
            };
          },
        ): Array<DependencyOptions>),
        env: internalAsset.value.env,
        filePath: result.filePath,
        isInline: result.isInline,
        isIsolated: result.isIsolated,
        map: await internalAsset.getMap(),
        meta: result.meta,
        pipeline: internalAsset.value.pipeline,
        // $FlowFixMe
        symbols: internalAsset.value.symbols,
        type: result.type,
        uniqueKey: internalAsset.value.uniqueKey,
      };
    }),
  );
}
