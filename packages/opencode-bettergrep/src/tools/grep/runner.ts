import { DEFAULT_GREP_RETRY_COUNT, RG_BINARY } from './constants';
import { executeDirectMode } from './direct';
import { executeGrepFallback } from './fallback';
import { type BuiltGrepCommand, buildGrepCommand } from './fallback-command';
import { buildDiscoveryInput, executeMtimeMode } from './mtime';
import {
  invalidateGrepCliResolverCache,
  type ResolvedGrepCli,
  resolveGrepCliWithAutoInstall,
} from './resolver';
import { createEmptyResult } from './result-utils';
import { buildRgCommand } from './rg-args';
import {
  AbortWaitError,
  createGlobalAbortState,
  createSearchAbortError,
  getRetryBackoffMs,
  RetryableRipgrepError,
  RUNNER_SEMAPHORE,
  remainingTimeout,
  sleepWithSignal,
  toErrorMessage,
} from './runtime';
import type {
  GrepRunner,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

function invalidateIfSpawnFailed(result: GrepSearchResult): void {
  if (
    result.error &&
    /\b(?:ENOENT|EACCES)\b|not available/i.test(result.error)
  ) {
    invalidateGrepCliResolverCache();
  }
}

function buildFailureMeta(
  input: NormalizedGrepInput,
  cli: ResolvedGrepCli,
): Pick<GrepSearchResult, 'strategy' | 'discoveryCommand'> {
  if (input.sortBy !== 'mtime' || cli.backend === 'grep') {
    return { strategy: 'direct', discoveryCommand: undefined };
  }

  const discoveryInput = buildDiscoveryInput(input);

  return {
    strategy: 'mtime-hybrid',
    discoveryCommand: buildRgCommand(discoveryInput, cli.path),
  };
}

async function executeOnce(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
  command?: string[],
  prepared?: BuiltGrepCommand,
): Promise<GrepSearchResult> {
  if (cli.backend === 'grep') {
    return executeGrepFallback(input, signal, cli, prepared);
  }

  if (input.sortBy === 'mtime') {
    return executeMtimeMode(input, signal, cli);
  }

  return executeDirectMode(input, signal, cli, command);
}

async function resolveCliForExecution(
  signal: AbortSignal,
): Promise<ResolvedGrepCli> {
  if (signal.aborted) {
    throw createSearchAbortError();
  }

  return resolveGrepCliWithAutoInstall(undefined, signal);
}

export const runRipgrep: GrepRunner = async (input, signal) => {
  const deadline = Date.now() + input.timeoutMs;
  const globalAbort = createGlobalAbortState(signal, input.timeoutMs);
  let previewCli: ResolvedGrepCli = {
    path: RG_BINARY,
    backend: 'rg',
    source: 'missing-rg',
  };
  let command = input.sortBy === 'mtime' ? undefined : buildRgCommand(input);

  const createAbortedResult = (
    attempt: number,
    error?: string,
  ): GrepSearchResult => ({
    ...createEmptyResult(input, command),
    ...buildFailureMeta(input, previewCli),
    truncated: globalAbort.getTimedOut() || globalAbort.getCancelled(),
    timedOut: globalAbort.getTimedOut(),
    cancelled: globalAbort.getCancelled(),
    retryCount: attempt,
    ...(error ? { error } : {}),
  });

  let finalResult: GrepSearchResult;
  try {
    finalResult = await RUNNER_SEMAPHORE.use(async () => {
      let attempt = 0;
      let cli: ResolvedGrepCli;
      let prepared: BuiltGrepCommand | undefined;

      try {
        cli = await resolveCliForExecution(globalAbort.signal);
        previewCli = cli;
        prepared =
          cli.backend === 'grep'
            ? buildGrepCommand(input, cli.path)
            : undefined;
        command =
          prepared?.command ??
          (input.sortBy === 'mtime'
            ? undefined
            : [cli.path, ...(command ?? buildRgCommand(input)).slice(1)]);
      } catch (error) {
        if (error instanceof AbortWaitError || globalAbort.signal.aborted) {
          return createAbortedResult(attempt);
        }

        return {
          ...createAbortedResult(attempt),
          error: toErrorMessage(error),
        };
      }

      if (cli.backend === 'grep') {
        const grepInput: NormalizedGrepInput = {
          ...input,
          timeoutMs: Math.max(1, remainingTimeout(deadline)),
        };
        const result = await executeOnce(
          grepInput,
          globalAbort.signal,
          cli,
          command,
          prepared,
        );
        result.retryCount = attempt;
        return result;
      }

      while (true) {
        const remaining = remainingTimeout(deadline);
        if (globalAbort.signal.aborted || remaining <= 1) {
          if (!globalAbort.signal.aborted && remaining <= 1) {
            globalAbort.timeout();
          }
          return createAbortedResult(attempt);
        }

        const scopedInput: NormalizedGrepInput = {
          ...input,
          timeoutMs: remaining,
        };

        try {
          const result = await executeOnce(
            scopedInput,
            globalAbort.signal,
            cli,
            command,
          );
          result.retryCount = attempt;
          return result;
        } catch (error) {
          if (error instanceof AbortWaitError || globalAbort.signal.aborted) {
            return createAbortedResult(attempt);
          }

          if (
            !(error instanceof RetryableRipgrepError) ||
            attempt >= DEFAULT_GREP_RETRY_COUNT
          ) {
            return {
              ...createAbortedResult(attempt),
              error: toErrorMessage(error),
            };
          }

          attempt += 1;

          try {
            await sleepWithSignal(
              getRetryBackoffMs(deadline),
              globalAbort.signal,
            );
          } catch {
            return createAbortedResult(attempt);
          }
        }
      }
    }, globalAbort.signal);
  } catch (error) {
    if (error instanceof AbortWaitError || globalAbort.signal.aborted) {
      finalResult = createAbortedResult(0);
    } else {
      finalResult = {
        ...createEmptyResult(input, command),
        ...buildFailureMeta(input, previewCli),
        error: toErrorMessage(error),
      };
    }
  } finally {
    globalAbort.cleanup();
  }
  invalidateIfSpawnFailed(finalResult);
  return finalResult;
};
