import { stat } from 'node:fs/promises';
import { MAX_MTIME_DISCOVERY_FILES } from './constants';
import { executeDirectMode, executeFileListMode } from './direct';
import { comparePathBytes, finishFileListMode } from './fallback-results';
import type { ResolvedGrepCli } from './resolver';
import {
  countOccurrences,
  countVisibleMatches,
  createEmptyResult,
  finalizeMtimeContentResult,
} from './result-utils';
import { buildRgCommand } from './rg-args';
import { isTimedOutAbort, remainingTimeout, toErrorMessage } from './runtime';
import type {
  GrepFileMatch,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

export function buildDiscoveryInput(
  input: NormalizedGrepInput,
): NormalizedGrepInput {
  return {
    ...input,
    outputMode: 'files_with_matches',
    sortBy: 'none',
    sortOrder: 'asc',
    maxResults: MAX_MTIME_DISCOVERY_FILES,
    maxCountPerFile: undefined,
  };
}

function withSearchTargets(
  input: NormalizedGrepInput,
  searchTargets: string[],
  timeoutMs: number,
  maxResults = input.maxResults,
): NormalizedGrepInput {
  return {
    ...input,
    searchPath: searchTargets[0] ?? input.searchPath,
    requestedPath:
      searchTargets.length === 1
        ? (searchTargets[0] ?? input.requestedPath)
        : input.requestedPath,
    permissionPatterns: searchTargets,
    maxResults,
    timeoutMs: Math.max(1, timeoutMs),
    sortBy: 'none',
    sortOrder: 'asc',
    searchTargets,
    // Replay batches run single-threaded so results follow argv order;
    // per-batch post-reorder below is belt and braces.
    sequentialReplay: true,
  };
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function reorderFilesByReplayOrder(
  files: GrepFileMatch[],
  orderedTargets: string[],
): GrepFileMatch[] {
  const order = new Map(orderedTargets.map((target, index) => [target, index]));
  return files.sort(
    (left, right) =>
      (order.get(left.replayPath ?? left.absolutePath) ?? Infinity) -
      (order.get(right.replayPath ?? right.absolutePath) ?? Infinity),
  );
}

function abortedKind(
  signal: AbortSignal,
): 'timedOut' | 'cancelled' | undefined {
  return signal.aborted
    ? isTimedOutAbort(signal)
      ? 'timedOut'
      : 'cancelled'
    : undefined;
}

async function discoverMatchingFiles(
  discoveryInput: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  const result = await executeFileListMode(discoveryInput, signal, cli);

  if (result.limitReached) {
    result.truncated = true;
    result.warnings.push(
      `mtime discovery capped at ${MAX_MTIME_DISCOVERY_FILES} matching files; ordering may be partial.`,
    );
  }

  if (result.error && result.totalFiles === 0 && result.totalMatches === 0) {
    throw new Error(result.error);
  }

  if (result.error) {
    result.truncated = true;
    result.warnings.push(`Partial discovery failure: ${result.error}`);
    result.error = undefined;
  }

  return result;
}

export async function executeMtimeMode(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  const deadline = Date.now() + input.timeoutMs;
  const discoveryInput = buildDiscoveryInput(input);
  const discovery = await discoverMatchingFiles(discoveryInput, signal, cli);
  const baseMtimeResult: GrepSearchResult = {
    ...createEmptyResult(input),
    backend: 'rg',
  };
  const strategyMeta = {
    strategy: 'mtime-hybrid' as const,
    discoveryCommand: buildRgCommand(discoveryInput, cli.path),
    discoveredFiles: discovery.files.length,
    mtimeDiscoveryCapped: discovery.limitReached,
  };

  const nonReplayableFiles = discovery.files.filter((file) => !file.replayPath);

  if (nonReplayableFiles.length > 0) {
    const timeoutMs = Math.max(1, remainingTimeout(deadline));
    const fallbackInput: NormalizedGrepInput = {
      ...input,
      sortBy: 'none',
      sortOrder: 'asc',
      timeoutMs,
    };
    const fallback = await executeDirectMode(fallbackInput, signal, cli);

    return {
      ...fallback,
      strategy: 'mtime-fallback',
      discoveryCommand: strategyMeta.discoveryCommand,
      discoveredFiles: strategyMeta.discoveredFiles,
      mtimeDiscoveryCapped: strategyMeta.mtimeDiscoveryCapped,
      warnings: [
        ...discovery.warnings,
        `mtime ordering disabled: ${nonReplayableFiles.length} non-UTF8 ${nonReplayableFiles.length === 1 ? 'path is' : 'paths are'} not safely orderable; returned direct search results instead.`,
        ...fallback.warnings,
      ],
    };
  }

  const sortedDiscovery = await sortFilesByMtime(
    discovery.files,
    input,
    signal,
    deadline,
  );
  const sortedFiles = sortedDiscovery.files;
  const fullStrategyMeta = {
    ...strategyMeta,
    sortedFiles: sortedFiles.length,
    replayTargetCount: sortedFiles.length,
  };

  if (input.outputMode === 'files_with_matches') {
    return finishFileListMode(
      {
        ...baseMtimeResult,
        ...fullStrategyMeta,
        truncated:
          discovery.truncated ||
          sortedDiscovery.hadMore ||
          sortedDiscovery.timedOut ||
          sortedDiscovery.cancelled,
        timedOut: discovery.timedOut || sortedDiscovery.timedOut,
        cancelled: discovery.cancelled || sortedDiscovery.cancelled,
        stderr: discovery.stderr,
        retryCount: discovery.retryCount,
        exitCode: discovery.exitCode,
        summary: undefined,
        partialPhase:
          discovery.timedOut || discovery.cancelled
            ? 'discovery'
            : sortedDiscovery.timedOut || sortedDiscovery.cancelled
              ? 'mtime-sort'
              : undefined,
      },
      sortedFiles,
      input,
      discovery.files.length > input.maxResults,
      { warnings: [...discovery.warnings, ...sortedDiscovery.warnings] },
    );
  }

  if (
    discovery.timedOut ||
    discovery.cancelled ||
    sortedDiscovery.timedOut ||
    sortedDiscovery.cancelled
  ) {
    const warnings = [...discovery.warnings, ...sortedDiscovery.warnings];
    if (discovery.files.length > 0) {
      warnings.push(
        `mtime ${sortedDiscovery.timedOut || sortedDiscovery.cancelled ? 'sorting' : 'discovery'} stopped after discovering ${discovery.files.length} candidate ${discovery.files.length === 1 ? 'file' : 'files'}.`,
      );
    }

    return {
      ...baseMtimeResult,
      ...fullStrategyMeta,
      truncated: true,
      timedOut: discovery.timedOut || sortedDiscovery.timedOut,
      cancelled: discovery.cancelled || sortedDiscovery.cancelled,
      stderr: discovery.stderr,
      warnings,
      retryCount: discovery.retryCount,
      exitCode: discovery.exitCode,
      summary: undefined,
      partialPhase:
        discovery.timedOut || discovery.cancelled ? 'discovery' : 'mtime-sort',
    };
  }

  const state = {
    collected: [] as GrepFileMatch[],
    timedOut: false,
    cancelled: false,
    limitReached: false,
    partialReplayFailure: false,
    stderr: discovery.stderr,
    warnings: [...discovery.warnings, ...sortedDiscovery.warnings],
    retryCount: discovery.retryCount,
    exitCode: discovery.exitCode,
    replayBatchCount: 0,
    replayedFiles: 0,
  };
  const runReplayAttempt = async (
    targets: string[],
    retrying = false,
  ): Promise<boolean> => {
    const scopedInput = withSearchTargets(
      input,
      targets,
      remainingTimeout(deadline),
      input.outputMode === 'count'
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, input.maxResults - countVisibleMatches(state.collected)),
    );
    state.replayBatchCount += 1;
    const partial = await executeDirectMode(scopedInput, signal, cli);
    // Discard a speculative failed batch's metadata if retries recover it.
    if (partial.error && !retrying) return false;
    state.retryCount += partial.retryCount;
    state.exitCode = Math.max(state.exitCode, partial.exitCode);
    if (partial.stderr) state.stderr = partial.stderr;
    state.warnings.push(...partial.warnings);
    if (partial.error) {
      state.partialReplayFailure = true;
      state.warnings.push(
        `Skipped mtime replay batch ${state.replayBatchCount}: ${partial.error}`,
      );
      return false;
    }
    state.timedOut ||= partial.timedOut;
    state.cancelled ||= partial.cancelled;
    state.limitReached ||= partial.limitReached;
    const reordered = reorderFilesByReplayOrder(partial.files, targets);
    state.collected.push(...reordered);
    state.replayedFiles += reordered.length;
    return true;
  };
  const noteAborted = (): boolean => {
    const kind = abortedKind(signal);
    if (kind) state[kind] = true;
    return kind !== undefined;
  };

  for (const batch of chunkArray(sortedFiles, 64)) {
    if (noteAborted()) {
      break;
    }

    if (remainingTimeout(deadline) <= 1) {
      state.timedOut = true;
      break;
    }

    const orderedTargets = batch.map((file) => file.replayPath as string);

    const batchOk = await runReplayAttempt(orderedTargets);
    if (!batchOk) {
      // A failed batch is retried file by file; attempts keep the global
      // numbering so batch warnings and replay_batch_count stay ordered.
      for (const file of batch) {
        if (noteAborted()) {
          break;
        }
        await runReplayAttempt([file.replayPath as string], true);
      }
    }

    if (
      input.outputMode === 'count'
        ? state.collected.length >= input.maxResults
        : countVisibleMatches(state.collected) >= input.maxResults
    ) {
      state.limitReached = true;
    }

    if (state.limitReached || state.timedOut || state.cancelled) {
      break;
    }
  }

  const base = createEmptyResult(input);
  const partialBase: GrepSearchResult = {
    ...base,
    ...fullStrategyMeta,
    files: state.collected,
    totalMatches:
      input.outputMode === 'count'
        ? countOccurrences(state.collected)
        : countVisibleMatches(state.collected),
    totalFiles: state.collected.length,
    truncated:
      discovery.truncated ||
      sortedDiscovery.timedOut ||
      sortedDiscovery.cancelled ||
      sortedDiscovery.hadMore ||
      state.timedOut ||
      state.cancelled ||
      state.limitReached ||
      state.partialReplayFailure,
    limitReached: state.limitReached,
    timedOut: state.timedOut,
    cancelled: state.cancelled,
    stderr: state.stderr,
    warnings: state.warnings,
    retryCount: state.retryCount,
    exitCode: state.exitCode,
    summary: undefined,
    replayBatchCount: state.replayBatchCount,
    replayedFiles: state.replayedFiles,
    partialPhase:
      state.timedOut || state.cancelled || state.partialReplayFailure
        ? 'replay'
        : undefined,
  };

  if (input.outputMode === 'count') {
    return finishFileListMode(
      partialBase,
      state.collected,
      input,
      state.limitReached || state.collected.length > input.maxResults,
      { warnings: state.warnings },
    );
  }

  return finalizeMtimeContentResult(
    input,
    state.collected,
    partialBase,
    state.limitReached,
  );
}

type StatOutcome =
  | { status: 'ok'; mtimeMs: number }
  | { status: 'error'; error: string }
  | { status: 'timed_out' }
  | { status: 'cancelled' };

type StatFile = (filePath: string) => Promise<{ mtimeMs: number }>;

async function statWithTimeout(
  filePath: string,
  stopped: Promise<StatOutcome>,
  statFile: StatFile,
): Promise<StatOutcome> {
  try {
    return await Promise.race([
      statFile(filePath).then(
        ({ mtimeMs }): StatOutcome => ({ status: 'ok', mtimeMs }),
        (error): StatOutcome => ({
          status: 'error',
          error: toErrorMessage(error),
        }),
      ),
      stopped,
    ]);
  } catch (error) {
    return { status: 'error', error: toErrorMessage(error) };
  }
}

export async function sortFilesByMtime(
  files: GrepFileMatch[],
  input: Pick<NormalizedGrepInput, 'sortOrder'>,
  signal: AbortSignal,
  deadline: number,
  statFile: StatFile = stat,
): Promise<{
  files: GrepFileMatch[];
  timedOut: boolean;
  cancelled: boolean;
  hadMore: boolean;
  warnings: string[];
}> {
  const entries: Array<{
    file: GrepFileMatch;
    mtimeMs: number;
    statFailed: boolean;
  }> = [];
  const warnings: string[] = [];
  let timedOut = false;
  let cancelled = false;
  let stop!: (outcome: StatOutcome) => void;
  const stopped = new Promise<StatOutcome>((resolve) => {
    stop = resolve;
  });
  const onAbort = () =>
    stop({ status: isTimedOutAbort(signal) ? 'timed_out' : 'cancelled' });
  const timer = setTimeout(
    () => stop({ status: 'timed_out' }),
    remainingTimeout(deadline),
  );
  signal.addEventListener('abort', onAbort, { once: true });

  const noteAborted = (): boolean => {
    const kind = abortedKind(signal);
    if (kind === 'timedOut') timedOut = true;
    if (kind === 'cancelled') cancelled = true;
    return kind !== undefined;
  };

  // Dynamic dispatch lets healthy workers stat all remaining files even if
  // another worker is stuck; the final sort restores deterministic order.
  let nextIndex = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(16, files.length) }, async () => {
        while (nextIndex < files.length) {
          if (noteAborted()) {
            return;
          }

          if (Date.now() >= deadline) {
            timedOut = true;
            return;
          }

          const file = files[nextIndex++];
          if (!file) return;
          const statResult = await statWithTimeout(
            file.replayPath as string,
            stopped,
            statFile,
          );
          if (statResult.status === 'timed_out') {
            timedOut = true;
            return;
          }

          if (statResult.status === 'cancelled') {
            cancelled = true;
            return;
          }

          if (statResult.status === 'error') {
            warnings.push(
              `Could not stat ${file.file} for mtime ordering: ${statResult.error}`,
            );
            entries.push({
              file,
              mtimeMs: Number.NEGATIVE_INFINITY,
              statFailed: true,
            });
            continue;
          }

          entries.push({
            file,
            mtimeMs: statResult.mtimeMs,
            statFailed: false,
          });
        }
      }),
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }

  entries.sort((left, right) => {
    if (left.statFailed !== right.statFailed) {
      return left.statFailed ? 1 : -1;
    }

    const delta = left.mtimeMs - right.mtimeMs;
    if (delta !== 0) {
      return input.sortOrder === 'desc' ? -delta : delta;
    }

    return comparePathBytes(left.file, right.file);
  });

  return {
    files: entries.map((entry) => entry.file),
    timedOut,
    cancelled,
    hadMore: entries.length < files.length,
    warnings,
  };
}
