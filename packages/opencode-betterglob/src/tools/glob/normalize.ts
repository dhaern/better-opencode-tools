import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { DEFAULT_GLOB_LIMIT, DEFAULT_GLOB_TIMEOUT_MS } from './constants';
import type { GlobToolInput, NormalizedGlobInput } from './types';

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().length > 0 ? value : undefined;
}

function integer(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value as number));
}

function hasMagic(value: string): boolean {
  return /[*?[{]/.test(value);
}

function splitAbsolutePattern(pattern: string): {
  base: string;
  glob: string;
} {
  const root = path.parse(pattern).root;
  const parts = pattern
    .slice(root.length)
    .split(/[\\/]+/)
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
    glob: parts.slice(index).join('/'),
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

function contains(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface ResolvedGlobScope {
  cwd: string;
  worktreeRoot: string;
  requestedPath: string;
  resolvedPath: string;
  relativePattern: string;
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
    relativePattern: split.glob,
  };
}

function getIgnoreFiles(searchPath: string, worktree: string): string[] {
  if (!contains(worktree, searchPath)) return [];
  if (existsSync(path.join(worktree, '.git'))) return [];

  const files: string[] = [];
  const root = path.join(worktree, '.gitignore');
  if (existsSync(root)) files.push(root);

  const local = path.join(searchPath, '.gitignore');
  if (local !== root && existsSync(local)) files.push(local);

  return files;
}

export function normalizeGlobInput(
  args: GlobToolInput,
  context: Pick<ToolContext, 'directory' | 'worktree'>,
  pluginCtx?: Pick<PluginInput, 'directory' | 'worktree'>,
): NormalizedGlobInput {
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
    relativePattern: scope.relativePattern,
    requestedPath: scope.requestedPath,
    resolvedPath: scope.resolvedPath,
    searchPath,
    ignoreFiles: getIgnoreFiles(searchPath, worktree),
    limit: integer(args.limit, DEFAULT_GLOB_LIMIT),
    sortBy,
    sortOrder: args.sort_order ?? (sortBy === 'mtime' ? 'desc' : 'asc'),
    hidden: args.hidden !== false,
    followSymlinks: args.follow_symlinks === true,
    timeoutMs: integer(args.timeout_ms, DEFAULT_GLOB_TIMEOUT_MS),
    cwd: scope.cwd,
    worktree,
  };
}
