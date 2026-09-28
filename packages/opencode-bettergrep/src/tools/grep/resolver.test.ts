/// <reference types="bun-types" />
import { describe, expect, jest, mock, test } from 'bun:test';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { probeExecutable } from './cli-probe';
import {
  invalidateGrepCliResolverCache,
  resolveGrepCli,
  resolveGrepCliWithAutoInstall,
} from './resolver';
import { setAbortKind } from './runtime';
import { createTempTracker } from './test-helpers';

describe('tools/grep/resolver', () => {
  const temps = createTempTracker({ resetResolver: true });

  test('memo reuses a valid probe per deps, then invalidates on stat, PATH, and deps changes', async () => {
    const dir = temps.createDir('bettergrep-probe-memo');
    const binary = path.join(dir, 'rg-stub');
    const calls = path.join(dir, 'calls');
    const script = (tag: string) =>
      `#!/bin/sh\nprintf 'hit\\n' >> "${calls}"\nprintf 'ripgrep ${tag}\\n'\n`;
    writeFileSync(binary, script('v1'), { mode: 0o755 });
    const deps = {
      findExecutable: (name: string) => (name === 'rg' ? binary : null),
    };
    const run = () => resolveGrepCliWithAutoInstall(deps);
    const count = () => readFileSync(calls, 'utf8').trim().split('\n').length;

    expect((await run()).path).toBe(binary);
    expect((await run()).path).toBe(binary);
    expect(count()).toBe(1);

    writeFileSync(binary, script('v222222'), { mode: 0o755 });
    utimesSync(
      binary,
      new Date('2020-01-01T00:00:00Z'),
      new Date('2020-01-01T00:00:00Z'),
    );
    await run();
    expect(count()).toBe(2);

    const previousPath = process.env.PATH;
    const previousCache = process.env.XDG_CACHE_HOME;
    try {
      process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`;
      await run();
      expect(count()).toBe(3);
      process.env.XDG_CACHE_HOME = dir;
      await run();
      expect(count()).toBe(4);
    } finally {
      process.env.PATH = previousPath;
      process.env.XDG_CACHE_HOME = previousCache;
    }
    await run();
    expect(count()).toBe(5);
    await resolveGrepCliWithAutoInstall({ ...deps });
    expect(count()).toBe(6);
  });

  test('GNU memo survives rejected rg until it changes', async () => {
    const rg = path.join(temps.createDir('bettergrep-rejected-rg'), 'rg');
    writeFileSync(rg, '');
    const isSupportedRipgrep = mock(() => readFileSync(rg, 'utf8') === 'rg');
    const deps = {
      findExecutable: (name: string) => (name === 'rg' ? rg : process.execPath),
      getInstalledRipgrepPath: () => null,
      isSupportedGrep: () => true,
      isSupportedRipgrep,
      installLatestStableRipgrep: () => Promise.reject(Error('offline')),
    };
    expect((await resolveGrepCliWithAutoInstall(deps)).backend).toBe('grep');
    expect((await resolveGrepCliWithAutoInstall(deps)).backend).toBe('grep');
    expect(isSupportedRipgrep).toHaveBeenCalledTimes(1);
    writeFileSync(rg, 'rg');
    expect((await resolveGrepCliWithAutoInstall(deps)).backend).toBe('rg');
  });

  test.each([
    {
      name: 'prioritizes system rg over managed rg and system grep',
      deps: {
        findExecutable: (name: string) => {
          if (name === 'rg') {
            return '/usr/bin/rg';
          }

          if (name === 'grep') {
            return '/usr/bin/grep';
          }

          return null;
        },
        getInstalledRipgrepPath: () =>
          '/home/user/.cache/opencode-bettergrep/grep/bin/rg',
        isSupportedRipgrep: () => true,
      },
      expected: {
        path: '/usr/bin/rg',
        backend: 'rg',
        source: 'system-rg',
      },
    },
    {
      name: 'falls back to managed rg when system rg is present but invalid',
      deps: {
        findExecutable: (name: string) => {
          if (name === 'rg') {
            return '/usr/bin/rg';
          }

          if (name === 'grep') {
            return '/usr/bin/grep';
          }

          return null;
        },
        getInstalledRipgrepPath: () =>
          '/home/user/.cache/opencode-bettergrep/grep/bin/rg',
        isSupportedRipgrep: () => false,
      },
      expected: {
        path: '/home/user/.cache/opencode-bettergrep/grep/bin/rg',
        backend: 'rg',
        source: 'managed-rg',
      },
    },
    {
      name: 'falls back to GNU grep when system rg is invalid and no managed rg exists',
      deps: {
        findExecutable: (name: string) => {
          if (name === 'rg') {
            return '/usr/bin/rg';
          }

          if (name === 'grep') {
            return '/usr/bin/grep';
          }

          return null;
        },
        getInstalledRipgrepPath: () => null,
        isSupportedRipgrep: () => false,
        isSupportedGrep: () => true,
      },
      expected: {
        path: '/usr/bin/grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    },
    {
      name: 'prefers managed rg before system grep',
      deps: {
        findExecutable: (name: string) =>
          name === 'grep' ? '/usr/bin/grep' : null,
        getInstalledRipgrepPath: () =>
          '/home/user/.cache/opencode-bettergrep/grep/bin/rg',
      },
      expected: {
        path: '/home/user/.cache/opencode-bettergrep/grep/bin/rg',
        backend: 'rg',
        source: 'managed-rg',
      },
    },
    {
      name: 'ignores non-GNU grep fallbacks',
      deps: {
        findExecutable: (name: string) =>
          name === 'grep' ? '/usr/bin/grep' : null,
        getInstalledRipgrepPath: () => null,
        isSupportedGrep: () => false,
      },
      expected: {
        path: 'rg',
        backend: 'rg',
        source: 'missing-rg',
      },
    },
  ])('resolveGrepCli $name', ({ deps, expected }) => {
    expect(resolveGrepCli(deps)).toEqual(expected);
  });

  test('probeExecutable enforces its timeout for a non-terminating binary', async () => {
    const result = await probeExecutable(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      undefined,
      20,
    );

    expect(result.timedOut).toBe(true);
  });

  test('probeExecutable times out with inherited pipes still open', async () => {
    const spawn = (() => ({
      proc: { stdout: new PassThrough(), stderr: new PassThrough() },
      exited: new Promise<number>(() => {}),
      kill: () => true,
      exitCode: null,
    })) as never;
    const result = await probeExecutable('stub', [], undefined, 20, spawn);
    expect(result.timedOut).toBe(true);
  });

  test('probeExecutable timeout uses one deadline with a stub process and fake timers', async () => {
    jest.useFakeTimers();
    try {
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const empty = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      const kill = mock(() => {
        resolveExit(1);
        return true;
      });
      const proc = {
        proc: { stdout: empty(), stderr: empty() },
        exited,
        kill,
        get exitCode() {
          return null;
        },
      };
      const pending = probeExecutable(
        'stub',
        ['--version'],
        undefined,
        500,
        () => proc as never,
      );
      jest.advanceTimersByTime(499);
      expect(kill).toHaveBeenCalledTimes(0);
      jest.advanceTimersByTime(1);
      expect((await pending).timedOut).toBe(true);
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('probeExecutable aborts a running probe without leaving it pending', async () => {
    const controller = new AbortController();
    const pending = probeExecutable(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      controller.signal,
      5_000,
    );

    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow(
      /cancelled before execution started/i,
    );
  });

  test('resolveGrepCliWithAutoInstall installs ripgrep once on miss', async () => {
    let installedPath: string | null = null;
    const installLatest = mock(async () => {
      installedPath = '/home/user/.cache/opencode-bettergrep/grep/bin/rg';
      return installedPath;
    });

    const resolverDeps = {
      findExecutable: (name: string) =>
        name === 'grep' ? '/usr/bin/grep' : null,
      getInstalledRipgrepPath: () => installedPath,
      installLatestStableRipgrep: installLatest,
    };

    const first = await resolveGrepCliWithAutoInstall(resolverDeps);
    const second = await resolveGrepCliWithAutoInstall(resolverDeps);

    expect(first).toEqual({
      path: '/home/user/.cache/opencode-bettergrep/grep/bin/rg',
      backend: 'rg',
      source: 'managed-rg',
    });
    expect(second).toEqual(first);
    expect(installLatest.mock.calls).toHaveLength(1);
  });

  test('resolveGrepCliWithAutoInstall falls back to system grep when install fails', async () => {
    const cli = await resolveGrepCliWithAutoInstall({
      findExecutable: (name) => (name === 'grep' ? '/usr/bin/grep' : null),
      getInstalledRipgrepPath: () => null,
      installLatestStableRipgrep: async () => {
        throw new Error('network down');
      },
    });

    expect(cli).toEqual({
      path: '/usr/bin/grep',
      backend: 'grep',
      source: 'system-gnu-grep',
    });
  });

  test('failed install with GNU grep retries only after the negative-cache TTL', async () => {
    jest.useFakeTimers();
    try {
      const install = mock(async () => {
        throw new Error('offline');
      });
      const deps = {
        findExecutable: (name: string) =>
          name === 'grep' ? '/usr/bin/grep' : null,
        getInstalledRipgrepPath: () => null,
        isSupportedGrep: () => true,
        installLatestStableRipgrep: install,
      };
      for (let index = 0; index < 3; index++) {
        expect((await resolveGrepCliWithAutoInstall(deps)).backend).toBe(
          'grep',
        );
      }
      expect(install).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(600_001);
      expect((await resolveGrepCliWithAutoInstall(deps)).backend).toBe('grep');
      expect(install).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  async function attemptsAfterAbortingInstall(
    reason: 'runner-timeout' | 'public-timeout' | 'cancel',
  ): Promise<number> {
    jest.useFakeTimers();
    try {
      let attempts = 0;
      let started!: () => void;
      const installed = new Promise<void>((resolve) => {
        started = resolve;
      });
      const deps = {
        findExecutable: (name: string) =>
          name === 'grep' ? '/usr/bin/grep' : null,
        getInstalledRipgrepPath: () => null,
        isSupportedGrep: () => true,
        installLatestStableRipgrep: (signal?: AbortSignal) => {
          attempts += 1;
          if (attempts > 1) return Promise.reject(new Error('offline'));
          started();
          return new Promise<string>((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          });
        },
      };
      const controller = new AbortController();
      const first = resolveGrepCliWithAutoInstall(deps, controller.signal);
      await installed;
      if (reason === 'runner-timeout')
        setAbortKind(controller.signal, 'timeout');
      controller.abort(
        reason === 'public-timeout'
          ? new DOMException('deadline', 'TimeoutError')
          : undefined,
      );
      await expect(first).rejects.toThrow(
        /cancelled before execution started/i,
      );
      await Promise.resolve();
      expect((await resolveGrepCliWithAutoInstall(deps)).backend).toBe('grep');
      return attempts;
    } finally {
      jest.useRealTimers();
    }
  }

  test('runner timeout with GNU grep memoizes the failed install', async () => {
    expect(await attemptsAfterAbortingInstall('runner-timeout')).toBe(1);
  });

  test('public TimeoutError with GNU grep memoizes the failed install', async () => {
    expect(await attemptsAfterAbortingInstall('public-timeout')).toBe(1);
  });

  test('user cancellation with GNU grep permits another install attempt', async () => {
    expect(await attemptsAfterAbortingInstall('cancel')).toBe(2);
  });

  test('explicit invalidation permits an immediate retry of a failed install', async () => {
    const install = mock(async () => {
      throw new Error('offline');
    });
    const deps = {
      findExecutable: (name: string) =>
        name === 'grep' ? '/usr/bin/grep' : null,
      getInstalledRipgrepPath: () => null,
      isSupportedGrep: () => true,
      installLatestStableRipgrep: install,
    };
    await resolveGrepCliWithAutoInstall(deps);
    invalidateGrepCliResolverCache();
    await resolveGrepCliWithAutoInstall(deps);
    expect(install).toHaveBeenCalledTimes(2);
  });

  test('hung installer has its own deadline and falls back to GNU grep', async () => {
    jest.useFakeTimers();
    try {
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      let installSignal: AbortSignal | undefined;
      const deps = {
        findExecutable: (name: string) =>
          name === 'grep' ? '/usr/bin/grep' : null,
        getInstalledRipgrepPath: () => null,
        isSupportedGrep: () => true,
        installLatestStableRipgrep: (signal?: AbortSignal) => {
          installSignal = signal;
          started();
          return new Promise<string>(() => {});
        },
      };
      const pending = resolveGrepCliWithAutoInstall(deps);
      await startedPromise;
      jest.advanceTimersByTime(30_000);
      expect(installSignal?.aborted).toBe(true);
      expect((await pending).backend).toBe('grep');
    } finally {
      jest.useRealTimers();
    }
  });

  test('without GNU grep a failed install is retried on every call', async () => {
    const install = mock(async () => {
      throw new Error('offline');
    });
    const deps = {
      findExecutable: () => null,
      getInstalledRipgrepPath: () => null,
      installLatestStableRipgrep: install,
    };
    for (let index = 0; index < 2; index++) {
      await expect(resolveGrepCliWithAutoInstall(deps)).rejects.toThrow(
        'offline',
      );
    }
    expect(install).toHaveBeenCalledTimes(2);
  });

  test('resolveGrepCliWithAutoInstall does not cache aborts as permanent install failures', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveGrepCliWithAutoInstall(
        {
          findExecutable: () => null,
          getInstalledRipgrepPath: () => null,
          installLatestStableRipgrep: async () => {
            throw new Error('should not reach installer when already aborted');
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow(/cancelled before execution started/i);

    const cli = await resolveGrepCliWithAutoInstall({
      findExecutable: () => null,
      getInstalledRipgrepPath: () => null,
      installLatestStableRipgrep: async () => '/tmp/managed-rg',
    });

    expect(cli).toEqual({
      path: '/tmp/managed-rg',
      backend: 'rg',
      source: 'managed-rg',
    });
  });

  test('resolveGrepCliWithAutoInstall retries after an aborted install attempt', async () => {
    let attempts = 0;
    const controller = new AbortController();

    const firstAttempt = resolveGrepCliWithAutoInstall(
      {
        findExecutable: () => null,
        getInstalledRipgrepPath: () => null,
        installLatestStableRipgrep: async (signal?: AbortSignal) => {
          attempts += 1;
          await new Promise<never>((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          });
          return '/tmp/unreachable';
        },
      },
      controller.signal,
    );

    controller.abort();

    await expect(firstAttempt).rejects.toThrow(
      /cancelled before execution started/i,
    );

    const secondAttempt = await resolveGrepCliWithAutoInstall({
      findExecutable: () => null,
      getInstalledRipgrepPath: () => null,
      installLatestStableRipgrep: async () => {
        attempts += 1;
        return '/tmp/managed-rg';
      },
    });

    expect(attempts).toBe(2);
    expect(secondAttempt.source).toBe('managed-rg');
  });

  test('resolveGrepCliWithAutoInstall does not let one caller abort a shared install for another waiter', async () => {
    let installSignal: AbortSignal | undefined;
    let resolveInstall: ((path: string) => void) | undefined;
    let rejectInstall: ((error: Error) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const firstController = new AbortController();
    const installLatest = mock((signal?: AbortSignal) => {
      installSignal = signal;
      markStarted?.();
      return new Promise<string>((resolve, reject) => {
        resolveInstall = resolve;
        rejectInstall = reject;
        signal?.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    });

    const deps = {
      findExecutable: () => null,
      getInstalledRipgrepPath: () => null,
      installLatestStableRipgrep: installLatest,
    };

    const firstWaiter = resolveGrepCliWithAutoInstall(
      deps,
      firstController.signal,
    );
    await started;
    const secondWaiter = resolveGrepCliWithAutoInstall(deps);

    firstController.abort();

    await expect(firstWaiter).rejects.toThrow(
      /cancelled before execution started/i,
    );
    expect(installLatest.mock.calls).toHaveLength(1);
    expect(installSignal?.aborted).toBe(false);

    resolveInstall?.('/tmp/managed-rg');
    await expect(secondWaiter).resolves.toEqual({
      path: '/tmp/managed-rg',
      backend: 'rg',
      source: 'managed-rg',
    });

    expect(installSignal?.aborted).toBe(false);
    expect(rejectInstall).toBeDefined();
  });

  test('resolveGrepCliWithAutoInstall aborts the shared install when the last waiter cancels', async () => {
    jest.useFakeTimers();
    try {
      let installSignal: AbortSignal | undefined;
      let markStarted: (() => void) | undefined;
      let markAborted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const aborted = new Promise<void>((resolve) => {
        markAborted = resolve;
      });
      const controller = new AbortController();

      const firstAttempt = resolveGrepCliWithAutoInstall(
        {
          findExecutable: () => null,
          getInstalledRipgrepPath: () => null,
          installLatestStableRipgrep: async (signal?: AbortSignal) => {
            installSignal = signal;
            markStarted?.();
            await new Promise<never>((_, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  markAborted?.();
                  const error = new Error('aborted');
                  error.name = 'AbortError';
                  reject(error);
                },
                { once: true },
              );
            });
            return '/tmp/unreachable';
          },
        },
        controller.signal,
      );

      await started;
      controller.abort();

      await expect(firstAttempt).rejects.toThrow(
        /cancelled before execution started/i,
      );
      expect(installSignal?.aborted).toBe(true);
      await aborted;

      const retry = await resolveGrepCliWithAutoInstall({
        findExecutable: () => null,
        getInstalledRipgrepPath: () => null,
        installLatestStableRipgrep: async () => '/tmp/managed-rg',
      });

      expect(retry).toEqual({
        path: '/tmp/managed-rg',
        backend: 'rg',
        source: 'managed-rg',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('resolveGrepCliWithAutoInstall throws a clear error when rg and grep are unavailable', async () => {
    await expect(
      resolveGrepCliWithAutoInstall({
        findExecutable: () => null,
        getInstalledRipgrepPath: () => null,
        installLatestStableRipgrep: async () => {
          throw new Error('network down');
        },
      }),
    ).rejects.toThrow(/Neither ripgrep \(rg\) nor GNU grep is available\./);
  });

  test('resolveGrepCliWithAutoInstall retries after a previous install failure when no fallback exists', async () => {
    let attempts = 0;

    await expect(
      resolveGrepCliWithAutoInstall({
        findExecutable: () => null,
        getInstalledRipgrepPath: () => null,
        installLatestStableRipgrep: async () => {
          attempts += 1;
          throw new Error(`network down ${attempts}`);
        },
      }),
    ).rejects.toThrow(/network down 1/);

    const second = await resolveGrepCliWithAutoInstall({
      findExecutable: () => null,
      getInstalledRipgrepPath: () => null,
      installLatestStableRipgrep: async () => {
        attempts += 1;
        return '/tmp/managed-rg';
      },
    });

    expect(attempts).toBe(2);
    expect(second).toEqual({
      path: '/tmp/managed-rg',
      backend: 'rg',
      source: 'managed-rg',
    });
  });
});
