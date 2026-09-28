export class AbortWaitError extends Error {
  constructor() {
    super('Search was cancelled before execution started.');
    this.name = 'AbortWaitError';
  }
}
export function createAbortError(): Error {
  return Object.assign(new Error('ripgrep auto-install was aborted'), {
    name: 'AbortError',
  });
}
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
}
/** Observe the losing operation even after cancellation or a bounded grace. */
export function raceSignal<T>(
  operation: Promise<T> | (() => Promise<T> | T),
  signal?: AbortSignal,
  options: { graceMs?: number; reason?: (signal: AbortSignal) => unknown } = {},
): Promise<T> {
  const reason = () =>
    options.reason?.(signal as AbortSignal) ??
    signal?.reason ??
    createAbortError();
  const promise = Promise.resolve().then(() => {
    if (signal?.aborted) {
      if (typeof operation === 'object') void operation.catch(() => undefined);
      throw reason();
    }
    return typeof operation === 'function' ? operation() : operation;
  });
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      const rejectAbort = () => {
        cleanup();
        reject(reason());
      };
      if ((options.graceMs ?? 0) > 0) {
        timer = setTimeout(rejectAbort, options.graceMs);
        timer.unref?.();
      } else {
        rejectAbort();
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
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
