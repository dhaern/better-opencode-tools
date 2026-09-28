import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { resolveOpenCodeEffect } from './opencode-effects';

test('resolves plain, promise, and Effect values with the bundled effect', async () => {
  expect(await resolveOpenCodeEffect(1)).toBe(1);
  expect(await resolveOpenCodeEffect(Promise.resolve(2))).toBe(2);
  expect(await resolveOpenCodeEffect(Effect.succeed(3))).toBe(3);
});
