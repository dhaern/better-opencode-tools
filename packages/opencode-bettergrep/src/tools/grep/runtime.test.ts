/// <reference types="bun-types" />
import { describe, expect, jest, test } from 'bun:test';
import { Readable } from 'node:stream';
import { executeMode } from './direct';
import { consumeRgJsonStream } from './json-stream';
import { normalizeGrepInput } from './normalize';
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
  function stubStubbornProcess() {
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
    return { proc, signals };
  }

  test('attachTerminationHandlers escalates timeout to kill stubborn child', async () => {
    jest.useFakeTimers();
    try {
      const { proc, signals } = stubStubbornProcess();
      const controller = new AbortController();
      const termination = attachTerminationHandlers(
        proc,
        20,
        controller.signal,
      );

      const done = proc.exited;
      jest.advanceTimersByTime(20);
      await Promise.resolve();
      expect(signals).toEqual([undefined]);
      jest.advanceTimersByTime(500);
      await done;
      termination.cleanup();

      expect(termination.state.timedOut).toBe(true);
      expect(termination.state.cancelled).toBe(false);
      expect(signals).toEqual([undefined, 'SIGKILL']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('attachTerminationHandlers escalates cancel to kill stubborn child', async () => {
    jest.useFakeTimers();
    try {
      const { proc, signals } = stubStubbornProcess();
      const controller = new AbortController();
      const termination = attachTerminationHandlers(
        proc,
        5_000,
        controller.signal,
      );

      controller.abort();
      const done = proc.exited;
      await Promise.resolve();
      expect(signals).toEqual([undefined]);
      jest.advanceTimersByTime(500);
      await done;
      termination.cleanup();

      expect(termination.state.timedOut).toBe(false);
      expect(termination.state.cancelled).toBe(true);
      expect(signals).toEqual([undefined, 'SIGKILL']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('attachTerminationHandlers preserves upstream timeout cause on abort', async () => {
    jest.useFakeTimers();
    try {
      const { proc, signals } = stubStubbornProcess();
      const controller = new AbortController();
      setAbortKind(controller.signal, 'timeout');
      const termination = attachTerminationHandlers(
        proc,
        5_000,
        controller.signal,
      );

      controller.abort();
      const done = proc.exited;
      await Promise.resolve();
      expect(signals).toEqual([undefined]);
      jest.advanceTimersByTime(500);
      await done;
      termination.cleanup();

      expect(termination.state.timedOut).toBe(true);
      expect(termination.state.cancelled).toBe(false);
      expect(signals).toEqual([undefined, 'SIGKILL']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('killProcess escalates to kill stubborn child', async () => {
    const proc = spawnStubbornProcess();

    killProcess(proc);
    await proc.exited;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(isAlive(proc.proc.pid)).toBe(false);
  });

  test('handles a rejected process promise without creating an unhandled rejection', async () => {
    const failure = Object.assign(new Error('spawn failed'), {
      code: 'EMFILE',
    });
    const proc = {
      proc: {
        exitCode: null,
        signalCode: null,
      },
      exited: Promise.reject(failure),
      kill: () => true,
    } as any;

    const result = await waitForExitAndStderr(proc, Promise.resolve(''));
    expect(result.error).toBe(failure);
    killProcess(proc);
    await Promise.resolve();
  });

  test('classifies asynchronous ENOENT and EMFILE exits in direct execution', async () => {
    const input = normalizeGrepInput({ pattern: 'needle', path: '.' }, {
      directory: process.cwd(),
      worktree: process.cwd(),
    } as never);
    const cli = {
      path: '/definitely-not-installed/rg',
      backend: 'rg' as const,
      source: 'system-rg' as const,
    };
    const options = {
      init: () => ({}),
      consumeStdout: async () => {},
      buildResult: (result: any) => result,
      isStopped: () => false,
    };
    const missing = await executeMode(
      input,
      new AbortController().signal,
      cli,
      options,
    );
    expect(missing.error).toBe(
      'rg is not available. Install ripgrep or allow the managed ripgrep installer to run.',
    );

    const failure = Object.assign(new Error('too many files'), {
      code: 'EMFILE',
    });
    const proc = {
      proc: { stdout: null, stderr: null, exitCode: null, signalCode: null },
      exited: Promise.reject(failure),
      kill: () => true,
    };
    await expect(
      executeMode(input, new AbortController().signal, cli, {
        ...options,
        spawn: () => proc as never,
      }),
    ).rejects.toThrow('too many files');
  });

  test('an infinite malformed stdout pipe ends without timing out after cancellation', async () => {
    let sent = false;
    const stdout = new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push('not JSON\n');
        }
      },
    });
    const input = normalizeGrepInput({ pattern: 'needle', path: '.' }, {
      directory: process.cwd(),
      worktree: process.cwd(),
    } as never);
    const result = await executeMode(
      input,
      new AbortController().signal,
      { path: 'rg', backend: 'rg', source: 'system-rg' },
      {
        spawn: () =>
          ({
            proc: { stdout, stderr: null, exitCode: 0, signalCode: null },
            exited: Promise.resolve(0),
            kill: () => true,
          }) as never,
        init: () => ({}),
        consumeStdout: (stream) => consumeRgJsonStream(stream, () => true),
        buildResult: (base) => base,
        isStopped: () => false,
      },
    );
    expect(result.error).toContain('invalid JSON');
    expect(result.timedOut).toBe(false);
    expect(stdout.destroyed).toBe(true);
  });
});
