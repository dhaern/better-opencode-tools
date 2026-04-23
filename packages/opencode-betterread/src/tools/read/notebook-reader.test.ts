/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_OUTPUT_BYTES, MAX_PARSED_NOTEBOOK_BYTES } from './constants';
import { readNotebook, shouldParseNotebook } from './notebook-reader';

const tempDirs: string[] = [];

async function createNotebookFile(contents: unknown): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'betterread-notebook-'),
  );
  tempDirs.push(directory);
  const filePath = path.join(directory, 'sample.ipynb');
  await writeFile(filePath, JSON.stringify(contents), 'utf8');
  return filePath;
}

async function createRawNotebookFile(contents: string): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'betterread-notebook-'),
  );
  tempDirs.push(directory);
  const filePath = path.join(directory, 'sample.ipynb');
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('readNotebook', () => {
  test('uses the parse path only below the parsed-notebook byte gate', () => {
    expect(shouldParseNotebook(MAX_PARSED_NOTEBOOK_BYTES)).toBe(true);
    expect(shouldParseNotebook(MAX_PARSED_NOTEBOOK_BYTES + 1)).toBe(false);
  });

  test('does not invent a phantom line for empty notebooks', async () => {
    const filePath = await createNotebookFile({ cells: [] });
    const result = await readNotebook(filePath, 1, 10);

    expect(result.content).toBe('');
    expect(result.mode).toBe('parsed');
    expect(result.totalLines).toBe(0);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  test('preserves notebook whitespace and blank lines without trimming them away', async () => {
    const filePath = await createNotebookFile({
      cells: [
        {
          cell_type: 'code',
          source: ['  alpha  \n', '\n', 'beta  '],
        },
        {
          cell_type: 'markdown',
          source: ['gamma'],
        },
      ],
    });
    const result = await readNotebook(filePath, 1, 10);

    expect(result.content).toBe(
      '# Cell 1 (code)\n  alpha  \n\nbeta  \n\n# Cell 2 (markdown)\ngamma',
    );
    expect(result.totalLines).toBe(7);
    expect(result.truncatedByBytes).toBe(false);
  });

  test('caps parsed notebook output to the shared byte and character budget', async () => {
    const line = `${'€'.repeat(4096)}\n`;
    const filePath = await createNotebookFile({
      cells: [
        {
          cell_type: 'code',
          source: Array.from({ length: 60 }, () => line),
        },
      ],
    });
    const result = await readNotebook(filePath, 1, 100);

    expect(result.truncatedByBytes).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.totalLines).toBe(61);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    );
  });

  test('marks parsed notebook cells as truncated when a rendered line exceeds MAX_LINE_LENGTH', async () => {
    const filePath = await createNotebookFile({
      cells: [
        {
          cell_type: 'code',
          source: [`${'x'.repeat(5000)}\n`],
        },
      ],
    });
    const result = await readNotebook(filePath, 1, 10);

    expect(result.mode).toBe('parsed');
    expect(result.content).toContain('…');
    expect(result.truncatedByLineLength).toBe(true);
    expect(result.truncatedByBytes).toBe(false);
    expect(result.hasMore).toBe(false);
  });

  test('falls back to streaming text for large notebooks before parsing', async () => {
    const contents = `${'{not valid json}\n'}${'x'.repeat(MAX_PARSED_NOTEBOOK_BYTES + 1)}`;
    const filePath = await createRawNotebookFile(contents);
    const result = await readNotebook(filePath, 1, 1);

    expect(result.kind).toBe('notebook');
    expect(result.mode).toBe('raw-fallback');
    expect(result.content).toContain('{not valid json}');
    expect(result.totalLines).toBeUndefined();
    expect(result.hasMore).toBe(true);
  });

  test('falls back to raw text when a small notebook cannot be parsed as JSON', async () => {
    const filePath = await createRawNotebookFile('{not valid json');
    const result = await readNotebook(filePath, 1, 10);

    expect(result.kind).toBe('notebook');
    expect(result.mode).toBe('raw-fallback');
    expect(result.content).toContain('{not valid json');
  });

  test('supports CR-only line endings inside notebook cell sources', async () => {
    const filePath = await createNotebookFile({
      cells: [
        {
          cell_type: 'code',
          source: ['alpha\rbeta\r'],
        },
      ],
    });
    const result = await readNotebook(filePath, 1, 10);

    expect(result.content).toBe('# Cell 1 (code)\nalpha\nbeta');
    expect(result.totalLines).toBe(3);
  });
});
