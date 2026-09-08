import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import {
  runBestEffortOpenCodeSideEffect,
  runOpenCodeSideEffect,
} from '../../utils/opencode-effects';
import {
  DEFAULT_GLOB_LIMIT,
  DEFAULT_GLOB_TIMEOUT_MS,
  GLOB_DESCRIPTION,
  GLOB_TOOL_ID,
  UNSUPPORTED_FOLLOW_SYMLINKS_ERROR,
} from './constants';
import { getRipgrepCacheDir } from './downloader';
import { formatGlobResult } from './format';
import {
  containsPath,
  MAX_TIMEOUT_MS,
  normalizeGlobInputAsync,
  resolveGlobScope,
} from './normalize';
import { type ResolvedGlobCli, resolveGlobCliAsync } from './resolver';
import { DEFAULT_CLEANUP_WAIT_MS, runRipgrep } from './runner';
import { globArgsSchema } from './schema';
import type {
  GlobRunner,
  GlobSearchResult,
  GlobToolInput,
  NormalizedGlobInput,
} from './types';

interface CreateGlobToolOptions {
  run?: GlobRunner;
  resolveCli?: (
    signal?: AbortSignal,
  ) => ResolvedGlobCli | Promise<ResolvedGlobCli>;
}

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

async function askExternalDirectory(
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

async function askRipgrepAutoInstall(ctx: {
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

const TIMEOUT_ERROR_MESSAGE = 'glob search exceeded its automatic deadline.';
// The runner has an independent TERM grace, supervisor watchdog and output
// drain phase. The small margin lets the outer promise observe that bounded
// result instead of rejecting first due to timer scheduling.
const RUNNER_ABORT_GRACE_MS = DEFAULT_CLEANUP_WAIT_MS + 250;

/** Measures automatic work and aborts pending preparation when it expires. */
class AutoClock {
  private remaining: number;
  private startedAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly controller = new AbortController();

  constructor(budgetMs: number) {
    this.remaining = budgetMs;
  }

  start(): void {
    if (this.startedAt !== undefined || this.controller.signal.aborted) {
      return;
    }

    if (this.remaining <= 0) {
      this.expire();
      return;
    }

    this.startedAt = performance.now();
    this.timer = setTimeout(() => this.expire(), Math.ceil(this.remaining));
    this.timer.unref?.();
  }

  /** Returns true when the clock was running (and is now paused). */
  pause(): boolean {
    if (this.startedAt === undefined) return false;
    this.updateRemaining();
    this.startedAt = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    return true;
  }

  remainingMs(): number {
    this.updateRemaining();
    return Math.max(0, this.remaining);
  }

  dispose(): void {
    this.updateRemaining();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.startedAt = undefined;
  }

  private updateRemaining(): void {
    if (this.startedAt === undefined || this.controller.signal.aborted) return;
    this.remaining -= performance.now() - this.startedAt;
    this.startedAt = performance.now();
  }

  private expire(): void {
    if (this.controller.signal.aborted) return;
    this.updateRemaining();
    this.remaining = 0;
    this.startedAt = undefined;
    this.timer = undefined;
    const error = new Error(TIMEOUT_ERROR_MESSAGE);
    error.name = 'TimeoutError';
    this.controller.abort(error);
  }
}

async function withHumanPause<T>(
  clock: AutoClock,
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  if (clock.controller.signal.aborted) {
    throw abortReason(clock.controller.signal);
  }
  const wasRunning = clock.pause();
  try {
    return await raceAbort(fn, signal);
  } finally {
    if (wasRunning) clock.start();
  }
}

function timeoutBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_GLOB_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('glob search was aborted.');
  error.name = 'AbortError';
  return error;
}

function raceAbort<T>(
  operation: () => Promise<T> | T,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));

  const promise = Promise.resolve().then(() => {
    if (signal.aborted) throw abortReason(signal);
    return operation();
  });

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function runWithDeadline<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));

  const promise = Promise.resolve().then(() => {
    if (signal.aborted) throw abortReason(signal);
    return operation();
  });

  return new Promise<T>((resolve, reject) => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(graceTimer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (graceTimer) return;
      graceTimer = setTimeout(() => {
        cleanup();
        reject(abortReason(signal));
      }, RUNNER_ABORT_GRACE_MS);
      graceTimer.unref?.();
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function createGlobTool(
  pluginCtx: PluginInput,
  options: CreateGlobToolOptions = {},
): ToolDefinition {
  const run = options.run ?? runRipgrep;
  const resolveCli =
    options.resolveCli ??
    ((signal?: AbortSignal) => resolveGlobCliAsync({}, signal));
  const argsSchema = globArgsSchema as Parameters<typeof tool>[0]['args'];

  return tool({
    description: GLOB_DESCRIPTION,
    args: argsSchema,
    async execute(args, ctx) {
      const raw = args as unknown as GlobToolInput;
      let input: NormalizedGlobInput | undefined;
      let stage: 'normalize' | 'permission' | 'execution' = 'normalize';

      try {
        if (raw.follow_symlinks === true) {
          throw new Error(UNSUPPORTED_FOLLOW_SYMLINKS_ERROR);
        }
        const scope = resolveGlobScope(raw, ctx, pluginCtx);
        stage = 'permission';

        await raceAbort(
          () =>
            runOpenCodeSideEffect(
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
            ),
          ctx.abort,
        );

        const clock = new AutoClock(timeoutBudget(raw.timeout_ms));
        clock.start();
        const phaseSignal = AbortSignal.any([
          ctx.abort,
          clock.controller.signal,
        ]);

        const preflight = {
          directory: scope.cwd,
          worktree: scope.worktreeRoot,
          searchPath: scope.resolvedPath,
          followSymlinks: false,
        };
        try {
          await withHumanPause(clock, phaseSignal, () =>
            askExternalDirectory(ctx, preflight),
          );

          stage = 'normalize';
          const normalizedInput = await raceAbort(
            () => normalizeGlobInputAsync(raw, ctx, pluginCtx),
            phaseSignal,
          );
          input = normalizedInput;

          if (
            normalizedInput.searchPath !== preflight.searchPath ||
            normalizedInput.worktree !== preflight.worktree
          ) {
            await withHumanPause(clock, phaseSignal, () =>
              askExternalDirectory(ctx, {
                directory: normalizedInput.cwd,
                worktree: normalizedInput.worktree,
                searchPath: normalizedInput.searchPath,
                followSymlinks: false,
              }),
            );
          }

          const cli = await raceAbort(
            () => Promise.resolve(resolveCli(phaseSignal)),
            phaseSignal,
          );
          if (cli.source === 'missing-rg') {
            await withHumanPause(clock, phaseSignal, () =>
              askRipgrepAutoInstall(ctx),
            );
            // Authorization travels with the execution: the resolver refuses
            // to auto-install unless this flag was set after the permission.
            input = { ...normalizedInput, allowAutoInstall: true };
          }

          const remaining = clock.remainingMs();
          if (remaining <= 0 || clock.controller.signal.aborted) {
            throw new Error(TIMEOUT_ERROR_MESSAGE);
          }

          stage = 'execution';
          const executionInput = input;
          if (!executionInput) {
            throw new Error('glob search normalization produced no input.');
          }
          // Preparation consumed the clock's budget. Pause it before entering
          // the runner: the runner owns the search deadline, and its bounded
          // cleanup phase must not be mistaken for additional automatic work.
          clock.pause();
          if (clock.controller.signal.aborted) {
            throw abortReason(clock.controller.signal);
          }
          const executionRemaining = clock.remainingMs();
          if (executionRemaining <= 0) {
            throw new Error(TIMEOUT_ERROR_MESSAGE);
          }
          const executionDeadline = new AbortController();
          const executionSignal = AbortSignal.any([
            ctx.abort,
            executionDeadline.signal,
          ]);
          const executionTimer = setTimeout(
            () => {
              const error = new Error(TIMEOUT_ERROR_MESSAGE);
              error.name = 'TimeoutError';
              executionDeadline.abort(error);
            },
            Math.max(1, Math.floor(executionRemaining)),
          );
          executionTimer.unref?.();

          try {
            // The runner's deadline covers its async resolver and rg process;
            // cap it by the remaining automatic budget. runWithDeadline then
            // waits long enough to receive the runner's bounded cleanup result.
            const result = await runWithDeadline(
              () =>
                run(
                  {
                    ...executionInput,
                    timeoutMs: Math.max(1, Math.floor(executionRemaining)),
                  },
                  executionSignal,
                ),
              executionSignal,
            );
            const output = formatGlobResult(executionInput, result);
            const metadata = resultMetadata(raw, executionInput, result);

            await emit(ctx, title(raw, executionInput), metadata);

            // Structured return: the host adapter preserves metadata attached
            // here instead of overwriting it with an empty object.
            return { title: title(raw, executionInput), output, metadata };
          } finally {
            clearTimeout(executionTimer);
          }
        } finally {
          clock.dispose();
        }
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
