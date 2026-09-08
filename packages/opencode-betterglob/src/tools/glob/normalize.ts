import { existsSync, realpathSync, statSync } from 'node:fs';
import {
  realpath as realpathAsyncFs,
  stat as statAsyncFs,
} from 'node:fs/promises';
import path from 'node:path';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import {
  DEFAULT_GLOB_LIMIT,
  DEFAULT_GLOB_TIMEOUT_MS,
  UNSUPPORTED_FOLLOW_SYMLINKS_ERROR,
} from './constants';
import type { GlobToolInput, NormalizedGlobInput } from './types';

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().length > 0 ? value : undefined;
}

// setTimeout() overflows (and fires immediately with a RangeError-adjacent
// warning) above 2^31-1 ms; reject larger timeouts instead of clamping so
// callers get honest feedback.
export const MAX_TIMEOUT_MS = 2_147_483_647;

function integer(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value as number));
}

function timeoutMs(value: number | undefined, fallback: number): number {
  const normalized = integer(value, fallback);
  if (normalized > MAX_TIMEOUT_MS) {
    throw new Error(
      `timeout_ms must not exceed ${MAX_TIMEOUT_MS} milliseconds`,
    );
  }
  return normalized;
}

function hasMagic(value: string): boolean {
  return /[*?[{]/.test(value);
}

function normalizeRelativePattern(pattern: string): string {
  let normalized =
    process.platform === 'win32' ? pattern.replace(/\\/g, '/') : pattern;
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function splitAbsolutePattern(pattern: string): {
  base: string;
  glob: string;
} {
  const root = path.parse(pattern).root;
  const parts = pattern
    .slice(root.length)
    .split(process.platform === 'win32' ? /[\\/]+/ : /\/+/)
    .filter(Boolean);
  const index = parts.findIndex(hasMagic);

  if (index < 0) {
    return {
      base: path.dirname(pattern),
      glob: path.basename(pattern),
    };
  }

  return {
    base: index === 0 ? root : path.join(root, ...parts.slice(0, index)),
    glob: normalizeRelativePattern(parts.slice(index).join('/')),
  };
}

function realpath(file: string, requested: string): string {
  try {
    return realpathSync.native ? realpathSync.native(file) : realpathSync(file);
  } catch (error) {
    throw new Error(
      `Failed to resolve search path: ${requested} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

async function realpathAsync(file: string, requested: string): Promise<string> {
  try {
    return await realpathAsyncFs(file);
  } catch (error) {
    throw new Error(
      `Failed to resolve search path: ${requested} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export function containsPath(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

export interface ResolvedGlobScope {
  cwd: string;
  worktreeRoot: string;
  requestedPath: string;
  resolvedPath: string;
  relativePattern: string;
  anchored: boolean;
}

export function resolveGlobScope(
  args: GlobToolInput,
  context: Pick<ToolContext, 'directory' | 'worktree'>,
  pluginCtx?: Pick<PluginInput, 'directory' | 'worktree'>,
): ResolvedGlobScope {
  if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
    throw new Error('pattern must be a non-empty string');
  }

  const cwd = context.directory || pluginCtx?.directory || process.cwd();
  const worktreeRoot = path.resolve(
    context.worktree || pluginCtx?.worktree || context.directory || cwd,
  );
  const requested = clean(args.path);
  const absolute = path.isAbsolute(args.pattern);
  const split = absolute
    ? splitAbsolutePattern(args.pattern)
    : { base: requested ?? '.', glob: args.pattern };
  const requestedPath = split.base;
  const resolvedPath = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(cwd, requestedPath);

  return {
    cwd,
    worktreeRoot,
    requestedPath,
    resolvedPath,
    relativePattern: normalizeRelativePattern(split.glob),
    anchored: absolute,
  };
}

function anchorAbsoluteGlob(glob: string): string {
  // Prepend "/" to the WHOLE pattern, including a leading "!" if present:
  // "!/README.md" would negate, but "/!README.md" matches the literal file
  // named "!README.md" at the search root. The "!" was never an operator in
  // the user's absolute pattern, so anchoring must not promote it.
  return `/${normalizeRelativePattern(glob)}`;
}

export function normalizeGlobInput(
  args: GlobToolInput,
  context: Pick<ToolContext, 'directory' | 'worktree'>,
  pluginCtx?: Pick<PluginInput, 'directory' | 'worktree'>,
): NormalizedGlobInput {
  if (args.follow_symlinks === true) {
    throw new Error(UNSUPPORTED_FOLLOW_SYMLINKS_ERROR);
  }

  const scope = resolveGlobScope(args, context, pluginCtx);

  if (!existsSync(scope.resolvedPath)) {
    throw new Error(`Search path does not exist: ${scope.requestedPath}`);
  }

  const searchPath = realpath(scope.resolvedPath, scope.requestedPath);
  const stat = statSync(searchPath);
  const resolvedWorktree = scope.worktreeRoot;
  const worktree = existsSync(resolvedWorktree)
    ? realpath(resolvedWorktree, scope.worktreeRoot)
    : resolvedWorktree;

  if (!stat.isDirectory()) {
    throw new Error(`Search path must be a directory: ${scope.requestedPath}`);
  }

  const sortBy = args.sort_by ?? 'mtime';

  return {
    pattern: args.pattern,
    relativePattern: scope.anchored
      ? anchorAbsoluteGlob(scope.relativePattern)
      : scope.relativePattern,
    requestedPath: scope.requestedPath,
    resolvedPath: scope.resolvedPath,
    searchPath,
    limit: integer(args.limit, DEFAULT_GLOB_LIMIT),
    sortBy,
    sortOrder: args.sort_order ?? (sortBy === 'mtime' ? 'desc' : 'asc'),
    hidden: args.hidden !== false,
    // Retained in the normalized shape for compatibility with metadata
    // consumers; true is rejected above because traversal cannot be confined.
    followSymlinks: false,
    timeoutMs: timeoutMs(args.timeout_ms, DEFAULT_GLOB_TIMEOUT_MS),
    cwd: scope.cwd,
    worktree,
  };
}

/**
 * Async counterpart used by the tool execution path. Filesystem preparation
 * must be raceable against the execution deadline; the synchronous variant is
 * retained for compatibility with callers that already use it directly.
 */
export async function normalizeGlobInputAsync(
  args: GlobToolInput,
  context: Pick<ToolContext, 'directory' | 'worktree'>,
  pluginCtx?: Pick<PluginInput, 'directory' | 'worktree'>,
): Promise<NormalizedGlobInput> {
  if (args.follow_symlinks === true) {
    throw new Error(UNSUPPORTED_FOLLOW_SYMLINKS_ERROR);
  }

  const scope = resolveGlobScope(args, context, pluginCtx);
  let info: Awaited<ReturnType<typeof statAsyncFs>>;
  try {
    info = await statAsyncFs(scope.resolvedPath);
  } catch {
    throw new Error(`Search path does not exist: ${scope.requestedPath}`);
  }

  const searchPath = await realpathAsync(
    scope.resolvedPath,
    scope.requestedPath,
  );
  let worktree = scope.worktreeRoot;
  try {
    worktree = await realpathAsyncFs(scope.worktreeRoot);
  } catch {
    // Preserve the synchronous contract for a missing worktree root.
  }

  if (!info.isDirectory()) {
    throw new Error(`Search path must be a directory: ${scope.requestedPath}`);
  }

  const sortBy = args.sort_by ?? 'mtime';
  return {
    pattern: args.pattern,
    relativePattern: scope.anchored
      ? anchorAbsoluteGlob(scope.relativePattern)
      : scope.relativePattern,
    requestedPath: scope.requestedPath,
    resolvedPath: scope.resolvedPath,
    searchPath,
    limit: integer(args.limit, DEFAULT_GLOB_LIMIT),
    sortBy,
    sortOrder: args.sort_order ?? (sortBy === 'mtime' ? 'desc' : 'asc'),
    hidden: args.hidden !== false,
    followSymlinks: false,
    timeoutMs: timeoutMs(args.timeout_ms, DEFAULT_GLOB_TIMEOUT_MS),
    cwd: scope.cwd,
    worktree,
  };
}
