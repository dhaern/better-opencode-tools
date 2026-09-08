import { performance } from 'node:perf_hooks';
import { DEFAULT_GLOB_TIMEOUT_MS } from './constants';
import { MAX_TIMEOUT_MS } from './normalize';
import { DEFAULT_CLEANUP_WAIT_MS } from './supervised-search';

export const TIMEOUT_ERROR_MESSAGE =
  'glob search exceeded its automatic deadline.';
// The runner has an independent TERM grace, supervisor watchdog and output
// drain phase. The small margin lets the outer promise observe that bounded
// result instead of rejecting first due to timer scheduling.
const RUNNER_ABORT_GRACE_MS = DEFAULT_CLEANUP_WAIT_MS + 250;

/** Measures automatic work and aborts pending preparation when it expires. */
export class AutoClock {
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

export async function withHumanPause<T>(
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

export function timeoutBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_GLOB_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
}

export function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('glob search was aborted.');
  error.name = 'AbortError';
  return error;
}

export function raceAbort<T>(
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

export function runWithDeadline<T>(
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
