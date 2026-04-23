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
    expect(request.patterns).toEqual([path.join(repoDir, 'src', 'example.ts')]);
    expect(request.always).toEqual([path.join(repoDir, 'src', 'example.ts')]);
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
    expect(readPermission.patterns).toEqual([outside]);
    expect(readPermission.always).toEqual([outside]);
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
    expect(readPermission.patterns).toEqual([missing]);
    expect(readPermission.always).toEqual([missing]);
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
    expect(readPermission.patterns).toEqual([outsideFile]);
    expect(readPermission.always).toEqual([outsideFile]);
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
      path.join(outside, 'secrett.txt'),
    ]);
    expect(readPermission.always).toEqual([path.join(outside, 'secrett.txt')]);
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
