/// <reference types="bun-types" />

import { describe, expect, mock, test } from 'bun:test';
import { symlinkSync } from 'node:fs';
import path from 'node:path';
import { Effect } from 'effect';
import { DEFAULT_GLOB_LIMIT, DEFAULT_GLOB_TIMEOUT_MS } from './constants';
import { createExecutionContext, createTempTracker } from './test-helpers';
import { createGlobTool } from './tool';
import type { GlobRunner } from './types';

describe('tools/glob/tool', () => {
  const temps = createTempTracker();

  function getAskInput(ctx: ReturnType<typeof createExecutionContext>) {
    const call = ctx.ask.mock.calls[0] as unknown as
      | [
          {
            permission: string;
            patterns: string[];
            always: string[];
            metadata: Record<string, unknown>;
          },
        ]
      | undefined;

    if (!call) throw new Error('ask was not called');
    return call[0];
  }

  function getMetadataInput(ctx: ReturnType<typeof createExecutionContext>) {
    const call = ctx.metadata.mock.calls[0] as unknown as
      | [
          {
            title: string;
            metadata: Record<string, unknown>;
          },
        ]
      | undefined;

    if (!call) throw new Error('metadata was not called');
    return call[0];
  }

  test('asks permission, runs rg, returns output text, and emits metadata', async () => {
    const repoDir = temps.createRepo();
    const run: GlobRunner = mock(async (input) => {
      expect(input.searchPath).toBe(path.join(repoDir, 'src'));
      return {
        files: [path.join(repoDir, 'src', 'a.ts')],
        count: 1,
        backend: 'rg' as const,
        truncated: false,
        incomplete: false,
        timedOut: false,
        cancelled: false,
        exitCode: 0,
        command: ['rg', '--files'],
        cwd: input.searchPath,
        stderr: '',
      };
    });
    const glob = createGlobTool(
      { directory: repoDir, worktree: repoDir, client: {} } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    const result = await glob.execute(
      { pattern: '*.ts', path: 'src' },
      ctx as any,
    );

    expect(result).toBe(path.join(repoDir, 'src', 'a.ts'));
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    expect(ctx.metadata).toHaveBeenCalledTimes(1);

    const ask = getAskInput(ctx);
    expect(ask.permission).toBe('glob');
    expect(ask.patterns).toEqual(['*.ts']);
    expect(ask.always).toEqual(['*']);
    expect(ask.metadata.limit).toBe(DEFAULT_GLOB_LIMIT);
    expect(ask.metadata.timeout_ms).toBe(DEFAULT_GLOB_TIMEOUT_MS);
    expect(ask.metadata.hidden).toBe(true);
    expect(ask.metadata.follow_symlinks).toBe(false);

    const metadata = getMetadataInput(ctx);
    expect(metadata.title).toBe('*.ts');
    expect(metadata.metadata.count).toBe(1);
    expect(metadata.metadata.truncated).toBe(false);
    expect(metadata.metadata.sort_by).toBe('mtime');
    expect(metadata.metadata.sort_order).toBe('desc');
  });

  test('emits metadata when normalization fails', async () => {
    const repoDir = temps.createRepo();
    const glob = createGlobTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    const ctx = createExecutionContext(repoDir);

    await expect(
      glob.execute({ pattern: '*.ts', path: 'missing' }, ctx as any),
    ).rejects.toThrow(/Search path does not exist/);

    const metadata = getMetadataInput(ctx);
    expect(metadata.title).toBe('*.ts');
    expect(metadata.metadata.error_stage).toBe('normalize');
    expect(metadata.metadata.count).toBe(0);
  });

  test('does not let metadata failure break successful glob output', async () => {
    const repoDir = temps.createRepo();
    const run: GlobRunner = mock(async (input) => ({
      files: [path.join(repoDir, 'src', 'a.ts')],
      count: 1,
      backend: 'rg' as const,
      truncated: false,
      incomplete: false,
      timedOut: false,
      cancelled: false,
      exitCode: 0,
      cwd: input.searchPath,
      stderr: '',
    }));
    const glob = createGlobTool(
      { directory: repoDir, worktree: repoDir, client: {} } as any,
      { run },
    );
    const ctx = {
      ...createExecutionContext(repoDir),
      metadata: mock(() => {
        throw new Error('metadata channel failed');
      }),
    };

    const result = await glob.execute(
      { pattern: '*.ts', path: 'src' },
      ctx as any,
    );

    expect(result).toBe(path.join(repoDir, 'src', 'a.ts'));
  });

  test('asks external_directory permission for searches outside the worktree', async () => {
    const worktree = temps.createRepo();
    const outside = temps.createRepo();
    const run: GlobRunner = mock(async (input) => ({
      files: [path.join(outside, 'src', 'a.ts')],
      count: 1,
      backend: 'rg' as const,
      truncated: false,
      incomplete: false,
      timedOut: false,
      cancelled: false,
      exitCode: 0,
      cwd: input.searchPath,
      stderr: '',
    }));
    const tool = createGlobTool(
      { directory: worktree, worktree, client: {} } as any,
      { run },
    );
    const ctx = createExecutionContext(worktree);

    await tool.execute({ pattern: '*.ts', path: outside }, ctx as any);

    expect(ctx.ask).toHaveBeenCalledTimes(2);
    const externalCall = ctx.ask.mock.calls[1] as unknown as
      | [
          {
            permission: string;
            patterns: string[];
            always: string[];
            metadata: Record<string, unknown>;
          },
        ]
      | undefined;
    if (!externalCall) throw new Error('external_directory ask was not called');
    const external = externalCall[0];
    const pattern = `${outside.replace(/\\/g, '/')}/*`;
    expect(external.permission).toBe('external_directory');
    expect(external.patterns).toEqual([pattern]);
    expect(external.always).toEqual([pattern]);
    expect(external.metadata.filepath).toBe(outside);
    expect(external.metadata.parentDir).toBe(outside);
  });

  test('asks external_directory before probing missing external paths', async () => {
    const repoDir = temps.createRepo();
    const outsideRoot = temps.createDir('opencode-betterglob-outside');
    const missing = path.join(outsideRoot, 'missing');
    const tool = createGlobTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    const ctx = createExecutionContext(repoDir);

    await expect(
      tool.execute({ pattern: '*.ts', path: missing }, ctx as any),
    ).rejects.toThrow(/Search path does not exist/);

    expect(ctx.ask).toHaveBeenCalledTimes(2);
    const external = (
      ctx.ask.mock.calls[1] as unknown as [{ permission: string }]
    )[0];
    expect(external.permission).toBe('external_directory');
  });

  test('asks external_directory when follow_symlinks is enabled inside the worktree', async () => {
    const repoDir = temps.createRepo();
    const run: GlobRunner = mock(async (input) => ({
      files: [path.join(repoDir, 'src', 'a.ts')],
      count: 1,
      backend: 'rg' as const,
      truncated: false,
      incomplete: false,
      timedOut: false,
      cancelled: false,
      exitCode: 0,
      cwd: input.searchPath,
      stderr: '',
    }));
    const tool = createGlobTool(
      { directory: repoDir, worktree: repoDir, client: {} } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    await tool.execute(
      { pattern: '*.ts', path: 'src', follow_symlinks: true },
      ctx as any,
    );

    expect(ctx.ask).toHaveBeenCalledTimes(2);
    const external = (
      ctx.ask.mock.calls[1] as unknown as [{ permission: string }]
    )[0];
    expect(external.permission).toBe('external_directory');
  });

  test('asks external_directory after normalization when an internal symlink resolves outside', async () => {
    const repoDir = temps.createRepo();
    const outside = temps.createRepo();
    const linked = path.join(repoDir, 'linked');
    symlinkSync(outside, linked, 'dir');
    const run: GlobRunner = mock(async (input) => ({
      files: [path.join(outside, 'src', 'a.ts')],
      count: 1,
      backend: 'rg' as const,
      truncated: false,
      incomplete: false,
      timedOut: false,
      cancelled: false,
      exitCode: 0,
      cwd: input.searchPath,
      stderr: '',
    }));
    const tool = createGlobTool(
      { directory: repoDir, worktree: repoDir, client: {} } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    await tool.execute({ pattern: '*.ts', path: 'linked' }, ctx as any);

    expect(ctx.ask).toHaveBeenCalledTimes(2);
    const external = (
      ctx.ask.mock.calls[1] as unknown as [
        { permission: string; metadata: Record<string, unknown> },
      ]
    )[0];
    expect(external.permission).toBe('external_directory');
    expect(external.metadata.filepath).toBe(outside);
  });

  test('asks permission before auto-installing ripgrep when missing', async () => {
    const repoDir = temps.createRepo();
    const toolPath = '/tmp/fake-rg';
    const run: GlobRunner = mock(async (input) => ({
      files: [path.join(repoDir, 'src', 'a.ts')],
      count: 1,
      backend: 'rg' as const,
      truncated: false,
      incomplete: false,
      timedOut: false,
      cancelled: false,
      exitCode: 0,
      command: [toolPath, '--files'],
      cwd: input.searchPath,
      stderr: '',
    }));
    const tool = createGlobTool(
      { directory: repoDir, worktree: repoDir, client: {} } as any,
      {
        run,
        resolveCli: () => ({
          path: 'rg',
          backend: 'rg',
          source: 'missing-rg',
        }),
      },
    );
    const ctx = createExecutionContext(repoDir);

    await tool.execute({ pattern: '*.ts', path: 'src' }, ctx as any);

    expect(ctx.ask).toHaveBeenCalledTimes(2);
    const install = (
      ctx.ask.mock.calls[1] as unknown as [
        { permission: string; metadata: Record<string, unknown> },
      ]
    )[0];
    expect(install.permission).toBe('install_ripgrep');
    expect(install.metadata.action).toBe('auto_install_ripgrep');
  });

  test('supports ask implementations that return Effect', async () => {
    const repoDir = temps.createRepo();
    const run: GlobRunner = mock(async (input) => ({
      files: [path.join(repoDir, 'src', 'a.ts')],
      count: 1,
      backend: 'rg' as const,
      truncated: false,
      incomplete: false,
      timedOut: false,
      cancelled: false,
      exitCode: 0,
      cwd: input.searchPath,
      stderr: '',
    }));
    const tool = createGlobTool(
      { directory: repoDir, worktree: repoDir, client: {} } as any,
      { run },
    );
    let calls = 0;
    const ctx = {
      ...createExecutionContext(repoDir),
      ask: mock(() =>
        Effect.sync(() => {
          calls += 1;
        }),
      ),
    };

    const result = await tool.execute(
      { pattern: '*.ts', path: 'src' },
      ctx as any,
    );

    expect(result).toBe(path.join(repoDir, 'src', 'a.ts'));
    expect(calls).toBe(1);
  });
});
