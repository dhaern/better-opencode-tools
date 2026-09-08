/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_GREP_TIMEOUT_MS } from './constants';
import {
  buildResult,
  createExecutionContext,
  createTempTracker,
} from './test-helpers';
import { createGrepTool } from './tool';
import type { GrepRunner, GrepSearchResult } from './types';

describe('tools/grep/tool', () => {
  const temps = createTempTracker();

  function getAskInput(ctx: ReturnType<typeof createExecutionContext>) {
    const call = ctx.ask.mock.calls[0] as unknown as
      | [
          {
            permission: string;
            patterns: string[];
            metadata: Record<string, unknown>;
          },
        ]
      | undefined;

    if (!call) {
      throw new Error('ask was not called');
    }

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

    if (!call) {
      throw new Error('metadata was not called');
    }

    return call[0];
  }

  test('creates a grep tool that asks permission, runs rg, and emits metadata', async () => {
    const repoDir = temps.createRepo();
    const run: GrepRunner = mock(async (input) => {
      expect(input.searchPath).toBe(path.join(repoDir, 'src'));
      expect(input.include).toBe('*.ts');
      return buildResult(repoDir);
    });

    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    const output = await grep.execute(
      {
        pattern: 'createTool',
        path: 'src',
        include: '*.ts',
      },
      ctx as any,
    );

    const structuredOutput = output as {
      output: string;
      title: string;
      metadata: Record<string, unknown>;
    };
    expect(structuredOutput.output).toContain('Found 1 match across 1 file.');
    expect(structuredOutput.output).toContain('src/example.ts');
    expect(structuredOutput.output).toContain(
      '2: const target = createTool();',
    );
    expect(structuredOutput.title).toBe('createTool');
    expect(structuredOutput.metadata.matches).toBe(1);
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    expect(ctx.metadata).toHaveBeenCalledTimes(1);

    const askInput = getAskInput(ctx);
    expect(askInput.permission).toBe('grep');
    expect(askInput.patterns).toEqual(['createTool']);
    expect(askInput.metadata.before_context).toBe(0);
    expect(askInput.metadata.after_context).toBe(0);
    expect(askInput.metadata.pattern).toBe('createTool');
    expect(askInput.metadata.case_sensitive).toBe(true);
    expect(askInput.metadata.word_regexp).toBe(false);
    expect(askInput.metadata.timeout_ms).toBe(DEFAULT_GREP_TIMEOUT_MS);
    expect(askInput.metadata.hidden).toBe(true);
    expect(askInput.metadata.follow_symlinks).toBe(false);
    expect(askInput.metadata.real_path_exhaustive).toBe(true);
    expect(askInput.metadata.fixed_strings).toBe(false);
    expect(askInput.metadata.multiline).toBe(false);
    expect(askInput.metadata.multiline_dotall).toBe(false);
    expect(askInput.metadata.pcre2).toBe(false);
    expect(askInput.metadata.max_filesize).toBeUndefined();
    expect(askInput.metadata.sort_by).toBe('none');
    expect(askInput.metadata.sort_order).toBe('asc');
    expect(askInput.metadata.file_types).toEqual([]);
    expect(askInput.metadata.exclude_file_types).toEqual([]);
    expect(askInput.metadata.invert_match).toBe(false);
    expect(askInput.metadata.max_count_per_file).toBeUndefined();
    expect(askInput.metadata.route_mode).toBeUndefined();
    expect(askInput.metadata.requested_backend).toBeUndefined();
    expect(askInput.metadata.effective_backend).toBeUndefined();
    expect(askInput.metadata.route_fallback_reason).toBeUndefined();

    const metadataInput = getMetadataInput(ctx);
    expect(metadataInput.title).toBe('createTool');
    expect(metadataInput.metadata.backend).toBe('rg');
    expect(metadataInput.metadata.pattern).toBe('createTool');
    expect(metadataInput.metadata.case_sensitive).toBe(true);
    expect(metadataInput.metadata.word_regexp).toBe(false);
    expect(metadataInput.metadata.timeout_ms).toBe(DEFAULT_GREP_TIMEOUT_MS);
    expect(metadataInput.metadata.hidden).toBe(true);
    expect(metadataInput.metadata.follow_symlinks).toBe(false);
    expect(metadataInput.metadata.real_path_exhaustive).toBe(true);
    expect(metadataInput.metadata.fixed_strings).toBe(false);
    expect(metadataInput.metadata.multiline).toBe(false);
    expect(metadataInput.metadata.multiline_dotall).toBe(false);
    expect(metadataInput.metadata.pcre2).toBe(false);
    expect(metadataInput.metadata.max_filesize).toBeUndefined();
    expect(metadataInput.metadata.sort_by).toBe('none');
    expect(metadataInput.metadata.sort_order).toBe('asc');
    expect(metadataInput.metadata.matches).toBe(1);
    expect(metadataInput.metadata.before_context).toBe(0);
    expect(metadataInput.metadata.after_context).toBe(0);
    expect(metadataInput.metadata.file_types).toEqual([]);
    expect(metadataInput.metadata.exclude_file_types).toEqual([]);
    expect(metadataInput.metadata.invert_match).toBe(false);
    expect(metadataInput.metadata.max_count_per_file).toBeUndefined();
    expect(metadataInput.metadata.route_mode).toBeUndefined();
    expect(metadataInput.metadata.requested_backend).toBeUndefined();
    expect(metadataInput.metadata.effective_backend).toBeUndefined();
    expect(metadataInput.metadata.route_fallback_reason).toBeUndefined();
  });

  test('fails closed when permission Effect loses OpenCode context', async () => {
    const repoDir = temps.createRepo();
    const run: GrepRunner = mock(async () => buildResult(repoDir));
    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = {
      ...createExecutionContext(repoDir),
      ask: mock(() => {
        throw new Error('Service not found: InstanceRef not provided');
      }),
    };

    await expect(
      grep.execute({ pattern: 'createTool', path: 'src' }, ctx as any),
    ).rejects.toThrow('InstanceRef not provided');
    expect(run).not.toHaveBeenCalled();
  });

  test('asks external_directory before grep for targets outside the worktree', async () => {
    const repoDir = temps.createRepo();
    const externalDir = temps.createDir('opencode-bettergrep-external');
    const run: GrepRunner = mock(async (input) => {
      expect(input.searchPath).toBe(externalDir);
      return buildResult(repoDir);
    });
    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    await grep.execute({ pattern: 'needle', path: externalDir }, ctx as any);

    expect(ctx.ask).toHaveBeenCalledTimes(2);
    const calls = ctx.ask.mock.calls as unknown as Array<
      [
        {
          permission: string;
          patterns: string[];
          always: string[];
        },
      ]
    >;
    expect(calls[0]?.[0]).toMatchObject({
      permission: 'external_directory',
      patterns: [`${externalDir}/*`],
      always: [`${externalDir}/*`],
    });
    expect(calls[1]?.[0]).toMatchObject({
      permission: 'grep',
      patterns: ['needle'],
      always: ['*'],
    });
  });

  test('authorizes external directories discovered by follow_symlinks walks', async () => {
    const repoDir = temps.createRepo();
    const externalDir = temps.createDir('opencode-bettergrep-ext-target');
    writeFileSync(path.join(externalDir, 'outside.ts'), 'needle\n');
    symlinkSync(
      externalDir,
      path.join(repoDir, 'src', 'linked-outside'),
      'dir',
    );
    const run: GrepRunner = mock(async () => buildResult(repoDir));
    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    await grep.execute(
      { pattern: 'needle', path: 'src', follow_symlinks: true },
      ctx as any,
    );

    const calls = ctx.ask.mock.calls as unknown as Array<
      [{ permission: string; patterns: string[] }]
    >;
    expect(calls[0]?.[0]).toMatchObject({
      permission: 'external_directory',
      patterns: [`${externalDir}/*`],
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('fails closed when a walked directory contains a non-UTF-8 name', async () => {
    const repoDir = temps.createRepo();
    const externalDir = temps.createDir('opencode-bettergrep-ext-nonutf8');
    writeFileSync(path.join(externalDir, 'outside.ts'), 'needle\n');
    symlinkSync(
      externalDir,
      path.join(repoDir, 'src', 'linked-outside'),
      'dir',
    );
    // A directory whose on-disk name contains a raw 0xff byte: readdir's
    // lossy UTF-8 decoding yields U+FFFD, so realpath would resolve a
    // different name than the backend (which matches by raw bytes).
    const srcDir = Buffer.from(path.join(repoDir, 'src'));
    const nonUtf8DirBuffer = Buffer.concat([
      srcDir,
      Buffer.from('/'),
      Buffer.from([0x66, 0x69, 0x6c, 0x65, 0xff]),
    ]);
    mkdirSync(nonUtf8DirBuffer, { recursive: true });
    const run: GrepRunner = mock(async () => buildResult(repoDir));
    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    await expect(
      grep.execute(
        { pattern: 'needle', path: 'src', follow_symlinks: true },
        ctx as any,
      ),
    ).rejects.toThrow(/non-UTF-8 name/);
    expect(run).not.toHaveBeenCalled();
  });

  test('fails closed when a symlink destination contains a non-UTF-8 name', async () => {
    if (process.platform === 'win32') return;

    const repoDir = temps.createRepo();
    const externalParent = temps.createDir(
      'opencode-bettergrep-ext-dest-parent',
    );
    const secondExternal = temps.createDir(
      'opencode-bettergrep-ext-dest-second',
    );
    const rawDestination = Buffer.concat([
      Buffer.from(externalParent),
      Buffer.from('/raw'),
      Buffer.from([0xff]),
    ]);
    mkdirSync(rawDestination, { recursive: true });
    symlinkSync(
      secondExternal,
      Buffer.concat([rawDestination, Buffer.from('/nested-link')]),
      'dir',
    );
    symlinkSync(rawDestination, path.join(repoDir, 'src', 'ascii-link'), 'dir');

    const run: GrepRunner = mock(async () => buildResult(repoDir));
    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    await expect(
      grep.execute(
        { pattern: 'needle', path: 'src', follow_symlinks: true },
        ctx as any,
      ),
    ).rejects.toThrow(/non-UTF-8 name/);
    expect(run).not.toHaveBeenCalled();
  });

  test('denies follow_symlinks walks when the external directory is refused', async () => {
    const repoDir = temps.createRepo();
    const externalDir = temps.createDir('opencode-bettergrep-ext-denied');
    writeFileSync(path.join(externalDir, 'outside.ts'), 'needle\n');
    symlinkSync(
      externalDir,
      path.join(repoDir, 'src', 'linked-outside'),
      'dir',
    );
    const run: GrepRunner = mock(async () => buildResult(repoDir));
    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = {
      ...createExecutionContext(repoDir),
      ask: mock(async () => {
        throw new Error('external directory denied');
      }),
    };

    await expect(
      grep.execute(
        { pattern: 'needle', path: 'src', follow_symlinks: true },
        ctx as any,
      ),
    ).rejects.toThrow('external directory denied');
    expect(run).not.toHaveBeenCalled();
  });

  test('emits strategy metadata for mtime-hybrid results', async () => {
    const repoDir = temps.createRepo();
    const run: GrepRunner = mock(async () => {
      return {
        ...buildResult(repoDir),
        outputMode: 'files_with_matches',
        matchKind: 'file',
        files: [
          {
            file: 'src/example.ts',
            absolutePath: path.join(repoDir, 'src', 'example.ts'),
            replayPath: path.join(repoDir, 'src', 'example.ts'),
            matchCount: 1,
            matches: [],
          },
        ],
        totalMatches: 1,
        totalFiles: 1,
        strategy: 'mtime-hybrid',
        discoveryCommand: ['rg', '--files-with-matches', 'needle', repoDir],
        replayBatchCount: 2,
        replayTargetCount: 5,
        discoveredFiles: 5,
        sortedFiles: 5,
        replayedFiles: 1,
        partialPhase: 'replay',
        mtimeDiscoveryCapped: true,
        command: undefined,
      } satisfies GrepSearchResult;
    });

    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    await grep.execute(
      {
        pattern: 'needle',
        path: 'src',
        sort_by: 'mtime',
        output_mode: 'files_with_matches',
      },
      ctx as any,
    );

    const metadataInput = getMetadataInput(ctx);
    expect(metadataInput.metadata.strategy).toBe('mtime-hybrid');
    expect(metadataInput.metadata.command).toBeUndefined();
    expect(metadataInput.metadata.discovery_command).toEqual([
      'rg',
      '--files-with-matches',
      'needle',
      repoDir,
    ]);
    expect(metadataInput.metadata.replay_batch_count).toBe(2);
    expect(metadataInput.metadata.replay_target_count).toBe(5);
    expect(metadataInput.metadata.discovered_files).toBe(5);
    expect(metadataInput.metadata.sorted_files).toBe(5);
    expect(metadataInput.metadata.replayed_files).toBe(1);
    expect(metadataInput.metadata.partial_phase).toBe('replay');
    expect(metadataInput.metadata.mtime_discovery_capped).toBe(true);
  });

  test('emits metadata when normalization fails before execution', async () => {
    const repoDir = temps.createRepo();
    const grep = createGrepTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    const ctx = createExecutionContext(repoDir);

    await expect(
      grep.execute(
        {
          pattern: 'createTool',
          path: 'missing-path',
        },
        ctx as any,
      ),
    ).rejects.toThrow(/Search path does not exist/);

    expect(ctx.metadata).toHaveBeenCalledTimes(1);
    const metadataInput = getMetadataInput(ctx);
    expect(metadataInput.title).toBe('createTool');
    expect(metadataInput.metadata.error_stage).toBe('normalize');
    expect(metadataInput.metadata.pattern).toBe('createTool');
    expect(metadataInput.metadata.path).toBe('missing-path');
  });

  test('does not let metadata failure break a successful grep result', async () => {
    const repoDir = temps.createRepo();
    const run: GrepRunner = mock(async () => buildResult(repoDir));
    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = {
      ...createExecutionContext(repoDir),
      metadata: mock(() => {
        throw new Error('metadata channel failed');
      }),
    };

    const output = await grep.execute(
      {
        pattern: 'createTool',
        path: 'src',
      },
      ctx as any,
    );

    const structuredOutput = output as { output: string };
    expect(structuredOutput.output).toContain('Found 1 match across 1 file.');
  });

  test('emits metadata when permission step fails', async () => {
    const repoDir = temps.createRepo();
    const grep = createGrepTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    const ctx = {
      ...createExecutionContext(repoDir),
      ask: mock(async () => {
        throw new Error('permission denied');
      }),
    };

    await expect(
      grep.execute(
        {
          pattern: 'createTool',
          path: 'src',
        },
        ctx as any,
      ),
    ).rejects.toThrow(/permission denied/);

    expect(ctx.metadata).toHaveBeenCalledTimes(1);
    const metadataCalls = ctx.metadata.mock.calls as unknown as Array<
      [{ metadata: Record<string, unknown> }]
    >;
    const metadataInput = metadataCalls[0]?.[0];
    expect(metadataInput?.metadata.error_stage).toBe('permission');
    expect(metadataInput?.metadata.real_path).toBe(path.join(repoDir, 'src'));
  });

  test('preserves the original error when metadata emission also fails', async () => {
    const repoDir = temps.createRepo();
    const grep = createGrepTool({
      directory: repoDir,
      worktree: repoDir,
      client: {},
    } as any);
    const ctx = {
      ...createExecutionContext(repoDir),
      metadata: mock(() => {
        throw new Error('metadata channel failed');
      }),
    };

    await expect(
      grep.execute(
        {
          pattern: 'createTool',
          path: 'missing-path',
        },
        ctx as any,
      ),
    ).rejects.toThrow(/Search path does not exist/);
  });

  test('sanitizes multiline pattern titles and reports real path metadata', async () => {
    const repoDir = temps.createRepo();
    const run: GrepRunner = mock(async () => buildResult(repoDir));
    const grep = createGrepTool(
      {
        directory: repoDir,
        worktree: repoDir,
        client: {},
      } as any,
      { run },
    );
    const ctx = createExecutionContext(repoDir);

    await grep.execute(
      {
        pattern: 'first line\nsecond line',
        path: 'src',
      },
      ctx as any,
    );

    const metadataInput = getMetadataInput(ctx);
    expect(metadataInput.title).toBe('first line second line');
    expect(metadataInput.metadata.resolved_path).toBe(
      path.join(repoDir, 'src'),
    );
    expect(metadataInput.metadata.real_path).toBe(path.join(repoDir, 'src'));
  });
});
