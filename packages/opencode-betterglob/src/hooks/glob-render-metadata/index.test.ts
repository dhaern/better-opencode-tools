import { describe, expect, test } from 'bun:test';
import { createGlobRenderMetadataHook, parseGlobOutputSummary } from './index';

describe('glob render metadata hook', () => {
  test('parses empty glob output as zero results', () => {
    expect(parseGlobOutputSummary('No files found')).toEqual({
      count: 0,
      truncated: false,
    });
  });

  test('parses truncation note output', () => {
    expect(
      parseGlobOutputSummary(
        [
          '/tmp/repo/a.ts',
          '/tmp/repo/b.ts',
          '',
          '(Results are truncated: showing first 2 results. Consider using a more specific path or pattern.)',
        ].join('\n'),
      ),
    ).toEqual({ count: 2, truncated: true });

    expect(
      parseGlobOutputSummary(
        [
          '/tmp/repo/a.ts',
          '/tmp/repo/b.ts',
          '',
          '(Results are truncated: reached the 2-result limit. Consider using a more specific path or pattern.)',
        ].join('\n'),
      ),
    ).toEqual({ count: 2, truncated: true });
  });

  test('ignores timeout and error status lines when rebuilding metadata', () => {
    expect(
      parseGlobOutputSummary('Search timed out before completing.'),
    ).toEqual({
      count: 0,
      truncated: false,
    });

    expect(
      parseGlobOutputSummary(
        ['No files found', '', 'Search timed out before completing.'].join(
          '\n',
        ),
      ),
    ).toEqual({ count: 0, truncated: false });

    expect(
      parseGlobOutputSummary('glob search failed.\nrg not available'),
    ).toEqual({
      count: 0,
      truncated: false,
    });
  });

  test('hydrates final output metadata for glob tools', async () => {
    const hook = createGlobRenderMetadataHook();
    const output: { title?: unknown; output: unknown; metadata?: unknown } = {
      title: '',
      output: '/tmp/repo/a.ts\n/tmp/repo/b.ts',
      metadata: {},
    };

    await hook['tool.execute.after'](
      {
        tool: 'glob',
        args: { pattern: '**/*.ts' },
      },
      output,
    );

    expect(output.title).toBe('**/*.ts');
    expect(output.metadata).toEqual({ count: 2, truncated: false });
  });

  test('preserves existing metadata values', async () => {
    const hook = createGlobRenderMetadataHook();
    const output: { title?: unknown; output: unknown; metadata?: unknown } = {
      title: 'existing',
      output: '/tmp/repo/a.ts\n/tmp/repo/b.ts',
      metadata: { count: 7, truncated: true },
    };

    await hook['tool.execute.after'](
      {
        tool: 'glob',
        args: { pattern: '**/*.ts' },
      },
      output,
    );

    expect(output).toEqual({
      title: 'existing',
      output: '/tmp/repo/a.ts\n/tmp/repo/b.ts',
      metadata: { count: 7, truncated: true },
    });
  });

  test('upgrades truncated metadata when output includes the truncation note', async () => {
    const hook = createGlobRenderMetadataHook();
    const output: { title?: unknown; output: unknown; metadata?: unknown } = {
      title: 'existing',
      output: [
        '/tmp/repo/a.ts',
        '',
        '(Results are truncated: showing first 1 results. Consider using a more specific path or pattern.)',
      ].join('\n'),
      metadata: { count: 1, truncated: false },
    };

    await hook['tool.execute.after'](
      {
        tool: 'glob',
        args: { pattern: '**/*.ts' },
      },
      output,
    );

    expect(output.metadata).toEqual({ count: 1, truncated: true });
  });

  test('ignores non-glob tools', async () => {
    const hook = createGlobRenderMetadataHook();
    const output = {
      title: '',
      output: '/tmp/repo/a.ts',
      metadata: {},
    };

    await hook['tool.execute.after'](
      {
        tool: 'grep',
        args: { pattern: '**/*.ts' },
      },
      output,
    );

    expect(output).toEqual({
      title: '',
      output: '/tmp/repo/a.ts',
      metadata: {},
    });
  });
});
