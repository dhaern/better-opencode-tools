/// <reference types="bun-types" />

import { describe, expect, spyOn, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  ensureSupervisorRuntime,
  type ProcessHandle,
  runProcess,
  waitForProcessOutputWithAbortGrace,
} from './process-output';
import {
  CleanupUnconfirmedError,
  type SupervisedProcess,
  SupervisorRuntimeError,
  spawnSupervised,
} from './process-supervisor';

function fakeProcess() {
  const child = new EventEmitter() as unknown as ChildProcess;
  child.stdout = null;
  child.stderr = null;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  child.kill = (signal?: NodeJS.Signals | number) => {
    signals.push(signal);
    return true;
  };
  const result = {
    proc: child,
    exited: new Promise<number>(() => undefined),
    get exitCode() {
      return null;
    },
  } satisfies ProcessHandle;

  return { child, result, signals };
}

describe('utils/process-output collection lifecycle', () => {
  test.each([
    new SupervisorRuntimeError(),
    new CleanupUnconfirmedError('probe supervisor died'),
  ])('propagates the original infrastructure rejection from probe cleanup: %s', async (error) => {
    const { result, signals } = fakeProcess();
    await expect(
      waitForProcessOutputWithAbortGrace({
        ...result,
        closed: Promise.reject(error),
      }),
    ).rejects.toBe(error);
    expect(signals).toEqual([]);
    if (error instanceof SupervisorRuntimeError) {
      const other = fakeProcess();
      const pending = waitForProcessOutputWithAbortGrace({
        ...other.result,
        closed: Promise.reject(new CleanupUnconfirmedError('cleanup failed')),
      });
      other.child.emit('error', error);
      await expect(pending).rejects.toBe(error);
    }
  });

  test('terminates immediately when stderr rejects before the child exits', async () => {
    const { child, result, signals } = fakeProcess();
    const error = new Error('stderr pipe failed');
    child.stderr = new PassThrough();
    const pending = waitForProcessOutputWithAbortGrace(result, undefined, {
      killGraceMs: 20,
    });
    child.stderr.emit('error', error);

    await Promise.resolve();
    expect(signals[0]).toBe('SIGTERM');

    child.emit('close', 1, null);
    await expect(pending).rejects.toBe(error);
  });

  test('does not treat a process error as a close event', async () => {
    const { child, result, signals } = fakeProcess();
    const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    let settled = false;
    const pending = waitForProcessOutputWithAbortGrace(result, undefined, {
      killGraceMs: 20,
    }).finally(() => {
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
    const { child, result, signals } = fakeProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const controller = new AbortController();
    const pending = waitForProcessOutputWithAbortGrace(
      result,
      controller.signal,
      { killGraceMs: 10 },
    );

    controller.abort();
    await expect(pending).resolves.toMatchObject({ aborted: true });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  test('observes stdout errors immediately as well as stderr errors', async () => {
    const { child, result, signals } = fakeProcess();
    const error = new Error('stdout pipe failed');
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const pending = waitForProcessOutputWithAbortGrace(result, undefined, {
      killGraceMs: 20,
    });
    child.stderr.emit('error', new Error('stderr failed first'));
    child.stdout.emit('error', error);
    await Promise.resolve();
    expect(signals).toEqual(['SIGTERM']);
    child.emit('close', 1, null);
    await expect(pending).rejects.toBe(error);
  });
});

const node = process.versions.bun ? 'node' : process.execPath;

function ownerHandle(owner: SupervisedProcess): ProcessHandle {
  return {
    proc: owner.proc,
    exited: owner.exited.then(({ code }) => code),
    closed: owner.closed,
    stop: owner.stop,
    release: owner.release,
    get exitCode() {
      return owner.exitCode;
    },
  };
}

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
      const kill = spyOn(process, 'kill').mockImplementation(() => true);
      try {
        await expect(child.stop(0)).rejects.toBeInstanceOf(
          CleanupUnconfirmedError,
        );
        expect(kill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
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
      await expect(
        waitForProcessOutputWithAbortGrace({
          ...result,
          closed: Promise.reject(error),
        }),
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
      const supervised: ProcessHandle = {
        ...result,
        exited: operation === 'release' ? Promise.resolve(0) : result.exited,
        closed: never,
        [operation]: () => {
          requested = true;
          return never;
        },
      };
      const controller = new AbortController();
      if (operation === 'release') {
        stdout.end();
        stderr.end();
      }
      const pending = waitForProcessOutputWithAbortGrace(
        supervised,
        controller.signal,
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
      if (operation === 'stop') {
        const other = fakeProcess();
        let released = false;
        const abort = new AbortController();
        const wait = waitForProcessOutputWithAbortGrace(
          {
            ...other.result,
            exited: Promise.resolve(0),
            closed: never,
            stop: () => never,
            release: () => {
              released = true;
              return never;
            },
          },
          abort.signal,
          { killGraceMs: 0, cleanupTimeoutMs: 20 },
        );
        abort.abort();
        await expect(wait).rejects.toBeInstanceOf(CleanupUnconfirmedError);
        expect(released).toBe(false);
      }
    });

    test('standalone stop has a parent watchdog when the real supervisor is SIGSTOPped', async () => {
      const owner = spawnSupervised(
        [
          node,
          '-e',
          'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);',
        ],
        { killGraceMs: 0, cleanupTimeoutMs: 30 },
      );
      const child = ownerHandle(owner);
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
          waitForProcessOutputWithAbortGrace(child),
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
        const kill = spyOn(process, 'kill').mockImplementation(() => true);
        try {
          await child.stop(0);
          expect(kill).not.toHaveBeenCalled();
        } finally {
          kill.mockRestore();
        }
      } finally {
        await child.stop(0);
      }
    });

    test('runProcess collects from launch and releases exactly once', async () => {
      let child!: SupervisedProcess;
      let send!: ReturnType<typeof spyOn>;
      const result = await runProcess(
        [
          node,
          '-e',
          'process.stdout.write("out"); process.stderr.write("err");',
        ],
        {},
        undefined,
        (cmd, options) => {
          child = spawnSupervised(cmd, options);
          send = spyOn(child.proc, 'send');
          return child;
        },
      );
      try {
        expect((await child.exited).code).toBe(0);
        await child.closed;
        expect(result.stdout).toBe('out');
        expect(result.stderr).toBe('err');
        expect(child.proc.exitCode).toBeNull();
        expect(child.proc.signalCode).toBe('SIGKILL');
        expect(result).toMatchObject({
          exitCode: 0,
          stdout: 'out',
          stderr: 'err',
          aborted: false,
        });
        const nonzero = await runProcess(
          [node, '-e', 'process.stderr.write("nonzero"); process.exit(23);'],
          { killProcessGroup: false },
        );
        expect(nonzero).toMatchObject({
          exitCode: 23,
          stderr: 'nonzero',
          aborted: false,
        });
        expect(
          send.mock.calls.filter(
            (call: unknown[]) =>
              typeof call[0] === 'object' &&
              call[0] !== null &&
              'type' in call[0] &&
              call[0].type === 'release',
          ),
        ).toHaveLength(1);
      } finally {
        send.mockRestore();
        await child.stop(0);
      }
    });

    test('abort retains the supervisor through grace even when the task exits on TERM', async () => {
      const descendant =
        'process.on("SIGTERM", () => {}); process.stdout.write("READY\\n"); setInterval(() => {}, 1000);';
      let child!: SupervisedProcess;
      const controller = new AbortController();
      const pending = runProcess(
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
        controller.signal,
        (cmd, options) => (child = spawnSupervised(cmd, options)),
      );
      let cleaned = false;
      void child.closed.then(() => {
        cleaned = true;
      });
      try {
        await ready(child.proc);
        controller.abort();
        expect((await child.exited).code).toBe(0);
        expect(cleaned).toBe(false);
        expect(await pending).toMatchObject({ aborted: true, exitCode: 0 });
        expect(cleaned).toBe(true);
        expect(child.proc.signalCode).toBe('SIGKILL');
      } finally {
        await child.stop(0);
      }
    });

    test('already-aborted calls cannot release the supervisor before cleanup', async () => {
      let child!: SupervisedProcess;
      let send!: ReturnType<typeof spyOn>;
      const controller = new AbortController();
      controller.abort();
      try {
        const result = await runProcess(
          [node, '-e', 'setInterval(() => {}, 1000);'],
          { killGraceMs: 20 },
          controller.signal,
          (cmd, options) => {
            child = spawnSupervised(cmd, options);
            send = spyOn(child.proc, 'send');
            return child;
          },
        );
        expect(result.aborted).toBe(true);
        expect(child.proc.signalCode).toBe('SIGKILL');
        expect(
          send.mock.calls.filter(
            (call: unknown[]) =>
              typeof call[0] === 'object' &&
              call[0] !== null &&
              'type' in call[0] &&
              call[0].type === 'release',
          ),
        ).toHaveLength(0);
      } finally {
        send?.mockRestore();
        await child.stop(0);
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
      let child!: SupervisedProcess;
      const pending = runProcess(
        [
          node,
          '-e',
          `
      require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }).unref();
      process.stdout.write('partial');
    `,
        ],
        { killGraceMs: 30, postCloseDrainMs: 20 },
        undefined,
        (cmd, options) => (child = spawnSupervised(cmd, options)),
      );
      try {
        expect((await child.exited).code).toBe(0);
        expect((await pending).stdout).toBe('partial');
        await child.closed;
        expect(child.proc.signalCode).toBe('SIGKILL');
      } finally {
        await child.stop(0);
      }
    });

    test.each([
      'stdout',
      'stderr',
    ] as const)('observes an early %s stream error and cleans up', async (stream) => {
      let child!: SupervisedProcess;
      const pending = runProcess(
        [
          node,
          '-e',
          'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);',
        ],
        { killGraceMs: 30 },
        undefined,
        (cmd, options) => (child = spawnSupervised(cmd, options)),
      );
      const error = new Error(`${stream} failed before collection`);
      try {
        await ready(child.proc);
        child.proc[stream]?.emit('error', error);
        // Error observers were installed synchronously at process creation.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await expect(pending).rejects.toBe(error);
        expect(child.proc.signalCode).toBe('SIGKILL');
      } finally {
        await child.stop(0);
      }
    });

    test('reports task spawn errors over IPC, without an unobserved rejection', async () => {
      let child!: SupervisedProcess;
      const pending = runProcess(
        ['/definitely-missing-betterglob-command'],
        {
          killGraceMs: 10,
        },
        undefined,
        (cmd, options) => (child = spawnSupervised(cmd, options)),
      );
      try {
        await child.closed;
        await expect(pending).rejects.toThrow('ENOENT');
      } finally {
        await child.stop(0);
      }
    });
  },
);
