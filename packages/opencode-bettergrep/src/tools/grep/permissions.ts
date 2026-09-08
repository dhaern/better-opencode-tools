import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { runOpenCodeSideEffect } from '../../utils/opencode-effects';
import { AbortWaitError } from './runtime';
import type { NormalizedGrepInput } from './types';

function contains(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function isEffectiveBoundary(root: string): boolean {
  const resolved = path.resolve(root);
  return resolved !== path.parse(resolved).root;
}

function isWithinProjectBoundary(
  directory: string,
  worktree: string,
  target: string,
): boolean {
  return (
    (isEffectiveBoundary(directory) && contains(directory, target)) ||
    (isEffectiveBoundary(worktree) && contains(worktree, target))
  );
}

const SYMLINK_WALK_ENTRY_LIMIT = 10_000;

export class SymlinkWalkLimitError extends Error {
  constructor() {
    super(
      'follow_symlinks search scope is too large to authorize external symlink destinations; restrict the search path or disable follow_symlinks.',
    );
    this.name = 'SymlinkWalkLimitError';
  }
}

export class SymlinkWalkUnsafeNameError extends Error {
  constructor(entryName: string) {
    super(
      `follow_symlinks cannot authorize a directory containing the non-UTF-8 name "${entryName}"; the backend could follow symlinks this walk cannot resolve. Restrict the search path or disable follow_symlinks.`,
    );
    this.name = 'SymlinkWalkUnsafeNameError';
  }
}

function assertSafeResolvedPath(resolvedPath: string): void {
  // fs.realpath() decodes raw directory entries as UTF-8 with replacement.
  // Never authorize or stat that lossy spelling: the backend may resolve the
  // original bytes to a different destination.
  if (resolvedPath.includes('\uFFFD')) {
    throw new SymlinkWalkUnsafeNameError(resolvedPath);
  }
}

interface ExternalSymlinkDestination {
  target: string;
  kind: 'directory' | 'file';
}

export async function collectExternalSymlinkDestinations(
  roots: string[],
  directory: string,
  worktree: string,
  signal: AbortSignal | undefined,
): Promise<ExternalSymlinkDestination[]> {
  const externals = new Map<string, 'file' | 'directory'>();
  const visitedDirs = new Set<string>();
  let budget = SYMLINK_WALK_ENTRY_LIMIT;

  const walk = async (dirPath: string): Promise<void> => {
    if (signal?.aborted) {
      throw new AbortWaitError(
        'Search was cancelled before execution started.',
      );
    }

    let realDir: string;
    try {
      realDir = await realpath(dirPath);
    } catch {
      return;
    }
    assertSafeResolvedPath(realDir);
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      budget -= 1;
      if (budget < 0) {
        throw new SymlinkWalkLimitError();
      }

      // readdir decodes names as UTF-8 strings: a non-UTF-8 filename becomes
      // replacement characters, so realpath would resolve a DIFFERENT name
      // than the backend (which matches by raw bytes). Fail closed instead
      // of authorizing an incomplete destination set.
      if (entry.name.includes('\uFFFD')) {
        throw new SymlinkWalkUnsafeNameError(entry.name);
      }

      const entryPath = path.join(dirPath, entry.name);

      if (entry.isSymbolicLink()) {
        let dest: string;
        try {
          dest = await realpath(entryPath);
        } catch {
          continue;
        }
        assertSafeResolvedPath(dest);

        if (
          !isWithinProjectBoundary(directory, worktree, dest) &&
          !visitedDirs.has(dest)
        ) {
          externals.set(dest, 'file');
        }

        let destStat: import('node:fs').Stats;
        try {
          destStat = await stat(dest);
        } catch {
          continue;
        }
        if (destStat.isDirectory()) {
          // Keep the destination authorized as a directory (the walk below
          // discovers further symlink targets, not authorization for this
          // one).
          externals.set(dest, 'directory');
          await walk(entryPath);
        }
        continue;
      }

      if (entry.isDirectory()) {
        await walk(entryPath);
      }
    }
  };

  for (const root of roots) {
    let rootStat: import('node:fs').Stats;
    try {
      rootStat = await stat(root);
    } catch {
      continue;
    }
    if (rootStat.isDirectory()) {
      await walk(root);
    }
  }

  return [...externals].map(([target, kind]) => ({ target, kind }));
}

function toExternalGlob(target: string, kind: 'directory' | 'file'): string {
  const parentDir = kind === 'directory' ? target : path.dirname(target);
  const normalizedParent = parentDir.replaceAll('\\', '/');
  return normalizedParent.endsWith('/')
    ? `${normalizedParent}*`
    : `${normalizedParent}/*`;
}

export async function askExternalDirectoryPermissions(
  ctx: Pick<ToolContext, 'ask'>,
  normalized: NormalizedGrepInput,
  directory: string,
  worktree: string,
  extraExternals: Array<{ target: string; kind: 'directory' | 'file' }> = [],
): Promise<void> {
  const seen = new Set<string>();

  const askFor = async (
    target: string,
    kind: 'directory' | 'file',
  ): Promise<void> => {
    if (
      isWithinProjectBoundary(directory, worktree, target) ||
      seen.has(target)
    ) {
      return;
    }

    seen.add(target);
    const glob = toExternalGlob(target, kind);
    await runOpenCodeSideEffect(
      ctx.ask({
        permission: 'external_directory',
        patterns: [glob],
        always: [glob],
        metadata: {
          filepath: target,
          parentDir: kind === 'directory' ? target : path.dirname(target),
          kind,
        },
      }),
    );
  };

  const targets = normalized.searchTargets ?? [normalized.searchPath];
  for (const [index, target] of targets.entries()) {
    const kind = normalized.searchTargetKinds[index] ?? 'directory';
    await askFor(target, kind);
  }

  for (const external of extraExternals) {
    await askFor(external.target, external.kind);
  }
}
