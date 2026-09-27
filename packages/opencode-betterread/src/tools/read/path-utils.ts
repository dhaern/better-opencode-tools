import { opendir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_SIMILAR_PATHS } from './constants';

const MAX_SIMILAR_PATH_SCAN_ENTRIES = 256;

export function resolveReadPath(filePath: string, directory: string): string {
  const expanded = filePath.startsWith('~/')
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath;
  return path.normalize(
    path.isAbsolute(expanded) ? expanded : path.resolve(directory, expanded),
  );
}

export function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function safeRealpath(targetPath: string): Promise<string | undefined> {
  try {
    return await realpath(targetPath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return undefined;
  }
}

// Canonical path used for every filesystem access. For a missing target the
// nearest existing ancestor is canonicalized and the unresolved suffix is
// kept, so child paths of a file stay invalid instead of collapsing onto it.
export async function resolveAccessPath(targetPath: string): Promise<{
  accessPath: string;
  realPath?: string;
}> {
  const realPath = await safeRealpath(targetPath);
  if (realPath) return { accessPath: realPath, realPath };

  const suffix: string[] = [];
  let currentPath = targetPath;
  for (;;) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return { accessPath: targetPath };
    suffix.unshift(path.basename(currentPath));
    currentPath = parentPath;
    const currentRealPath = await safeRealpath(currentPath);
    if (currentRealPath) {
      const accessPath = path.join(currentRealPath, ...suffix);
      return accessPath === targetPath
        ? { accessPath }
        : { accessPath, realPath: accessPath };
    }
  }
}

export async function listSimilarPaths(targetPath: string): Promise<string[]> {
  const parent = path.dirname(targetPath);
  const needle = path.basename(targetPath).toLowerCase().slice(0, 3);
  if (parent === targetPath || needle.length === 0 || needle === path.sep) {
    return [];
  }
  try {
    const directory = await opendir(parent);
    try {
      const matches: string[] = [];
      for (let inspected = 0; inspected < MAX_SIMILAR_PATH_SCAN_ENTRIES; ) {
        const entry = await directory.read();
        if (!entry) break;
        inspected += 1;
        if (entry.name.toLowerCase().includes(needle)) {
          matches.push(path.join(parent, entry.name));
          if (matches.length >= MAX_SIMILAR_PATHS) break;
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
