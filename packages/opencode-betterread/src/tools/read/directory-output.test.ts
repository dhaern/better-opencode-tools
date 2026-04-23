/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import {
  buildDirectoryFooter,
  buildDirectoryOutput,
  escapeDirectoryEntry,
} from './directory-output';

describe('escapeDirectoryEntry', () => {
  test('escapes newline characters in directory entry names', () => {
    expect(escapeDirectoryEntry('a\nnewline.txt')).toBe('a\\nnewline.txt');
    expect(escapeDirectoryEntry('a\rnewline.txt')).toBe('a\\rnewline.txt');
  });

  test('escapes backslashes before newline escape sequences', () => {
    expect(escapeDirectoryEntry('a\\nnewline.txt')).toBe('a\\\\nnewline.txt');
  });

  test('escapes structural XML-like characters in directory entry names', () => {
    expect(escapeDirectoryEntry('a<&>b.txt')).toBe('a&lt;&amp;&gt;b.txt');
  });
});

describe('buildDirectoryOutput', () => {
  test('renders newline-containing names as a single escaped entry', () => {
    const output = buildDirectoryOutput(
      '/tmp',
      ['normal.txt', 'a\nnewline.txt'],
      '(End of directory - 2 entries)',
    );

    expect(output).toContain('normal.txt\na\\nnewline.txt');
    expect(output).not.toContain('a\nnewline.txt');
  });

  test('escapes structural path fields', () => {
    const output = buildDirectoryOutput(
      '/tmp/<unsafe>&dir',
      ['normal.txt'],
      '(End of directory - 1 entries)',
    );

    expect(output).toContain('<path>/tmp/&lt;unsafe&gt;&amp;dir</path>');
  });
});

describe('buildDirectoryFooter', () => {
  test('treats offset=1 in an empty directory as end of directory', () => {
    expect(
      buildDirectoryFooter({
        offset: 1,
        entriesCount: 0,
        totalEntries: 0,
        hasMore: false,
        truncatedByBytes: false,
      }),
    ).toBe('(End of directory - 0 entries)');
  });

  test('labels bounded scans honestly when the total is not yet known', () => {
    expect(
      buildDirectoryFooter({
        offset: 1,
        entriesCount: 3,
        totalEntries: 132,
        totalEntriesKnown: false,
        hasMore: true,
        truncatedByBytes: false,
      }),
    ).toBe(
      '(Showing entries 1-3 of at least 132 from a bounded directory scan. Exact pagination beyond the first window is not supported; use a more specific path.)',
    );
  });
});
