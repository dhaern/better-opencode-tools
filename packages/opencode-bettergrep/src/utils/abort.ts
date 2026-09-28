/** Preserve the caller's error type and message at each abort boundary. */
export class AbortWaitError extends Error {}

export function createSearchAbortError(): AbortWaitError {
  return new AbortWaitError('Search was cancelled before execution started.');
}

export function createAbortError(
  message = 'ripgrep auto-install was aborted',
): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(
  signal?: AbortSignal,
  errorFactory: () => Error = createAbortError,
): void {
  if (signal?.aborted) throw errorFactory();
}
