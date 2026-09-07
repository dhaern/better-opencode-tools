import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type PluginInput,
  type ToolContext,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import {
  runBestEffortOpenCodeSideEffect,
  runOpenCodeSideEffect,
} from '../../utils/opencode-effects';
import { GREP_DESCRIPTION, GREP_TOOL_ID } from './constants';
import { formatGrepResult } from './format';
import { normalizeGrepInput } from './normalize';
import { sanitizeTitle } from './path-utils';
import { runRipgrep } from './runner';
import { AbortWaitError } from './runtime';
import { grepArgsSchema } from './schema';
import type {
  GrepRunner,
  GrepSearchResult,
  GrepToolInput,
  NormalizedGrepInput,
} from './types';

interface CreateGrepToolOptions {
  run?: GrepRunner;
}

function getRawPattern(args: GrepToolInput): string {
  return typeof args.pattern === 'string' && args.pattern.length > 0
    ? args.pattern
    : 'grep';
}

function getTitle(
  args: GrepToolInput,
  normalized?: NormalizedGrepInput,
): string {
  return sanitizeTitle(normalized?.pattern ?? getRawPattern(args));
}

function buildBaseMetadata(
  args: GrepToolInput,
  normalized?: NormalizedGrepInput,
): Record<string, unknown> {
  return {
    backend: 'rg',
    pattern: normalized?.pattern ?? getRawPattern(args),
    path: normalized?.requestedPath ?? args.path,
    paths: normalized?.searchTargets
      ? normalized.permissionPatterns
      : args.paths,
    resolved_path: normalized?.resolvedPath,
    real_path: normalized?.searchPath,
    include: normalized?.include ?? args.include,
    globs: normalized?.globs ?? args.globs ?? [],
    exclude_globs: normalized?.excludeGlobs ?? args.exclude_globs ?? [],
    output_mode: normalized?.outputMode ?? args.output_mode ?? 'content',
    case_sensitive: normalized?.caseSensitive ?? args.case_sensitive !== false,
    smart_case: normalized?.smartCase ?? args.smart_case === true,
    word_regexp: normalized?.wordRegexp ?? args.word_regexp === true,
    context: normalized?.context ?? args.context,
    context_requested: normalized?.context ?? args.context,
    context_effective:
      normalized && normalized.beforeContext === normalized.afterContext
        ? normalized.beforeContext
        : undefined,
    before_context: normalized?.beforeContext ?? args.before_context,
    after_context: normalized?.afterContext ?? args.after_context,
    max_results: normalized?.maxResults ?? args.max_results,
    max_count_per_file: normalized?.maxCountPerFile ?? args.max_count_per_file,
    timeout_ms: normalized?.timeoutMs ?? args.timeout_ms,
    hidden: normalized?.hidden ?? args.hidden !== false,
    follow_symlinks:
      normalized?.followSymlinks ?? args.follow_symlinks === true,
    real_path_exhaustive: normalized
      ? !normalized.followSymlinks
      : args.follow_symlinks !== true,
    fixed_strings: normalized?.fixedStrings ?? args.fixed_strings === true,
    invert_match: normalized?.invertMatch ?? args.invert_match === true,
    multiline: normalized?.multiline ?? args.multiline === true,
    multiline_dotall:
      normalized?.multilineDotall ?? args.multiline_dotall === true,
    pcre2: normalized?.pcre2 ?? args.pcre2 === true,
    file_type: normalized?.fileType ?? args.file_type,
    file_types: normalized?.fileTypes ?? args.file_types ?? [],
    exclude_file_types:
      normalized?.excludeFileTypes ?? args.exclude_file_types ?? [],
    max_filesize: normalized?.maxFilesize ?? args.max_filesize,
    sort_by: normalized?.sortBy ?? args.sort_by ?? 'none',
    sort_order: normalized?.sortOrder ?? args.sort_order,
  };
}

function buildResultMetadata(
  args: GrepToolInput,
  normalized: NormalizedGrepInput,
  result: GrepSearchResult,
): Record<string, unknown> {
  const strategy =
    result.strategy ??
    (normalized.sortBy === 'mtime' ? 'mtime-hybrid' : 'direct');

  return {
    ...buildBaseMetadata(args, normalized),
    backend: result.backend ?? 'rg',
    matches: result.totalMatches,
    match_kind: result.matchKind,
    files: result.totalFiles,
    truncated: result.truncated,
    search_truncated: result.truncated || result.limitReached,
    limit_reached: result.limitReached,
    timed_out: result.timedOut,
    cancelled: result.cancelled,
    retry_count: result.retryCount,
    exit_code: result.exitCode,
    error: result.error,
    cwd: result.cwd,
    command: result.command,
    strategy,
    discovery_command: result.discoveryCommand,
    replay_batch_count: result.replayBatchCount,
    replay_target_count: result.replayTargetCount,
    discovered_files: result.discoveredFiles,
    sorted_files: result.sortedFiles,
    replayed_files: result.replayedFiles,
    partial_phase: result.partialPhase,
    mtime_discovery_capped: result.mtimeDiscoveryCapped,
  };
}

function buildFailureMetadata(
  args: GrepToolInput,
  stage: 'normalize' | 'permission' | 'execution',
  error: unknown,
  normalized?: NormalizedGrepInput,
): Record<string, unknown> {
  return {
    ...buildBaseMetadata(args, normalized),
    truncated: false,
    limit_reached: false,
    timed_out: false,
    cancelled: false,
    retry_count: 0,
    exit_code: undefined,
    error: error instanceof Error ? error.message : String(error),
    error_stage: stage,
  };
}

async function emitMetadataSafely(
  ctx: {
    metadata: (payload: {
      title: string;
      metadata: Record<string, unknown>;
    }) => Promise<unknown> | unknown;
  },
  title: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await runBestEffortOpenCodeSideEffect(ctx.metadata({ title, metadata }));
  } catch {
    // Metadata is best-effort.
  }
}

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

async function collectExternalSymlinkDestinations(
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

async function askExternalDirectoryPermissions(
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

export function createGrepTool(
  pluginCtx: PluginInput,
  options: CreateGrepToolOptions = {},
): ToolDefinition {
  const run = options.run ?? runRipgrep;
  const argsSchema = grepArgsSchema as Parameters<typeof tool>[0]['args'];

  return tool({
    description: GREP_DESCRIPTION,
    args: argsSchema,
    async execute(args, ctx) {
      const rawArgs = args as unknown as GrepToolInput;
      let normalized: NormalizedGrepInput | undefined;
      let stage: 'normalize' | 'permission' | 'execution' = 'normalize';

      try {
        normalized = normalizeGrepInput(rawArgs, ctx, pluginCtx);
        stage = 'permission';

        const directory = ctx.directory ?? pluginCtx.directory;
        const worktree = ctx.worktree ?? pluginCtx.worktree;

        const externalSymlinks = normalized.followSymlinks
          ? await collectExternalSymlinkDestinations(
              normalized.searchTargets ?? [normalized.searchPath],
              directory,
              worktree,
              ctx.abort,
            )
          : [];

        await askExternalDirectoryPermissions(
          ctx,
          normalized,
          directory,
          worktree,
          externalSymlinks,
        );

        await runOpenCodeSideEffect(
          ctx.ask({
            permission: GREP_TOOL_ID,
            patterns: [normalized.pattern],
            always: ['*'],
            metadata: buildBaseMetadata(rawArgs, normalized),
          }),
        );

        stage = 'execution';
        const result = await run(normalized, ctx.abort);
        const output = formatGrepResult(normalized, result);
        const title = getTitle(rawArgs, normalized);
        const metadata = buildResultMetadata(rawArgs, normalized, result);

        await emitMetadataSafely(ctx, title, metadata);

        return { output, title, metadata };
      } catch (error) {
        await emitMetadataSafely(
          ctx,
          getTitle(rawArgs, normalized),
          buildFailureMetadata(rawArgs, stage, error, normalized),
        );
        throw error;
      }
    },
  });
}
