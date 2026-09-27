import { Effect } from 'effect';

export type MaybeEffect<T> = T | Promise<T> | Effect.Effect<T>;

export async function resolveOpenCodeEffect<T>(
  value: MaybeEffect<T>,
): Promise<T> {
  if (!Effect.isEffect(value)) return Promise.resolve(value);

  return Effect.runPromise(value);
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
