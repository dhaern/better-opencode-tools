import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { runOpenCodeSideEffect } from '../../utils/opencode-effects';
import { GREP_DESCRIPTION, GREP_TOOL_ID } from './constants';
import { formatGrepResult } from './format';
import {
  DEFAULT_OUTPUT_MODE,
  DEFAULT_SORT_BY,
  normalizeGrepInput,
} from './normalize';
import { sanitizeTitle } from './path-utils';
import {
  askExternalDirectoryPermissions,
  collectExternalSymlinkDestinations,
} from './permissions';
import { runRipgrep } from './runner';
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
  const value = (key: keyof NormalizedGrepInput, fallback: unknown): unknown =>
    normalized?.[key] ?? fallback;
  return {
    backend: 'rg',
    pattern: value('pattern', getRawPattern(args)),
    path: value('requestedPath', args.path),
    paths: normalized?.searchTargets
      ? normalized.permissionPatterns
      : args.paths,
    resolved_path: normalized?.resolvedPath,
    real_path: normalized?.searchPath,
    include: value('include', args.include),
    globs: value('globs', args.globs ?? []),
    exclude_globs: value('excludeGlobs', args.exclude_globs ?? []),
    output_mode: value('outputMode', args.output_mode ?? DEFAULT_OUTPUT_MODE),
    case_sensitive: value('caseSensitive', args.case_sensitive !== false),
    smart_case: value('smartCase', args.smart_case === true),
    word_regexp: value('wordRegexp', args.word_regexp === true),
    context: value('context', args.context),
    context_requested: value('context', args.context),
    context_effective:
      normalized && normalized.beforeContext === normalized.afterContext
        ? normalized.beforeContext
        : undefined,
    before_context: value('beforeContext', args.before_context),
    after_context: value('afterContext', args.after_context),
    max_results: value('maxResults', args.max_results),
    max_count_per_file: value('maxCountPerFile', args.max_count_per_file),
    timeout_ms: value('timeoutMs', args.timeout_ms),
    hidden: value('hidden', args.hidden !== false),
    follow_symlinks: value('followSymlinks', args.follow_symlinks === true),
    real_path_exhaustive: normalized
      ? !normalized.followSymlinks
      : args.follow_symlinks !== true,
    fixed_strings: value('fixedStrings', args.fixed_strings === true),
    invert_match: value('invertMatch', args.invert_match === true),
    multiline: value('multiline', args.multiline === true),
    multiline_dotall: value('multilineDotall', args.multiline_dotall === true),
    pcre2: value('pcre2', args.pcre2 === true),
    file_type: value('fileType', args.file_type),
    file_types: value('fileTypes', args.file_types ?? []),
    exclude_file_types: value(
      'excludeFileTypes',
      args.exclude_file_types ?? [],
    ),
    max_filesize: value('maxFilesize', args.max_filesize),
    sort_by: value('sortBy', args.sort_by ?? DEFAULT_SORT_BY),
    sort_order: value('sortOrder', args.sort_order),
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
    await runOpenCodeSideEffect(ctx.metadata({ title, metadata }));
  } catch {
    // Metadata is best-effort.
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
