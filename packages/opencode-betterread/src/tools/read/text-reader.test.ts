/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FAST_PATH_MAX_BYTES, MAX_LINE_LENGTH } from './constants';
import { readTextFile, readTextFileStreaming } from './text-reader';

const tempDirs: string[] = [];

async function createTempFile(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'betterread-text-'));
  tempDirs.push(directory);
  const filePath = path.join(directory, 'sample.txt');
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

async function createLargeTempFile(): Promise<string> {
  const filler = 'x'.repeat(2048);
  const sampleLine = `line-1:${filler}`;
  const bytesPerLine = Buffer.byteLength(`${sampleLine}\n`, 'utf8');
  const lineCount = Math.ceil(
    (FAST_PATH_MAX_BYTES + bytesPerLine) / bytesPerLine,
  );
  const contents = `${Array.from(
    { length: lineCount },
    (_, index) => `line-${index + 1}:${filler}`,
  ).join('\n')}\n`;

  return createTempFile(contents);
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('readTextFile', () => {
  test('reads a selected window with total lines on fast path', async () => {
    const filePath = await createTempFile('one\ntwo\nthree\nfour\n');
    const result = await readTextFile(filePath, 2, 2);

    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.totalLines).toBe(4);
    expect(result.content).toBe('two\nthree');
    expect(result.hasMore).toBe(true);
  });

  test('does not invent a phantom final line for trailing newlines', async () => {
    const filePath = await createTempFile('one\ntwo\n');
    const result = await readTextFile(filePath, 2, 2);

    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(2);
    expect(result.totalLines).toBe(2);
    expect(result.content).toBe('two');
    expect(result.hasMore).toBe(false);
  });

  test('preserves blank lines and trailing spaces inside the selected window', async () => {
    const filePath = await createTempFile(' alpha  \n\n beta  \n');
    const result = await readTextFile(filePath, 1, 3);

    expect(result.content).toBe(' alpha  \n\n beta  ');
    expect(result.endLine).toBe(3);
    expect(result.totalLines).toBe(3);
  });

  test('supports CR-only line endings in the fast path', async () => {
    const filePath = await createTempFile('one\rtwo\rthree\r');
    const result = await readTextFile(filePath, 2, 2);

    expect(result.content).toBe('two\nthree');
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.totalLines).toBe(3);
  });

  test('truncates very long lines for model safety', async () => {
    const filePath = await createTempFile(`${'x'.repeat(5000)}\n`);
    const result = await readTextFile(filePath, 1, 1);
    const [line] = result.content.split('\n');

    expect(line.length).toBeGreaterThan(4000);
    expect(line.endsWith('…')).toBe(true);
    expect(result.truncatedByLineLength).toBe(true);
    expect(result.truncatedByBytes).toBe(false);
    expect(result.hasMore).toBe(false);
  });

  test('streams large files without duplicating lines and respects offset and limit', async () => {
    const filePath = await createLargeTempFile();
    const result = await readTextFile(filePath, 120, 3);
    const filler = 'x'.repeat(2048);

    expect(result.content.split('\n')).toEqual([
      `line-120:${filler}`,
      `line-121:${filler}`,
      `line-122:${filler}`,
    ]);
    expect(result.startLine).toBe(120);
    expect(result.endLine).toBe(122);
    expect(result.hasMore).toBe(true);
    expect(result.totalLines).toBeUndefined();
  });

  test('supports CRLF, LF, and CR line endings in the streaming path', async () => {
    const filePath = await createTempFile('one\r\ntwo\nthree\rfour\r\n');
    const result = await readTextFileStreaming(filePath, 2, 3);

    expect(result.content).toBe('two\nthree\nfour');
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(4);
    expect(result.totalLines).toBe(4);
    expect(result.hasMore).toBe(false);
  });

  test('streams giant physical lines without retaining the whole line', async () => {
    const filePath = await createTempFile(
      `${'x'.repeat(FAST_PATH_MAX_BYTES + 4096)}\nsecond\n`,
    );
    const result = await readTextFile(filePath, 1, 1);

    expect(result.content).toBe(`${'x'.repeat(MAX_LINE_LENGTH)}…`);
    expect(result.truncatedByLineLength).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.totalLines).toBeUndefined();
  });
});
