import { opendir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_SIMILAR_PATHS } from './constants';

export function resolveReadPath(filePath: string, directory: string): string {
  const expanded = filePath.startsWith('~/')
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath;

  return path.normalize(
    path.isAbsolute(expanded) ? expanded : path.resolve(directory, expanded),
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function safeRealpath(targetPath: string): Promise<string | undefined> {
  try {
    return await realpath(targetPath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return undefined;
  }
}

function canonicalMissingPath(
  targetPath: string,
  accessPath: string,
): {
  accessPath: string;
  realPath?: string;
} {
  return accessPath === targetPath
    ? { accessPath }
    : { accessPath, realPath: accessPath };
}

export async function resolveAccessPath(targetPath: string): Promise<{
  accessPath: string;
  realPath?: string;
}> {
  const realPath = await safeRealpath(targetPath);
  if (realPath) {
    return {
      accessPath: realPath,
      realPath,
    };
  }

  const suffix: string[] = [];
  let currentPath = targetPath;

  while (true) {
    try {
      await stat(currentPath);
      const currentRealPath = await safeRealpath(currentPath);
      if (currentRealPath) {
        // Preserve the unresolved suffix so file/child paths stay invalid instead
        // of collapsing to the existing file ancestor.
        return canonicalMissingPath(
          targetPath,
          path.join(currentRealPath, ...suffix),
        );
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return {
        accessPath: targetPath,
      };
    }

    suffix.unshift(path.basename(currentPath));
    currentPath = parentPath;
  }
}

const MAX_SIMILAR_PATH_SCAN_ENTRIES = 256;

export async function listSimilarPaths(
  targetPath: string,
  limit: number = MAX_SIMILAR_PATHS,
): Promise<string[]> {
  const parent = path.dirname(targetPath);
  const base = path.basename(targetPath).toLowerCase();
  const needle = base.slice(0, 3);
  const resultLimit = Math.min(
    MAX_SIMILAR_PATHS,
    Math.max(0, Math.floor(limit)),
  );

  if (resultLimit <= 0) return [];
  if (parent === targetPath || base.length === 0 || base === path.sep)
    return [];
  if (needle.length === 0) return [];

  try {
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) return [];
    const directory = await opendir(parent);

    try {
      const matches: string[] = [];
      let inspectedEntries = 0;

      while (inspectedEntries < MAX_SIMILAR_PATH_SCAN_ENTRIES) {
        const entry = await directory.read();
        if (!entry) break;

        inspectedEntries += 1;
        if (entry.name.toLowerCase().includes(needle)) {
          matches.push(path.join(parent, entry.name));
          if (matches.length >= resultLimit) break;
        }
      }

      return matches;
    } finally {
      await directory.close();
    }
  } catch {
    return [];
  }
}
