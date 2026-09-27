import path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
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
  return (
    containsPath(input.directory, input.searchPath) ||
    (isEffectiveBoundary(input.worktree) &&
      containsPath(input.worktree, input.searchPath))
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
    follow_symlinks: false,
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
    // The host overwrites `truncated`; this is the plugin's result flag.
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

type AskContext = Pick<ToolContext, 'ask'>;

function askPermission(
  ctx: AskContext,
  permission: string,
  value: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  return runOpenCodeSideEffect(
    ctx.ask({
      permission,
      patterns: [value],
      always: [value],
      metadata,
    }),
  );
}

export const permissionPath = (
  file: string,
  platform = process.platform,
): string => (platform === 'win32' ? file.replaceAll('\\', '/') : file);

export async function askExternalDirectory(
  ctx: AskContext,
  input: {
    directory: string;
    worktree: string;
    searchPath: string;
  },
): Promise<void> {
  if (isInsideAllowedBoundary(input)) return;

  const glob = `${permissionPath(input.searchPath)}/*`;
  await askPermission(ctx, 'external_directory', glob, {
    filepath: input.searchPath,
    parentDir: input.searchPath,
    follow_symlinks: false,
    may_traverse_outside_worktree: false,
  });
}

export async function askRipgrepAutoInstall(ctx: AskContext): Promise<void> {
  const dir = permissionPath(getRipgrepCacheDir());
  await askPermission(ctx, 'install_ripgrep', dir, {
    tool: GLOB_TOOL_ID,
    action: 'auto_install_ripgrep',
    cache_dir: dir,
  });
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
  ctx: Pick<ToolContext, 'metadata'>,
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
  } finally {
    clearTimeout(timer);
  }
}
