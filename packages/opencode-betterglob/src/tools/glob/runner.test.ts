/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeGlobInput } from './normalize';
import { parseNulPaths, runRipgrep } from './runner';
import { createRepoContext, createTempTracker } from './test-helpers';
import type { GlobToolInput } from './types';

describe('tools/glob/runner', () => {
  const temps = createTempTracker({ resetResolver: true });

  function createNormalized(
    input: GlobToolInput,
    repoDir = temps.createRepo(),
  ) {
    return {
      repoDir,
      normalized: normalizeGlobInput(input, createRepoContext(repoDir) as any),
    };
  }

  test('parses NUL-delimited paths with names containing newlines', async () => {
    const repoDir = temps.createRepo();
    const weird = path.join(repoDir, 'src', 'odd\nname.ts');
    writeFileSync(weird, 'export const weird = true;\n');

    const { normalized } = createNormalized(
      { pattern: '*.ts', path: 'src', sort_by: 'path' },
      repoDir,
    );
    const result = await runRipgrep(normalized, new AbortController().signal);

    expect(result.files).toContain(weird);
    expect(result.error).toBeUndefined();
  });

  test.each([
    {
      name: 'mtime desc',
      input: { sort_by: 'mtime', sort_order: 'desc' } as const,
      expected: ['newest.ts', 'middle.ts', 'oldest.ts'],
    },
    {
      name: 'mtime asc',
      input: { sort_by: 'mtime', sort_order: 'asc' } as const,
      expected: ['oldest.ts', 'middle.ts', 'newest.ts'],
    },
    {
      name: 'path asc',
      input: { sort_by: 'path', sort_order: 'asc' } as const,
      expected: ['middle.ts', 'newest.ts', 'oldest.ts'],
    },
    {
      name: 'path desc',
      input: { sort_by: 'path', sort_order: 'desc' } as const,
      expected: ['oldest.ts', 'newest.ts', 'middle.ts'],
    },
  ])('orders files by $name before truncation', async ({ input, expected }) => {
    const repoDir = temps.createDir();
    const src = path.join(repoDir, 'src');
    mkdirSync(src, { recursive: true });
    const files = ['oldest.ts', 'middle.ts', 'newest.ts'].map((file) =>
      path.join(src, file),
    );
    for (const file of files) writeFileSync(file, '');
    const now = Date.now() / 1000;
    utimesSync(files[0] as string, now - 30, now - 30);
    utimesSync(files[1] as string, now - 20, now - 20);
    utimesSync(files[2] as string, now - 10, now - 10);

    const { normalized } = createNormalized(
      { pattern: '*.ts', path: 'src', limit: 2, ...input },
      repoDir,
    );
    const result = await runRipgrep(normalized, new AbortController().signal);

    expect(result.files.map((file) => path.basename(file))).toEqual(
      expected.slice(0, 2),
    );
    expect(result.truncated).toBe(true);
    expect(result.count).toBe(2);
  });

  test('returns no files for an unmatched pattern', async () => {
    const { normalized } = createNormalized({
      pattern: '*.missing',
      path: 'src',
    });
    const result = await runRipgrep(normalized, new AbortController().signal);

    expect(result.files).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.truncated).toBe(false);
  });

  test('filters matched files without re-including ignored files', async () => {
    const repoDir = temps.createRepo();
    mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    writeFileSync(path.join(repoDir, '.gitignore'), 'src/ignored.ts\n');
    writeFileSync(path.join(repoDir, 'src', 'ignored.ts'), 'ignored\n');
    writeFileSync(path.join(repoDir, 'src', 'ok.ts'), 'ok\n');
    const { normalized } = createNormalized(
      { pattern: '*.ts', path: 'src', sort_by: 'path' },
      repoDir,
    );
    const result = await runRipgrep(normalized, new AbortController().signal);

    expect(result.files.map((file) => path.basename(file))).toEqual([
      'a.ts',
      'b.ts',
      'ok.ts',
    ]);
  });

  test('drops incomplete trailing path when parsing interrupted NUL output', () => {
    const repoDir = temps.createRepo();

    expect(
      parseNulPaths({ searchPath: repoDir }, `src/a.ts\0src/partial`, {
        discardIncomplete: true,
      }),
    ).toEqual([path.join(repoDir, 'src', 'a.ts')]);
  });
});
