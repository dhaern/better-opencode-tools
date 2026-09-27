import { GrepAggregator } from './aggregate';
import { collectFileEntries, finishFileListMode } from './fallback-results';
import { consumeRgJsonStream, readTextStream } from './json-stream';
import type { ResolvedGrepCli } from './resolver';
import {
  applySuccessfulStderr,
  createEmptyResult,
  finalizeNonFatalExit,
  hasVisibleResults,
} from './result-utils';
import { buildRgCommand } from './rg-args';
import {
  attachTerminationHandlers,
  createFriendlySpawnError,
  type GrepProcess,
  getAbortKind,
  isTransientFailure,
  isTransientStderr,
  killProcess,
  RetryableRipgrepError,
  spawnRipgrep,
  type TerminationState,
  toErrorMessage,
  waitForExitAndStderr,
} from './runtime';
import type {
  GrepFileMatch,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

interface ContentState {
  aggregator: GrepAggregator;
  killedForLimit: boolean;
}

interface FileListState {
  files: GrepFileMatch[];
  limitReached: boolean;
}

function simpleIsStopped(
  state: { limitReached: boolean },
  termination: TerminationState,
): boolean {
  return termination.timedOut || termination.cancelled || state.limitReached;
}

export async function executeMode<TState>(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
  options: {
    command?: string[];
    env?: NodeJS.ProcessEnv;
    retries?: 0;
    warnings?: string[];
    spawn?: typeof spawnRipgrep;
    init: () => TState;
    consumeStdout: (
      stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
      proc: GrepProcess,
      state: TState,
    ) => Promise<void>;
    buildResult: (
      baseResult: GrepSearchResult,
      state: TState,
    ) => GrepSearchResult;
    isStopped: (state: TState, termination: TerminationState) => boolean;
    finalizeResult?: (
      result: GrepSearchResult,
      stdoutError: unknown,
      exitError: unknown,
    ) => GrepSearchResult;
  },
): Promise<GrepSearchResult> {
  const command = options.command ?? buildRgCommand(input, cli.path);
  const baseResult: GrepSearchResult = {
    ...createEmptyResult(input, command),
    backend: cli.backend,
    warnings: options.warnings ?? [],
  };

  if (signal.aborted) {
    return {
      ...baseResult,
      truncated: true,
      timedOut: getAbortKind(signal) === 'timeout',
      cancelled: getAbortKind(signal) !== 'timeout',
    };
  }

  const proc = (options.spawn ?? spawnRipgrep)(command, input.cwd, options.env);

  const state = options.init();
  const termination = attachTerminationHandlers(proc, input.timeoutMs, signal);

  try {
    const stdout = proc.proc.stdout ?? undefined;
    const stderrStream = proc.proc.stderr ?? undefined;
    const stdoutPromise = options.consumeStdout(stdout, proc, state);
    const stderrPromise = readTextStream(stderrStream);
    // Observe process exit from the start: a spawn failure can reject long
    // before stdout finishes, and the rejection must have a handler attached.
    const exitPromise = waitForExitAndStderr(proc, stderrPromise);

    const captureError = (error: unknown) => error;
    const [stdoutError, { exitCode, stderr, error: exitError }] =
      await Promise.all([
        stdoutPromise.then(() => undefined, captureError),
        exitPromise,
      ]);
    baseResult.timedOut = termination.state.timedOut;
    baseResult.cancelled = termination.state.cancelled;
    baseResult.exitCode = exitCode;
    baseResult.stderr = stderr.trim();
    const result = options.buildResult(baseResult, state);

    if (options.finalizeResult)
      return options.finalizeResult(result, stdoutError, exitError);

    if (stdoutError && !options.isStopped(state, termination.state)) {
      if (options.retries !== 0 && isTransientFailure(stdoutError)) {
        throw new RetryableRipgrepError(toErrorMessage(stdoutError));
      }

      if (hasVisibleResults(result)) {
        result.truncated = true;
        result.warnings.push(
          `Partial output processing failure: ${toErrorMessage(stdoutError)}`,
        );
        return result;
      }

      result.error =
        stdoutError instanceof Error
          ? stdoutError.message
          : 'Failed to process rg output';
      return result;
    }

    applySuccessfulStderr(result, result.stderr, exitCode);

    if (exitError && !options.isStopped(state, termination.state)) {
      const friendlyMessage = createFriendlySpawnError(exitError, cli);
      if (friendlyMessage) {
        result.error = friendlyMessage;
        return result;
      }
      if (options.retries !== 0 && isTransientFailure(exitError)) {
        throw new RetryableRipgrepError(toErrorMessage(exitError));
      }
      result.error = toErrorMessage(exitError);
      return result;
    }

    if (options.isStopped(state, termination.state)) {
      return result;
    }

    const nonFatal = finalizeNonFatalExit(result, exitCode, result.stderr);
    if (nonFatal) {
      return nonFatal;
    }

    if (options.retries !== 0 && isTransientStderr(result.stderr)) {
      throw new RetryableRipgrepError(result.stderr);
    }

    result.error = result.stderr || `rg exited with code ${String(exitCode)}`;
    return result;
  } finally {
    termination.cleanup();
  }
}

export async function executeContentLikeMode(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  return executeMode(input, signal, cli, {
    init: (): ContentState => ({
      aggregator: new GrepAggregator({
        cwd: input.cwd,
        worktree: input.worktree,
        maxResults: input.maxResults,
        beforeContext: input.beforeContext,
        afterContext: input.afterContext,
      }),
      killedForLimit: false,
    }),
    consumeStdout: async (stdout, proc, state) =>
      consumeRgJsonStream(stdout, (event) => {
        state.aggregator.consume(event);

        if (state.aggregator.isFull()) {
          state.killedForLimit = true;
          killProcess(proc);
          return false;
        }

        return true;
      }),
    buildResult: (baseResult, state) => {
      const snapshot = state.aggregator.snapshot();
      return {
        ...baseResult,
        ...snapshot,
        truncated:
          snapshot.limitReached ||
          state.killedForLimit ||
          baseResult.timedOut ||
          baseResult.cancelled,
        limitReached: snapshot.limitReached || state.killedForLimit,
        summary: snapshot.summary,
        warnings: [],
      };
    },
    isStopped: (state, termination) =>
      termination.timedOut ||
      termination.cancelled ||
      state.killedForLimit ||
      state.aggregator.snapshot().limitReached,
  });
}

export async function executeFileListMode(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  return executeMode(input, signal, cli, {
    init: (): FileListState => ({
      files: [],
      limitReached: false,
    }),
    consumeStdout: async (stdout, proc, state) => {
      // ripgrep pre-sorts, so the shared file-list consumer needs no admission.
      const collected = await collectFileEntries(
        proc,
        { ...input, sortBy: 'none' },
        stdout,
        input.outputMode === 'count' ? 'count' : 'files',
      );
      state.files = collected.files;
      state.limitReached = collected.limitReached;
    },
    buildResult: (baseResult, state) =>
      finishFileListMode(baseResult, state.files, input, state.limitReached),
    isStopped: simpleIsStopped,
  });
}

// Keep the internal named entry points while sharing their implementation.
export const executeCountMode = executeFileListMode;
export const executeFilesMode = executeFileListMode;

export function executeDirectMode(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  return input.outputMode === 'content'
    ? executeContentLikeMode(input, signal, cli)
    : executeFileListMode(input, signal, cli);
}
