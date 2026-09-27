/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { parseGlobOutputSummary } from '../../hooks/glob-render-metadata';
import { buildTruncatedNote, formatGlobResult } from './format';
import { normalizeGlobInputAsync } from './normalize';
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

  test('formats absolute paths one per line', async () => {
    const repoDir = temps.createRepo();
    const input = await normalizeGlobInputAsync(
      { pattern: '*.ts', path: 'src' },
      createRepoContext(repoDir) as any,
    );

    expect(formatGlobResult(input, createResult(repoDir))).toBe(
      path.join(repoDir, 'src', 'a.ts'),
    );
  });

  test('formats empty output exactly as native glob', async () => {
    const repoDir = temps.createRepo();
    const input = await normalizeGlobInputAsync(
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

  test('formats truncation note exactly as native glob', async () => {
    const repoDir = temps.createRepo();
    const input = await normalizeGlobInputAsync(
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

  test('formats backend errors honestly instead of as empty results', async () => {
    const repoDir = temps.createRepo();
    const input = await normalizeGlobInputAsync(
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

  test('formats timeout separately from truncation', async () => {
    const repoDir = temps.createRepo();
    const input = await normalizeGlobInputAsync(
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

  test.each([
    { label: 'empty', flags: {}, note: '', count: 0, truncated: false },
    {
      label: 'timeout',
      flags: { timedOut: true },
      note: 'Search timed out before completing.',
      count: 0,
      truncated: false,
    },
    {
      label: 'cancelled',
      flags: { cancelled: true },
      note: 'Search was cancelled before completing.',
      count: 0,
      truncated: false,
    },
    {
      label: 'incomplete',
      flags: { incomplete: true },
      note: 'Search stopped before completing.',
      count: 0,
      truncated: false,
    },
    {
      label: 'timeout wins',
      flags: { timedOut: true, cancelled: true, incomplete: true },
      note: 'Search timed out before completing.',
      count: 0,
      truncated: false,
    },
    {
      label: 'cancel wins',
      flags: { cancelled: true, incomplete: true },
      note: 'Search was cancelled before completing.',
      count: 0,
      truncated: false,
    },
    { label: 'rows', flags: {}, note: '', count: 1, truncated: false },
    {
      label: 'truncated rows',
      flags: { truncated: true },
      note: '',
      count: 1,
      truncated: true,
    },
    {
      label: 'truncated timeout',
      flags: { truncated: true, timedOut: true },
      note: 'Search timed out before completing.',
      count: 1,
      truncated: true,
    },
    {
      label: 'truncated cancelled',
      flags: { truncated: true, cancelled: true },
      note: 'Search was cancelled before completing.',
      count: 1,
      truncated: true,
    },
    {
      label: 'truncated incomplete',
      flags: { truncated: true, incomplete: true },
      note: 'Search stopped before completing.',
      count: 1,
      truncated: true,
    },
  ])('golden format and fallback parser: $label', async ({
    flags,
    note,
    count,
    truncated,
  }) => {
    const repoDir = temps.createRepo();
    const file = path.join(repoDir, 'src', 'a.ts');
    const input = await normalizeGlobInputAsync(
      { pattern: '*.ts', path: 'src', limit: 1 },
      createRepoContext(repoDir) as any,
    );
    const result = {
      ...createResult(repoDir),
      files: count ? [file] : [],
      count,
      ...flags,
    };
    const output = formatGlobResult(input, result);
    const expected = count
      ? [
          file,
          ...(truncated ? ['', buildTruncatedNote(1)] : []),
          ...(note ? ['', note] : []),
        ].join('\n')
      : note || 'No files found';
    expect(output).toBe(expected);
    expect(parseGlobOutputSummary(output)).toEqual({ count, truncated });
  });

  test('errors override all status flags and yield zero rows on fallback parsing', async () => {
    const repoDir = temps.createRepo();
    const input = await normalizeGlobInputAsync(
      { pattern: '*.ts' },
      createRepoContext(repoDir) as any,
    );
    const output = formatGlobResult(input, {
      ...createResult(repoDir),
      truncated: true,
      incomplete: true,
      timedOut: true,
      error: 'backend failed',
    });
    expect(output).toBe('glob search failed.\nbackend failed');
    expect(parseGlobOutputSummary(output)).toEqual({
      count: 0,
      truncated: false,
    });
  });
});
