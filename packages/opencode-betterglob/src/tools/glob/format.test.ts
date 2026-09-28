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

  test('golden format and fallback parser matrix', async () => {
    const repoDir = temps.createRepo();
    const file = path.join(repoDir, 'src', 'a.ts');
    const input = await normalizeGlobInputAsync(
      { pattern: '*.ts', path: 'src', limit: 1 },
      createRepoContext(repoDir) as any,
    );
    // t=timeout, c=cancelled, i=incomplete, x=truncated.
    for (const [label, status, note, count] of [
      ['empty', '', '', 0],
      ['timeout', 't', 'Search timed out before completing.', 0],
      ['cancelled', 'c', 'Search was cancelled before completing.', 0],
      ['incomplete', 'i', 'Search stopped before completing.', 0],
      ['timeout wins', 'tci', 'Search timed out before completing.', 0],
      ['cancel wins', 'ci', 'Search was cancelled before completing.', 0],
      ['rows', '', '', 1],
      ['truncated rows', 'x', '', 1],
      ['truncated timeout', 'xt', 'Search timed out before completing.', 1],
      [
        'truncated cancelled',
        'xc',
        'Search was cancelled before completing.',
        1,
      ],
      ['truncated incomplete', 'xi', 'Search stopped before completing.', 1],
    ] as const) {
      const flags = {
        timedOut: status.includes('t'),
        cancelled: status.includes('c'),
        incomplete: status.includes('i'),
        truncated: status.includes('x'),
      };
      const truncated = flags.truncated;
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
      expect({ label, output }).toEqual({ label, output: expected });
      expect({ label, summary: parseGlobOutputSummary(output) }).toEqual({
        label,
        summary: { count, truncated },
      });
    }
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
