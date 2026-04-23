/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test';
import {
  resetGlobCliResolverForTests,
  resolveGlobCli,
  resolveGlobCliWithAutoInstall,
} from './resolver';

describe('tools/glob/resolver', () => {
  afterEach(() => {
    resetGlobCliResolverForTests();
  });

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

  test('shares a single auto-install across concurrent waiters', async () => {
    let installs = 0;
    const installLatestStableRipgrep = async () => {
      installs += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return '/managed/rg';
    };

    const deps = {
      findExecutable: () => null,
      getInstalledRipgrepPath: () => null,
      installLatestStableRipgrep,
    };

    const [first, second] = await Promise.all([
      resolveGlobCliWithAutoInstall(deps),
      resolveGlobCliWithAutoInstall(deps),
    ]);

    expect(installs).toBe(1);
    expect(first).toEqual({
      path: '/managed/rg',
      backend: 'rg',
      source: 'managed-rg',
    });
    expect(second).toEqual(first);
  });
});
