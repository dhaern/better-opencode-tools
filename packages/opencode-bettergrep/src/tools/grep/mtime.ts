import { stat } from 'node:fs/promises';
import { MAX_MTIME_DISCOVERY_FILES } from './constants';
import {
  executeContentLikeMode,
  executeCountMode,
  executeFilesMode,
} from './direct';
import { finishFileListMode } from './fallback-results';
import type { ResolvedGrepCli } from './resolver';
import {
  countOccurrences,
  countVisibleMatches,
  createEmptyResult,
  finalizeMtimeContentResult,
} from './result-utils';
import { buildRgCommand } from './rg-args';
import {
  getAbortKind,
  isTimedOutAbort,
  remainingTimeout,
  toErrorMessage,
} from './runtime';
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

interface ReplayState {
  collected: GrepFileMatch[];
  timedOut: boolean;
  cancelled: boolean;
  limitReached: boolean;
  partialReplayFailure: boolean;
  stderr: string;
  warnings: string[];
  retryCount: number;
  exitCode: number;
  replayBatchCount: number;
  replayedFiles: number;
}

async function runReplayAttempt(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
  deadline: number,
  targets: string[],
  state: ReplayState,
): Promise<boolean> {
  const scopedInput = withSearchTargets(
    input,
    targets,
    remainingTimeout(deadline),
    input.outputMode === 'count'
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, input.maxResults - countVisibleMatches(state.collected)),
  );
  state.replayBatchCount += 1;
  const partial =
    input.outputMode === 'count'
      ? await executeCountMode(scopedInput, signal, cli)
      : await executeContentLikeMode(scopedInput, signal, cli);

  state.retryCount += partial.retryCount;
  state.exitCode = Math.max(state.exitCode, partial.exitCode);
  if (partial.stderr) {
    state.stderr = partial.stderr;
  }
  state.warnings.push(...partial.warnings);
  if (partial.error) {
    state.partialReplayFailure = true;
    state.warnings.push(
      `Skipped mtime replay batch ${state.replayBatchCount}: ${partial.error}`,
    );
    return false;
  }

  state.timedOut = state.timedOut || partial.timedOut;
  state.cancelled = state.cancelled || partial.cancelled;
  state.limitReached = state.limitReached || partial.limitReached;
  const reordered = reorderFilesByReplayOrder(partial.files, targets);
  state.collected.push(...reordered);
  state.replayedFiles += reordered.length;
  return true;
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
  const order = new Map<string, number>();
  orderedTargets.forEach((target, index) => {
    order.set(target, index);
  });

  return [...files].sort((left, right) => {
    const leftOrder =
      order.get(left.replayPath ?? left.absolutePath) ??
      Number.MAX_SAFE_INTEGER;
    const rightOrder =
      order.get(right.replayPath ?? right.absolutePath) ??
      Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}

async function discoverMatchingFiles(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  const discoveryInput = buildDiscoveryInput(input);
  const result = await executeFilesMode(discoveryInput, signal, cli);

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
  const discovery = await discoverMatchingFiles(input, signal, cli);
  const discoveryInput = buildDiscoveryInput(input);
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
    const fallback =
      input.outputMode === 'files_with_matches'
        ? await executeFilesMode(fallbackInput, signal, cli)
        : input.outputMode === 'count'
          ? await executeCountMode(fallbackInput, signal, cli)
          : await executeContentLikeMode(fallbackInput, signal, cli);

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
    replayTargetCount: sortedFiles.filter((file) => file.replayPath).length,
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
      {
        timedOut: discovery.timedOut || sortedDiscovery.timedOut,
        cancelled: discovery.cancelled || sortedDiscovery.cancelled,
      },
      discovery.exitCode,
      discovery.stderr,
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

  const state: ReplayState = {
    collected: [],
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
  const replayableFiles = sortedFiles.filter((file) => {
    if (file.replayPath) {
      return true;
    }
    state.partialReplayFailure = true;
    state.warnings.push(
      `Skipped ${file.file} during mtime replay: non-UTF8 paths are not replayable safely.`,
    );
    return false;
  });
  const noteAborted = (): boolean => {
    if (!signal.aborted) {
      return false;
    }
    if (getAbortKind(signal) === 'timeout') {
      state.timedOut = true;
    } else {
      state.cancelled = true;
    }
    return true;
  };

  for (const batch of chunkArray(replayableFiles, 64)) {
    if (noteAborted()) {
      break;
    }

    if (remainingTimeout(deadline) <= 1) {
      state.timedOut = true;
      break;
    }

    const orderedTargets = batch
      .map((file) => file.replayPath)
      .filter((value): value is string => Boolean(value));
    if (orderedTargets.length === 0) {
      continue;
    }

    const batchOk = await runReplayAttempt(
      input,
      signal,
      cli,
      deadline,
      orderedTargets,
      state,
    );
    if (!batchOk) {
      // A failed batch is retried file by file; attempts keep the global
      // numbering so batch warnings and replay_batch_count stay ordered.
      for (const file of batch) {
        if (noteAborted()) {
          break;
        }
        const target = file.replayPath;
        if (!target) {
          continue;
        }
        await runReplayAttempt(input, signal, cli, deadline, [target], state);
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
      { timedOut: state.timedOut, cancelled: state.cancelled },
      state.exitCode,
      state.stderr,
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

async function statWithTimeout(
  filePath: string,
  signal: AbortSignal,
  deadline: number,
): Promise<StatOutcome> {
  if (signal.aborted) {
    return { status: isTimedOutAbort(signal) ? 'timed_out' : 'cancelled' };
  }

  const timeoutMs = remainingTimeout(deadline);
  if (timeoutMs <= 1) {
    return { status: 'timed_out' };
  }

  const timeoutSentinel = Symbol('grep-stat-timeout');
  const cancelSentinel = Symbol('grep-stat-cancel');
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortCleanup: (() => void) | undefined;

  try {
    const stats = await Promise.race([
      stat(filePath),
      new Promise<typeof timeoutSentinel>((resolve) => {
        timeoutId = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
      }),
      new Promise<typeof cancelSentinel>((resolve) => {
        const onAbort = () => resolve(cancelSentinel);
        signal.addEventListener('abort', onAbort, { once: true });
        abortCleanup = () => signal.removeEventListener('abort', onAbort);
      }),
    ]);

    if (stats === timeoutSentinel) {
      return { status: 'timed_out' };
    }

    if (stats === cancelSentinel) {
      return { status: isTimedOutAbort(signal) ? 'timed_out' : 'cancelled' };
    }

    return { status: 'ok', mtimeMs: stats.mtimeMs };
  } catch (error) {
    return { status: 'error', error: toErrorMessage(error) };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    abortCleanup?.();
  }
}

export async function sortFilesByMtime(
  files: GrepFileMatch[],
  input: Pick<NormalizedGrepInput, 'sortOrder'>,
  signal: AbortSignal,
  deadline: number,
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

  const noteAborted = (): boolean => {
    if (!signal.aborted) {
      return false;
    }
    if (isTimedOutAbort(signal)) {
      timedOut = true;
    } else {
      cancelled = true;
    }
    return true;
  };

  // Up to 16 files stat concurrently; the final sort below restores order.
  const chunks = chunkArray(files, Math.max(1, Math.ceil(files.length / 16)));
  await Promise.all(
    chunks.map(async (chunk) => {
      for (const file of chunk) {
        if (noteAborted()) {
          return;
        }

        if (Date.now() >= deadline) {
          timedOut = true;
          return;
        }

        if (!file.replayPath) {
          warnings.push(
            `Could not stat ${file.file} for mtime ordering: non-UTF8 paths are not orderable safely.`,
          );
          entries.push({
            file,
            mtimeMs: Number.NEGATIVE_INFINITY,
            statFailed: true,
          });
          continue;
        }

        const statResult = await statWithTimeout(
          file.replayPath,
          signal,
          deadline,
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

        entries.push({ file, mtimeMs: statResult.mtimeMs, statFailed: false });
      }
    }),
  );

  entries.sort((left, right) => {
    if (left.statFailed !== right.statFailed) {
      return left.statFailed ? 1 : -1;
    }

    const delta = left.mtimeMs - right.mtimeMs;
    if (delta !== 0) {
      return input.sortOrder === 'desc' ? -delta : delta;
    }

    return left.file.file.localeCompare(right.file.file);
  });

  return {
    files: entries.map((entry) => entry.file),
    timedOut,
    cancelled,
    hadMore: entries.length < files.length,
    warnings,
  };
}
