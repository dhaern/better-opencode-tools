import { describe, expect, jest, spyOn, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { watchStderr } from '../tools/glob/runner-output';
import { AbortWaitError, raceSignal } from './abort';
import { capText } from './process-output';

describe('abort race', () => {
  test('returns a value without leaving a listener', async () => {
    const signal = new AbortController().signal;
    const remove = spyOn(signal, 'removeEventListener');
    expect(await raceSignal(Promise.resolve('value'), signal)).toBe('value');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    remove.mockRestore();
  });

  test('pre-aborted operations reject with the exact abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    let invoked = false;
    await expect(
      raceSignal(() => {
        invoked = true;
        return 'value';
      }, controller.signal),
    ).rejects.toBe(reason);
    expect(invoked).toBe(false);
  });

  test('aborts mid-operation, observes late rejection, and removes listener', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    const controller = new AbortController();
    const remove = spyOn(controller.signal, 'removeEventListener');
    const pending = Promise.withResolvers<number>();
    const result = raceSignal(pending.promise, controller.signal);
    controller.abort(new Error('stopped'));
    await expect(result).rejects.toThrow('stopped');
    pending.reject(new Error('late failure'));
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(unhandled).toEqual([]);
    process.removeListener('unhandledRejection', onUnhandled);
    remove.mockRestore();
  });

  test('observes a pre-aborted promise that rejects later', async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<number>();
    controller.abort(new Error('before start'));
    await expect(
      raceSignal(pending.promise, controller.signal),
    ).rejects.toThrow('before start');
    pending.reject(new Error('late rejection'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  test('keeps grace pending until its boundary then rejects', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      let settled = false;
      const result = raceSignal(
        new Promise<number>(() => undefined),
        controller.signal,
        { graceMs: 25 },
      );
      void result.catch(() => {
        settled = true;
      });
      controller.abort(new Error('deadline'));
      jest.advanceTimersByTime(24);
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      await expect(result).rejects.toThrow('deadline');
    } finally {
      jest.useRealTimers();
    }
  });

  test('AbortWaitError retains its exact message', () => {
    expect(new AbortWaitError().message).toBe(
      'Search was cancelled before execution started.',
    );
  });

  test('capped diagnostics retain exactly 8192 bytes and the native note', () => {
    expect(capText([Buffer.alloc(8192, 120)], true, 'stderr')).toBe(
      `${'x'.repeat(8192)}\n[stderr truncated at 8192 bytes]`,
    );
  });

  test('an exact 8192-byte stream is not truncated until more bytes arrive', () => {
    const stream = new PassThrough();
    const stderr = watchStderr(stream);
    stream.emit('data', Buffer.alloc(8192, 120));
    expect(stderr.read()).toBe('x'.repeat(8192));
    stream.emit('data', Buffer.from('y'));
    expect(stderr.read()).toBe(
      `${'x'.repeat(8192)}\n[stderr truncated at 8192 bytes]`,
    );
    stderr.stop();
  });
});
