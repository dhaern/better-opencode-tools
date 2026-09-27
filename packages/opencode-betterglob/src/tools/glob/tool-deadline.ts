import { performance } from 'node:perf_hooks';
import { raceSignal } from '../../utils/abort';
import { DEFAULT_GLOB_TIMEOUT_MS } from './constants';
import { MAX_TIMEOUT_MS } from './normalize';
import { DEFAULT_CLEANUP_WAIT_MS } from './supervised-search';

export const TIMEOUT_ERROR_MESSAGE =
  'glob search exceeded its automatic deadline.';
// Allow the runner's TERM/watchdog/drain to settle before the outer deadline.
export const RUNNER_ABORT_GRACE_MS = DEFAULT_CLEANUP_WAIT_MS + 250;

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
  return raceSignal(operation, signal, { reason: abortReason });
}
