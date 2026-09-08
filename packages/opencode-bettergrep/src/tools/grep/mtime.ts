import { MAX_MTIME_DISCOVERY_FILES } from './constants';
import {
  executeContentLikeMode,
  executeCountMode,
  executeFilesMode,
} from './direct';
import { sortFilesByMtime } from './mtime-sort';
import type { ResolvedGrepCli } from './resolver';
import {
  countOccurrences,
  countVisibleMatches,
  createEmptyResult,
  finalizeMtimeContentResult,
  finalizeMtimeSimpleResult,
} from './result-utils';
import { buildRgCommand } from './rg-args';
import { getAbortKind, remainingTimeout } from './runtime';
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
    return finalizeMtimeSimpleResult(
      input,
      sortedFiles,
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
        warnings: [...discovery.warnings, ...sortedDiscovery.warnings],
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
      discovery.files.length > input.maxResults,
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

  const collected: GrepFileMatch[] = [];
  let timedOut = false;
  let cancelled = false;
  let limitReached = false;
  let partialReplayFailure = false;
  let stderr = discovery.stderr;
  const warnings: string[] = [
    ...discovery.warnings,
    ...sortedDiscovery.warnings,
  ];
  let retryCount = discovery.retryCount;
  let exitCode = discovery.exitCode;
  let replayBatchCount = 0;
  let replayedFiles = 0;
  const replayableFiles = sortedFiles.filter((file) => {
    if (file.replayPath) {
      return true;
    }
    partialReplayFailure = true;
    warnings.push(
      `Skipped ${file.file} during mtime replay: non-UTF8 paths are not replayable safely.`,
    );
    return false;
  });

  const replayBatchSize = input.outputMode === 'content' ? 1 : 64;

  for (const batch of chunkArray(replayableFiles, replayBatchSize)) {
    if (signal.aborted) {
      if (getAbortKind(signal) === 'timeout') {
        timedOut = true;
      } else {
        cancelled = true;
      }
      break;
    }

    const timeoutMs = remainingTimeout(deadline);
    if (timeoutMs <= 1) {
      timedOut = true;
      break;
    }

    const orderedTargets = batch
      .map((file) => file.replayPath)
      .filter((value): value is string => Boolean(value));
    if (orderedTargets.length === 0) {
      continue;
    }

    const scopedInput = withSearchTargets(
      input,
      orderedTargets,
      timeoutMs,
      input.outputMode === 'count'
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, input.maxResults - countVisibleMatches(collected)),
    );
    replayBatchCount += 1;
    const partial =
      input.outputMode === 'count'
        ? await executeCountMode(scopedInput, signal, cli)
        : await executeContentLikeMode(scopedInput, signal, cli);

    retryCount += partial.retryCount;
    exitCode = Math.max(exitCode, partial.exitCode);
    if (partial.stderr) {
      stderr = partial.stderr;
    }
    warnings.push(...partial.warnings);
    if (partial.error) {
      partialReplayFailure = true;
      warnings.push(
        `Skipped mtime replay batch ${replayBatchCount}: ${partial.error}`,
      );
      continue;
    }

    timedOut = timedOut || partial.timedOut;
    cancelled = cancelled || partial.cancelled;
    limitReached = limitReached || partial.limitReached;
    const reordered = reorderFilesByReplayOrder(partial.files, orderedTargets);

    if (input.outputMode === 'count') {
      collected.push(...reordered);
      replayedFiles += reordered.length;

      if (collected.length >= input.maxResults) {
        limitReached = true;
      }

      if (limitReached || timedOut || cancelled) {
        break;
      }

      continue;
    }

    collected.push(...reordered);
    replayedFiles += reordered.length;

    const visibleMatches = countVisibleMatches(collected);
    if (visibleMatches >= input.maxResults) {
      limitReached = true;
    }

    if (limitReached || timedOut || cancelled) {
      break;
    }
  }

  const base = createEmptyResult(input);
  const partialBase: GrepSearchResult = {
    ...base,
    ...fullStrategyMeta,
    files: collected,
    totalMatches:
      input.outputMode === 'count'
        ? countOccurrences(collected)
        : countVisibleMatches(collected),
    totalFiles: collected.length,
    truncated:
      discovery.truncated ||
      sortedDiscovery.timedOut ||
      sortedDiscovery.cancelled ||
      sortedDiscovery.hadMore ||
      timedOut ||
      cancelled ||
      limitReached ||
      partialReplayFailure,
    limitReached,
    timedOut,
    cancelled,
    stderr,
    warnings,
    retryCount,
    exitCode,
    summary: undefined,
    replayBatchCount,
    replayedFiles,
    partialPhase:
      timedOut || cancelled || partialReplayFailure ? 'replay' : undefined,
  };

  if (input.outputMode === 'count') {
    return finalizeMtimeSimpleResult(
      input,
      collected,
      partialBase,
      limitReached || collected.length > input.maxResults,
    );
  }

  return finalizeMtimeContentResult(
    input,
    collected,
    partialBase,
    limitReached,
  );
}
