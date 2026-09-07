/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Effect } from 'effect';
import { createExecutionContext, createTempTracker } from './test-helpers';
import { createReadTool } from './tool';

describe('tools/read/tool', () => {
  const temps = createTempTracker();

  test('asks read permission and returns structured text output', async () => {
    const repoDir = temps.createRepo();
    const read = createReadTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    const ctx = createExecutionContext(repoDir);

    const result = await read.execute(
      {
        filePath: path.join(repoDir, 'src', 'example.ts'),
        offset: 2,
        limit: 1,
      },
      ctx as any,
    );

    expect(result).toEqual({
      output: expect.stringContaining('<type>file</type>'),
      metadata: expect.objectContaining({
        preview: '2: const target = createTool();',
        truncated: true,
        kind: 'text',
        loaded: [],
      }),
    });
    expect((result as { output: string }).output).toContain(
      '2: const target = createTool();',
    );
    expect(ctx.ask).toHaveBeenCalledTimes(1);

    const request = (
      ctx.ask.mock.calls[0] as unknown as [
        {
          permission: string;
          patterns: string[];
          always: string[];
          metadata: Record<string, unknown>;
        },
      ]
    )[0];
    expect(request.permission).toBe('read');
    // The native tool asks with the worktree-relative path so host rules like
    // `secrets/*` match; mirror that contract.
    expect(request.patterns).toEqual(['src/example.ts']);
    expect(request.always).toEqual(['src/example.ts']);
    expect(request.metadata.resolved_path).toBe(
      path.join(repoDir, 'src', 'example.ts'),
    );
    expect(request.metadata.access_path).toBe(
      path.join(repoDir, 'src', 'example.ts'),
    );
  });

  test('asks external_directory for external directories before reading them', async () => {
    const worktree = temps.createRepo();
    const outside = temps.createDir('opencode-betterread-outside');
    writeFileSync(path.join(outside, 'a.txt'), 'alpha\n');
    const read = createReadTool({
      directory: worktree,
      worktree,
      client: {},
    } as any);
    const ctx = createExecutionContext(worktree);

    const result = await read.execute({ filePath: outside }, ctx as any);

    expect((result as { output: string }).output).toContain(
      '<type>directory</type>',
    );
    expect(ctx.ask).toHaveBeenCalledTimes(2);
    const external = (
      ctx.ask.mock.calls[0] as unknown as [
        {
          permission: string;
          patterns: string[];
          metadata: Record<string, unknown>;
        },
      ]
    )[0];
    expect(external.permission).toBe('external_directory');
    expect(external.patterns).toEqual([
      path.join(outside, '*').replace(/\\/g, '/'),
    ]);
    expect(external.metadata.filepath).toBe(outside);
    const readPermission = (
      ctx.ask.mock.calls[1] as unknown as [
        { permission: string; patterns: string[]; always: string[] },
      ]
    )[0];
    expect(readPermission.permission).toBe('read');
    expect(readPermission.patterns).toEqual([path.relative(worktree, outside)]);
    expect(readPermission.always).toEqual([path.relative(worktree, outside)]);
  });

  test('keeps the separate read prompt for missing external paths but scopes it to the exact target', async () => {
    const worktree = temps.createRepo();
    const outside = temps.createDir('opencode-betterread-missing');
    const missing = path.join(outside, 'missing.txt');
    const read = createReadTool({
      directory: worktree,
      worktree,
      client: {},
    } as any);
    const ctx = createExecutionContext(worktree);

    await expect(
      read.execute({ filePath: missing }, ctx as any),
    ).rejects.toThrow(/File not found:/);

    expect(ctx.ask).toHaveBeenCalledTimes(2);
    const external = (
      ctx.ask.mock.calls[0] as unknown as [
        { permission: string; patterns: string[] },
      ]
    )[0];
    expect(external.permission).toBe('external_directory');
    expect(external.patterns).toEqual([
      path.join(outside, '*').replace(/\\/g, '/'),
    ]);
    const readPermission = (
      ctx.ask.mock.calls[1] as unknown as [
        { permission: string; patterns: string[]; always: string[] },
      ]
    )[0];
    expect(readPermission.permission).toBe('read');
    expect(readPermission.patterns).toEqual([path.relative(worktree, missing)]);
    expect(readPermission.always).toEqual([path.relative(worktree, missing)]);
  });

  test('asks external_directory when an internal symlink resolves outside the worktree', async () => {
    const worktree = temps.createRepo();
    const outside = temps.createDir('opencode-betterread-symlink');
    const outsideFile = path.join(outside, 'secret.txt');
    writeFileSync(outsideFile, 'secret\n');
    const linked = path.join(worktree, 'linked.txt');
    temps.createSymlink(outsideFile, linked);
    const read = createReadTool({
      directory: worktree,
      worktree,
      client: {},
    } as any);
    const ctx = createExecutionContext(worktree);

    const result = await read.execute({ filePath: linked }, ctx as any);

    expect((result as { output: string }).output).toContain('1: secret');
    expect(ctx.ask).toHaveBeenCalledTimes(2);
    const external = (
      ctx.ask.mock.calls[0] as unknown as [
        { permission: string; metadata: Record<string, unknown> },
      ]
    )[0];
    expect(external.permission).toBe('external_directory');
    expect(external.metadata.filepath).toBe(outsideFile);
    const readPermission = (
      ctx.ask.mock.calls[1] as unknown as [
        {
          permission: string;
          patterns: string[];
          always: string[];
          metadata: Record<string, unknown>;
        },
      ]
    )[0];
    expect(readPermission.permission).toBe('read');
    expect(readPermission.patterns).toEqual([
      path.relative(worktree, outsideFile),
    ]);
    expect(readPermission.always).toEqual([
      path.relative(worktree, outsideFile),
    ]);
    expect(readPermission.metadata.resolved_path).toBe(linked);
    expect(readPermission.metadata.access_path).toBe(outsideFile);
  });

  test('asks external_directory for missing paths beneath internal symlinked directories before suggesting siblings', async () => {
    const worktree = temps.createRepo();
    const outside = temps.createDir('opencode-betterread-symlink-dir');
    writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    const linkedDir = path.join(worktree, 'linked-dir');
    temps.createSymlink(outside, linkedDir);
    const missing = path.join(linkedDir, 'secrett.txt');
    const read = createReadTool({
      directory: worktree,
      worktree,
      client: {},
    } as any);
    const ctx = createExecutionContext(worktree);

    await expect(
      read.execute({ filePath: missing }, ctx as any),
    ).rejects.toThrow(path.join(outside, 'secret.txt'));

    expect(ctx.ask).toHaveBeenCalledTimes(2);
    const external = (
      ctx.ask.mock.calls[0] as unknown as [
        {
          permission: string;
          patterns: string[];
          metadata: Record<string, unknown>;
        },
      ]
    )[0];
    expect(external.permission).toBe('external_directory');
    expect(external.patterns).toEqual([
      path.join(outside, '*').replace(/\\/g, '/'),
    ]);
    expect(external.metadata.filepath).toBe(path.join(outside, 'secrett.txt'));
    const readPermission = (
      ctx.ask.mock.calls[1] as unknown as [
        { permission: string; patterns: string[]; always: string[] },
      ]
    )[0];
    expect(readPermission.permission).toBe('read');
    expect(readPermission.patterns).toEqual([
      path.relative(worktree, path.join(outside, 'secrett.txt')),
    ]);
    expect(readPermission.always).toEqual([
      path.relative(worktree, path.join(outside, 'secrett.txt')),
    ]);
  });

  test('rejects when the read target is swapped while awaiting permission', async () => {
    const repoDir = temps.createRepo();
    const target = path.join(repoDir, 'src', 'example.ts');
    const read = createReadTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    // Swap the regular file for a symlink to a different real file while the
    // permission ask is pending; the canonical target changes, so the read
    // must fail instead of opening the substituted object.
    const outside = temps.createDir('opencode-betterread-swap');
    const outsideFile = path.join(outside, 'swapped.txt');
    writeFileSync(outsideFile, 'swapped\n');
    const ctx = {
      ...createExecutionContext(repoDir),
      ask: mock(async () => {
        const { rmSync, symlinkSync } = await import('node:fs');
        rmSync(target);
        symlinkSync(outsideFile, target);
      }),
    };

    await expect(
      read.execute({ filePath: target }, ctx as any),
    ).rejects.toThrow(/changed while awaiting permission/);
  });

  test('rejects immediately when the abort signal is already cancelled', async () => {
    const repoDir = temps.createRepo();
    const read = createReadTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    const controller = new AbortController();
    controller.abort();
    const ctx = {
      ...createExecutionContext(repoDir),
      abort: controller.signal,
    };

    await expect(
      read.execute(
        { filePath: path.join(repoDir, 'src', 'example.ts') },
        ctx as any,
      ),
    ).rejects.toThrow();
    expect(ctx.ask).not.toHaveBeenCalled();
  });

  test('supports ask implementations that return Effect', async () => {
    const repoDir = temps.createRepo();
    const read = createReadTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    let calls = 0;
    const ctx = {
      ...createExecutionContext(repoDir),
      ask: mock(() =>
        Effect.sync(() => {
          calls += 1;
        }),
      ),
    };

    const result = await read.execute(
      { filePath: path.join(repoDir, 'src', 'example.ts') },
      ctx as any,
    );

    expect((result as { output: string }).output).toContain(
      '<type>file</type>',
    );
    expect(calls).toBe(1);
  });
});
