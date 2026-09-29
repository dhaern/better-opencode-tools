/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import which from 'which';
import { executeFileListMode } from './direct';
import { normalizeGrepInput } from './normalize';
import { runRipgrep } from './runner';
import { createGlobalAbortState, setAbortKind } from './runtime';
import { createRepoContext, createTempTracker } from './test-helpers';
import type { GrepToolInput } from './types';

describe('tools/grep/runner', () => {
  const temps = createTempTracker();

  test('invalidates the memoized probe after an ENOENT execution failure', async () => {
    const repoDir = temps.createRepo();
    const wrapperDir = temps.createDir('bettergrep-spawn-failure');
    const calls = path.join(wrapperDir, 'probes');
    const binary = path.join(wrapperDir, 'rg');
    writeFileSync(
      binary,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        `  printf 'probe\\n' >> "${calls}"`,
        "  printf 'ripgrep 15.2.0\\n'",
        '  exit 0',
        'fi',
        "printf 'spawn failed: ENOENT\\n' >&2",
        'exit 2',
      ].join('\n'),
      { mode: 0o755 },
    );
    const input = normalizeGrepInput(
      { pattern: 'createTool', path: repoDir, fixed_strings: true },
      createRepoContext(repoDir) as any,
    );
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath ?? ''}`;
      const first = await runRipgrep(input, new AbortController().signal);
      const second = await runRipgrep(input, new AbortController().signal);
      expect(first.error).toContain('ENOENT');
      expect(second.error).toContain('ENOENT');
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test('re-probes an mtime CLI after its executable permission is removed', async () => {
    const repo = temps.createRepo();
    const dir = temps.createDir('bettergrep-chmod');
    const binary = path.join(dir, 'rg');
    writeFileSync(
      binary,
      `#!/bin/sh\nexec ${JSON.stringify(which.sync('rg', { nothrow: false }))} "$@"\n`,
      { mode: 0o755 },
    );
    symlinkSync(which.sync('grep', { nothrow: false }), path.join(dir, 'grep'));
    const input = normalizeGrepInput(
      {
        pattern: 'createTool',
        path: repo,
        sort_by: 'mtime',
        fixed_strings: true,
      },
      createRepoContext(repo) as never,
    );
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = dir;
      const first = await runRipgrep(input, new AbortController().signal);
      expect(first.totalMatches).toBeGreaterThan(0);
      expect(first.error).toBeUndefined();
      chmodSync(binary, 0o644);
      const second = await runRipgrep(input, new AbortController().signal);
      expect(second.backend).toBe('grep');
      expect(second.totalMatches).toBeGreaterThan(0);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test('resolved absolute rg path is retained in the returned command', async () => {
    const repo = temps.createRepo();
    const dir = temps.createDir('bettergrep-absolute-rg');
    const binary = path.join(dir, 'rg');
    writeFileSync(
      binary,
      `#!/bin/sh\nexec ${JSON.stringify(which.sync('rg', { nothrow: false }))} "$@"\n`,
      { mode: 0o755 },
    );
    const input = normalizeGrepInput(
      { pattern: 'createTool', path: repo, fixed_strings: true },
      createRepoContext(repo) as never,
    );
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = dir;
      const result = await runRipgrep(input, new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(result.command?.[0]).toBe(binary);
      expect(result.totalMatches).toBeGreaterThan(0);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test('synchronous transient GNU grep spawn failure retains the resolved backend', async () => {
    const repo = temps.createRepo();
    const binDir = temps.createDir('bettergrep-busy-grep');
    const cacheDir = temps.createDir('bettergrep-busy-cache');
    const binary = path.join(binDir, 'grep');
    copyFileSync(which.sync('grep', { nothrow: false }), binary);
    chmodSync(binary, 0o755);
    const input = normalizeGrepInput(
      { pattern: 'createTool', path: repo, fixed_strings: true },
      createRepoContext(repo) as never,
    );
    const previousPath = process.env.PATH;
    const previousCache = process.env.XDG_CACHE_HOME;
    const previousFetch = globalThis.fetch;
    let writer: number | undefined;
    try {
      process.env.PATH = binDir;
      process.env.XDG_CACHE_HOME = cacheDir;
      globalThis.fetch = Object.assign(
        async () => {
          throw new Error('offline auto-install');
        },
        { preconnect: previousFetch.preconnect },
      );
      const first = await runRipgrep(input, new AbortController().signal);
      expect(first.backend).toBe('grep');
      expect(first.error).toBeUndefined();
      writer = openSync(binary, 'r+');

      const result = await runRipgrep(input, new AbortController().signal);
      expect(result.error).toContain('ETXTBSY');
      expect(result.backend).toBe('grep');
    } finally {
      if (writer !== undefined) closeSync(writer);
      process.env.PATH = previousPath;
      process.env.XDG_CACHE_HOME = previousCache;
      globalThis.fetch = previousFetch;
    }
  });

  function createNormalized(
    input: GrepToolInput,
    repoDir = temps.createRepo(),
  ) {
    return {
      repoDir,
      normalized: normalizeGrepInput(input, createRepoContext(repoDir) as any),
    };
  }

  test('a match-all include keeps honoring ignore files', async () => {
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, '.ignore'), 'ignored.ts\n');
    writeFileSync(path.join(repoDir, 'src', 'ignored.ts'), 'createTool\n');
    writeFileSync(path.join(repoDir, 'src', 'notes.md'), 'createTool\n');
    const search = async (input: Partial<GrepToolInput>) => {
      const { normalized } = createNormalized(
        {
          pattern: 'createTool',
          output_mode: 'files_with_matches',
          sort_by: 'path',
          ...input,
        },
        repoDir,
      );
      const result = await runRipgrep(normalized, new AbortController().signal);
      return result.files.map((file) =>
        path.relative(repoDir, file.absolutePath),
      );
    };

    for (const include of ['*', '**', '/**']) {
      expect(await search({ include })).toEqual([
        path.join('src', 'example.ts'),
        path.join('src', 'notes.md'),
      ]);
    }
    // Specific globs still reach rg, keeping its override semantics.
    expect(await search({ include: '*.ts', globs: ['*.md'] })).toEqual([
      path.join('src', 'example.ts'),
      path.join('src', 'ignored.ts'),
      path.join('src', 'notes.md'),
    ]);
  });

  test('runRipgrep excludes .git after user globs', async () => {
    const repoDir = temps.createRepo();
    const gitDir = path.join(repoDir, 'site.github.io', '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, 'marker.txt'), 'createTool\n');
    const search = async (globs: string[], target = repoDir) => {
      const { normalized } = createNormalized(
        {
          pattern: 'createTool',
          path: target,
          output_mode: 'files_with_matches',
          sort_by: 'path',
          globs,
        },
        repoDir,
      );
      const result = await runRipgrep(normalized, new AbortController().signal);
      return result.files.map((file) =>
        path.relative(repoDir, file.absolutePath),
      );
    };

    expect(await search([])).toEqual([path.join('src', 'example.ts')]);
    expect(await search(['**/.git/**'])).toEqual([]);
    // ".git" inside a name (site.github.io) is not a .git directory.
    expect(await search([], path.dirname(gitDir))).toEqual([]);
    expect(await search([], gitDir)).toEqual([
      path.join('site.github.io', '.git', 'marker.txt'),
    ]);
  });

  test('runRipgrep parses NUL-delimited filenames in files/count modes', async () => {
    const repoDir = temps.createRepo();
    const weirdName = path.join(repoDir, 'src', 'odd\nname.ts');
    writeFileSync(weirdName, 'const createTool = true;\ncreateTool\n');

    const { normalized: filesInput } = createNormalized(
      {
        pattern: 'createTool',
        path: 'src',
        output_mode: 'files_with_matches',
      },
      repoDir,
    );
    const { normalized: countInput } = createNormalized(
      {
        pattern: 'createTool',
        path: 'src',
        output_mode: 'count',
      },
      repoDir,
    );

    const filesResult = await runRipgrep(
      filesInput,
      new AbortController().signal,
    );
    const countResult = await runRipgrep(
      countInput,
      new AbortController().signal,
    );

    expect(
      filesResult.files.some((file) => file.absolutePath === weirdName),
    ).toBe(true);
    expect(
      countResult.files.some((file) => file.absolutePath === weirdName),
    ).toBe(true);
  });

  test('runRipgrep respects global limit in content mtime mode on a single file', async () => {
    const repoDir = temps.createRepo();
    const singleFile = path.join(repoDir, 'src', 'mtime-limit.ts');
    writeFileSync(singleFile, 'needle\nneedle\nneedle\n');
    const now = Date.now() / 1000;
    utimesSync(singleFile, now, now + 10);

    const { normalized } = createNormalized(
      {
        pattern: 'needle',
        path: singleFile,
        output_mode: 'content',
        sort_by: 'mtime',
        max_results: 1,
        fixed_strings: true,
      },
      repoDir,
    );

    const result = await runRipgrep(normalized, new AbortController().signal);

    expect(result.totalMatches).toBe(1);
    expect(result.limitReached).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.command).toBeUndefined();
    expect(result.files[0]?.matches).toHaveLength(1);
  });

  test('runRipgrep preserves mtime order in content mode across multiple files', async () => {
    const repoDir = temps.createRepo();
    const older = path.join(repoDir, 'src', 'older.ts');
    const newer = path.join(repoDir, 'src', 'newer.ts');
    const newest = path.join(repoDir, 'src', 'newest.ts');
    writeFileSync(older, 'needle\n');
    writeFileSync(newer, 'needle\n');
    writeFileSync(newest, 'needle\n');
    const now = Date.now() / 1000;
    utimesSync(older, now - 30, now - 30);
    utimesSync(newer, now - 20, now - 20);
    utimesSync(newest, now - 10, now - 10);

    const { normalized } = createNormalized(
      {
        pattern: 'needle',
        path: path.join(repoDir, 'src'),
        output_mode: 'content',
        sort_by: 'mtime',
        sort_order: 'desc',
        max_results: 3,
        fixed_strings: true,
      },
      repoDir,
    );

    const result = await runRipgrep(normalized, new AbortController().signal);

    expect(result.command).toBeUndefined();
    expect(
      result.files.map((file) => path.basename(file.absolutePath)),
    ).toEqual(['newest.ts', 'newer.ts', 'older.ts']);
  });

  test.each([
    {
      name: 'falls back to direct mode for non-UTF8 paths in mtime content mode',
      input: {
        pattern: 'needle',
        output_mode: 'content',
        expectedMatches: 1,
        expectedFiles: undefined,
      },
    },
    {
      name: 'falls back to direct mode for non-UTF8 paths in mtime count mode',
      input: {
        pattern: 'needle',
        output_mode: 'count',
        expectedMatches: 2,
        expectedFiles: 1,
      },
    },
    {
      name: 'falls back to direct mode for non-UTF8 paths in mtime files mode',
      input: {
        pattern: 'needle',
        output_mode: 'files_with_matches',
        expectedMatches: 1,
        expectedFiles: 1,
      },
    },
  ])('runRipgrep $name', async ({ input }) => {
    const repoDir = temps.createRepo();
    const rawPath = Buffer.concat([
      Buffer.from(path.join(repoDir, 'src')),
      Buffer.from('/bad_'),
      Buffer.from([0x80]),
      Buffer.from('.txt'),
    ]);
    const contents =
      input.output_mode === 'count' ? 'needle\nneedle\n' : 'needle\n';
    writeFileSync(rawPath, contents);

    const { normalized } = createNormalized(
      {
        pattern: input.pattern,
        path: path.join(repoDir, 'src'),
        output_mode: input.output_mode as GrepToolInput['output_mode'],
        sort_by: 'mtime',
        fixed_strings: true,
      },
      repoDir,
    );

    const result = await runRipgrep(normalized, new AbortController().signal);

    expect(result.strategy).toBe('mtime-fallback');
    expect(result.command).toBeDefined();
    expect(result.discoveryCommand).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.partialPhase).toBeUndefined();
    expect(result.totalMatches).toBe(input.expectedMatches);
    if (input.expectedFiles !== undefined) {
      expect(result.totalFiles).toBe(input.expectedFiles);
    }
    expect(result.warnings.join('\n')).toContain(
      'mtime ordering disabled: 1 non-UTF8 path is not safely orderable; returned direct search results instead.',
    );
  });

  test.each([
    {
      name: 'returns cancelled immediately when signal is already aborted',
      input: { pattern: 'createTool', path: 'src' },
      setup(controller: AbortController) {
        controller.abort();
      },
      assertResult(result: Awaited<ReturnType<typeof runRipgrep>>) {
        expect(result.cancelled).toBe(true);
        expect(result.truncated).toBe(true);
        expect(result.error).toBeUndefined();
      },
    },
    {
      name: 'keeps mtime-hybrid strategy metadata on pre-aborted results',
      input: { pattern: 'needle', path: 'src', sort_by: 'mtime' },
      setup(controller: AbortController) {
        controller.abort();
      },
      assertResult(result: Awaited<ReturnType<typeof runRipgrep>>) {
        expect(result.strategy).toBe('mtime-hybrid');
        expect(result.discoveryCommand).toBeDefined();
        expect(result.command).toBeUndefined();
        expect(result.cancelled).toBe(true);
      },
    },
    {
      name: 'treats upstream timeout pre-abort as timed out in direct mode',
      input: { pattern: 'createTool', path: 'src' },
      setup(controller: AbortController) {
        setAbortKind(controller.signal, 'timeout');
        controller.abort();
      },
      assertResult(result: Awaited<ReturnType<typeof runRipgrep>>) {
        expect(result.timedOut).toBe(true);
        expect(result.cancelled).toBe(false);
        expect(result.truncated).toBe(true);
      },
    },
    {
      name: 'treats upstream timeout pre-abort as timed out in mtime mode',
      input: { pattern: 'needle', path: 'src', sort_by: 'mtime' },
      setup(controller: AbortController) {
        setAbortKind(controller.signal, 'timeout');
        controller.abort();
      },
      assertResult(result: Awaited<ReturnType<typeof runRipgrep>>) {
        expect(result.strategy).toBe('mtime-hybrid');
        expect(result.discoveryCommand).toBeDefined();
        expect(result.command).toBeUndefined();
        expect(result.timedOut).toBe(true);
        expect(result.cancelled).toBe(false);
        expect(result.truncated).toBe(true);
      },
    },
  ])('runRipgrep $name', async ({ input, setup, assertResult }) => {
    const { normalized } = createNormalized(input);
    const controller = new AbortController();
    setup(controller);

    assertResult(await runRipgrep(normalized, controller.signal));
  });

  test.each([
    {
      name: 'createGlobalAbortState keeps first cause when cancel wins',
      run() {
        const controller = new AbortController();
        const state = createGlobalAbortState(controller.signal, 50);
        controller.abort();
        state.timeout();
        expect(state.getCancelled()).toBe(true);
        expect(state.getTimedOut()).toBe(false);
        state.cleanup();
      },
    },
    {
      name: 'createGlobalAbortState keeps first cause when timeout wins',
      run() {
        const controller = new AbortController();
        const state = createGlobalAbortState(controller.signal, 50);
        state.timeout();
        controller.abort();
        expect(state.getTimedOut()).toBe(true);
        expect(state.getCancelled()).toBe(false);
        state.cleanup();
      },
    },
    {
      name: 'createGlobalAbortState preserves upstream timeout abort cause',
      run() {
        const controller = new AbortController();
        setAbortKind(controller.signal, 'timeout');
        controller.abort();
        const state = createGlobalAbortState(controller.signal, 50);
        expect(state.getTimedOut()).toBe(true);
        expect(state.getCancelled()).toBe(false);
        state.cleanup();
      },
    },
  ])('$name', ({ run }) => {
    run();
  });

  test('executeFileListMode treats pre-aborted timeout signals as timed out', async () => {
    const { normalized } = createNormalized({
      pattern: 'createTool',
      path: 'src',
      output_mode: 'files_with_matches',
    });
    const controller = new AbortController();
    setAbortKind(controller.signal, 'timeout');
    controller.abort();

    const result = await executeFileListMode(normalized, controller.signal, {
      path: 'rg',
      backend: 'rg',
      source: 'system-rg',
    });

    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.truncated).toBe(true);
  });
});
