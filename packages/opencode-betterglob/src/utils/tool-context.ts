import type { Effect } from 'effect';

export type MaybeEffect<T> = T | Promise<T> | Effect.Effect<T, unknown>;

export async function resolveOpenCodeEffect<T>(
  value: MaybeEffect<T>,
): Promise<T> {
  if (typeof value !== 'object' || value === null) return value as T;
  if ('then' in value && typeof value.then === 'function')
    return (await value) as T;
  const { Effect: runtime } = await import('effect');
  return runtime.isEffect(value) ? runtime.runPromise(value) : (value as T);
}

export async function runOpenCodeSideEffect<T>(
  value: MaybeEffect<T>,
): Promise<void> {
  await resolveOpenCodeEffect(value);
}

export async function runBestEffortOpenCodeSideEffect<T>(
  value: MaybeEffect<T>,
): Promise<void> {
  try {
    await runOpenCodeSideEffect(value);
  } catch {
    // Best-effort side effects must not affect tool execution.
  }
}
