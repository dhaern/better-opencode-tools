import path from 'node:path';
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { Effect } from 'effect';
import {
  DEFAULT_GLOB_LIMIT,
  DEFAULT_GLOB_TIMEOUT_MS,
  GLOB_DESCRIPTION,
  GLOB_TOOL_ID,
} from './constants';
import { getInstalledRipgrepPath, getRipgrepCacheDir } from './downloader';
import { formatGlobResult } from './format';
import { normalizeGlobInput, resolveGlobScope } from './normalize';
import { type ResolvedGlobCli, resolveGlobCli } from './resolver';
import { runRipgrep } from './runner';
import { globArgsSchema } from './schema';
import type {
  GlobRunner,
  GlobSearchResult,
  GlobToolInput,
  NormalizedGlobInput,
} from './types';

interface CreateGlobToolOptions {
  run?: GlobRunner;
  resolveCli?: () => ResolvedGlobCli;
}

function execute<T>(value: T | Promise<T> | Effect.Effect<T>): Promise<T> {
  if (Effect.isEffect(value)) return Effect.runPromise(value);
  return Promise.resolve(value);
}

function title(args: GlobToolInput, input?: NormalizedGlobInput): string {
  const pattern = input?.pattern ?? args.pattern;
  return typeof pattern === 'string' && pattern.length > 0 ? pattern : 'glob';
}

function baseMetadata(
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

function resultMetadata(
  args: GlobToolInput,
  input: NormalizedGlobInput,
  result: GlobSearchResult,
): Record<string, unknown> {
  return {
    ...baseMetadata(args, input),
    count: result.count,
    truncated: result.truncated,
    incomplete: result.incomplete,
    timed_out: result.timedOut,
    cancelled: result.cancelled,
    exit_code: result.exitCode,
    error: result.error,
    cwd: result.cwd,
    command: result.command,
  };
}

function contains(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function askExternalDirectory(
  ctx: {
    ask: (payload: {
      permission: string;
      patterns: string[];
      always: string[];
      metadata: Record<string, unknown>;
    }) => Promise<unknown> | unknown;
  },
  input: { worktree: string; searchPath: string; followSymlinks: boolean },
): Promise<void> {
  if (!input.followSymlinks && contains(input.worktree, input.searchPath))
    return;

  const glob = path.join(input.searchPath, '*').replaceAll('\\', '/');
  await execute(
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

async function askRipgrepAutoInstall(ctx: {
  ask: (payload: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }) => Promise<unknown> | unknown;
}): Promise<void> {
  const dir = getRipgrepCacheDir().replaceAll('\\', '/');
  await execute(
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

function failureMetadata(
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

async function emit(
  ctx: {
    metadata: (payload: {
      title?: string;
      metadata?: Record<string, unknown>;
    }) => Promise<unknown> | unknown;
  },
  name: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.metadata({ title: name, metadata });
  } catch {
    // Metadata is best-effort.
  }
}

export function createGlobTool(
  pluginCtx: PluginInput,
  options: CreateGlobToolOptions = {},
): ToolDefinition {
  const run = options.run ?? runRipgrep;
  const resolveCli =
    options.resolveCli ??
    (() =>
      resolveGlobCli({
        getInstalledRipgrepPath: () =>
          getInstalledRipgrepPath({ repair: false }),
      }));
  const argsSchema = globArgsSchema as Parameters<typeof tool>[0]['args'];

  return tool({
    description: GLOB_DESCRIPTION,
    args: argsSchema,
    async execute(args, ctx) {
      const raw = args as unknown as GlobToolInput;
      let input: NormalizedGlobInput | undefined;
      let stage: 'normalize' | 'permission' | 'execution' = 'normalize';

      try {
        const scope = resolveGlobScope(raw, ctx, pluginCtx);
        stage = 'permission';

        await execute(
          ctx.ask({
            permission: GLOB_TOOL_ID,
            patterns: [raw.pattern],
            always: ['*'],
            metadata: {
              pattern: raw.pattern,
              path: raw.path,
              ...baseMetadata(raw, input),
            },
          }),
        );

        const preflight = {
          worktree: scope.worktreeRoot,
          searchPath: scope.resolvedPath,
          followSymlinks: raw.follow_symlinks === true,
        };
        await askExternalDirectory(ctx, preflight);

        stage = 'normalize';
        input = normalizeGlobInput(raw, ctx, pluginCtx);
        if (
          input.searchPath !== preflight.searchPath ||
          input.worktree !== preflight.worktree
        ) {
          await askExternalDirectory(ctx, {
            worktree: input.worktree,
            searchPath: input.searchPath,
            followSymlinks: input.followSymlinks,
          });
        }

        if (resolveCli().source === 'missing-rg') {
          await askRipgrepAutoInstall(ctx);
        }

        stage = 'execution';
        const result = await run(input, ctx.abort);
        const output = formatGlobResult(input, result);
        const metadata = resultMetadata(raw, input, result);

        await emit(ctx, title(raw, input), metadata);

        return output;
      } catch (error) {
        await emit(
          ctx,
          title(raw, input),
          failureMetadata(raw, stage, error, input),
        );
        throw error;
      }
    },
  });
}
