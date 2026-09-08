/// <reference types="bun-types" />

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CleanupUnconfirmedError,
  SupervisorRuntimeError,
} from '../../utils/process-supervisor';
import {
  resetGlobCliResolverForTests,
  resolveGlobCli,
  resolveGlobCliAsync,
  resolveGlobCliWithAutoInstall,
} from './resolver';

describe('tools/glob/resolver', () => {
  afterEach(() => {
    resetGlobCliResolverForTests();
  });

  for (const stage of ['runtime', 'probe', 'cache'] as const) {
    test.each([
      new SupervisorRuntimeError(),
      new CleanupUnconfirmedError('validation supervisor died'),
    ])(`${stage} infrastructure rejection never resolves missing-rg or permits installation: %s`, async (error) => {
      let installs = 0;
      const deps = {
        ensureSupervisorRuntimeAsync: async () => {
          if (stage === 'runtime') throw error;
        },
        findExecutableAsync: async () =>
          stage === 'probe' ? '/system/rg' : null,
        validateExecutableAsync: async () => {
          throw error;
        },
        // Inject the cache boundary: downloader must preserve the original
        // validation rejection for this contract to hold in production.
        getInstalledRipgrepPathAsync: async () => {
          throw error;
        },
        installLatestStableRipgrep: async () => {
          installs++;
          return '/managed/rg';
        },
      };
      await expect(resolveGlobCliAsync(deps)).rejects.toBe(error);
      await expect(resolveGlobCliWithAutoInstall(deps)).rejects.toBe(error);
      await expect(
        resolveGlobCliWithAutoInstall(deps, undefined, {
          allowAutoInstall: true,
        }),
      ).rejects.toBe(error);
      expect(installs).toBe(0);
    });
  }

  test.each([
    new SupervisorRuntimeError(),
    new CleanupUnconfirmedError('publication validation supervisor died'),
  ])('preserves infrastructure errors from an authorized installation: %s', async (error) => {
    let logs = 0;
    await expect(
      resolveGlobCliWithAutoInstall(
        {
          ensureSupervisorRuntimeAsync: async () => {},
          findExecutableAsync: async () => null,
          getInstalledRipgrepPathAsync: async () => null,
          installLatestStableRipgrep: async () => {
            throw error;
          },
          logger: () => {
            logs++;
          },
        },
        undefined,
        { allowAutoInstall: true },
      ),
    ).rejects.toBe(error);
    expect(logs).toBe(0);
  });

  test.skipIf(process.platform === 'win32')(
    'real probe supervisor death cannot become absence or authorize auto-install',
    async () => {
      const dir = await mkdtemp(
        path.join(os.tmpdir(), 'betterglob-probe-death-'),
      );
      const executable = path.join(dir, 'rg');
      let cacheReads = 0;
      let installs = 0;
      // Only the private supervisor is this shell's parent. The shell exits too;
      // no persistent descendant or saved-PGID test teardown is needed.
      await writeFile(executable, '#!/bin/sh\nkill -KILL "$PPID"\nexit 0\n', {
        mode: 0o755,
      });
      const deps = {
        findExecutableAsync: async () => executable,
        getInstalledRipgrepPathAsync: async () => {
          cacheReads++;
          return null;
        },
        installLatestStableRipgrep: async () => {
          installs++;
          return '/managed/rg';
        },
      };
      try {
        await expect(resolveGlobCliAsync(deps)).rejects.toBeInstanceOf(
          CleanupUnconfirmedError,
        );
        await expect(
          resolveGlobCliWithAutoInstall(deps, undefined, {
            allowAutoInstall: true,
          }),
        ).rejects.toBeInstanceOf(CleanupUnconfirmedError);
        expect(cacheReads).toBe(0);
        expect(installs).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'real probe propagates EACCES but allows ENOENT and negative validation',
    async () => {
      const dir = await mkdtemp(
        path.join(os.tmpdir(), 'betterglob-probe-errors-'),
      );
      const denied = path.join(dir, 'denied');
      const negative = path.join(dir, 'negative');
      await writeFile(denied, '#!/bin/sh\necho ripgrep\n', { mode: 0o600 });
      await writeFile(negative, '#!/bin/sh\necho ripgrep\nexit 1\n', {
        mode: 0o755,
      });
      const deps = (file: string) => ({
        findExecutableAsync: async () => file,
        getInstalledRipgrepPathAsync: async () => null,
      });
      try {
        await expect(resolveGlobCliAsync(deps(denied))).rejects.toMatchObject({
          code: 'EACCES',
        });
        for (const file of [path.join(dir, 'missing'), negative]) {
          await expect(resolveGlobCliAsync(deps(file))).resolves.toMatchObject({
            source: 'missing-rg',
          });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test('prefers system rg when available', () => {
    expect(
      resolveGlobCli({
        findExecutable: () => '/usr/bin/rg',
        getInstalledRipgrepPath: () => null,
        validateExecutable: () => true,
      }),
    ).toEqual({
      path: '/usr/bin/rg',
      backend: 'rg',
      source: 'system-rg',
    });
  });

  test.skipIf(process.platform === 'win32' || !process.versions.bun)(
    'missing node fails preflight before rg lookup, validation, managed cache or authorized installation',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'betterglob-no-node-'));
      const originalPath = process.env.PATH;
      const calls: string[] = [];
      const deps = {
        findExecutableAsync: async () => {
          calls.push('find');
          return '/system/rg';
        },
        validateExecutableAsync: async () => {
          calls.push('validate');
          return true;
        },
        getInstalledRipgrepPathAsync: async () => {
          calls.push('managed');
          return null;
        },
        installLatestStableRipgrep: async () => {
          calls.push('install');
          return '/managed/rg';
        },
      };
      process.env.PATH = dir;
      try {
        await expect(resolveGlobCliAsync(deps)).rejects.toBeInstanceOf(
          SupervisorRuntimeError,
        );
        await expect(
          resolveGlobCliWithAutoInstall(deps, undefined, {
            allowAutoInstall: true,
          }),
        ).rejects.toMatchObject({ code: 'SUPERVISOR_RUNTIME_UNAVAILABLE' });
        await expect(
          resolveGlobCliWithAutoInstall(deps),
        ).rejects.toBeInstanceOf(SupervisorRuntimeError);
        expect(calls).toEqual([]);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test('falls back to managed rg when system rg is present but invalid', () => {
    expect(
      resolveGlobCli({
        findExecutable: () => '/usr/bin/rg',
        validateExecutable: () => false,
        getInstalledRipgrepPath: () => '/managed/rg',
      }),
    ).toEqual({
      path: '/managed/rg',
      backend: 'rg',
      source: 'managed-rg',
    });
  });

  test('treats invalid system rg as missing when no managed rg exists', () => {
    expect(
      resolveGlobCli({
        findExecutable: () => '/usr/bin/rg',
        validateExecutable: () => false,
        getInstalledRipgrepPath: () => null,
      }),
    ).toEqual({
      path: 'rg',
      backend: 'rg',
      source: 'missing-rg',
    });
  });

  test('uses an asynchronous executable probe in the execution resolver', async () => {
    let probed = false;
    await expect(
      resolveGlobCliAsync({
        findExecutableAsync: async () => '/system/rg',
        validateExecutableAsync: async () => {
          probed = true;
          return true;
        },
        getInstalledRipgrepPathAsync: async () => null,
      }),
    ).resolves.toEqual({
      path: '/system/rg',
      backend: 'rg',
      source: 'system-rg',
    });
    expect(probed).toBe(true);
  });

  test('cancels an asynchronous executable probe', async () => {
    const controller = new AbortController();
    const pending = resolveGlobCliAsync(
      {
        findExecutableAsync: async () => '/system/rg',
        validateExecutableAsync: async (_file, signal) =>
          new Promise<boolean>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new Error('probe aborted')),
              { once: true },
            );
          }),
        getInstalledRipgrepPathAsync: async () => null,
      },
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled|aborted/i);
  });

  test('cancels PATH lookup and observes its late rejection without using legacy APIs', async () => {
    const controller = new AbortController();
    let rejectLookup!: (error: Error) => void;
    const lookup = new Promise<string | null>((_resolve, reject) => {
      rejectLookup = reject;
    });
    let receivedSignal: AbortSignal | undefined;
    const legacy = () => {
      throw new Error('legacy synchronous API must not run');
    };
    const pending = resolveGlobCliAsync(
      {
        findExecutable: legacy,
        ensureSupervisorRuntimeAsync: async () => {},
        findExecutableAsync: (_name, signal) => {
          receivedSignal = signal;
          return lookup;
        },
        getInstalledRipgrepPath: legacy,
        validateExecutable: legacy,
      },
      controller.signal,
    );
    // The lookup remains pending while the event loop processes cancellation.
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(receivedSignal).toBe(controller.signal);
    rejectLookup(new Error('late lookup failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  (process.platform === 'win32' ? test.skip : test)(
    'resolves a real PATH executable without synchronous filesystem calls',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'betterglob-resolver-'));
      const executable = path.join(dir, 'rg');
      const originalPath = process.env.PATH;
      await writeFile(executable, '#!/bin/sh\necho ripgrep 14.1.1\n', {
        mode: 0o755,
      });
      process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
      const syncCalls = [
        spyOn(fs, 'statSync'),
        spyOn(fs, 'lstatSync'),
        spyOn(fs, 'accessSync'),
        spyOn(fs, 'existsSync'),
        spyOn(fs, 'readFileSync'),
      ];
      try {
        const resolved = await resolveGlobCliAsync({
          findExecutableAsync: async () => executable,
          getInstalledRipgrepPathAsync: async () => null,
          validateExecutableAsync: async () => true,
        });
        expect(resolved).toEqual({
          path: executable,
          backend: 'rg',
          source: 'system-rg',
        });
        for (const call of syncCalls) expect(call).not.toHaveBeenCalled();
      } finally {
        for (const call of syncCalls) call.mockRestore();
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test('cancels a pending failure logger and observes its late rejection', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const logging = new Promise<void>((resolve) => {
      started = resolve;
    });
    let rejectLog!: (error: Error) => void;
    const pending = resolveGlobCliWithAutoInstall(
      {
        findExecutableAsync: async () => null,
        getInstalledRipgrepPathAsync: async () => null,
        installLatestStableRipgrep: async () => {
          throw new Error('installation failed');
        },
        logger: async (_message, _data, signal) => {
          expect(signal?.aborted).toBe(false);
          started();
          return new Promise<void>((_resolve, reject) => {
            rejectLog = reject;
          });
        },
      },
      controller.signal,
      { allowAutoInstall: true },
    );
    await logging;
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/i);
    rejectLog(new Error('late logging failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  test('shares a single auto-install across concurrent waiters', async () => {
    let installs = 0;
    const installLatestStableRipgrep = async () => {
      installs += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return '/managed/rg';
    };

    const deps = {
      findExecutableAsync: async () => null,
      getInstalledRipgrepPathAsync: async () => null,
      installLatestStableRipgrep,
    };

    const [first, second] = await Promise.all([
      resolveGlobCliWithAutoInstall(deps, undefined, {
        allowAutoInstall: true,
      }),
      resolveGlobCliWithAutoInstall(deps, undefined, {
        allowAutoInstall: true,
      }),
    ]);

    expect(installs).toBe(1);
    expect(first).toEqual({
      path: '/managed/rg',
      backend: 'rg',
      source: 'managed-rg',
    });
    expect(second).toEqual(first);
  });

  test('refuses to auto-install without explicit authorization', async () => {
    let installs = 0;
    const deps = {
      findExecutableAsync: async () => null,
      getInstalledRipgrepPathAsync: async () => null,
      installLatestStableRipgrep: async () => {
        installs += 1;
        return '/managed/rg';
      },
    };

    // A system rg that vanished between preflight and execution must fail
    // closed: no download, no cache mutation, no install.
    await expect(resolveGlobCliWithAutoInstall(deps)).rejects.toThrow(
      /auto-install was not authorized/,
    );
    expect(installs).toBe(0);
  });
});
