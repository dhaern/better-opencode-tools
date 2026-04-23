/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_GLOB_LIMIT, DEFAULT_GLOB_TIMEOUT_MS } from './constants';
import { normalizeGlobInput } from './normalize';
import { buildRgArgs } from './rg-args';
import { createRepoContext, createTempTracker } from './test-helpers';

describe('tools/glob/normalize', () => {
  const temps = createTempTracker();

  function createNormalized(input: any, repoDir = temps.createRepo()) {
    return {
      repoDir,
      normalized: normalizeGlobInput(input, createRepoContext(repoDir) as any),
    };
  }

  test('normalizes defaults while keeping base glob fields compatible', () => {
    const { repoDir, normalized } = createNormalized({ pattern: '**/*.ts' });

    expect(normalized.pattern).toBe('**/*.ts');
    expect(normalized.relativePattern).toBe('**/*.ts');
    expect(normalized.requestedPath).toBe('.');
    expect(normalized.searchPath).toBe(repoDir);
    expect(normalized.limit).toBe(DEFAULT_GLOB_LIMIT);
    expect(normalized.sortBy).toBe('mtime');
    expect(normalized.sortOrder).toBe('desc');
    expect(normalized.hidden).toBe(true);
    expect(normalized.followSymlinks).toBe(false);
    expect(normalized.timeoutMs).toBe(DEFAULT_GLOB_TIMEOUT_MS);
  });

  test('resolves relative path against current directory', () => {
    const repoDir = temps.createRepo();
    const normalized = normalizeGlobInput(
      { pattern: '*.ts', path: 'src' },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.searchPath).toBe(path.join(repoDir, 'src'));
    expect(normalized.relativePattern).toBe('*.ts');
  });

  test('extracts base directory and relative pattern from absolute patterns', () => {
    const repoDir = temps.createRepo();
    const normalized = normalizeGlobInput(
      { pattern: path.join(repoDir, 'src', '*.ts') },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.searchPath).toBe(path.join(repoDir, 'src'));
    expect(normalized.relativePattern).toBe('*.ts');
  });

  test('lets absolute patterns take precedence over path like Claude-style normalization', () => {
    const repoDir = temps.createRepo();
    const otherDir = temps.createRepo();
    const normalized = normalizeGlobInput(
      { pattern: path.join(repoDir, 'src', '*.ts'), path: otherDir },
      createRepoContext(otherDir) as any,
    );

    expect(normalized.searchPath).toBe(path.join(repoDir, 'src'));
    expect(normalized.relativePattern).toBe('*.ts');
  });

  test('rejects missing paths and file paths', () => {
    const repoDir = temps.createRepo();

    expect(() =>
      normalizeGlobInput(
        { pattern: '*.ts', path: 'missing' },
        createRepoContext(repoDir) as any,
      ),
    ).toThrow(/Search path does not exist/);

    expect(() =>
      normalizeGlobInput(
        { pattern: '*.md', path: 'README.md' },
        createRepoContext(repoDir) as any,
      ),
    ).toThrow(/Search path must be a directory/);
  });

  test('builds rg args with NUL output, sorting, hidden and symlink flags', () => {
    const { normalized } = createNormalized({
      pattern: '*.ts',
      path: 'src',
      sort_by: 'path',
      sort_order: 'desc',
      follow_symlinks: true,
    });

    expect(buildRgArgs(normalized)).toEqual(
      expect.arrayContaining([
        '--files',
        '--null',
        '--no-config',
        '--sortr',
        'path',
        '--hidden',
        '--follow',
      ]),
    );
  });

  test('uses local .gitignore as ignore-file outside git repos', () => {
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');
    const normalized = normalizeGlobInput(
      { pattern: '*.ts' },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.ignoreFiles).toEqual([path.join(repoDir, '.gitignore')]);
    expect(buildRgArgs(normalized)).toEqual(
      expect.arrayContaining([
        '--ignore-file',
        path.join(repoDir, '.gitignore'),
      ]),
    );
  });

  test('uses root .gitignore for nested searches outside git repos', () => {
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');
    const normalized = normalizeGlobInput(
      { pattern: '*.ts', path: 'src' },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.ignoreFiles).toEqual([path.join(repoDir, '.gitignore')]);
  });

  test('does not inherit worktree ignore files for external searches', () => {
    const repoDir = temps.createRepo();
    const outside = temps.createRepo();
    writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');
    const normalized = normalizeGlobInput(
      { pattern: '*.ts', path: outside },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.ignoreFiles).toEqual([]);
  });

  test('supports absolute patterns with glob directory segments', () => {
    const repoDir = temps.createRepo();
    mkdirSync(path.join(repoDir, 'pkg-a'), { recursive: true });
    writeFileSync(path.join(repoDir, 'pkg-a', 'index.ts'), '');
    const normalized = normalizeGlobInput(
      { pattern: path.join(repoDir, 'pkg-*', '*.ts') },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.searchPath).toBe(repoDir);
    expect(normalized.relativePattern).toBe('pkg-*/*.ts');
  });

  test('supports absolute patterns with forward slashes', () => {
    const repoDir = temps.createRepo();
    const pattern = `${repoDir.replace(/\\/g, '/')}/src/*.ts`;
    const normalized = normalizeGlobInput(
      { pattern },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.searchPath).toBe(path.join(repoDir, 'src'));
    expect(normalized.relativePattern).toBe('*.ts');
  });

  test('realpaths the worktree when it exists as a symlink', () => {
    const real = temps.createRepo();
    const link = temps.createDir('opencode-betterglob-link');
    const alias = path.join(link, 'repo-link');
    symlinkSync(real, alias, 'dir');
    const normalized = normalizeGlobInput(
      { pattern: '*.ts', path: 'src' },
      createRepoContext(alias, alias) as any,
    );

    expect(normalized.worktree).toBe(real);
  });

  test('does not treat closing glob delimiters as magic by themselves', () => {
    const repoDir = temps.createRepo();
    mkdirSync(path.join(repoDir, 'src]literal'), { recursive: true });
    const normalized = normalizeGlobInput(
      { pattern: path.join(repoDir, 'src]literal', '*.ts') },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.searchPath).toBe(path.join(repoDir, 'src]literal'));
    expect(normalized.relativePattern).toBe('*.ts');
  });
});
