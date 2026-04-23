/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { ATTACHMENT_UNAVAILABLE_NOTE, MAX_OUTPUT_BYTES } from './constants';
import { buildTextMetadata } from './enhanced-metadata';
import {
  formatImageInfoResult,
  formatPdfResult,
  formatTextResult,
  renderTextResult,
} from './formatter';

function lastRenderedLineNumber(output: string): number | undefined {
  const matches = Array.from(output.matchAll(/^(\d+): /gm));
  const lastMatch = matches[matches.length - 1];
  return lastMatch ? Number(lastMatch[1]) : undefined;
}

describe('formatTextResult', () => {
  test('preserves blank lines and trailing whitespace inside the content block', () => {
    const output = formatTextResult({
      kind: 'text',
      path: '/tmp/sample.txt',
      content: 'alpha\n\n  beta  \n',
      startLine: 2,
      endLine: 5,
      totalLines: 5,
      truncatedByBytes: false,
      truncatedByLineLength: false,
      hasMore: false,
      mtimeMs: 0,
    });

    expect(output).toContain(
      '<content>\n2: alpha\n3: \n4:   beta  \n5: \n</content>',
    );
    expect(output).toContain('(End of file - showing lines 2-5 of 5)');
  });

  test('escapes structural path fields without escaping file content', () => {
    const output = formatTextResult({
      kind: 'text',
      path: '/tmp/<unsafe>&name\nfile.txt',
      content: '<literal>&content',
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncatedByBytes: false,
      truncatedByLineLength: false,
      hasMore: false,
      mtimeMs: 0,
    });

    expect(output).toContain(
      '<path>/tmp/&lt;unsafe&gt;&amp;name\\nfile.txt</path>',
    );
    expect(output).toContain('1: <literal>&content');
  });

  test('renders an exact single blank line window without collapsing the content block', () => {
    const output = formatTextResult({
      kind: 'text',
      path: '/tmp/blank.txt',
      content: '',
      startLine: 4,
      endLine: 4,
      totalLines: 4,
      truncatedByBytes: false,
      truncatedByLineLength: false,
      hasMore: false,
      mtimeMs: 0,
    });

    expect(output).toContain('<content>\n4: \n</content>');
    expect(output).toContain('(End of file - showing lines 4-4 of 4)');
  });

  test('keeps the final formatted text output within the global byte budget', () => {
    const line = 'x'.repeat(120);
    const content = Array.from({ length: 4096 }, () => line).join('\n');

    const output = formatTextResult({
      kind: 'text',
      path: '/tmp/large.txt',
      content,
      startLine: 1,
      endLine: 4096,
      totalLines: 4096,
      truncatedByBytes: false,
      truncatedByLineLength: false,
      hasMore: false,
      mtimeMs: 0,
    });

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
      mtimeMs: 0,
    };

    const rendered = renderTextResult(result);
    const metadata = buildTextMetadata({ filePath: result.path }, result);
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
      mtimeMs: 0,
    };

    const rendered = renderTextResult(result);
    const metadata = buildTextMetadata({ filePath: result.path }, result);

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
      mtimeMs: 0,
    };

    const output = formatTextResult(result);
    const metadata = buildTextMetadata({ filePath: result.path }, result);

    expect(output).toContain('(End of file - showing lines 1-1 of 1)');
    expect(output).toContain('truncated to 4096 characters');
    expect(metadata.truncated).toBe(true);
    expect(metadata.truncated_by_line_length).toBe(true);
    expect(metadata.has_more).toBe(false);
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
      mtimeMs: 0,
    });

    expect(output).toContain('<page_count>2</page_count>');
    expect(output).toContain(ATTACHMENT_UNAVAILABLE_NOTE);
    expect(output).not.toContain('<pages>');
  });

  test('escapes structural PDF path fields', () => {
    const output = formatPdfResult({
      kind: 'pdf',
      path: '/tmp/<unsafe>&file.pdf',
      mtimeMs: 0,
    });

    expect(output).toContain('<path>/tmp/&lt;unsafe&gt;&amp;file.pdf</path>');
  });
});
