import { describe, expect, test } from 'bun:test';
import { formatGrepResult } from '../../tools/grep/format';
import { normalizeGrepInput } from '../../tools/grep/normalize';
import { createEmptyResult } from '../../tools/grep/result-utils';
import type {
  GrepSearchResult,
  NormalizedGrepInput,
} from '../../tools/grep/types';
import { createGrepRenderMetadataHook, parseGrepSummary } from './index';

describe('grep render metadata hook', () => {
  test('parses match summary lines', () => {
    expect(
      parseGrepSummary(
        'Pattern: alpha\nPath: src\n\nFound 7 matches across 3 files.\n',
      ),
    ).toEqual({ matches: 7, files: 3 });
  });

  test('parses files_with_matches summary lines', () => {
    expect(parseGrepSummary('Found 4 matching files.\n\nsrc/a.ts')).toEqual({
      matches: 4,
      files: 4,
    });
  });

  test('parses zero-result summaries', () => {
    expect(parseGrepSummary('No matches found.\nPattern: alpha')).toEqual({
      matches: 0,
      files: 0,
    });
    expect(parseGrepSummary('No files found.\nPattern: alpha')).toEqual({
      matches: 0,
      files: 0,
    });
  });

  test('parses mtime no-visible summaries as zero results', () => {
    expect(
      parseGrepSummary(
        'mtime sorting could not produce visible results after discovering 3 candidate files.\nPattern: alpha',
      ),
    ).toEqual({
      matches: 0,
      files: 0,
    });
  });

  test('hydrates final output metadata for grep tools', async () => {
    const hook = createGrepRenderMetadataHook();
    const output: { title?: unknown; output: unknown; metadata?: unknown } = {
      title: '',
      output:
        'Pattern: alpha\nPath: src\n\nFound 2 matches across 1 file.\n\nsrc/example.ts\n      1: alpha',
      metadata: { truncated: false },
    };

    await hook['tool.execute.after'](
      {
        tool: 'grep',
        args: { pattern: 'alpha' },
      },
      output,
    );

    expect(output.title).toBe('alpha');
    expect(output.metadata).toEqual({
      truncated: false,
      matches: 2,
      files: 1,
    });
  });

  test('hydrates zero-result metadata for grep tools', async () => {
    const hook = createGrepRenderMetadataHook();
    const output: { title?: unknown; output: unknown; metadata?: unknown } = {
      title: '',
      output: 'No matches found.\nPattern: alpha\nPath: src',
      metadata: { truncated: false },
    };

    await hook['tool.execute.after'](
      {
        tool: 'grep',
        args: { pattern: 'alpha' },
      },
      output,
    );

    expect(output.title).toBe('alpha');
    expect(output.metadata).toEqual({
      truncated: false,
      matches: 0,
      files: 0,
    });
  });

  describe('formatter to hook parse-back contract', () => {
    const inputFor = (outputMode: 'content' | 'count' | 'files_with_matches') =>
      normalizeGrepInput(
        { pattern: 'alpha', path: '.', output_mode: outputMode },
        { directory: process.cwd(), worktree: process.cwd() },
      );

    const resultFor = (
      input: NormalizedGrepInput,
      overrides: Partial<GrepSearchResult>,
    ): GrepSearchResult => ({ ...createEmptyResult(input), ...overrides });

    const roundTrip = (
      outputMode: 'content' | 'count' | 'files_with_matches',
      overrides: Partial<GrepSearchResult>,
    ) => {
      const input = inputFor(outputMode);
      return parseGrepSummary(
        formatGrepResult(input, resultFor(input, overrides)),
      );
    };

    test.each([
      ['files_with_matches', 1, 1, 'file'],
      ['files_with_matches', 5, 5, 'file'],
      ['count', 7, 3, 'occurrence'],
      ['count', 1, 1, 'occurrence'],
      ['content', 7, 3, 'match'],
      ['content', 1, 1, 'match'],
    ] as const)(
      'parses back %s output with %d matches across %d files',
      (outputMode, totalMatches, totalFiles, matchKind) => {
        expect(
          roundTrip(outputMode, { totalMatches, totalFiles, matchKind }),
        ).toEqual({ matches: totalMatches, files: totalFiles });
      },
    );

    test.each(['content', 'count', 'files_with_matches'] as const)(
      'parses back empty %s output as zero results',
      (outputMode) => {
        expect(roundTrip(outputMode, {})).toEqual({ matches: 0, files: 0 });
      },
    );

    test('parses back timed-out and mtime partial outputs as zero results', () => {
      expect(roundTrip('content', { timedOut: true })).toEqual({
        matches: 0,
        files: 0,
      });
      expect(
        roundTrip('content', {
          partialPhase: 'replay',
          discoveredFiles: 2,
          timedOut: true,
        }),
      ).toEqual({ matches: 0, files: 0 });
    });

    test('failed searches have no parseable summary', () => {
      const input = inputFor('content');
      const output = formatGrepResult(
        input,
        resultFor(input, { error: 'boom' }),
      );
      expect(output.startsWith('grep search failed.')).toBe(true);
      expect(parseGrepSummary(output)).toBeNull();
    });
  });

  test('ignores non-grep tools', async () => {
    const hook = createGrepRenderMetadataHook();
    const output = {
      title: '',
      output: 'Found 2 matches across 1 file.',
      metadata: {},
    };

    await hook['tool.execute.after'](
      {
        tool: 'read',
        args: { pattern: 'alpha' },
      },
      output,
    );

    expect(output).toEqual({
      title: '',
      output: 'Found 2 matches across 1 file.',
      metadata: {},
    });
  });
});
