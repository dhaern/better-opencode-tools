import type { Effect } from 'effect';

// OpenCode ≤1.15 returns permission asks as Effects, newer hosts as Promises;
// both must settle (and fail closed) before the tool continues.
export async function runOpenCodeSideEffect(value: unknown): Promise<void> {
  const { Effect: runtime } = await import('effect');
  if (runtime.isEffect(value)) {
    await runtime.runPromise(value as Effect.Effect<unknown>);
  } else {
    await value;
  }
}
