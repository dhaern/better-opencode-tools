import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import {
  DEFAULT_GREP_CONTEXT,
  DEFAULT_GREP_LIMIT,
  DEFAULT_GREP_TIMEOUT_MS,
  MAX_GREP_CONTEXT,
  MAX_GREP_LIMIT,
  MAX_GREP_TIMEOUT_MS,
} from './constants';
import type { GrepToolInput, NormalizedGrepInput } from './types';

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value as number);
  return Math.min(Math.max(normalized, min), max);
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.trim().length > 0 ? value : undefined;
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => cleanOptionalString(item))
    .filter((item): item is string => Boolean(item));
}

function uniqueStrings(values: Iterable<string | undefined>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function normalizeSearchTarget(
  target: string,
  base: string,
): {
  requestedPath: string;
  resolvedPath: string;
  searchPath: string;
} {
  const resolvedPath = path.isAbsolute(target)
    ? target
    : path.resolve(base, target);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Search path does not exist: ${target}`);
  }

  let searchPath: string;
  try {
    searchPath = realpathSync.native
      ? realpathSync.native(resolvedPath)
      : realpathSync(resolvedPath);
  } catch (error) {
    throw new Error(
      `Failed to resolve search path: ${target} (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const searchStat = statSync(searchPath);
  if (!searchStat.isFile() && !searchStat.isDirectory()) {
    throw new Error(`Search path must be a file or directory: ${target}`);
  }

  return {
    requestedPath: target,
    resolvedPath,
    searchPath,
  };
}

function cleanOptionalPositiveInteger(
  value: number | undefined,
): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value as number);
  return normalized > 0 ? normalized : undefined;
}

export function normalizeGrepInput(
  args: GrepToolInput,
  context: Pick<ToolContext, 'directory' | 'worktree'>,
  pluginCtx?: Pick<PluginInput, 'directory' | 'worktree'>,
): NormalizedGrepInput {
  if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
    throw new Error('pattern must be a non-empty string');
  }

  const cwd = context.directory || pluginCtx?.directory || process.cwd();
  const rawWorktree =
    context.worktree || pluginCtx?.worktree || context.directory || cwd;
  const absoluteRawWorktree = path.isAbsolute(rawWorktree)
    ? rawWorktree
    : path.resolve(cwd, rawWorktree);
  let worktree: string;
  try {
    worktree = existsSync(absoluteRawWorktree)
      ? realpathSync.native
        ? realpathSync.native(absoluteRawWorktree)
        : realpathSync(absoluteRawWorktree)
      : absoluteRawWorktree;
  } catch {
    worktree = absoluteRawWorktree;
  }
  const base = cwd;
  const rawTargets = cleanStringArray(args.paths);
  if (
    rawTargets.length === 0 &&
    Array.isArray((args as { path?: unknown }).path)
  ) {
    throw new Error(
      'path must be a string; use paths for multiple search targets',
    );
  }
  const requestedTargets =
    rawTargets.length > 0
      ? uniqueStrings(rawTargets)
      : [cleanOptionalString(args.path) ?? '.'];
  const normalizedTargets = requestedTargets.map((target) =>
    normalizeSearchTarget(target, base),
  );
  const primaryTarget =
    normalizedTargets[0] as (typeof normalizedTargets)[number];
  const requestedPath =
    rawTargets.length > 0
      ? requestedTargets.join(', ')
      : primaryTarget.requestedPath;
  const resolvedPath =
    rawTargets.length > 0
      ? primaryTarget.resolvedPath
      : primaryTarget.resolvedPath;
  const searchPath = primaryTarget.searchPath;
  const include = cleanOptionalString(args.include);
  const globs = cleanStringArray(args.globs);
  const excludeGlobs = cleanStringArray(args.exclude_globs);
  const contextValue = clampInteger(
    args.context,
    DEFAULT_GREP_CONTEXT,
    0,
    MAX_GREP_CONTEXT,
  );
  const beforeContext = clampInteger(
    args.before_context,
    contextValue,
    0,
    MAX_GREP_CONTEXT,
  );
  const afterContext = clampInteger(
    args.after_context,
    contextValue,
    0,
    MAX_GREP_CONTEXT,
  );
  const fileType = cleanOptionalString(args.file_type);
  const fileTypes = uniqueStrings([
    fileType,
    ...cleanStringArray(args.file_types),
  ]);
  const excludeFileTypes = uniqueStrings(
    cleanStringArray(args.exclude_file_types),
  );

  const multilineDotall = args.multiline_dotall === true;
  const multiline = args.multiline === true || multilineDotall;
  const caseSensitive = args.case_sensitive !== false;
  const smartCase = caseSensitive && args.smart_case === true;

  return {
    pattern: args.pattern,
    requestedPath,
    resolvedPath,
    searchPath,
    include,
    globs,
    excludeGlobs,
    outputMode: args.output_mode ?? 'content',
    caseSensitive,
    smartCase,
    wordRegexp: args.word_regexp === true,
    context: contextValue,
    beforeContext,
    afterContext,
    maxResults: clampInteger(
      args.max_results,
      DEFAULT_GREP_LIMIT,
      1,
      MAX_GREP_LIMIT,
    ),
    maxCountPerFile: cleanOptionalPositiveInteger(args.max_count_per_file),
    timeoutMs: clampInteger(
      args.timeout_ms,
      DEFAULT_GREP_TIMEOUT_MS,
      1,
      MAX_GREP_TIMEOUT_MS,
    ),
    hidden: args.hidden !== false,
    followSymlinks: args.follow_symlinks === true,
    fixedStrings: args.fixed_strings === true,
    invertMatch: args.invert_match === true,
    multiline,
    multilineDotall,
    pcre2: args.pcre2 === true,
    fileType,
    fileTypes,
    excludeFileTypes,
    maxFilesize: cleanOptionalString(args.max_filesize),
    sortBy: args.sort_by ?? 'none',
    sortOrder: args.sort_order ?? (args.sort_by === 'mtime' ? 'desc' : 'asc'),
    cwd,
    worktree,
    ...(rawTargets.length > 0
      ? { searchTargets: normalizedTargets.map((target) => target.searchPath) }
      : {}),
    permissionPatterns: normalizedTargets.map((target) => target.searchPath),
  };
}
