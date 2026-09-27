import { GrepAggregator } from './aggregate';
import { collectFileEntries, finalizeFiles } from './fallback-results';
import {
  consumeNullCountPairsBytes,
  consumeNullItemsBytes,
  consumeRgJsonStream,
  readTextStream,
} from './json-stream';
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

function finishFileListMode(
  baseResult: GrepSearchResult,
  files: GrepFileMatch[],
  input: NormalizedGrepInput,
  killedForLimit: boolean,
  termination: TerminationState,
  exitCode: number,
  stderr: string,
): GrepSearchResult {
  const finalized = finalizeFiles(files, input);
  const limitReached = finalized.limitReached || killedForLimit;
  return {
    ...baseResult,
    ...finalized,
    truncated: limitReached || termination.timedOut || termination.cancelled,
    limitReached,
    timedOut: termination.timedOut,
    cancelled: termination.cancelled,
    exitCode,
    stderr,
    warnings: [],
  };
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
    init: () => TState;
    consumeStdout: (
      stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
      proc: GrepProcess,
      state: TState,
    ) => Promise<void>;
    buildResult: (
      baseResult: GrepSearchResult,
      state: TState,
      termination: TerminationState,
      exitCode: number,
      stderr: string,
    ) => GrepSearchResult;
    isStopped: (state: TState, termination: TerminationState) => boolean;
    finalizeResult?: (
      result: GrepSearchResult,
      stdoutError: unknown,
      exitError: string | undefined,
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

  let proc: GrepProcess;
  try {
    proc = spawnRipgrep(command, input.cwd, options.env);
  } catch (error) {
    const friendlyMessage = createFriendlySpawnError(error, cli);
    if (friendlyMessage) return { ...baseResult, error: friendlyMessage };
    if (isTransientFailure(error)) {
      throw new RetryableRipgrepError(toErrorMessage(error));
    }
    return {
      ...baseResult,
      error:
        error instanceof Error
          ? error.message
          : `Failed to spawn ${cli.backend}`,
    };
  }

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
    const result = options.buildResult(
      baseResult,
      state,
      termination.state,
      exitCode,
      stderr.trim(),
    );

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
      result.error = exitError;
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
    buildResult: (baseResult, state, termination, exitCode, stderr) => {
      const snapshot = state.aggregator.snapshot();
      return {
        ...baseResult,
        ...snapshot,
        truncated:
          snapshot.limitReached ||
          state.killedForLimit ||
          termination.timedOut ||
          termination.cancelled,
        limitReached: snapshot.limitReached || state.killedForLimit,
        timedOut: termination.timedOut,
        cancelled: termination.cancelled,
        exitCode,
        stderr,
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

export async function executeCountMode(
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
      // ripgrep pre-sorts, so the shared file-list consumer runs without
      // admission: identical records, limits and early stop as GNU fallback.
      const collected = await collectFileEntries(
        proc,
        { ...input, sortBy: 'none' },
        (yieldFile) =>
          consumeNullCountPairsBytes(stdout, (filePath, countText) => {
            if (!/^\d+$/.test(countText)) {
              return true;
            }

            const count = Number.parseInt(countText, 10);
            if (count === 0) {
              return true;
            }
            return yieldFile(filePath, count);
          }),
      );
      state.files = collected.files;
      state.limitReached = collected.limitReached;
    },
    buildResult: (baseResult, state, termination, exitCode, stderr) =>
      finishFileListMode(
        baseResult,
        state.files,
        input,
        state.limitReached,
        termination,
        exitCode,
        stderr,
      ),
    isStopped: simpleIsStopped,
  });
}

export async function executeFilesMode(
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
      const collected = await collectFileEntries(
        proc,
        { ...input, sortBy: 'none' },
        (yieldFile) =>
          consumeNullItemsBytes(stdout, (filePath) => {
            if (filePath.length === 0) {
              return true;
            }
            return yieldFile(filePath, 1);
          }),
      );
      state.files = collected.files;
      state.limitReached = collected.limitReached;
    },
    buildResult: (baseResult, state, termination, exitCode, stderr) =>
      finishFileListMode(
        baseResult,
        state.files,
        input,
        state.limitReached,
        termination,
        exitCode,
        stderr,
      ),
    isStopped: simpleIsStopped,
  });
}
