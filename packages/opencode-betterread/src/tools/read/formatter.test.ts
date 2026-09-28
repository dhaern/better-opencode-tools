/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ATTACHMENT_DATA_URL_NOTE, MAX_OUTPUT_BYTES } from './constants';
import { executeRead } from './engine';
import {
  buildTextMetadata,
  formatImageInfoResult,
  formatPdfResult,
  renderTextResult,
} from './formatter';

function lastRenderedLineNumber(output: string): number | undefined {
  const matches = Array.from(output.matchAll(/^(\d+): /gm));
  const lastMatch = matches[matches.length - 1];
  return lastMatch ? Number(lastMatch[1]) : undefined;
}

describe('formatTextResult', () => {
  test('preserves blank lines and trailing whitespace inside the content block', () => {
    const output = renderTextResult({
      kind: 'text',
      path: '/tmp/sample.txt',
      content: 'alpha\n\n  beta  \n',
      startLine: 2,
      endLine: 5,
      totalLines: 5,
      truncatedByBytes: false,
      truncatedByLineLength: false,
      hasMore: false,
    }).output;

    expect(output).toContain(
      '<content>\n2: alpha\n3: \n4:   beta  \n5: \n</content>',
    );
    expect(output).toContain('(End of file - showing lines 2-5 of 5)');
  });

  test('escapes structural path fields without escaping file content', () => {
    const output = renderTextResult({
      kind: 'text',
      path: '/tmp/<unsafe>&name\nfile.txt',
      content: '<literal>&content',
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncatedByBytes: false,
      truncatedByLineLength: false,
      hasMore: false,
    }).output;

    expect(output).toContain(
      '<path>/tmp/&lt;unsafe&gt;&amp;name\\nfile.txt</path>',
    );
    expect(output).toContain('1: <literal>&content');
  });

  test('renders an exact single blank line window without collapsing the content block', () => {
    const output = renderTextResult({
      kind: 'text',
      path: '/tmp/blank.txt',
      content: '',
      startLine: 4,
      endLine: 4,
      totalLines: 4,
      truncatedByBytes: false,
      truncatedByLineLength: false,
      hasMore: false,
    }).output;

    expect(output).toContain('<content>\n4: \n</content>');
    expect(output).toContain('(End of file - showing lines 4-4 of 4)');
  });

  test('keeps the final formatted text output within the global byte budget', () => {
    const line = 'x'.repeat(120);
    const content = Array.from({ length: 4096 }, () => line).join('\n');

    const output = renderTextResult({
      kind: 'text',
      path: '/tmp/large.txt',
      content,
      startLine: 1,
      endLine: 4096,
      totalLines: 4096,
      truncatedByBytes: false,
      truncatedByLineLength: false,
      hasMore: false,
    }).output;

    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    );
    expect(output).toContain('(Output capped by byte budget.)');
  });

  test('syncs metadata end_line with the final formatter cap', () => {
    const line = 'x'.repeat(120);
    const result = {
      kind: 'text' as const,
      path: '/tmp/large.txt',
      content: Array.from({ length: 4096 }, () => line).join('\n'),
      startLine: 1,
      endLine: 4096,
      totalLines: 4096,
      truncatedByBytes: false,
      truncatedByLineLength: false,
      hasMore: false,
    };

    const rendered = renderTextResult(result);
    const metadata = buildTextMetadata(
      { filePath: result.path },
      result,
      rendered,
    );
    const lastLine = lastRenderedLineNumber(rendered.output);

    if (lastLine === undefined) {
      throw new Error('Expected at least one rendered line');
    }

    expect(metadata.end_line).toBe(lastLine);
    expect(lastLine).toBeLessThan(result.endLine);
  });

  test('syncs metadata has_more and truncated_by_bytes with the final formatter cap', () => {
    const line = 'x'.repeat(120);
    const result = {
      kind: 'text' as const,
      path: '/tmp/large-metadata.txt',
      content: Array.from({ length: 4096 }, () => line).join('\n'),
      startLine: 1,
      endLine: 4096,
      totalLines: 4096,
      truncatedByBytes: false,
      truncatedByLineLength: false,
      hasMore: false,
    };

    const rendered = renderTextResult(result);
    const metadata = buildTextMetadata(
      { filePath: result.path },
      result,
      rendered,
    );

    expect(rendered.truncated).toBe(true);
    expect(rendered.hasMore).toBe(true);
    expect(rendered.truncatedByBytes).toBe(true);
    expect(metadata.has_more).toBe(true);
    expect(metadata.truncated_by_bytes).toBe(true);
  });

  test('adds an explicit line-truncation note and metadata flag', () => {
    const result = {
      kind: 'text' as const,
      path: '/tmp/long-line.txt',
      content: `${'x'.repeat(4096)}…`,
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncatedByBytes: false,
      truncatedByLineLength: true,
      hasMore: false,
    };

    const rendered = renderTextResult(result);
    const output = rendered.output;
    const metadata = buildTextMetadata(
      { filePath: result.path },
      result,
      rendered,
    );

    expect(output).toContain('(End of file - showing lines 1-1 of 1)');
    expect(output).toContain('truncated to 4096 characters');
    expect(metadata.truncated).toBe(true);
    expect(metadata.truncated_by_line_length).toBe(true);
    expect(metadata.has_more).toBe(false);
  });

  test('does not report a truncated line removed by the final output cap', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'betterread-h2-'));
    const filePath = path.join(directory, 'long.txt');
    try {
      writeFileSync(
        filePath,
        `${Array.from({ length: 2071 }, (_, index) => 'x'.repeat(index < 200 ? 119 : 118)).join('\n')}\n${'x'.repeat(4097)}`,
      );
      const result = await executeRead({
        args: { filePath, limit: 16384 },
        directory,
      });
      expect(result.output).toContain('2071: ');
      expect(result.output.includes('2072: ')).toBe(false);
      expect(result.output.includes('One or more lines were truncated')).toBe(
        false,
      );
      expect(result.metadata.truncated_by_line_length).toBe(false);
      expect(result.metadata.has_more).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('reports a truncated line at the last emitted line, not the first removed line', () => {
    const result = {
      kind: 'text' as const,
      path: '/tmp/edge.txt',
      content: `${'x'.repeat(116)}\n${'y'.repeat(4096)}…`,
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      truncatedByBytes: false,
      truncatedByLineLength: true,
      firstTruncatedLine: 2,
      hasMore: false,
    };
    const rendered = renderTextResult(result);
    expect(rendered.endLine).toBe(2);
    expect(rendered.truncatedByLineLength).toBe(true);
    expect(rendered.output).toContain('One or more lines were truncated');
    const beyond = renderTextResult({ ...result, firstTruncatedLine: 3 });
    expect(beyond.truncatedByLineLength).toBe(false);
    expect(beyond.output).not.toContain('One or more lines were truncated');
  });
});

describe('formatImageInfoResult', () => {
  test('escapes unsafe basenames in the metadata summary line', () => {
    const output = formatImageInfoResult({
      kind: 'image',
      path: '/tmp/unsafe\n<image>&.png',
      mime: 'image/png',
      sizeBytes: 42,
    });

    expect(output).toContain(
      'Image metadata extracted: unsafe\\n&lt;image&gt;&amp;.png',
    );
    expect(output).not.toContain('unsafe\n<image>&.png');
  });
});

describe('formatPdfResult', () => {
  test('keeps PDFs metadata-only without exposing page selections', () => {
    const output = formatPdfResult({
      kind: 'pdf',
      path: '/tmp/sample.pdf',
      pageCount: 2,
    });

    expect(output).toContain('<page_count>2</page_count>');
    expect(output).toContain(ATTACHMENT_DATA_URL_NOTE);
    expect(output).not.toContain('<pages>');
  });

  test('escapes structural PDF path fields', () => {
    const output = formatPdfResult({
      kind: 'pdf',
      path: '/tmp/<unsafe>&file.pdf',
    });

    expect(output).toContain('<path>/tmp/&lt;unsafe&gt;&amp;file.pdf</path>');
  });
});
