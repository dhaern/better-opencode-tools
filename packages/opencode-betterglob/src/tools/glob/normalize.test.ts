/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_GLOB_LIMIT, DEFAULT_GLOB_TIMEOUT_MS } from './constants';
import {
  containsPath,
  normalizeGlobInput,
  normalizeGlobInputAsync,
} from './normalize';
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
    expect(buildRgArgs(normalized)).toContain('--no-mmap');
    expect(buildRgArgs(normalized)).toContain('--no-config');
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

  test('normalizes leading dot-slash relative patterns', () => {
    const repoDir = temps.createRepo();
    const normalized = normalizeGlobInput(
      { pattern: './src/*.ts' },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.searchPath).toBe(repoDir);
    expect(normalized.relativePattern).toBe('src/*.ts');
  });

  test('preserves POSIX glob escapes instead of treating backslashes as separators', () => {
    if (process.platform === 'win32') return;
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, 'a[1].ts'), '');
    const normalized = normalizeGlobInput(
      { pattern: 'a\\[1\\].ts' },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.relativePattern).toBe('a\\[1\\].ts');
  });

  test('preserves POSIX glob escapes in the async execution path', async () => {
    if (process.platform === 'win32') return;
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, 'a[1].ts'), '');
    const normalized = await normalizeGlobInputAsync(
      { pattern: 'a\\[1\\].ts' },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.relativePattern).toBe('a\\[1\\].ts');
  });

  test('treats nested names starting with dot-dot as contained paths', () => {
    const repoDir = temps.createRepo();
    const nested = path.join(repoDir, '..bar');
    mkdirSync(nested);

    expect(containsPath(repoDir, nested)).toBe(true);
    expect(containsPath(repoDir, path.dirname(repoDir))).toBe(false);
  });

  test('extracts base directory and root-anchored pattern from absolute patterns', () => {
    const repoDir = temps.createRepo();
    const normalized = normalizeGlobInput(
      { pattern: path.join(repoDir, 'src', '*.ts') },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.searchPath).toBe(path.join(repoDir, 'src'));
    // Absolute patterns are root-anchored: a leading "/" makes rg match
    // only at the search root instead of at any depth.
    expect(normalized.relativePattern).toBe('/*.ts');
  });

  test('lets absolute patterns take precedence over path like Claude-style normalization', () => {
    const repoDir = temps.createRepo();
    const otherDir = temps.createRepo();
    const normalized = normalizeGlobInput(
      { pattern: path.join(repoDir, 'src', '*.ts'), path: otherDir },
      createRepoContext(otherDir) as any,
    );

    expect(normalized.searchPath).toBe(path.join(repoDir, 'src'));
    expect(normalized.relativePattern).toBe('/*.ts');
  });

  test('rejects timeout values that would overflow setTimeout', () => {
    const repoDir = temps.createRepo();

    expect(() =>
      normalizeGlobInput(
        { pattern: '*.ts', timeout_ms: 2_147_483_648 },
        createRepoContext(repoDir) as any,
      ),
    ).toThrow(/timeout_ms must not exceed/);

    const boundary = normalizeGlobInput(
      { pattern: '*.ts', timeout_ms: 2_147_483_647 },
      createRepoContext(repoDir) as any,
    );
    expect(boundary.timeoutMs).toBe(2_147_483_647);
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

  test('rejects unsupported symlink traversal and never emits --follow', () => {
    expect(() =>
      createNormalized({
        pattern: '*.ts',
        path: 'src',
        sort_by: 'path',
        sort_order: 'desc',
        follow_symlinks: true,
      }),
    ).toThrow(/follow_symlinks:true is unsupported/);

    const { normalized } = createNormalized({
      pattern: '*.ts',
      path: 'src',
      sort_by: 'path',
      sort_order: 'desc',
    });
    expect(buildRgArgs(normalized)).not.toContain('--follow');
  });

  test('honors .gitignore natively outside git repos via --no-require-git', () => {
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');
    const normalized = normalizeGlobInput(
      { pattern: '*.ts' },
      createRepoContext(repoDir) as any,
    );

    // rg reads .gitignore hierarchies itself with correct bases; the
    // plugin no longer reparents them through --ignore-file.
    expect(buildRgArgs(normalized)).toContain('--no-require-git');
    expect(buildRgArgs(normalized)).not.toContain('--ignore-file');
  });

  test('nested searches keep native hierarchical ignore semantics', () => {
    const repoDir = temps.createRepo();
    writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');
    const normalized = normalizeGlobInput(
      { pattern: '*.ts', path: 'src' },
      createRepoContext(repoDir) as any,
    );

    expect(buildRgArgs(normalized)).toContain('--no-require-git');
  });

  test('external searches rely on rg defaults instead of worktree ignores', () => {
    const repoDir = temps.createRepo();
    const outside = temps.createRepo();
    writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');
    const normalized = normalizeGlobInput(
      { pattern: '*.ts', path: outside },
      createRepoContext(repoDir) as any,
    );

    // Outside the worktree there is no ignore inheritance to emulate:
    // rg applies whatever .gitignore trees exist under the search path.
    const args = buildRgArgs(normalized);
    expect(args.find((arg) => arg.startsWith('--ignore-file'))).toBeUndefined();
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
    expect(normalized.relativePattern).toBe('/pkg-*/*.ts');
  });

  test('supports absolute patterns with forward slashes', () => {
    const repoDir = temps.createRepo();
    const pattern = `${repoDir.replace(/\\/g, '/')}/src/*.ts`;
    const normalized = normalizeGlobInput(
      { pattern },
      createRepoContext(repoDir) as any,
    );

    expect(normalized.searchPath).toBe(path.join(repoDir, 'src'));
    expect(normalized.relativePattern).toBe('/*.ts');
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
    expect(normalized.relativePattern).toBe('/*.ts');
  });
});
