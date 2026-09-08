import { stat } from 'node:fs/promises';
import { isTimedOutAbort, remainingTimeout } from './runtime';
import type { GrepFileMatch, NormalizedGrepInput } from './types';

function formatStatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function statWithTimeout(
  filePath: string,
  signal: AbortSignal,
  deadline: number,
): Promise<
  | { status: 'ok'; mtimeMs: number }
  | { status: 'error'; error: string }
  | { status: 'timed_out' }
  | { status: 'cancelled' }
> {
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
    return { status: 'error', error: formatStatError(error) };
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
  let index = 0;
  let processedCount = 0;
  let timedOut = false;
  let cancelled = false;

  const workers = Array.from(
    { length: Math.max(1, Math.min(16, files.length)) },
    async () => {
      while (true) {
        if (signal.aborted) {
          if (isTimedOutAbort(signal)) {
            timedOut = true;
          } else {
            cancelled = true;
          }
          return;
        }

        if (Date.now() >= deadline) {
          timedOut = true;
          return;
        }

        const current = index;
        index += 1;
        if (current >= files.length) {
          return;
        }

        const file = files[current] as GrepFileMatch;
        if (!file.replayPath) {
          warnings.push(
            `Could not stat ${file.file} for mtime ordering: non-UTF8 paths are not orderable safely.`,
          );
          entries.push({
            file,
            mtimeMs: Number.NEGATIVE_INFINITY,
            statFailed: true,
          });
          processedCount += 1;
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
          processedCount += 1;
          continue;
        }

        entries.push({ file, mtimeMs: statResult.mtimeMs, statFailed: false });
        processedCount += 1;
      }
    },
  );

  await Promise.all(workers);

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
    hadMore: processedCount < files.length,
    warnings,
  };
}
