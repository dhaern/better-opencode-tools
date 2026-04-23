/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { createReadRenderMetadataHook } from './index';

describe('hooks/read-render-metadata', () => {
  test('sets a sanitized title for read results when one is missing', async () => {
    const hook = createReadRenderMetadataHook();
    const output: { title?: unknown; metadata?: Record<string, unknown> } = {
      title: undefined,
      metadata: {
        truncated: false,
        has_more: true,
      },
    };

    await hook['tool.execute.after'](
      {
        tool: 'read',
        args: {
          filePath: '/tmp/example.txt\nwith-space',
        },
      },
      output,
    );

    expect(output.title).toBe('/tmp/example.txt with-space');
    expect(output.metadata?.truncated).toBe(true);
  });

  test('keeps runtime truncation when bridge already truncated output', async () => {
    const hook = createReadRenderMetadataHook();
    const output: { title?: unknown; metadata?: Record<string, unknown> } = {
      metadata: {
        truncated: true,
        has_more: false,
        truncated_by_bytes: false,
      },
    };

    await hook['tool.execute.after'](
      { tool: 'read', args: { filePath: '/tmp/example.txt' } },
      output,
    );

    expect(output.metadata?.truncated).toBe(true);
  });

  test('leaves non-read tool outputs unchanged', async () => {
    const hook = createReadRenderMetadataHook();
    const output: { title?: unknown; metadata?: Record<string, unknown> } = {
      title: undefined,
      metadata: { truncated: false, has_more: true },
    };

    await hook['tool.execute.after'](
      {
        tool: 'glob',
        args: {
          filePath: '/tmp/example.txt',
        },
      },
      output,
    );

    expect(output.title).toBeUndefined();
    expect(output.metadata?.truncated).toBe(false);
  });
});
