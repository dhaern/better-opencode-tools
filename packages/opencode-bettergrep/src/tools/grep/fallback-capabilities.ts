import { probeExecutable } from './cli-probe';
import {
  AbortWaitError,
  isTransientFailure,
  isTransientStderr,
} from './runtime';

interface GnuGrepCheckResult {
  error?: string;
  cacheable: boolean;
}

interface GnuGrepCheckEntry {
  promise: Promise<GnuGrepCheckResult>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

const GNU_GREP_CACHE = new Map<string, GnuGrepCheckEntry>();

function isAbortLikeFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('cancelled') ||
    message.includes('canceled')
  );
}

function shouldCacheGnuGrepFailure(
  error: unknown,
  stderr?: string,
  firstLine?: string,
): boolean {
  if (isTransientFailure(error) || isAbortLikeFailure(error)) {
    return false;
  }

  if (stderr && isTransientStderr(stderr)) {
    return false;
  }

  if (firstLine !== undefined && firstLine.length === 0) {
    return false;
  }

  return true;
}

async function checkGnuGrep(
  binaryPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GnuGrepCheckResult> {
  const probe = await probeExecutable(
    binaryPath,
    ['--version'],
    signal,
    timeoutMs,
  );

  if (probe.timedOut) {
    return {
      error: 'GNU grep validation timed out.',
      cacheable: false,
    };
  }

  const stdout = probe.stdout.trim();
  const { exitCode, stderr } = probe;

  if (exitCode !== 0) {
    const error =
      stderr || `grep --version exited with code ${String(exitCode)}`;
    return {
      error,
      cacheable: shouldCacheGnuGrepFailure(undefined, stderr),
    };
  }

  const firstLine = stdout.split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine.includes('GNU grep')) {
    return {
      error:
        firstLine.length > 0
          ? 'System grep fallback requires GNU grep; the detected grep is not GNU grep.'
          : 'System grep fallback could not validate GNU grep version output.',
      cacheable: shouldCacheGnuGrepFailure(undefined, undefined, firstLine),
    };
  }

  return {
    cacheable: true,
  };
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new AbortWaitError('Search was cancelled before execution started.'),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        new AbortWaitError('Search was cancelled before execution started.'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function ensureGnuGrep(
  binaryPath: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string | undefined> {
  let entry = GNU_GREP_CACHE.get(binaryPath);

  if (!entry) {
    const controller = new AbortController();
    const created: GnuGrepCheckEntry = {
      controller,
      waiters: 0,
      settled: false,
      promise: checkGnuGrep(binaryPath, timeoutMs, controller.signal),
    };
    created.promise = created.promise.then(
      (result) => {
        created.settled = true;
        if (!result.cacheable && GNU_GREP_CACHE.get(binaryPath) === created) {
          GNU_GREP_CACHE.delete(binaryPath);
        }
        return result;
      },
      (error) => {
        created.settled = true;
        if (GNU_GREP_CACHE.get(binaryPath) === created) {
          GNU_GREP_CACHE.delete(binaryPath);
        }
        throw error;
      },
    );
    // Early waiters can abandon the shared check; keep its rejection handled.
    void created.promise.catch(() => undefined);
    GNU_GREP_CACHE.set(binaryPath, created);
    entry = created;
  }

  entry.waiters += 1;
  try {
    return (await raceWithAbort(entry.promise, signal)).error;
  } finally {
    entry.waiters = Math.max(0, entry.waiters - 1);
    if (entry.waiters === 0 && !entry.settled) {
      // Remove the entry BEFORE aborting so a new caller cannot join a check
      // that is already being cancelled.
      if (GNU_GREP_CACHE.get(binaryPath) === entry) {
        GNU_GREP_CACHE.delete(binaryPath);
      }
      entry.controller.abort();
    }
  }
}
