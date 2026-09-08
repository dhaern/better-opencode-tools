/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  type CrossSpawnResult,
  crossSpawn,
  ensureSupervisorRuntime,
  waitForProcessOutputWithAbortGrace,
} from './compat';
import {
  CleanupUnconfirmedError,
  SupervisorRuntimeError,
  spawnSupervised,
} from './process-supervisor';

function fakeProcess() {
  const child = new EventEmitter() as unknown as ChildProcess;
  child.stdout = null;
  child.stderr = null;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const result = {
    proc: child,
    stdout: () => Promise.resolve(''),
    stderr: () => Promise.resolve(''),
    exited: new Promise<number>(() => undefined),
    kill: (signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      return true;
    },
    get exitCode() {
      return null;
    },
  } satisfies CrossSpawnResult;

  return { child, result, signals };
}

describe('utils/compat process lifecycle', () => {
  test.each([
    new SupervisorRuntimeError(),
    new CleanupUnconfirmedError('probe supervisor died'),
  ])('propagates the original infrastructure rejection from probe cleanup: %s', async (error) => {
    const { result, signals } = fakeProcess();
    await expect(
      waitForProcessOutputWithAbortGrace(
        {
          ...result,
          closed: Promise.reject(error),
        },
        Promise.resolve(''),
      ),
    ).rejects.toBe(error);
    expect(signals).toEqual([]);
  });

  test('terminates immediately when stderr rejects before the child exits', async () => {
    const { child, result, signals } = fakeProcess();
    const error = new Error('stderr pipe failed');
    const pending = waitForProcessOutputWithAbortGrace(
      result,
      Promise.reject(error),
      undefined,
      Promise.resolve(''),
      { killGraceMs: 20 },
    );

    await Promise.resolve();
    expect(signals[0]).toBe('SIGTERM');

    child.emit('close', 1, null);
    await expect(pending).rejects.toBe(error);
  });

  test('does not treat a process error as a close event', async () => {
    const { child, result, signals } = fakeProcess();
    const error = new Error('spawn failed');
    let settled = false;
    const pending = waitForProcessOutputWithAbortGrace(
      result,
      Promise.resolve(''),
      undefined,
      Promise.resolve(''),
      { killGraceMs: 20 },
    ).finally(() => {
      settled = true;
    });

    child.emit('error', error);
    await Promise.resolve();
    expect(signals[0]).toBe('SIGTERM');
    expect(settled).toBe(false);

    child.emit('close', null, null);
    await expect(pending).rejects.toBe(error);
  });

  test('settles after SIGKILL when a descendant keeps pipes open', async () => {
    const { result, signals } = fakeProcess();
    const controller = new AbortController();
    const pending = waitForProcessOutputWithAbortGrace(
      result,
      Promise.resolve(''),
      controller.signal,
      Promise.resolve(''),
      { killGraceMs: 10 },
    );

    controller.abort();
    await expect(pending).resolves.toMatchObject({ aborted: true });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('observes stdout errors immediately as well as stderr errors', async () => {
    const { child, result, signals } = fakeProcess();
    const error = new Error('stdout pipe failed');
    const pending = waitForProcessOutputWithAbortGrace(
      result,
      Promise.resolve(''),
      undefined,
      Promise.reject(error),
      { killGraceMs: 20 },
    );
    await Promise.resolve();
    expect(signals).toEqual(['SIGTERM']);
    child.emit('close', 1, null);
    await expect(pending).rejects.toBe(error);
  });
});

const node = process.versions.bun ? 'node' : process.execPath;

async function ready(proc: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let text = '';
    proc.stdout?.on('data', (chunk) => {
      text += chunk.toString();
      if (text.includes('READY\n')) resolve();
    });
    proc.once('error', reject);
    proc.once('exit', () => reject(new Error('Exited before READY')));
  });
}

describe.skipIf(process.platform === 'win32')(
  'POSIX private supervisor',
  () => {
    test('rejects bare supervisor death even after a successful taskExit', async () => {
      const child = spawnSupervised([node, '-e', 'process.exit(0)']);
      expect((await child.exited).code).toBe(0);
      child.proc.kill('SIGKILL');
      await expect(child.closed).rejects.toBeInstanceOf(
        CleanupUnconfirmedError,
      );
      await expect(child.release()).rejects.toBeInstanceOf(
        CleanupUnconfirmedError,
      );
      expect(child.kill('SIGKILL')).toBe(false);
    });

    test('a requested stop does not turn unexpected SIGKILL into confirmed cleanup', async () => {
      const child = spawnSupervised([node, '-e', 'process.exit(0)']);
      await child.exited;
      child.proc.kill('SIGSTOP');
      const stopped = child.stop(0);
      child.proc.kill('SIGKILL');
      await expect(stopped).rejects.toBeInstanceOf(CleanupUnconfirmedError);
    });

    test('cleanup rejection settles the wait even without task exit or output settlement', async () => {
      const { result, signals, child } = fakeProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const error = new CleanupUnconfirmedError('supervisor died');
      const pending = new Promise<string>(() => undefined);
      await expect(
        waitForProcessOutputWithAbortGrace(
          {
            ...result,
            closed: Promise.reject(error),
          },
          pending,
          undefined,
          pending,
        ),
      ).rejects.toBe(error);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(signals).toEqual([]);
    });

    test.each([
      'stop',
      'release',
    ] as const)('parent wait watchdog bounds an unresponsive %s without PID fallback', async (operation) => {
      const { result, signals, child } = fakeProcess();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      const never = new Promise<void>(() => undefined);
      let requested = false;
      const supervised: CrossSpawnResult = {
        ...result,
        exited: operation === 'release' ? Promise.resolve(0) : result.exited,
        closed: never,
        [operation]: () => {
          requested = true;
          return never;
        },
      };
      const controller = new AbortController();
      const output =
        operation === 'release'
          ? Promise.resolve('')
          : new Promise<string>(() => undefined);
      const pending = waitForProcessOutputWithAbortGrace(
        supervised,
        output,
        controller.signal,
        output,
        {
          killGraceMs: 0,
          cleanupTimeoutMs: 20,
        },
      );
      if (operation === 'stop') controller.abort();
      await expect(pending).rejects.toBeInstanceOf(CleanupUnconfirmedError);
      expect(requested).toBe(true);
      expect(stdout.destroyed).toBe(true);
      expect(stderr.destroyed).toBe(true);
      expect(signals).toEqual([]);
    });

    test('standalone stop has a parent watchdog when the real supervisor is SIGSTOPped', async () => {
      const child = crossSpawn(
        [
          node,
          '-e',
          'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);',
        ],
        { killGraceMs: 0, cleanupTimeoutMs: 30 },
      );
      const transportExited = new Promise<void>((resolve) =>
        child.proc.once('exit', () => resolve()),
      );
      try {
        await ready(child.proc);
        expect(child.proc.kill('SIGSTOP')).toBe(true);
        await expect(child.stop?.(0)).rejects.toBeInstanceOf(
          CleanupUnconfirmedError,
        );
        expect(child.proc.stdout?.destroyed).toBe(true);
        expect(child.proc.stderr?.destroyed).toBe(true);
        // Timeout is not a claim that the stopped supervisor was killed.
        expect(child.proc.signalCode).toBeNull();
        await expect(
          waitForProcessOutputWithAbortGrace(child, child.stderr()),
        ).rejects.toBeInstanceOf(CleanupUnconfirmedError);
      } finally {
        // Test-only resumption of our unreaped ChildProcess allows its queued
        // stop/disconnect cleanup to run; production never sends this signal.
        child.proc.kill('SIGCONT');
        await transportExited;
      }
    });

    test.skipIf(!process.versions.bun)(
      'reports missing auxiliary Node as infrastructure, not a task failure',
      async () => {
        await expect(
          ensureSupervisorRuntime(
            undefined,
            '/definitely-missing-betterglob-node',
          ),
        ).rejects.toBeInstanceOf(SupervisorRuntimeError);
        const child = spawnSupervised([node, '-e', 'process.exit(0)'], {
          supervisorExecutable: '/definitely-missing-betterglob-node',
        });
        await expect(child.exited).rejects.toBeInstanceOf(
          SupervisorRuntimeError,
        );
        await expect(child.closed).rejects.toBeInstanceOf(
          CleanupUnconfirmedError,
        );
      },
    );

    test('separates taskExit, output EOF and normal supervisor release', async () => {
      const argument = 'literal $(exit 91); "quoted"\nnext line';
      const child = spawnSupervised([
        node,
        '-e',
        'process.stdout.write(process.argv[1]); process.exitCode = 23;',
        argument,
      ]);
      let output = '';
      child.proc.stdout?.on('data', (chunk) => {
        output += chunk.toString();
      });
      const eof = new Promise<void>((resolve) =>
        child.proc.stdout?.once('end', resolve),
      );
      let cleaned = false;
      void child.closed.then(() => {
        cleaned = true;
      });
      try {
        expect((await child.exited).code).toBe(23);
        await eof;
        expect(output).toBe(argument);
        expect(child.exitCode).toBe(23);
        expect(cleaned).toBe(false);
        await child.release();
        expect(child.proc.exitCode).toBeNull();
        expect(child.proc.signalCode).toBe('SIGKILL');
        // A stale capability never falls back to signalling a saved PID/PGID.
        expect(child.kill('SIGKILL')).toBe(false);
        await child.stop(0);
      } finally {
        await child.stop(0);
      }
    });

    test('crossSpawn collects from launch, caches promises and releases automatically', async () => {
      const child = crossSpawn([
        node,
        '-e',
        'process.stdout.write("out"); process.stderr.write("err");',
      ]);
      try {
        expect(await child.exited).toBe(0);
        await child.closed;
        expect(child.stdout()).toBe(child.stdout());
        expect(await child.stdout()).toBe('out');
        expect(await child.stderr()).toBe('err');
        expect(child.proc.exitCode).toBeNull();
        expect(child.proc.signalCode).toBe('SIGKILL');
        const result = await waitForProcessOutputWithAbortGrace(
          child,
          child.stderr(),
          undefined,
          child.stdout(),
        );
        expect(result).toMatchObject({
          exitCode: 0,
          stdout: 'out',
          stderr: 'err',
          aborted: false,
        });
      } finally {
        await child.stop?.(0);
      }
    });

    test('abort retains the supervisor through grace even when the task exits on TERM', async () => {
      const descendant =
        'process.on("SIGTERM", () => {}); process.stdout.write("READY\\n"); setInterval(() => {}, 1000);';
      const child = crossSpawn(
        [
          node,
          '-e',
          `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => process.exit(0));
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.once('data', () => process.stdout.write('READY\\n'));
    `,
        ],
        { killGraceMs: 150 },
      );
      const controller = new AbortController();
      let cleaned = false;
      void child.closed?.then(() => {
        cleaned = true;
      });
      try {
        await ready(child.proc);
        const pending = waitForProcessOutputWithAbortGrace(
          child,
          child.stderr(),
          controller.signal,
          child.stdout(),
          { killGraceMs: 150 },
        );
        controller.abort();
        expect(await child.exited).toBe(0);
        expect(cleaned).toBe(false);
        expect(await pending).toMatchObject({ aborted: true, exitCode: 0 });
        expect(cleaned).toBe(true);
        expect(child.proc.signalCode).toBe('SIGKILL');
      } finally {
        await child.stop?.(0);
      }
    });

    test('already-aborted calls cannot release the supervisor before cleanup', async () => {
      const child = crossSpawn([node, '-e', 'setInterval(() => {}, 1000);'], {
        killGraceMs: 20,
      });
      const controller = new AbortController();
      controller.abort();
      try {
        const result = await waitForProcessOutputWithAbortGrace(
          child,
          child.stderr(),
          controller.signal,
          child.stdout(),
          { killGraceMs: 20 },
        );
        expect(result.aborted).toBe(true);
        expect(child.proc.signalCode).toBe('SIGKILL');
      } finally {
        await child.stop?.(0);
      }
    });

    test('disconnecting private IPC initiates cleanup but cannot confirm it', async () => {
      const child = spawnSupervised(
        [
          node,
          '-e',
          'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);',
        ],
        { killGraceMs: 30 },
      );
      const transportExited = new Promise<void>((resolve) =>
        child.proc.once('exit', () => resolve()),
      );
      try {
        await ready(child.proc);
        child.proc.disconnect();
        await expect(child.closed).rejects.toBeInstanceOf(
          CleanupUnconfirmedError,
        );
        await transportExited;
        expect(child.proc.signalCode).toBe('SIGKILL');
        await expect(child.exited).rejects.toBeInstanceOf(
          CleanupUnconfirmedError,
        );
      } finally {
        await child.stop(0).catch(() => undefined);
      }
    });

    test('bounds post-task drain when a descendant inherits output', async () => {
      const child = crossSpawn(
        [
          node,
          '-e',
          `
      require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }).unref();
      process.stdout.write('partial');
    `,
        ],
        { killGraceMs: 30, postExitDrainMs: 20 },
      );
      try {
        expect(await child.exited).toBe(0);
        expect(await child.stdout()).toBe('partial');
        await child.closed;
        expect(child.proc.signalCode).toBe('SIGKILL');
      } finally {
        await child.stop?.(0);
      }
    });

    test.each([
      'stdout',
      'stderr',
    ] as const)('observes an early %s stream error and cleans up', async (stream) => {
      const child = crossSpawn(
        [
          node,
          '-e',
          'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);',
        ],
        { killGraceMs: 30 },
      );
      const error = new Error(`${stream} failed before collection`);
      try {
        await ready(child.proc);
        child.proc[stream]?.emit('error', error);
        // No stdout()/stderr()/wait call until after the rejection microtask.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const pending = waitForProcessOutputWithAbortGrace(
          child,
          child.stderr(),
          undefined,
          child.stdout(),
          { killGraceMs: 30 },
        );
        await expect(pending).rejects.toBe(error);
        expect(child.proc.signalCode).toBe('SIGKILL');
      } finally {
        await child.stop?.(0);
      }
    });

    test('reports task spawn errors over IPC, without an unobserved rejection', async () => {
      const child = crossSpawn(['/definitely-missing-betterglob-command'], {
        killGraceMs: 10,
      });
      try {
        await child.closed;
        await expect(
          waitForProcessOutputWithAbortGrace(
            child,
            child.stderr(),
            undefined,
            child.stdout(),
            { killGraceMs: 10 },
          ),
        ).rejects.toThrow('ENOENT');
      } finally {
        await child.stop?.(0);
      }
    });
  },
);
