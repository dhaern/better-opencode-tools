/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { buildTruncatedNote, formatGlobResult } from './format';
import { normalizeGlobInput } from './normalize';
import { createRepoContext, createTempTracker } from './test-helpers';
import type { GlobSearchResult } from './types';

describe('tools/glob/format', () => {
  const temps = createTempTracker();

  function createResult(repoDir: string): GlobSearchResult {
    return {
      files: [path.join(repoDir, 'src', 'a.ts')],
      count: 1,
      backend: 'rg',
      truncated: false,
      incomplete: false,
      timedOut: false,
      cancelled: false,
      exitCode: 0,
      cwd: repoDir,
      stderr: '',
    };
  }

  test('formats absolute paths one per line', () => {
    const repoDir = temps.createRepo();
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src' },
      createRepoContext(repoDir) as any,
    );

    expect(formatGlobResult(input, createResult(repoDir))).toBe(
      path.join(repoDir, 'src', 'a.ts'),
    );
  });

  test('formats empty output exactly as native glob', () => {
    const repoDir = temps.createRepo();
    const input = normalizeGlobInput(
      { pattern: '*.missing', path: 'src' },
      createRepoContext(repoDir) as any,
    );

    expect(
      formatGlobResult(input, {
        ...createResult(repoDir),
        files: [],
        count: 0,
      }),
    ).toBe('No files found');
  });

  test('formats truncation note exactly as native glob', () => {
    const repoDir = temps.createRepo();
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src', limit: 1 },
      createRepoContext(repoDir) as any,
    );
    const output = formatGlobResult(input, {
      ...createResult(repoDir),
      truncated: true,
    });

    expect(output).toBe(
      `${path.join(repoDir, 'src', 'a.ts')}\n\n${buildTruncatedNote(1)}`,
    );
    expect(buildTruncatedNote(1)).toBe(
      '(Results are truncated: reached the 1-result limit. Consider using a more specific path or pattern.)',
    );
  });

  test('formats backend errors honestly instead of as empty results', () => {
    const repoDir = temps.createRepo();
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src' },
      createRepoContext(repoDir) as any,
    );

    expect(
      formatGlobResult(input, {
        ...createResult(repoDir),
        files: [],
        count: 0,
        error: 'rg not available',
        exitCode: 1,
      }),
    ).toBe('glob search failed.\nrg not available');
  });

  test('formats timeout separately from truncation', () => {
    const repoDir = temps.createRepo();
    const input = normalizeGlobInput(
      { pattern: '*.ts', path: 'src' },
      createRepoContext(repoDir) as any,
    );

    expect(
      formatGlobResult(input, {
        ...createResult(repoDir),
        files: [],
        count: 0,
        incomplete: true,
        timedOut: true,
      }),
    ).toBe('Search timed out before completing.');
  });
});
