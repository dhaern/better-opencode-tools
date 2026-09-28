/// <reference types="bun-types" />

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { RUNNER_ABORT_GRACE_MS } from '../tools/glob/tool-deadline';
import {
  DEFAULT_SEARCH_KILL_GRACE_MS,
  ensureSupervisorRuntime,
  isMissingExecutableError,
  POST_EXIT_DRAIN_MS,
  runProcess,
} from './process-output';
import {
  CleanupUnconfirmedError,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  type SupervisedProcess,
  SupervisorRuntimeError,
  spawnSupervised as spawnOwner,
} from './process-supervisor';

function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Test promise did not settle within ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function reaped(pid: number): Promise<boolean> {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

const trackedOwners: SupervisedProcess[] = [];
function spawnSupervised(
  ...args: Parameters<typeof spawnOwner>
): SupervisedProcess {
  const owner = spawnOwner(...args);
  trackedOwners.push(owner);
  return owner;
}

afterEach(async () => {
  for (const owner of trackedOwners.splice(0)) {
    const proc = owner.proc;
    if (
      proc.pid === undefined ||
      proc.exitCode !== null ||
      proc.signalCode !== null
    )
      continue;
    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve();
      else proc.once('exit', () => resolve());
    });
    // Test-only recovery of a SIGSTOPped transport, never a saved PGID.
    proc.kill('SIGCONT');
    void owner.stop(0).catch(() => undefined);
    await within(exited);
  }
});

const releaseCount = (send: ReturnType<typeof spyOn>) =>
  send.mock.calls.filter(
    (call: unknown[]) => (call[0] as { type?: string })?.type === 'release',
  ).length;

const node = process.versions.bun ? 'node' : process.execPath;

test('runner abort grace follows its actual stop and cleanup budget', () => {
  expect(RUNNER_ABORT_GRACE_MS).toBe(
    DEFAULT_SEARCH_KILL_GRACE_MS +
      DEFAULT_CLEANUP_TIMEOUT_MS +
      POST_EXIT_DRAIN_MS +
      250,
  );
});

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

test('direct spawn failures retain their typed ENOENT cause', async () => {
  let error: unknown;
  try {
    await within(
      runProcess(['/definitely-missing-betterglob-command'], {
        killProcessGroup: false,
        killGraceMs: 20,
      }),
    );
  } catch (caught) {
    error = caught;
  }
  expect(isMissingExecutableError(error)).toBe(true);
});

describe.skipIf(process.platform === 'win32')(
  'POSIX private supervisor',
  () => {
    test('preserves the first typed infrastructure error', async () => {
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const cause = new SupervisorRuntimeError();
      const cleanup = new CleanupUnconfirmedError('cleanup failed');
      const owner: SupervisedProcess = {
        proc: child,
        exited: Promise.reject(cause),
        closed: Promise.reject(cleanup),
        exitCode: null,
        stop: async () => undefined,
        release: async () => undefined,
      };
      await expect(
        within(runProcess(['injected-task'], {}, undefined, () => owner)),
      ).rejects.toBe(cause);
    });
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

    test('runProcess bounds a stalled cleanup with the shared budget', async () => {
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const never = new Promise<void>(() => undefined);
      let stops = 0;
      const owner: SupervisedProcess = {
        proc: child,
        exited: new Promise(() => undefined),
        closed: never,
        exitCode: null,
        stop: () => {
          stops++;
          return never;
        },
        release: () => never,
      };
      const controller = new AbortController();
      const pending = runProcess(
        ['injected-task'],
        { killGraceMs: 0, cleanupTimeoutMs: 20, postCloseDrainMs: 0 },
        controller.signal,
        () => owner,
      );
      controller.abort();
      await expect(within(pending)).rejects.toBeInstanceOf(
        CleanupUnconfirmedError,
      );
      expect(stops).toBe(1);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
    });

    test('direct auxiliary child ignoring TERM is reaped after POSIX SIGKILL', async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'betterglob-direct-'));
      const marker = path.join(dir, 'pid');
      const controller = new AbortController();
      let pid: number | undefined;
      let observer: ReturnType<typeof watch> | undefined;
      try {
        const ready = new Promise<void>((resolve) => {
          observer = watch(dir, () => {
            let value: number;
            try {
              value = Number.parseInt(readFileSync(marker, 'utf8'), 10);
            } catch {
              return;
            }
            if (!Number.isInteger(value) || value < 1) return;
            pid = value;
            observer?.close();
            resolve();
          });
        });
        const script = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
        const pending = runProcess(
          [node, '-e', script],
          {
            killProcessGroup: false,
            killGraceMs: 40,
            cleanupTimeoutMs: 1000,
          },
          controller.signal,
        );
        await within(ready);
        controller.abort();
        await expect(within(pending, 4000)).resolves.toMatchObject({
          aborted: true,
        });
        expect(await reaped(pid as number)).toBe(true);
      } finally {
        observer?.close();
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already reaped */
          }
        }
        rmSync(dir, { recursive: true, force: true });
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
      const child = owner;
      const transportExited = new Promise<void>((resolve) =>
        child.proc.once('exit', () => resolve()),
      );
      try {
        await ready(child.proc);
        expect(child.proc.kill('SIGSTOP')).toBe(true);
        await expect(within(child.stop(0))).rejects.toBeInstanceOf(
          CleanupUnconfirmedError,
        );
        expect(child.proc.stdout?.destroyed).toBe(true);
        expect(child.proc.stderr?.destroyed).toBe(true);
        // Timeout is not a claim that the stopped supervisor was killed.
        expect(child.proc.signalCode).toBeNull();
      } finally {
        // Test-only resumption of our unreaped ChildProcess allows its queued
        // stop/disconnect cleanup to run; production never sends this signal.
        child.proc.kill('SIGCONT');
        await within(transportExited);
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
        expect(releaseCount(send)).toBe(1);
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
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(cleaned).toBe(false);
        expect(child.proc.signalCode).toBeNull();
        expect(await pending).toMatchObject({ aborted: true, exitCode: 0 });
        expect(cleaned).toBe(true);
        expect(child.proc.signalCode).toBe('SIGKILL');
      } finally {
        await child.stop(0);
      }
    });

    test('a pending release does not shorten the termination grace after stop', async () => {
      const child = spawnSupervised(
        [
          node,
          '-e',
          'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("READY\\n"); setInterval(() => {}, 1000)',
        ],
        { killGraceMs: 150 },
      );
      try {
        await ready(child.proc);
        void child.release();
        const started = performance.now();
        void child.stop();
        await child.closed;
        expect(performance.now() - started).toBeGreaterThan(50);
        expect(child.proc.signalCode).toBe('SIGKILL');
      } finally {
        await child.stop(0).catch(() => undefined);
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
        expect(releaseCount(send)).toBe(0);
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
