// @flow strict-local

import type {PackageName, ConfigResult} from '@parcel/types';
import {md5FromString} from '@parcel/utils';
import type {
  Config,
  Environment,
  InternalFileCreateInvalidation,
  InternalDevDepOptions,
} from './types';
import {type ProjectPath, fromProjectPathRelative} from './projectPath';

type ConfigOpts = {|
  plugin: PackageName,
  isSource: boolean,
  searchPath: ProjectPath,
  env: Environment,
  result?: ConfigResult,
  includedFiles?: Set<ProjectPath>,
  invalidateOnFileCreate?: Array<InternalFileCreateInvalidation>,
  devDeps?: Array<InternalDevDepOptions>,
  shouldInvalidateOnStartup?: boolean,
|};

export function createConfig({
  plugin,
  isSource,
  searchPath,
  env,
  result,
  includedFiles,
  invalidateOnFileCreate,
  devDeps,
  shouldInvalidateOnStartup,
}: ConfigOpts): Config {
  return {
    id: md5FromString(
      plugin + fromProjectPathRelative(searchPath) + env.id + String(isSource),
    ),
    isSource,
    searchPath,
    env,
    result: result ?? null,
    resultHash: null,
    includedFiles: includedFiles ?? new Set(),
    invalidateOnFileCreate: invalidateOnFileCreate ?? [],
    devDeps: devDeps ?? [],
    shouldInvalidateOnStartup: shouldInvalidateOnStartup ?? false,
  };
}
