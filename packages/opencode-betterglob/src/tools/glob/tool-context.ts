import path from 'node:path';
import {
  runBestEffortOpenCodeSideEffect,
  runOpenCodeSideEffect,
} from '../../utils/opencode-effects';
import {
  DEFAULT_GLOB_LIMIT,
  DEFAULT_GLOB_TIMEOUT_MS,
  GLOB_TOOL_ID,
} from './constants';
import { containsPath } from './normalize';
import { getRipgrepCacheDir } from './rg-cache';
import type {
  GlobSearchResult,
  GlobToolInput,
  NormalizedGlobInput,
} from './types';

function isEffectiveBoundary(root: string): boolean {
  const resolved = path.resolve(root);
  return resolved !== path.parse(resolved).root;
}

function isInsideAllowedBoundary(input: {
  directory: string;
  worktree: string;
  searchPath: string;
}): boolean {
  if (containsPath(input.directory, input.searchPath)) return true;
  return (
    isEffectiveBoundary(input.worktree) &&
    containsPath(input.worktree, input.searchPath)
  );
}

export function title(
  args: GlobToolInput,
  input?: NormalizedGlobInput,
): string {
  const pattern = input?.pattern ?? args.pattern;
  return typeof pattern === 'string' && pattern.length > 0 ? pattern : 'glob';
}

export function baseMetadata(
  args: GlobToolInput,
  input?: NormalizedGlobInput,
): Record<string, unknown> {
  const sortBy = input?.sortBy ?? args.sort_by ?? 'mtime';

  return {
    backend: 'rg',
    pattern: input?.pattern ?? args.pattern,
    path: input?.requestedPath ?? args.path,
    resolved_path: input?.resolvedPath,
    real_path: input?.searchPath,
    relative_pattern: input?.relativePattern,
    limit: input?.limit ?? args.limit ?? DEFAULT_GLOB_LIMIT,
    sort_by: sortBy,
    sort_order:
      input?.sortOrder ??
      args.sort_order ??
      (sortBy === 'mtime' ? 'desc' : 'asc'),
    hidden: input?.hidden ?? args.hidden !== false,
    follow_symlinks: input?.followSymlinks ?? args.follow_symlinks === true,
    timeout_ms: input?.timeoutMs ?? args.timeout_ms ?? DEFAULT_GLOB_TIMEOUT_MS,
  };
}

export function resultMetadata(
  args: GlobToolInput,
  input: NormalizedGlobInput,
  result: GlobSearchResult,
): Record<string, unknown> {
  return {
    ...baseMetadata(args, input),
    count: result.count,
    truncated: result.truncated,
    // Plugin-authoritative truncation flag: the host overwrites
    // `truncated` with its own text-level truncation after execution.
    search_truncated: result.truncated,
    incomplete: result.incomplete,
    timed_out: result.timedOut,
    cancelled: result.cancelled,
    exit_code: result.exitCode,
    error: result.error,
    cwd: result.cwd,
    command: result.command,
  };
}

export async function askExternalDirectory(
  ctx: {
    ask: (payload: {
      permission: string;
      patterns: string[];
      always: string[];
      metadata: Record<string, unknown>;
    }) => Promise<unknown> | unknown;
  },
  input: {
    directory: string;
    worktree: string;
    searchPath: string;
    followSymlinks: boolean;
  },
): Promise<void> {
  if (!input.followSymlinks && isInsideAllowedBoundary(input)) {
    return;
  }

  const normalizedPath =
    process.platform === 'win32'
      ? input.searchPath.replaceAll('\\', '/')
      : input.searchPath;
  const glob = `${normalizedPath}/*`;
  await runOpenCodeSideEffect(
    ctx.ask({
      permission: 'external_directory',
      patterns: [glob],
      always: [glob],
      metadata: {
        filepath: input.searchPath,
        parentDir: input.searchPath,
        follow_symlinks: input.followSymlinks,
        may_traverse_outside_worktree: input.followSymlinks,
      },
    }),
  );
}

export async function askRipgrepAutoInstall(ctx: {
  ask: (payload: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }) => Promise<unknown> | unknown;
}): Promise<void> {
  const cacheDir = getRipgrepCacheDir();
  const dir =
    process.platform === 'win32' ? cacheDir.replaceAll('\\', '/') : cacheDir;
  await runOpenCodeSideEffect(
    ctx.ask({
      permission: 'install_ripgrep',
      patterns: [dir],
      always: [dir],
      metadata: {
        tool: GLOB_TOOL_ID,
        action: 'auto_install_ripgrep',
        cache_dir: dir,
      },
    }),
  );
}

export function failureMetadata(
  args: GlobToolInput,
  stage: 'normalize' | 'permission' | 'execution',
  error: unknown,
  input?: NormalizedGlobInput,
): Record<string, unknown> {
  return {
    ...baseMetadata(args, input),
    count: 0,
    truncated: false,
    error: error instanceof Error ? error.message : String(error),
    error_stage: stage,
  };
}

export async function emit(
  ctx: {
    metadata: (payload: {
      title?: string;
      metadata?: Record<string, unknown>;
    }) => Promise<unknown> | unknown;
  },
  name: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const pending = Promise.resolve()
    .then(() =>
      runBestEffortOpenCodeSideEffect(ctx.metadata({ title: name, metadata })),
    )
    .catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Metadata is best-effort.
  } finally {
    clearTimeout(timer);
  }
}
