/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import {
  MAX_LINE_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_CHARS,
  OUTPUT_CAPPED_NOTE,
} from './constants';
import {
  buildDirectoryFooter,
  buildDirectoryOutput,
  formatDirectoryResult,
  readDirectory,
} from './directory-reader';
import { renderTextResult } from './formatter';

const text = (
  startLine: number,
  content: string,
  firstTruncatedLine?: number,
) => ({
  kind: 'text' as const,
  path: '/tmp/boundary.txt',
  content,
  startLine,
  endLine: startLine + content.split('\n').length - 1,
  totalLines: undefined,
  hasMore: true,
  truncatedByBytes: true,
  truncatedByLineLength: firstTruncatedLine !== undefined,
  firstTruncatedLine,
});

// Independent candidate oracle: tune the next line to exceed the exact
// numbered-prefix budget by one character (including footer and notes).
function candidate(
  startLine: number,
  lines: string[],
  firstTruncatedLine?: number,
): string {
  const end = startLine + lines.length - 1;
  return [
    '<path>/tmp/boundary.txt</path>',
    '<type>file</type>',
    `<content>\n${lines.map((line, index) => `${startLine + index}: ${line}`).join('\n')}\n</content>`,
    `(Showing lines ${startLine}-${end}. Use offset=${end + 1} to continue.)`,
    ...(firstTruncatedLine !== undefined && firstTruncatedLine <= end
      ? [`(One or more lines were truncated to ${MAX_LINE_LENGTH} characters.)`]
      : []),
    OUTPUT_CAPPED_NOTE,
  ].join('\n');
}

function tunedWindow(startLine: number, firstTruncatedLine?: number) {
  const lines = ['x', '', 'end'];
  const base = candidate(startLine, lines.slice(0, 2), firstTruncatedLine);
  lines[1] = 'a'.repeat(MAX_OUTPUT_CHARS + 1 - base.length);
  return text(startLine, lines.join('\n'), firstTruncatedLine);
}

describe('exact text footer boundaries', () => {
  for (const startLine of [8, 98]) {
    test(`counts both end and next-offset digits when ${startLine + 1} crosses a decimal width`, () => {
      const result = renderTextResult(tunedWindow(startLine));
      expect(result.endLine).toBe(startLine);
      expect(result.truncatedByBytes).toBe(true);
      expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    });
  }

  test('counts end-line digits at the 9→10 transition', () => {
    const result = renderTextResult(tunedWindow(9));
    expect(result.endLine).toBe(9);
    expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  });

  test('counts a visible truncated-line note before accepting a line', () => {
    const result = renderTextResult(tunedWindow(1, 2));
    expect(result.endLine).toBe(1);
    expect(result.truncatedByLineLength).toBe(false);
    expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  });

  test('caps UTF-8 bytes even when an untruncated full window has hasMore=false', () => {
    const base = {
      ...text(1, ''),
      hasMore: false,
      truncatedByBytes: false,
      totalLines: 1,
    };
    const overhead = Buffer.byteLength(renderTextResult(base).output);
    const byteCount = MAX_OUTPUT_BYTES + 1 - overhead;
    const content = `${'€'.repeat(Math.floor(byteCount / 3))}${'a'.repeat(byteCount % 3)}`;
    const rendered = renderTextResult({ ...base, content });
    expect(rendered.hasMore).toBe(true);
    expect(rendered.truncatedByBytes).toBe(true);
    expect(Buffer.byteLength(rendered.output)).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    );
  });
});

const directory = '/tmp/boundary-directory';
const dirent = { isDirectory: () => false, isSymbolicLink: () => false } as any;
async function readEntries(names: string[]) {
  return readDirectory(directory, 1, 16384, {
    scanDirectoryEntries: async () => ({
      entries: names.map((name) => ({ name, dirent })),
      totalEntries: names.length,
      totalEntriesKnown: true,
    }),
  });
}

describe('exact directory footer boundaries', () => {
  test('retains a whole page whose footer fits the character cap exactly', async () => {
    const footer = buildDirectoryFooter({
      offset: 1,
      entriesCount: 1,
      totalEntries: 1,
      hasMore: false,
      truncatedByBytes: false,
    });
    const empty = buildDirectoryOutput(directory, [''], footer);
    const name = 'a'.repeat(MAX_OUTPUT_CHARS - empty.length);
    const result = await readEntries([name]);
    expect(result.entries).toEqual([name]);
    expect(result.truncatedByBytes).toBe(false);
    expect(result.hasMore).toBe(false);
    expect(formatDirectoryResult(result).length).toBe(MAX_OUTPUT_CHARS);
  });

  test('caps a multibyte directory entry on bytes before characters', async () => {
    const result = await readEntries(['€'.repeat(200_000)]);
    expect(result.entries).toHaveLength(0);
    expect(result.truncatedByBytes).toBe(true);
    expect(
      Buffer.byteLength(formatDirectoryResult(result)),
    ).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });
});
