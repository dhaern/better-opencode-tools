/// <reference types="bun-types" />
import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { runOpenCodeSideEffect } from './opencode-effects';

test('runOpenCodeSideEffect fails closed on OpenCode InstanceRef bridge failures', async () => {
  await expect(
    runOpenCodeSideEffect(
      Effect.fail(
        new Error('Service not found: InstanceRef not provided'),
      ) as never,
    ),
  ).rejects.toThrow('InstanceRef not provided');
});

test('runOpenCodeSideEffect keeps non-InstanceRef failures visible', async () => {
  await expect(
    runOpenCodeSideEffect(Effect.fail(new Error('permission denied')) as never),
  ).rejects.toThrow('permission denied');
});
