/// <reference types="bun-types" />
import { describe, expect, jest, test } from 'bun:test';
import {
  attachTerminationHandlers,
  createFriendlySpawnError,
  killProcess,
  setAbortKind,
  spawnRipgrep,
  waitForExitAndStderr,
} from './runtime';

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnStubbornProcess() {
  return spawnRipgrep(
    [
      process.execPath,
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ],
    process.cwd(),
  );
}

describe('tools/grep/runtime process termination', () => {
  test('missing executable reports the friendly GNU grep spawn error', () => {
    const error = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    expect(
      createFriendlySpawnError(error, { backend: 'grep', path: 'grep' }),
    ).toBe(
      'grep is not available. ripgrep was unavailable or auto-install failed, and GNU grep could not be executed.',
    );
  });
  test('one escalation timer for repeated kills, SIGKILL only at 500ms and never after exit', async () => {
    jest.useFakeTimers();
    try {
      let resolveExit!: (code: number) => void;
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const proc = {
        proc: { exitCode: null, signalCode: null },
        exited: new Promise<number>((resolve) => {
          resolveExit = resolve;
        }),
        kill: (signal?: NodeJS.Signals | number) => {
          signals.push(signal);
          if (signal === 'SIGKILL') resolveExit(1);
          return true;
        },
        get exitCode() {
          return null;
        },
      } as any;
      killProcess(proc);
      killProcess(proc);
      expect(signals).toEqual([undefined]);
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(499);
      expect(signals).toEqual([undefined]);
      jest.advanceTimersByTime(1);
      expect(signals).toEqual([undefined, 'SIGKILL']);
      await proc.exited;

      let resolveEarly!: (code: number) => void;
      const earlySignals: Array<NodeJS.Signals | number | undefined> = [];
      const exited = {
        proc: { exitCode: null, signalCode: null },
        exited: new Promise<number>((resolve) => {
          resolveEarly = resolve;
        }),
        kill: (signal?: NodeJS.Signals | number) => {
          earlySignals.push(signal);
          resolveEarly(0);
          return true;
        },
        get exitCode() {
          return null;
        },
      } as any;
      killProcess(exited);
      await exited.exited;
      await Promise.resolve();
      jest.advanceTimersByTime(500);
      expect(earlySignals).toEqual([undefined]);
    } finally {
      jest.useRealTimers();
    }
  });
  test('attachTerminationHandlers escalates timeout to kill stubborn child', async () => {
    const proc = spawnStubbornProcess();
    const controller = new AbortController();
    const termination = attachTerminationHandlers(proc, 20, controller.signal);

    await proc.exited;
    await new Promise((resolve) => setTimeout(resolve, 50));
    termination.cleanup();

    expect(termination.state.timedOut).toBe(true);
    expect(termination.state.cancelled).toBe(false);
    expect(isAlive(proc.proc.pid)).toBe(false);
  });

  test('attachTerminationHandlers escalates cancel to kill stubborn child', async () => {
    const proc = spawnStubbornProcess();
    const controller = new AbortController();
    const termination = attachTerminationHandlers(
      proc,
      5_000,
      controller.signal,
    );

    controller.abort();
    await proc.exited;
    await new Promise((resolve) => setTimeout(resolve, 50));
    termination.cleanup();

    expect(termination.state.timedOut).toBe(false);
    expect(termination.state.cancelled).toBe(true);
    expect(isAlive(proc.proc.pid)).toBe(false);
  });

  test('attachTerminationHandlers preserves upstream timeout cause on abort', async () => {
    const proc = spawnStubbornProcess();
    const controller = new AbortController();
    setAbortKind(controller.signal, 'timeout');
    const termination = attachTerminationHandlers(
      proc,
      5_000,
      controller.signal,
    );

    controller.abort();
    await proc.exited;
    await new Promise((resolve) => setTimeout(resolve, 50));
    termination.cleanup();

    expect(termination.state.timedOut).toBe(true);
    expect(termination.state.cancelled).toBe(false);
    expect(isAlive(proc.proc.pid)).toBe(false);
  });

  test('killProcess escalates to kill stubborn child', async () => {
    const proc = spawnStubbornProcess();

    killProcess(proc);
    await proc.exited;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(isAlive(proc.proc.pid)).toBe(false);
  });

  test('handles a rejected process promise without creating an unhandled rejection', async () => {
    const proc = {
      proc: {
        exitCode: null,
        signalCode: null,
      },
      exited: Promise.reject(new Error('spawn failed')),
      kill: () => true,
    } as any;

    const result = await waitForExitAndStderr(proc, Promise.resolve(''));
    expect(result.error).toBe('spawn failed');
    killProcess(proc);
    await Promise.resolve();
  });
});
