/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildGrepCommand,
  executeGrepFallback,
  translatePatternToEre,
} from './fallback';
import { normalizeGrepInput } from './normalize';
import { createRepoContext, createTempTracker } from './test-helpers';

describe('tools/grep/fallback', () => {
  const temps = createTempTracker();

  function createNormalized(
    input: any,
    options: { directory?: string; worktree?: string } = {},
  ) {
    const repoDir = options.worktree ?? temps.createRepo();
    const directory = options.directory ?? repoDir;
    const worktree = options.worktree ?? repoDir;

    return {
      repoDir,
      normalized: normalizeGrepInput(
        input,
        createRepoContext(directory, worktree) as any,
      ),
    };
  }

  test.each([
    {
      name: 'builds lightweight GNU grep count commands without -o byte parsing',
      input: {
        pattern: 'createTool',
        path: 'src',
        output_mode: 'count',
        invert_match: true,
        sort_by: 'mtime',
      },
      assertResult(built: ReturnType<typeof buildGrepCommand>) {
        expect(built.command).toEqual(
          expect.arrayContaining(['grep', '-H', '-c', '-v']),
        );
        expect(built.command).not.toContain('-o');
        expect(built.command).not.toContain('-b');
        expect(built.warnings.join('\n')).toContain(
          'GNU grep fallback count mode reports matching lines per file',
        );
        expect(built.warnings.join('\n')).toContain(
          'GNU grep fallback ignores sort_by=mtime',
        );
      },
    },
    {
      name: 'builds GNU grep fallback warnings for path-aware globs',
      input: {
        pattern: 'createTool',
        path: 'src',
        globs: ['src/**/*.ts'],
        exclude_globs: ['dist/**'],
      },
      assertResult(built: ReturnType<typeof buildGrepCommand>) {
        expect(built.warnings.join('\n')).toContain(
          'GNU grep fallback ignores path-aware glob patterns',
        );
        expect(built.command).not.toContain('src/**/*.ts');
        expect(built.command).not.toContain('dist/**');
      },
    },
    {
      name: 'uses ERE and expands simple brace include globs',
      input: {
        pattern: 'createTool',
        path: 'src',
        include: '*.{ts,tsx}',
      },
      assertResult(built: ReturnType<typeof buildGrepCommand>) {
        expect(built.command).toContain('-E');
        expect(built.command).toEqual(
          expect.arrayContaining(['--include', '*.ts', '--include', '*.tsx']),
        );
      },
    },
  ])('$name', ({ input, assertResult }) => {
    const { normalized } = createNormalized(input);
    assertResult(buildGrepCommand(normalized, 'grep'));
  });

  test('executeGrepFallback respects hidden=false by excluding dotfiles', async () => {
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, '.hidden.txt'), 'createTool\n');

    const input = normalizeGrepInput(
      {
        pattern: 'createTool',
        path: repoDir,
        output_mode: 'files_with_matches',
        hidden: false,
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    expect(
      result.files.some((file) => file.absolutePath.endsWith('.hidden.txt')),
    ).toBe(false);
  });

  test('executeGrepFallback parses content mode paths with colons correctly', async () => {
    const repoDir = temps.createRepo();
    const colonFile = path.join(repoDir, 'src', 'a:1:b.txt');
    writeFileSync(colonFile, 'needle\n');

    const input = normalizeGrepInput(
      {
        pattern: 'needle',
        path: path.join(repoDir, 'src'),
        output_mode: 'content',
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    const matched = result.files.find(
      (file) => file.absolutePath === colonFile,
    );
    expect(matched).toBeDefined();
    expect(matched?.matches[0]?.lineText).toBe('needle');
  });

  test('executeGrepFallback parses files mode paths with embedded newlines correctly', async () => {
    const repoDir = temps.createRepo();
    const newlineFile = path.join(repoDir, 'src', 'odd\nname.txt');
    writeFileSync(newlineFile, 'needle\n');

    const input = normalizeGrepInput(
      {
        pattern: 'needle',
        path: path.join(repoDir, 'src'),
        output_mode: 'files_with_matches',
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    expect(result.files.some((file) => file.absolutePath === newlineFile)).toBe(
      true,
    );
    expect(
      result.files.some((file) => file.absolutePath.endsWith('/odd')),
    ).toBe(false);
  });

  test('executeGrepFallback count mode with invert_match counts selected lines', async () => {
    const repoDir = temps.createRepo();
    const sample = path.join(repoDir, 'src', 'invert.txt');
    writeFileSync(sample, 'foo\nbar\nbaz\n');

    const input = normalizeGrepInput(
      {
        pattern: 'foo',
        path: sample,
        output_mode: 'count',
        fixed_strings: true,
        invert_match: true,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    const matched = result.files.find((file) => file.absolutePath === sample);
    expect(matched?.matchCount).toBe(2);
    expect(result.totalMatches).toBe(2);
  });

  test('executeGrepFallback excludes zero-count files from count results', async () => {
    const repoDir = temps.createRepo();
    const empty = path.join(repoDir, 'src', 'empty.txt');
    writeFileSync(empty, 'nothing here\n');

    const input = normalizeGrepInput(
      {
        pattern: 'createTool',
        path: path.join(repoDir, 'src'),
        output_mode: 'count',
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );
    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.absolutePath).toBe(
      path.join(repoDir, 'src', 'example.ts'),
    );
    expect(result.files.some((file) => file.matchCount === 0)).toBe(false);
  });

  test('executeGrepFallback sorts all path results before applying max_results', async () => {
    const repoDir = temps.createRepo();
    const zFile = path.join(repoDir, 'src', 'z.txt');
    const aFile = path.join(repoDir, 'src', 'a.txt');
    writeFileSync(zFile, 'needle\n');
    writeFileSync(aFile, 'needle\n');

    const input = normalizeGrepInput(
      {
        pattern: 'needle',
        paths: [zFile, aFile],
        output_mode: 'files_with_matches',
        fixed_strings: true,
        sort_by: 'path',
        max_results: 1,
      },
      createRepoContext(repoDir) as any,
    );
    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.absolutePath).toBe(aFile);
    expect(result.limitReached).toBe(true);
  });

  test('executeGrepFallback preserves non-UTF8 content paths', async () => {
    const repoDir = temps.createRepo();
    const rawPath = Buffer.concat([
      Buffer.from(path.join(repoDir, 'src') + path.sep),
      Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74]),
    ]);
    writeFileSync(rawPath, 'needle\n');

    const input = normalizeGrepInput(
      {
        pattern: 'needle',
        path: path.join(repoDir, 'src'),
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );
    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    const matched = result.files.find((file) => file.nonUtf8Path);
    expect(matched?.matches[0]?.lineText).toBe('needle');
    expect(matched?.file).toContain('bytes:base64:');
  });

  test('executeGrepFallback reports operational stderr instead of no matches', async () => {
    const repoDir = temps.createRepo();
    const wrapperDir = temps.createDir('opencode-bettergrep-error-wrapper');
    const wrapperPath = path.join(wrapperDir, 'grep-wrapper.sh');
    writeFileSync(
      wrapperPath,
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "--version" ]; then',
        "  printf 'grep (GNU grep) 3.11\\n'",
        '  exit 0',
        'fi',
        "printf 'permission denied\\n' >&2",
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const input = normalizeGrepInput(
      {
        pattern: 'needle',
        path: path.join(repoDir, 'src'),
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: wrapperPath,
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    expect(result.error).toContain('permission denied');
  });

  test('executeGrepFallback rejects Unicode digit classes instead of approximating them', async () => {
    const repoDir = temps.createRepo();
    writeFileSync(
      path.join(repoDir, 'src', 'version.txt'),
      'version 1.2.3\nno digits here\n',
    );

    const input = normalizeGrepInput(
      {
        pattern: '\\d+\\.\\d+',
        path: path.join(repoDir, 'src'),
        fixed_strings: false,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    // rg gives \d Unicode semantics; an ASCII [0-9] approximation would
    // silently diverge, so the fallback must reject the pattern.
    expect(result.error).toContain('escape sequence \\d');
    expect(result.totalMatches).toBe(0);
  });

  test('executeGrepFallback passes plain alternation through ERE unchanged', async () => {
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, 'src', 'alt.txt'), 'alpha\nbeta\ngamma\n');

    const input = normalizeGrepInput(
      {
        pattern: 'alpha|gamma',
        path: path.join(repoDir, 'src'),
        fixed_strings: false,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.totalMatches).toBe(2);
  });

  test('executeGrepFallback rejects patterns it cannot represent in ERE', async () => {
    const repoDir = temps.createRepo();
    const input = normalizeGrepInput(
      {
        pattern: 'foo(?=bar)',
        path: path.join(repoDir, 'src'),
        fixed_strings: false,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    expect(result.error).toContain('Cannot reproduce this regex');
    expect(result.totalMatches).toBe(0);
  });

  test('executeGrepFallback always warns about ignored ignore-files', () => {
    const repoDir = temps.createDir('opencode-bettergrep-nogit');
    const input = normalizeGrepInput(
      { pattern: 'needle', path: repoDir, fixed_strings: true },
      createRepoContext(repoDir) as any,
    );

    const built = buildGrepCommand(input, 'grep');
    expect(built.warnings.join('\n')).toContain(
      'does not apply ripgrep ignore rules',
    );
  });

  test('executeGrepFallback sorts paths bytewise like ripgrep', async () => {
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, 'README.md'), 'needle\n');
    writeFileSync(path.join(repoDir, 'package.json'), 'needle\n');

    const input = normalizeGrepInput(
      {
        pattern: 'needle',
        path: repoDir,
        output_mode: 'files_with_matches',
        fixed_strings: true,
        sort_by: 'path',
        max_results: 1,
      },
      createRepoContext(repoDir) as any,
    );
    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    // 'R' (0x52) sorts before 'p' (0x70) bytewise, matching ripgrep.
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.absolutePath).toBe(path.join(repoDir, 'README.md'));
    expect(result.limitReached).toBe(true);
  });

  test('executeGrepFallback keeps context group separators out of file paths', async () => {
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, 'src', 'a.txt'), 'match\ncontext\n');
    writeFileSync(path.join(repoDir, 'src', 'b.txt'), 'match\ncontext\n');

    const input = normalizeGrepInput(
      {
        pattern: 'match',
        paths: [
          path.join(repoDir, 'src', 'a.txt'),
          path.join(repoDir, 'src', 'b.txt'),
        ],
        after_context: 1,
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    const paths = result.files.map((file) => file.absolutePath);
    expect(paths).toHaveLength(2);
    expect(paths).toContain(path.join(repoDir, 'src', 'a.txt'));
    expect(paths).toContain(path.join(repoDir, 'src', 'b.txt'));
    expect(paths.some((p) => p.includes('--'))).toBe(false);
    for (const file of result.files) {
      expect(file.matches[0]?.after).toHaveLength(1);
    }
  });

  test('executeGrepFallback keeps the top-K prefix property with capacity above one', async () => {
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, 'LICENSE'), 'needle\n');
    writeFileSync(path.join(repoDir, 'package.json'), 'needle\n');
    writeFileSync(path.join(repoDir, 'README.md'), 'needle\n');

    const normalize = (overrides: Record<string, unknown>) =>
      normalizeGrepInput(
        {
          pattern: 'needle',
          path: repoDir,
          output_mode: 'files_with_matches',
          fixed_strings: true,
          sort_by: 'path',
          ...overrides,
        },
        createRepoContext(repoDir) as any,
      );

    const three = await executeGrepFallback(
      normalize({ max_results: 3 }),
      new AbortController().signal,
      { path: 'grep', backend: 'grep', source: 'system-gnu-grep' },
    );
    const two = await executeGrepFallback(
      normalize({ max_results: 2 }),
      new AbortController().signal,
      { path: 'grep', backend: 'grep', source: 'system-gnu-grep' },
    );

    const threePaths = three.files.map((file) => file.absolutePath);
    expect(threePaths).toEqual([
      path.join(repoDir, 'LICENSE'),
      path.join(repoDir, 'README.md'),
      path.join(repoDir, 'package.json'),
    ]);
    // The capacity-2 result must be a prefix of the capacity-3 result.
    expect(two.files.map((file) => file.absolutePath)).toEqual(
      threePaths.slice(0, 2),
    );
    expect(two.limitReached).toBe(true);
  });

  test('executeGrepFallback content budget follows result priority, not arrival order', async () => {
    const repoDir = temps.createRepo();
    // README.md sorts before package.json but is listed SECOND in targets:
    // GNU grep still emits matches in argument order, so the worse file's
    // matches arrive first and must be displaced when README's arrive.
    writeFileSync(path.join(repoDir, 'package.json'), 'needle\nneedle\n');
    writeFileSync(path.join(repoDir, 'README.md'), 'needle\n');

    const run = async (paths: string[]) => {
      const input = normalizeGrepInput(
        {
          pattern: 'needle',
          paths,
          output_mode: 'content',
          fixed_strings: true,
          sort_by: 'path',
          max_results: 2,
        },
        createRepoContext(repoDir) as any,
      );
      return executeGrepFallback(input, new AbortController().signal, {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      });
    };

    const direct = await run([
      path.join(repoDir, 'package.json'),
      path.join(repoDir, 'README.md'),
    ]);
    const reversed = await run([
      path.join(repoDir, 'README.md'),
      path.join(repoDir, 'package.json'),
    ]);

    // The best file must retain its match regardless of target order.
    const readme = (result: typeof direct) =>
      result.files.find(
        (file) => file.absolutePath === path.join(repoDir, 'README.md'),
      );
    expect(readme(direct)?.matches).toHaveLength(1);
    expect(readme(reversed)?.matches).toHaveLength(1);
    // And the total retained matches must be identical across permutations.
    expect(direct.totalMatches).toBe(reversed.totalMatches);
  });

  test('executeGrepFallback keeps full context stable when eviction follows target permutation', async () => {
    const repoDir = temps.createRepo();
    const betterPath = path.join(repoDir, 'README.md');
    const worsePath = path.join(repoDir, 'package.json');
    writeFileSync(betterPath, 'needle\n');
    writeFileSync(worsePath, 'needle\nplain\nneedle\nplain\nplain\n');

    const run = async (paths: string[]) => {
      const input = normalizeGrepInput(
        {
          pattern: 'needle',
          paths,
          output_mode: 'content',
          fixed_strings: true,
          sort_by: 'path',
          max_results: 2,
          before_context: 2,
          after_context: 2,
        },
        createRepoContext(repoDir) as any,
      );
      return executeGrepFallback(input, new AbortController().signal, {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      });
    };

    const direct = await run([worsePath, betterPath]);
    const reversed = await run([betterPath, worsePath]);
    const structure = (result: typeof direct) =>
      result.files.map((file) => ({
        path: file.absolutePath,
        matchCount: file.matchCount,
        matches: file.matches.map((match) => ({
          lineNumber: match.lineNumber,
          lineText: match.lineText,
          before: match.before,
          after: match.after,
        })),
      }));

    expect(structure(direct)).toEqual(structure(reversed));
    expect({
      totalMatches: direct.totalMatches,
      limitReached: direct.limitReached,
      truncated: direct.truncated,
    }).toEqual({
      totalMatches: reversed.totalMatches,
      limitReached: reversed.limitReached,
      truncated: reversed.truncated,
    });
  });

  test('executeGrepFallback reports limit flags when sorted eviction has no context', async () => {
    const repoDir = temps.createRepo();
    const betterPath = path.join(repoDir, 'README.md');
    const worsePath = path.join(repoDir, 'package.json');
    writeFileSync(betterPath, 'needle\n');
    writeFileSync(worsePath, 'needle\nneedle\n');

    const run = async (paths: string[]) => {
      const input = normalizeGrepInput(
        {
          pattern: 'needle',
          paths,
          output_mode: 'content',
          fixed_strings: true,
          sort_by: 'path',
          max_results: 2,
          context: 0,
        },
        createRepoContext(repoDir) as any,
      );
      return executeGrepFallback(input, new AbortController().signal, {
        path: 'grep',
        backend: 'grep',
        source: 'system-gnu-grep',
      });
    };

    const direct = await run([worsePath, betterPath]);
    const reversed = await run([betterPath, worsePath]);

    expect(direct.files.map((file) => file.absolutePath)).toEqual(
      reversed.files.map((file) => file.absolutePath),
    );
    expect(direct.totalMatches).toBe(reversed.totalMatches);
    expect(direct.limitReached).toBe(true);
    expect(direct.truncated).toBe(true);
    expect(reversed.limitReached).toBe(true);
    expect(reversed.truncated).toBe(true);
  });

  test('executeGrepFallback rejects non-equivalent ERE constructs instead of reinterpreting them', async () => {
    const repoDir = temps.createRepo();

    for (const pattern of [
      '[a&&b]',
      '[a~~a]',
      '[[a]]',
      '[[:alpha:]]',
      '[\\]]',
      'version\\nAUDIT_ABSENT',
      'version\nAUDIT_ABSENT',
      'a\\>',
    ]) {
      const input = normalizeGrepInput(
        {
          pattern,
          path: repoDir,
          output_mode: 'files_with_matches',
        },
        createRepoContext(repoDir) as any,
      );

      const result = await executeGrepFallback(
        input,
        new AbortController().signal,
        {
          path: 'grep',
          backend: 'grep',
          source: 'system-gnu-grep',
        },
      );

      expect(result.error).toBeDefined();
      expect(result.totalFiles).toBe(0);
    }
  });

  test('translatePatternToEre accepts only the supported equivalent subset', () => {
    for (const pattern of [
      '[a-z]',
      '[0-9_]',
      '^import|^# ',
      'foo.*bar',
      'a{2,}',
      '\\t',
      '\\.',
    ]) {
      expect(translatePatternToEre(pattern).error).toBeUndefined();
    }
  });

  test('buildGrepCommand rejects word_regexp instead of approximating boundaries', () => {
    const { normalized } = createNormalized({
      pattern: 'a',
      word_regexp: true,
    });
    const built = buildGrepCommand(normalized);

    expect(built.patternError).toContain('word_regexp');
    expect(built.command).not.toContain('-w');
  });

  test('buildGrepCommand rejects effective case-insensitive matching', () => {
    for (const args of [
      { pattern: 'i', case_sensitive: false },
      { pattern: 'lowercase', smart_case: true },
    ]) {
      const { normalized } = createNormalized(args);
      const built = buildGrepCommand(normalized);

      expect(built.patternError).toContain('case-insensitive');
      expect(built.command).not.toContain('-i');
    }
  });

  test('buildGrepCommand rejects line breaks before the fixed-string branch', () => {
    const { normalized } = createNormalized({
      pattern: 'GNU\nAUDIT_ABSENT',
      fixed_strings: true,
    });
    const built = buildGrepCommand(normalized);

    expect(built.patternError).toContain('line breaks');
    expect(built.command).not.toContain('-F');
  });

  test('executeGrepFallback marks mixed text and binary matches as truncated', async () => {
    const repoDir = temps.createRepo();
    const textPath = path.join(repoDir, 'src', 'text.txt');
    const binaryPath = path.join(repoDir, 'src', 'binary.bin');
    writeFileSync(textPath, 'GNU\n');
    writeFileSync(
      binaryPath,
      Uint8Array.from([
        0x47, 0x4e, 0x55, 0x00, 0x62, 0x69, 0x6e, 0x61, 0x72, 0x79,
      ]),
    );

    const input = normalizeGrepInput(
      {
        pattern: 'GNU',
        paths: [textPath, binaryPath],
        output_mode: 'content',
        fixed_strings: true,
        context: 0,
        max_results: 1000,
      },
      createRepoContext(repoDir) as any,
    );
    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      { path: 'grep', backend: 'grep', source: 'system-gnu-grep' },
    );

    expect(result.totalMatches).toBe(1);
    expect(result.totalFiles).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.limitReached).toBe(false);
    expect(result.error).toBeUndefined();
    expect(
      result.warnings.some((warning) => /binary file.*matches/i.test(warning)),
    ).toBe(true);
  });

  test('executeGrepFallback retains adjacent matches as context after the budget is exhausted', async () => {
    const repoDir = temps.createRepo();
    const sample = path.join(repoDir, 'src', 'adjacent.txt');
    writeFileSync(sample, 'import a\nimport b\nplain\n');

    const input = normalizeGrepInput(
      {
        pattern: '^import',
        path: sample,
        after_context: 1,
        fixed_strings: false,
        sort_by: 'path',
        max_results: 1,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      { path: 'grep', backend: 'grep', source: 'system-gnu-grep' },
    );

    const file = result.files.find((entry) => entry.absolutePath === sample);
    expect(file).toBeDefined();
    expect(file?.matches).toHaveLength(1);
    // The second adjacent match, discarded by the budget, still appears as
    // trailing context of the retained one, like ripgrep.
    expect(file?.matches[0]?.after).toEqual([
      { lineNumber: 2, text: 'import b' },
    ]);
  });

  test('executeGrepFallback treats binary-file stderr as unrepresentable output', async () => {
    const repoDir = temps.createRepo();
    const wrapperDir = temps.createDir('opencode-bettergrep-binary-wrapper');
    const wrapperPath = path.join(wrapperDir, 'grep-wrapper.sh');
    writeFileSync(
      wrapperPath,
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "--version" ]; then',
        "  printf 'grep (GNU grep) 3.11\\n'",
        '  exit 0',
        'fi',
        "printf 'grep: /usr/bin/grep: binary file matches\\n' >&2",
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const input = normalizeGrepInput(
      {
        pattern: 'GNU',
        path: path.join(repoDir, 'src'),
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );

    const result = await executeGrepFallback(
      input,
      new AbortController().signal,
      {
        path: wrapperPath,
        backend: 'grep',
        source: 'system-gnu-grep',
      },
    );

    expect(result.error).toContain('binary files');
    expect(result.truncated).toBe(true);
    expect(result.totalMatches).toBe(0);
  });

  test('executeGrepFallback retries GNU grep validation after transient failures', async () => {
    const repoDir = temps.createRepo();
    const wrapperDir = temps.createDir('opencode-bettergrep-wrapper');
    const markerPath = path.join(wrapperDir, 'validated');
    const wrapperPath = path.join(wrapperDir, 'grep-wrapper.sh');

    writeFileSync(
      wrapperPath,
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `marker=${JSON.stringify(markerPath)}`,
        'if [ "$#" -gt 0 ] && [ "$1" = "--version" ]; then',
        '  if [ ! -f "$marker" ]; then',
        '    : > "$marker"',
        "    printf 'resource temporarily unavailable\\n' >&2",
        '    exit 1',
        '  fi',
        "  printf 'grep (GNU grep) 3.11\\n'",
        '  exit 0',
        'fi',
        'exec grep "$@"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const input = normalizeGrepInput(
      {
        pattern: 'createTool',
        path: path.join(repoDir, 'src'),
        output_mode: 'files_with_matches',
        fixed_strings: true,
      },
      createRepoContext(repoDir) as any,
    );
    const cli = {
      path: wrapperPath,
      backend: 'grep' as const,
      source: 'system-gnu-grep' as const,
    };

    const first = await executeGrepFallback(
      input,
      new AbortController().signal,
      cli,
    );
    expect(first.error).toContain('resource temporarily unavailable');

    const second = await executeGrepFallback(
      input,
      new AbortController().signal,
      cli,
    );
    expect(second.error).toBeUndefined();
    expect(
      second.files.some(
        (file) => file.absolutePath === path.join(repoDir, 'src', 'example.ts'),
      ),
    ).toBe(true);
  });
});
