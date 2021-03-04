// @flow strict-local
import type {FilePath} from '@parcel/types';
import path from 'path';
import {relativePath} from '@parcel/utils';

export opaque type ProjectPath = string;

export function toProjectPath_(
  projectRoot: FilePath,
  p: FilePath,
): ProjectPath {
  // TODO we could save the `./` at the start of every path
  // return p != null ? relativePath(projectRoot, p, false) : p;
  return p != null ? relativePath(projectRoot, p) : p;
}

export const toProjectPath: ((
  projectRoot: FilePath,
  p: FilePath,
) => ProjectPath) &
  ((projectRoot: FilePath, p: FilePath | void) => ProjectPath | void) &
  // $FlowFixMe Not sure how to type properly
  ((projectRoot: FilePath, p: ?FilePath) => ?ProjectPath) = toProjectPath_;

export function fromProjectPath_(
  projectRoot: FilePath,
  p: ?ProjectPath,
): ?FilePath {
  return p != null ? path.join(projectRoot, p) : p;
}

export const fromProjectPath: ((
  projectRoot: FilePath,
  p: ProjectPath,
) => FilePath) &
  // $FlowFixMe Not sure how to type properly
  ((projectRoot: FilePath, p: ?ProjectPath) => ?FilePath) = fromProjectPath_;

export function fromProjectPathRelative(p: ProjectPath): FilePath {
  return p;
}

export function toProjectPathUnsafe(p: FilePath): ProjectPath {
  return p;
}

export function joinProjectPath(
  a: ProjectPath,
  ...b: Array<FilePath>
): ProjectPath {
  return path.join(a, ...b);
}
