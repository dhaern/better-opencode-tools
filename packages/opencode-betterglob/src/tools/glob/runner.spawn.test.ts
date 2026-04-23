/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { spawn as nodeSpawn } from 'node:child_process';
import { normalizeGlobInput } from './normalize';
import { createRipgrepRunner } from './runner';
import { createRepoContext, createTempTracker } from './test-helpers';

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

  test('reports spawn rejection as an error instead of empty results', async () => {
    const repoDir = temps.createRepo();
    const runRipgrep = createRipgrepRunner({
      resolve: async () => ({ path: 'rg', backend: 'rg', source: 'system-rg' }),
      spawn: () => {
        throw new Error('spawn failed');
      },
    });
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src' },
      createRepoContext(repoDir) as any,
    );
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
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src', timeout_ms: 1000 },
      createRepoContext(repoDir) as any,
    );
    const started = Date.now();
    const result = await runRipgrep(input, new AbortController().signal);

    expect(Date.now() - started).toBeLessThan(250);
    expect(result.error).toContain('resolve failed');
  });

  test('does not treat slow resolver setup as rg process timeout', async () => {
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
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src', timeout_ms: 20 },
      createRepoContext(repoDir) as any,
    );
    const started = Date.now();
    const result = await runRipgrep(input, new AbortController().signal);

    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(result.timedOut).toBe(false);
    expect(result.error).toContain('resolve failed slowly');
  });

  test('returns quickly when spawn throws before the timeout elapses', async () => {
    const repoDir = temps.createRepo();
    const runRipgrep = createRipgrepRunner({
      resolve: async () => ({ path: 'rg', backend: 'rg', source: 'system-rg' }),
      spawn: () => {
        throw new Error('spawn threw');
      },
    });
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src', timeout_ms: 1000 },
      createRepoContext(repoDir) as any,
    );
    const started = Date.now();
    const result = await runRipgrep(input, new AbortController().signal);

    expect(Date.now() - started).toBeLessThan(250);
    expect(result.error).toContain('spawn threw');
  });

  test('returns near the hard timeout instead of waiting for process exit', async () => {
    const repoDir = temps.createRepo();
    const runRipgrep = createRipgrepRunner({
      resolve: async () => ({
        path: process.execPath,
        backend: 'rg',
        source: 'system-rg',
      }),
      spawn: (_cmd, _args, _opts) =>
        nodeSpawn(
          process.execPath,
          [
            '-e',
            "process.stdout.write('a.ts\\0b.ts\\0'); setInterval(() => {}, 1000)",
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ),
    });
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src', timeout_ms: 200 },
      createRepoContext(repoDir) as any,
    );
    const started = Date.now();
    const result = await runRipgrep(input, new AbortController().signal);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(result.timedOut).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(result.files).toEqual([
      `${repoDir}/src/a.ts`,
      `${repoDir}/src/b.ts`,
    ]);
  });

  test('kills stubborn child after timeout grace', async () => {
    const repoDir = temps.createRepo();
    let child: ReturnType<typeof nodeSpawn> | undefined;
    const runRipgrep = createRipgrepRunner({
      resolve: async () => ({
        path: process.execPath,
        backend: 'rg',
        source: 'system-rg',
      }),
      spawn: (_cmd, _args, _opts) => {
        child = nodeSpawn(
          process.execPath,
          [
            '-e',
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        return child;
      },
      killGraceMs: 20,
    });
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src', timeout_ms: 20 },
      createRepoContext(repoDir) as any,
    );

    const result = await runRipgrep(input, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(result.timedOut).toBe(true);
    expect(isAlive(child?.pid)).toBe(false);
  });

  test('stops early at limit plus one without waiting for timeout', async () => {
    const repoDir = temps.createRepo();
    const runRipgrep = createRipgrepRunner({
      resolve: async () => ({
        path: process.execPath,
        backend: 'rg',
        source: 'system-rg',
      }),
      spawn: (_cmd, _args, _opts) =>
        nodeSpawn(
          process.execPath,
          [
            '-e',
            "process.stdout.write(Array.from({length: 10}, (_, i) => 'f' + i + '.ts').join('\\0') + '\\0'); setInterval(() => {}, 1000)",
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ),
    });
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src', limit: 2, timeout_ms: 5000 },
      createRepoContext(repoDir) as any,
    );
    const started = Date.now();
    const result = await runRipgrep(input, new AbortController().signal);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.count).toBe(2);
  });

  test('kills stubborn child after early stop grace', async () => {
    const repoDir = temps.createRepo();
    let child: ReturnType<typeof nodeSpawn> | undefined;
    const runRipgrep = createRipgrepRunner({
      resolve: async () => ({
        path: process.execPath,
        backend: 'rg',
        source: 'system-rg',
      }),
      spawn: (_cmd, _args, _opts) => {
        child = nodeSpawn(
          process.execPath,
          [
            '-e',
            "process.on('SIGTERM', () => {}); process.stdout.write(Array.from({length: 10}, (_, i) => 'f' + i + '.ts').join('\\0') + '\\0'); setInterval(() => {}, 1000)",
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        return child;
      },
      killGraceMs: 20,
    });
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src', limit: 2, timeout_ms: 5000 },
      createRepoContext(repoDir) as any,
    );

    const result = await runRipgrep(input, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(result.truncated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(isAlive(child?.pid)).toBe(false);
  });
});
