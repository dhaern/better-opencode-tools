/// <reference types="bun-types" />
import { describe, expect, spyOn, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  adaptDirectSearch,
  adaptSupervisedSearch,
  type ManagedSearch,
} from '../../utils/process-output';
import {
  type SupervisedExit,
  type SupervisedProcess,
  type SupervisorOptions,
  spawnSupervised,
} from '../../utils/process-supervisor';
import { normalizeGlobInputAsync } from './normalize';
import { createDefaultRunnerDeps, createRipgrepRunner } from './runner';
import { collectMatchedPaths } from './runner-output';
import { createRepoContext, createTempTracker, within } from './test-helpers';

function spawnTestSearch(
  cmd: string,
  args: string[],
  options: SupervisorOptions & { postExitDrainMs?: number },
): ManagedSearch {
  return adaptSupervisedSearch(spawnSupervised([cmd, ...args], options), {
    postExitDrainMs: options.postExitDrainMs,
  });
}

function spawnScript(
  script: string,
  options: { cwd: string; killGraceMs?: number; postExitDrainMs?: number },
): ManagedSearch {
  return spawnTestSearch('node', ['-e', script], {
    cwd: options.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    killGraceMs: options.killGraceMs,
    postExitDrainMs: options.postExitDrainMs,
  });
}

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function controlledSupervisor() {
  const child = fakeChild();
  const task = Promise.withResolvers<SupervisedExit>();
  const cleanup = Promise.withResolvers<void>();
  const stops: (number | undefined)[] = [];
  let releases = 0;
  const supervised: SupervisedProcess = {
    proc: child,
    exited: task.promise,
    closed: cleanup.promise,
    exitCode: null,
    stop: (grace) => {
      stops.push(grace);
      return cleanup.promise;
    },
    release: () => {
      releases++;
      return cleanup.promise;
    },
  };
  return { child, task, cleanup, supervised, stops, releases: () => releases };
}

const fakeResolve = async () =>
  ({ path: 'injected-rg', backend: 'rg', source: 'system-rg' }) as const;

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function normalizeSearchInput(
  args: Partial<Parameters<typeof normalizeGlobInputAsync>[0]>,
  repoDir: string,
) {
  return normalizeGlobInputAsync(
    { pattern: '*.ts', path: 'src', ...args },
    createRepoContext(repoDir) as any,
  );
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('tools/glob/runner spawn failures', () => {
  const temps = createTempTracker();

  test('direct adapter waits for close and stops only through the child capability', async () => {
    const child = fakeChild();
    let kills = 0;
    child.kill = () => {
      kills++;
      return true;
    };
    const managed = adaptDirectSearch(child, {});
    let completed = false;
    void managed.completed.then(() => {
      completed = true;
    });
    child.emit('error', new Error('spawn failed'));
    await nextTurn();
    expect(completed).toBe(false);
    managed.stop();
    expect(kills).toBe(1);
    child.emit('close', null, null);
    expect(await within(managed.completed)).toMatchObject({
      code: null,
      signal: null,
      error: 'spawn failed',
    });
    expect(managed.readExit()).toEqual(await managed.completed);
  });

  test('direct adapter retains a stream read failure in the runner result', async () => {
    const child = fakeChild();
    const run = createRipgrepRunner({
      resolve: fakeResolve,
      spawn: () => adaptDirectSearch(child, {}),
    });
    const pending = run(
      await normalizeSearchInput({}, temps.createRepo()),
      new AbortController().signal,
    );
    await nextTurn();
    child.stdout?.emit('error', new Error('read failed'));
    child.stdout?.emit('end');
    child.stderr?.emit('end');
    child.emit('close', 0, null);
    expect(await within(pending)).toMatchObject({
      error: 'read failed',
      incomplete: true,
    });
  });

  test.each(['direct', 'supervised'] as const)(
    '%s adapter stops on stream error, retains its diagnostic, and destroys readers',
    async (adapter) => {
      const fixture =
        adapter === 'supervised' ? controlledSupervisor() : undefined;
      const child = fixture?.child ?? fakeChild();
      let stops = 0;
      if (fixture) {
        fixture.supervised.stop = () => {
          stops++;
          void fixture.task.promise.then(() => fixture.cleanup.resolve());
          return fixture.cleanup.promise;
        };
      } else {
        child.kill = () => {
          stops++;
          return true;
        };
      }
      const run = createRipgrepRunner({
        resolve: fakeResolve,
        spawn: () =>
          fixture
            ? adaptSupervisedSearch(fixture.supervised)
            : adaptDirectSearch(child, {}),
      });
      const repoDir = temps.createRepo();
      const pending = run(
        await normalizeSearchInput({}, repoDir),
        new AbortController().signal,
      );
      await nextTurn();
      child.stdout?.emit('data', 'a.ts\0');
      child.stderr?.emit('error', new Error('read failed'));
      if (fixture) {
        // The supervised adapter must close abandoned pipes at the error,
        // not only after its post-exit drain deadline expires.
        expect(child.stdout?.destroyed).toBe(true);
        fixture.task.resolve({ code: 0, signal: null });
      } else child.emit('close', 0, null);
      const result = await within(pending);
      expect(result?.files).toEqual([`${repoDir}/src/a.ts`]);
      expect(result?.exitCode).toBe(0);
      expect(result?.incomplete).toBe(true);
      expect(result?.error).toContain(
        fixture ? 'Output reader failed: read failed' : 'read failed',
      );
      expect(stops).toBe(1);
      expect(child.stdout?.destroyed).toBe(true);
      expect(child.stderr?.destroyed).toBe(true);
    },
  );

  test('cancelled managed search without an exit status retains exit code 130', async () => {
    const child = fakeChild();
    const completion =
      Promise.withResolvers<Awaited<ManagedSearch['completed']>>();
    const controller = new AbortController();
    const run = createRipgrepRunner({
      resolve: fakeResolve,
      spawn: () => ({
        child,
        completed: completion.promise,
        readExit: () => undefined,
        stop: () => completion.resolve({ code: null, signal: null }),
      }),
    });
    const pending = run(
      await normalizeSearchInput({}, temps.createRepo()),
      controller.signal,
    );
    await nextTurn();
    controller.abort();
    const result = await within(pending, 2500);
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(130);
  });

  test.skipIf(process.platform === 'win32')(
    'default search stops a NUL-writing executable at limit one without waiting its kill grace',
    async () => {
      const dir = temps.createRepo();
      const executable = path.join(dir, 'fake-rg');
      writeFileSync(
        executable,
        '#!/usr/bin/env node\nprocess.stdout.write("a.ts\\0b.ts\\0c.ts\\0"); setInterval(() => {}, 1000);',
        { mode: 0o755 },
      );
      const run = createRipgrepRunner({
        ...createDefaultRunnerDeps(),
        // A grace far beyond the bound: only a stop that does not wait it passes.
        killGraceMs: 10_000,
        resolve: async () => ({
          path: executable,
          backend: 'rg',
          source: 'system-rg',
        }),
      });
      const input = await normalizeSearchInput(
        { limit: 1, timeout_ms: 20_000 },
        dir,
      );
      const result = await within(
        run(input, new AbortController().signal),
        2500,
      );
      expect(result).toBeDefined();
      if (!result) return;

      expect(result.files).toEqual([`${dir}/src/a.ts`]);
      expect(result.truncated).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.incomplete).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'default search bounds timeout for a NUL-writing executable that stays alive',
    async () => {
      const dir = temps.createRepo();
      const executable = path.join(dir, 'fake-rg');
      writeFileSync(
        executable,
        '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {}); process.stdout.write("a.ts\\0b.ts\\0c.ts\\0"); setInterval(() => {}, 1000);',
        { mode: 0o755 },
      );
      const run = createRipgrepRunner({
        ...createDefaultRunnerDeps(),
        resolve: async () => ({
          path: executable,
          backend: 'rg',
          source: 'system-rg',
        }),
      });
      const input = await normalizeSearchInput(
        { limit: 10, timeout_ms: 150 },
        dir,
      );
      const started = performance.now();
      const result = await within(
        run(input, new AbortController().signal),
        2500,
      );
      expect(result).toBeDefined();
      if (!result) return;

      expect(result.timedOut).toBe(true);
      expect(result.incomplete).toBe(true);
      expect(result.error).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(2500);
    },
  );

  test.each(
    (['limit', 'abort', 'timeout'] as const).flatMap((ending) =>
      (['error', 'confirmed'] as const).map((cleanup) => ({
        ending,
        cleanup,
      })),
    ),
  )(
    'awaits final cleanup after $ending and preserves $cleanup semantics',
    async ({ ending, cleanup }) => {
      const child = fakeChild();
      const completion =
        Promise.withResolvers<Awaited<ManagedSearch['completed']>>();
      const taskExit = { code: cleanup === 'confirmed' ? 0 : 2, signal: null };
      const controller = new AbortController();
      const repoDir = temps.createRepo();
      let stops = 0;
      let finished = false;
      const run = createRipgrepRunner({
        resolve: fakeResolve,
        spawn: () => ({
          child,
          stop: () => {
            stops++;
          },
          readExit: () => taskExit,
          completed: completion.promise,
        }),
        cleanupWaitMs: 2000,
      });
      const input = await normalizeSearchInput(
        { limit: ending === 'limit' ? 1 : 10 },
        repoDir,
      );
      const pending = run(input, controller.signal);
      void pending.then(() => {
        finished = true;
      });
      await nextTurn();
      child.stdout?.emit('data', 'a.ts\0');
      if (ending === 'limit') child.stdout?.emit('data', 'b.ts\0');
      else
        controller.abort(
          ending === 'timeout'
            ? new DOMException('deadline', 'TimeoutError')
            : new Error('cancelled'),
        );
      await nextTurn();
      expect(finished).toBe(false);
      expect(stops).toBe(1);
      // Diagnostics and complete paths received while cleanup is pending must
      // be present in the FINAL result, not discarded by the early race winner.
      child.stderr?.emit('data', 'late cleanup diagnostic');
      if (ending !== 'limit') child.stdout?.emit('data', 'b.ts\0unfinished');
      completion.resolve({
        ...taskExit,
        ...(cleanup === 'error'
          ? { error: 'cleanup unconfirmed: watchdog' }
          : {}),
      });
      const result = await within(pending, 2500);
      expect(result).toBeDefined();
      if (!result) return;
      expect(result.files).toEqual(
        ending === 'limit'
          ? [`${repoDir}/src/a.ts`]
          : [`${repoDir}/src/a.ts`, `${repoDir}/src/b.ts`],
      );
      expect(result.stderr).toBe('late cleanup diagnostic');
      expect(result.exitCode).toBe(taskExit.code);
      expect(result.truncated).toBe(ending === 'limit');
      expect(result.cancelled).toBe(ending === 'abort');
      expect(result.timedOut).toBe(ending === 'timeout');
      expect(result.incomplete).toBe(
        ending !== 'limit' || cleanup !== 'confirmed',
      );
      if (cleanup === 'confirmed') expect(result.error).toBeUndefined();
      else expect(result.error).toContain('watchdog');
      await nextTurn();
      for (const stream of [child.stdout, child.stderr]) {
        expect(stream?.destroyed).toBe(true);
        expect(stream?.listenerCount('data')).toBe(0);
        expect(stream?.listenerCount('error')).toBe(0);
      }
    },
  );

  test.each(['limit', 'abort', 'timeout'] as const)(
    'bounds stalled cleanup after %s and ignores late completion',
    async (ending) => {
      const child = fakeChild();
      const completion =
        Promise.withResolvers<Awaited<ManagedSearch['completed']>>();
      const controller = new AbortController();
      const repoDir = temps.createRepo();
      const run = createRipgrepRunner({
        resolve: fakeResolve,
        spawn: () => ({
          child,
          stop: () => undefined,
          readExit: () =>
            ending === 'limit' ? undefined : { code: 0, signal: null },
          completed: completion.promise,
        }),
        cleanupWaitMs: 0,
      });
      const input = await normalizeSearchInput({ limit: 1 }, repoDir);
      const pending = run(input, controller.signal);
      await nextTurn();
      child.stdout?.emit('data', 'a.ts\0');
      if (ending === 'limit') child.stdout?.emit('data', 'b.ts\0');
      else
        controller.abort(
          ending === 'timeout'
            ? new DOMException('deadline', 'TimeoutError')
            : new Error('cancelled'),
        );
      const result = await within(pending, 2500);
      expect(result).toBeDefined();
      if (!result) return;
      expect(result.files).toEqual([`${repoDir}/src/a.ts`]);
      expect(result.exitCode).toBe(0);
      expect(result.incomplete).toBe(true);
      expect(result.error).toContain('cleanup wait deadline exceeded');
      expect(result.error).not.toContain('Supervisor');
      expect(result.cancelled).toBe(ending === 'abort');
      expect(result.timedOut).toBe(ending === 'timeout');
      expect(child.listenerCount('error')).toBe(0);
      completion.resolve({ code: 0, signal: null });
      await nextTurn();
      expect(result.error).toContain('cleanup wait deadline exceeded');
    },
  );

  test('the search deadline cannot reclassify a limit stop during cleanup', async () => {
    const child = fakeChild();
    const completion =
      Promise.withResolvers<Awaited<ManagedSearch['completed']>>();
    const run = createRipgrepRunner({
      resolve: fakeResolve,
      spawn: () => {
        queueMicrotask(() => child.stdout?.emit('data', 'a.ts\0b.ts\0'));
        return {
          child,
          stop: () => {
            setTimeout(() => completion.resolve({ code: 0, signal: null }), 30);
          },
          readExit: () => ({ code: 0, signal: null }),
          completed: completion.promise,
        };
      },
      cleanupWaitMs: 2000,
    });
    const input = await normalizeSearchInput(
      { limit: 1, timeout_ms: 1 },
      temps.createRepo(),
    );
    const result = await run(input, new AbortController().signal);
    expect(result.truncated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.incomplete).toBe(false);
    expect(result.error).toBeUndefined();
  });

  test('starts bounded drain at taskExit and preserves bytes without waiting for transport close', async () => {
    const fixture = controlledSupervisor();
    fixture.supervised.stop = (grace) => {
      fixture.stops.push(grace);
      fixture.cleanup.resolve();
      return fixture.cleanup.promise;
    };
    const repoDir = temps.createRepo();
    const run = createRipgrepRunner({
      resolve: fakeResolve,
      spawn: () =>
        adaptSupervisedSearch(fixture.supervised, { postExitDrainMs: 0 }),
    });
    const input = await normalizeSearchInput({ timeout_ms: 3000 }, repoDir);
    const pending = run(input, new AbortController().signal);
    await nextTurn();
    fixture.child.stdout?.emit('data', 'a.ts\0');
    expect(fixture.stops).toEqual([]);
    expect(fixture.child.stdout?.destroyed).toBe(false);
    fixture.task.resolve({ code: 0, signal: null });
    queueMicrotask(() => {
      fixture.child.stdout?.emit('data', 'b.ts\0unfinished');
      fixture.child.stderr?.emit('data', 'retained diagnostic');
    });
    const result = await within(pending, 2500);
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.files).toEqual([
      `${repoDir}/src/a.ts`,
      `${repoDir}/src/b.ts`,
    ]);
    expect(result.stderr).toBe('retained diagnostic');
    expect(result.exitCode).toBe(0);
    expect(result.incomplete).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.error).toContain('Output drain deadline exceeded');
    expect(fixture.stops).toEqual([0]);
    expect(fixture.releases()).toBe(0);
    // The transport emitted no close at all: completion uses the owner facts.
    for (const stream of [fixture.child.stdout, fixture.child.stderr]) {
      expect(stream?.destroyed).toBe(true);
      expect(stream?.listenerCount('data')).toBe(0);
      expect(stream?.listenerCount('error')).toBe(0);
    }
  });

  test.each([0, 2])(
    'reports unconfirmed cleanup after task exit %i with inherited pipes',
    async (code) => {
      const fixture = controlledSupervisor();
      const repoDir = temps.createRepo();
      const run = createRipgrepRunner({
        resolve: fakeResolve,
        spawn: () =>
          adaptSupervisedSearch(fixture.supervised, { postExitDrainMs: 0 }),
      });
      const input = await normalizeSearchInput({ timeout_ms: 3000 }, repoDir);
      const pending = run(input, new AbortController().signal);
      await nextTurn();
      fixture.child.stdout?.emit('data', 'a.ts\0');
      fixture.task.resolve({ code, signal: null });
      queueMicrotask(() => {
        fixture.child.emit('close', null, 'SIGKILL');
        fixture.cleanup.reject(
          new Error('cleanup unconfirmed: unexpected supervisor death'),
        );
      });
      const result = await within(pending, 2500);
      expect(result).toBeDefined();
      if (!result) return;
      expect(result.files).toEqual([`${repoDir}/src/a.ts`]);
      expect(result.exitCode).toBe(code);
      expect(result.error).toContain('cleanup unconfirmed');
      expect(result.incomplete).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(fixture.releases()).toBe(0);
      expect(fixture.stops).toEqual([]);
    },
  );

  test('transport close after release cannot replace the cleanup protocol', async () => {
    const fixture = controlledSupervisor();
    const run = createRipgrepRunner({
      resolve: fakeResolve,
      spawn: () => adaptSupervisedSearch(fixture.supervised),
    });
    const input = await normalizeSearchInput({}, temps.createRepo());
    let finished = false;
    const pending = run(input, new AbortController().signal);
    void pending.then(() => {
      finished = true;
    });
    await nextTurn();
    fixture.task.resolve({ code: 0, signal: null });
    fixture.child.stdout?.emit('end');
    fixture.child.stderr?.emit('end');
    await nextTurn();
    expect(fixture.releases()).toBe(1);
    fixture.child.emit('close', 0, null);
    await nextTurn();
    expect(finished).toBe(false);
    fixture.cleanup.reject(
      new Error('cleanup unconfirmed: no protocol acknowledgement'),
    );
    const result = await within(pending, 2500);
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.exitCode).toBe(0);
    expect(result.error).toContain('no protocol acknowledgement');
    expect(result.incomplete).toBe(true);
    expect(fixture.stops).toEqual([]);
  });

  test.each(['release', 'stop'] as const)(
    'adapts common task status, output drain and idempotent %s',
    async (ending) => {
      const child = fakeChild();
      const task = Promise.withResolvers<SupervisedExit>();
      const cleanup = Promise.withResolvers<void>();
      let releases = 0;
      let stops = 0;
      const supervised: SupervisedProcess = {
        proc: child,
        exited: task.promise,
        closed: cleanup.promise,
        exitCode: null,
        release: () => {
          releases++;
          return cleanup.promise;
        },
        stop: () => {
          stops++;
          return cleanup.promise;
        },
      };
      const managed = adaptSupervisedSearch(supervised);
      if (ending === 'stop') {
        managed.stop();
        managed.stop();
      }
      task.resolve({ code: 2, signal: null });
      await nextTurn();
      expect(managed.readExit()).toEqual({ code: 2, signal: null });
      expect(releases).toBe(0);
      child.stdout?.emit('end');
      expect(releases).toBe(0); // stderr can still contain diagnostic output.
      child.stderr?.emit('close');
      child.stdout?.emit('close');
      expect(releases).toBe(ending === 'release' ? 1 : 0);
      expect(stops).toBe(ending === 'stop' ? 1 : 0);
      cleanup.resolve();
      await nextTurn();
      managed.stop(); // An abandoned transport is never signalled again.
      expect(stops).toBe(ending === 'stop' ? 1 : 0);
      for (const stream of [child.stdout, child.stderr]) {
        expect(stream?.listenerCount('end')).toBe(0);
        expect(stream?.listenerCount('close')).toBe(0);
        expect(stream?.listenerCount('error')).toBe(0);
        stream?.destroy();
      }
    },
  );

  test.each(['cancel', 'timeout'] as const)(
    'does not spawn when %s arrives after CLI resolution wins the race',
    async (reason) => {
      const controller = new AbortController();
      const input = await normalizeSearchInput({}, temps.createRepo());
      let resolvedPathRead = false;
      let spawns = 0;
      const run = createRipgrepRunner({
        resolve: async () => {
          // Let the resolver's then/catch chain settle first, but deliver
          // abort before the winning race's await continuation resumes.
          queueMicrotask(() => {
            queueMicrotask(() => {
              queueMicrotask(() => {
                controller.abort(
                  reason === 'timeout'
                    ? new DOMException('deadline', 'TimeoutError')
                    : new Error('cancelled'),
                );
              });
            });
          });
          return {
            // Reading this proves the CLI, not cancellation, won the race.
            get path() {
              resolvedPathRead = true;
              return 'injected-rg';
            },
            backend: 'rg',
            source: 'system-rg',
          };
        },
        spawn: () => {
          spawns++;
          throw new Error('must not spawn');
        },
      });

      const result = await run(input, controller.signal);
      expect(resolvedPathRead).toBe(true);
      expect(spawns).toBe(0);
      expect(result.incomplete).toBe(true);
      expect(result.cancelled).toBe(reason === 'cancel');
      expect(result.timedOut).toBe(reason === 'timeout');
      expect(result.exitCode).toBe(reason === 'cancel' ? 130 : 124);
      expect(result.error).toBeUndefined();
    },
  );

  test.each(['cancel', 'timeout'] as const)(
    'classifies a pre-aborted %s without resolving or spawning',
    async (reason) => {
      const controller = new AbortController();
      controller.abort(
        reason === 'timeout'
          ? new DOMException('deadline', 'TimeoutError')
          : new Error('cancelled'),
      );
      const unexpected = () => {
        throw new Error('must not resolve or spawn');
      };
      const run = createRipgrepRunner({
        resolve: unexpected,
        spawn: unexpected,
      });
      const input = await normalizeSearchInput({}, temps.createRepo());
      const result = await run(input, controller.signal);
      expect(result.exitCode).toBe(reason === 'cancel' ? 130 : 124);
      expect(result.cancelled).toBe(reason === 'cancel');
      expect(result.timedOut).toBe(reason === 'timeout');
    },
  );

  test.skipIf(process.platform === 'win32')(
    'keeps the supervisor alive after worker exit until its resistant descendant is killed',
    async () => {
      const controller = new AbortController();
      let child: ChildProcess | undefined;
      let descendant: number | undefined;
      let closed = false;
      let aliveAfterWorkerExit = false;
      const events: string[] = [];
      let stopRequestedAt = 0;
      let supervisorClosedAt = 0;
      let ready = '';
      const run = createRipgrepRunner({
        resolve: fakeResolve,
        killGraceMs: 250,
        spawn: (_cmd, _args, options) => {
          const managed = spawnTestSearch(
            process.execPath,
            [
              '-e',
              `
              const { spawn } = require('node:child_process');
              const descendant = spawn(process.execPath, ['-e',
                "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"
              ], { stdio: ['ignore', 'pipe', 'ignore'] });
              descendant.stdout.once('data', () => {
                process.stdout.write('descendant-' + descendant.pid + '.ts\\0');
              });
              process.on('SIGTERM', () => process.exit(0));
              setInterval(() => {}, 1000);
              `,
            ],
            options,
          );
          if (!('child' in managed))
            throw new Error('expected POSIX supervisor');
          child = managed.child;
          child.on('message', (message: { type?: string }) => {
            if (message.type !== 'taskExit') return;
            events.push('worker-exit');
            aliveAfterWorkerExit = isAlive(child?.pid) && isAlive(descendant);
          });
          child.once('close', () => {
            closed = true;
            supervisorClosedAt = performance.now();
            events.push('supervisor-close');
          });
          child.stdout?.on('data', (data: Buffer) => {
            ready += data.toString();
            const match = /descendant-(\d+)\.ts\0/.exec(ready);
            if (!match) return;
            descendant = Number(match[1]);
            // Allow the runner's data listener to collect the complete row.
            queueMicrotask(() => {
              stopRequestedAt = performance.now();
              controller.abort();
            });
          });
          return managed;
        },
      });
      const repoDir = temps.createRepo();
      const input = await normalizeSearchInput({ timeout_ms: 3000 }, repoDir);
      try {
        const result = await run(input, controller.signal);
        expect(descendant).toBeDefined();
        expect(result.cancelled).toBe(true);
        expect(result.files).toEqual([
          `${repoDir}/src/descendant-${descendant}.ts`,
        ]);
        for (let i = 0; i < 200 && (!closed || isAlive(descendant)); i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(events).toEqual(['worker-exit', 'supervisor-close']);
        expect(aliveAfterWorkerExit).toBe(true);
        expect(closed).toBe(true);
        expect(supervisorClosedAt - stopRequestedAt).toBeGreaterThanOrEqual(
          245,
        );
        expect(isAlive(descendant)).toBe(false);
      } finally {
        // Only clean up processes still alive; never send to a stale PGID.
        if (isAlive(child?.pid)) child?.kill('SIGKILL');
        if (descendant && isAlive(descendant)) {
          process.kill(descendant, 'SIGKILL');
        }
      }
    },
  );

  const testPosix = process.platform === 'win32' ? test.skip : test;

  testPosix(
    'bounds drain after the real task exits while a descendant retains stdout',
    async () => {
      const repoDir = temps.createRepo();
      let descendant: number | undefined;
      const run = createRipgrepRunner({
        resolve: fakeResolve,
        spawn: (_cmd, _args, options) => {
          const managed = spawnTestSearch(
            process.execPath,
            [
              '-e',
              `
          const { spawn } = require('node:child_process');
          const descendant = spawn(process.execPath, ['-e',
            "process.on('SIGTERM', () => {}); process.stdout.write(process.pid + '.ts' + String.fromCharCode(0)); process.stderr.write('ready'); setInterval(() => {}, 1000);"
          ], { stdio: ['ignore', 'inherit', 'pipe'] });
          descendant.stderr.once('data', () => process.exit(0));
        `,
            ],
            { ...options, postExitDrainMs: 20 },
          );
          managed.child.stdout?.once('data', (data: Buffer) => {
            descendant = Number.parseInt(data.toString(), 10);
          });
          return managed;
        },
      });
      const input = await normalizeSearchInput({ timeout_ms: 3000 }, repoDir);
      try {
        const pending = within(run(input, new AbortController().signal));
        await expect(pending).resolves.toMatchObject({ exitCode: 0 });
        const result = await pending;
        expect(descendant).toBeDefined();
        expect(result.files).toEqual([`${repoDir}/src/${descendant}.ts`]);
        expect(result.exitCode).toBe(0);
        expect(result.error).toContain('Output drain deadline exceeded');
        expect(result.incomplete).toBe(true);
        expect(result.timedOut).toBe(false);
        for (let i = 0; i < 100 && isAlive(descendant); i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(isAlive(descendant)).toBe(false);
      } finally {
        if (descendant && isAlive(descendant))
          process.kill(descendant, 'SIGKILL');
      }
    },
  );

  testPosix(
    'preserves the task signal exposed by the common supervisor',
    async () => {
      const run = createRipgrepRunner({
        resolve: fakeResolve,
        spawn: (_cmd, _args, options) =>
          spawnTestSearch(
            process.execPath,
            ['-e', "process.kill(process.pid, 'SIGTERM')"],
            options,
          ),
      });
      const input = await normalizeSearchInput({}, temps.createRepo());
      const result = await run(input, new AbortController().signal);
      expect(result.error).toContain('SIGTERM');
      expect(result.incomplete).toBe(true);
    },
  );

  testPosix.each([
    { code: 0, rows: '', error: undefined, incomplete: false },
    { code: 1, rows: '', error: undefined, incomplete: false },
    { code: 2, rows: '', error: 'permission denied', incomplete: true },
    { code: 2, rows: 'a.ts\0', error: undefined, incomplete: true },
  ])(
    'preserves worker exit $code and rows %j through supervisor cleanup',
    async ({ code, rows, error, incomplete }) => {
      let managed: ManagedSearch | undefined;
      const repoDir = temps.createRepo();
      const run = createRipgrepRunner({
        resolve: fakeResolve,
        killGraceMs: 10,
        spawn: (_cmd, _args, options) => {
          const spawned = spawnTestSearch(
            process.execPath,
            [
              '-e',
              `process.stdout.write(${JSON.stringify(rows)}); process.stderr.write('permission denied'); process.exit(${code});`,
            ],
            options,
          );
          if (!('child' in spawned))
            throw new Error('expected POSIX supervisor');
          managed = spawned;
          return spawned;
        },
      });
      const input = await normalizeSearchInput({}, repoDir);
      const result = await run(input, new AbortController().signal);
      expect(result.exitCode).toBe(code);
      expect(result.incomplete).toBe(incomplete);
      expect(result.files).toEqual(rows ? [`${repoDir}/src/a.ts`] : []);
      expect(result.error).toBe(error);
      expect(isAlive(managed?.child.pid)).toBe(false);

      // This capability outlives the supervisor, whose numeric PGID is now
      // reusable. Calling it again must not signal either that PID or a group.
      if (!managed) throw new Error('expected managed search');
      const numericKill = spyOn(process, 'kill').mockReturnValue(true);
      const directKill = spyOn(managed.child, 'kill').mockReturnValue(true);
      try {
        managed.stop();
        managed.stop();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(numericKill).not.toHaveBeenCalled();
        expect(directKill).not.toHaveBeenCalled();
      } finally {
        directKill.mockRestore();
        numericKill.mockRestore();
      }
    },
  );

  testPosix(
    'fails closed when the supervisor runtime is unavailable',
    async () => {
      const repoDir = temps.createRepo();
      const run = createRipgrepRunner({
        resolve: fakeResolve,
        spawn: (cmd, args, options) =>
          spawnTestSearch(cmd, args, {
            ...options,
            supervisorExecutable: `${repoDir}/nonexistent-node`,
          }),
      });
      const input = await normalizeSearchInput({}, repoDir);
      const result = await run(input, new AbortController().signal);
      expect(result.error).toContain('infrastructure unavailable');
      expect(result.incomplete).toBe(true);
    },
  );

  testPosix(
    'disconnect makes the supervisor terminate its own group without a parent fallback',
    async () => {
      const repoDir = temps.createRepo();
      let worker: number | undefined;
      const run = createRipgrepRunner({
        resolve: fakeResolve,
        killGraceMs: 20,
        spawn: (_cmd, _args, options) => {
          const managed = spawnTestSearch(
            process.execPath,
            [
              '-e',
              `
          process.on('SIGTERM', () => {});
          process.stdout.write(process.pid + '.ts\\0');
          setInterval(() => {}, 1000);
        `,
            ],
            options,
          );
          if (!('child' in managed))
            throw new Error('expected POSIX supervisor');
          managed.child.stdout?.once('data', (data: Buffer) => {
            worker = Number.parseInt(data.toString(), 10);
            queueMicrotask(() => managed.child.disconnect());
          });
          return managed;
        },
      });
      const input = await normalizeSearchInput({ timeout_ms: 2000 }, repoDir);
      try {
        const result = await run(input, new AbortController().signal);
        expect(worker).toBeDefined();
        expect(result.files).toEqual([`${repoDir}/src/${worker}.ts`]);
        expect(result.error).toContain('cleanup unconfirmed');
        expect(result.incomplete).toBe(true);
        for (let i = 0; i < 100 && isAlive(worker); i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(isAlive(worker)).toBe(false);
      } finally {
        if (worker && isAlive(worker)) process.kill(worker, 'SIGKILL');
      }
    },
  );

  test('reports spawn rejection as an error instead of empty results', async () => {
    const repoDir = temps.createRepo();
    const runRipgrep = createRipgrepRunner({
      resolve: async () => ({ path: 'rg', backend: 'rg', source: 'system-rg' }),
      spawn: () => {
        throw new Error('spawn failed');
      },
    });
    const input = await normalizeSearchInput({}, repoDir);
    const result = await runRipgrep(input, new AbortController().signal);

    expect(result.files).toEqual([]);
    expect(result.error).toContain('spawn failed');
  });

  test('returns quickly when resolve fails before the timeout elapses', async () => {
    const repoDir = temps.createRepo();
    const runRipgrep = createRipgrepRunner({
      resolve: async () => {
        throw new Error('resolve failed');
      },
      spawn: () => {
        throw new Error('spawn should not run');
      },
    });
    const input = await normalizeSearchInput({ timeout_ms: 1000 }, repoDir);
    const started = Date.now();
    const result = await runRipgrep(input, new AbortController().signal);

    expect(Date.now() - started).toBeLessThan(250);
    expect(result.error).toContain('resolve failed');
  });

  test('applies the global deadline to slow resolver setup', async () => {
    const repoDir = temps.createRepo();
    const runRipgrep = createRipgrepRunner({
      resolve: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error('resolve failed slowly');
      },
      spawn: () => {
        throw new Error('spawn should not run');
      },
    });
    const input = await normalizeSearchInput({ timeout_ms: 20 }, repoDir);
    const started = Date.now();
    const result = await runRipgrep(input, new AbortController().signal);

    // The deadline covers preparation (resolve/auto-install) too, so a
    // hung setup is cut at timeout_ms instead of blocking the search.
    expect(Date.now() - started).toBeLessThan(250);
    expect(result.timedOut).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  test('returns quickly when spawn throws before the timeout elapses', async () => {
    const repoDir = temps.createRepo();
    const runRipgrep = createRipgrepRunner({
      resolve: async () => ({ path: 'rg', backend: 'rg', source: 'system-rg' }),
      spawn: () => {
        throw new Error('spawn threw');
      },
    });
    const input = await normalizeSearchInput({ timeout_ms: 1000 }, repoDir);
    const started = Date.now();
    const result = await runRipgrep(input, new AbortController().signal);

    expect(Date.now() - started).toBeLessThan(250);
    expect(result.error).toContain('spawn threw');
  });

  test.each(['', 'rg: permission denied'])(
    'reports exit 2 without rows, with stderr %j',
    async (diagnostic) => {
      const repoDir = temps.createRepo();
      const run = createRipgrepRunner({
        resolve: fakeResolve,
        spawn: (_cmd, _args, options) =>
          spawnScript(
            `process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(2);`,
            options,
          ),
      });
      const result = await run(
        await normalizeSearchInput({}, repoDir),
        new AbortController().signal,
      );
      expect(result.files).toEqual([]);
      expect(result.exitCode).toBe(2);
      expect(result.incomplete).toBe(true);
      expect(result.error).toBe(diagnostic || 'rg exited with code 2');
    },
  );

  test('caps stderr retention from a supervised search', async () => {
    const repoDir = temps.createRepo();
    const run = createRipgrepRunner({
      resolve: fakeResolve,
      spawn: (_cmd, _args, options) =>
        spawnScript(
          "process.stderr.write('x'.repeat(1_048_576)); process.stdout.write('a.ts\\0');",
          options,
        ),
    });
    const input = await normalizeSearchInput(
      { limit: 1, timeout_ms: 3000 },
      repoDir,
    );
    const result = await run(input, new AbortController().signal);
    expect(result.files).toEqual([`${repoDir}/src/a.ts`]);
    expect(result.stderr.length).toBeLessThanOrEqual(8 * 1024 + 40);
    expect(result.stderr).toContain('[stderr truncated at 8192 bytes]');
  });

  test('treats exit 2 with collected rows as a partial success', async () => {
    const repoDir = temps.createRepo();
    const run = createRipgrepRunner({
      resolve: fakeResolve,
      spawn: (_cmd, _args, options) =>
        spawnScript(
          "process.stdout.write('a.ts\\0'); process.stderr.write('rg: /locked: Permission denied'); process.exit(2);",
          options,
        ),
    });
    const result = await run(
      await normalizeSearchInput({}, repoDir),
      new AbortController().signal,
    );
    expect(result.files).toEqual([`${repoDir}/src/a.ts`]);
    expect(result.exitCode).toBe(2);
    expect(result.incomplete).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('reassembles multibyte paths split across stream chunks deterministically', async () => {
    // Direct stream test: every PassThrough.write() is one data event, so
    // the multibyte sequence is guaranteed to be split across chunks.
    const repoDir = temps.createRepo();
    const input = await normalizeSearchInput({ timeout_ms: 2000 }, repoDir);
    const stream = new PassThrough();
    const collected = collectMatchedPaths(input, stream);
    const payload = Buffer.from('é.ts\0odd\nname.ts\0', 'utf-8');
    for (const byte of payload) {
      stream.write(Buffer.from([byte]));
    }
    stream.end();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(collected.read()).toEqual([
      `${repoDir}/src/é.ts`,
      `${repoDir}/src/odd\nname.ts`,
    ]);
  });

  test('never publishes a path from a fragment without NUL terminator', async () => {
    const repoDir = temps.createRepo();
    const input = await normalizeSearchInput({ timeout_ms: 2000 }, repoDir);
    const stream = new PassThrough();
    const collected = collectMatchedPaths(input, stream);
    stream.write(Buffer.from('a.ts\0')); // complete record
    stream.write(Buffer.from([0xc3])); // dangling first byte of "é"
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The incomplete fragment must NOT become a path, even though the
    // stream ended without a terminator.
    expect(collected.read()).toEqual([`${repoDir}/src/a.ts`]);
  });
});
