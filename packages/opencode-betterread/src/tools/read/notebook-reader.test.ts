/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_OUTPUT_BYTES, MAX_PARSED_NOTEBOOK_BYTES } from './constants';
import { renderTextResult } from './formatter';
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

async function readSampleNotebook(
  filePath: string,
  offset: number,
  limit: number,
) {
  const handle = await open(filePath, 'r');
  try {
    return await readNotebook(
      offset,
      limit,
      handle,
      (await handle.stat()).size,
    );
  } finally {
    await handle.close();
  }
}

describe('readNotebook', () => {
  test('uses the parse path only below the parsed-notebook byte gate', () => {
    expect(shouldParseNotebook(MAX_PARSED_NOTEBOOK_BYTES)).toBe(true);
    expect(shouldParseNotebook(MAX_PARSED_NOTEBOOK_BYTES + 1)).toBe(false);
  });

  test('parses a near-cap notebook with 1,048,553 empty source lines', async () => {
    const raw = `${JSON.stringify({ cells: [{ cell_type: 'code', source: '\n'.repeat(1_048_553) }] })} `;
    expect(Buffer.byteLength(raw)).toBe(MAX_PARSED_NOTEBOOK_BYTES - 1);
    const filePath = await createRawNotebookFile(raw);
    const result = await readSampleNotebook(filePath, 1, 2);
    expect(result.mode).toBe('parsed');
    expect(result.totalLines).toBe(1_048_554);
    expect(result.content).toBe('# Cell 1 (code)\n');
  });

  test('does not invent a phantom line for empty notebooks', async () => {
    const filePath = await createNotebookFile({ cells: [] });
    const result = await readSampleNotebook(filePath, 1, 10);

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
    const result = await readSampleNotebook(filePath, 1, 10);

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
    const result = await readSampleNotebook(filePath, 1, 100);

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
    const result = await readSampleNotebook(filePath, 1, 10);

    expect(result.mode).toBe('parsed');
    expect(result.content).toContain('…');
    expect(result.truncatedByLineLength).toBe(true);
    expect(result.truncatedByBytes).toBe(false);
    expect(result.hasMore).toBe(false);
  });

  test('marks a long notebook line truncated when it is the last emitted line', async () => {
    const filePath = await createNotebookFile({
      cells: [{ cell_type: 'code', source: ['x'.repeat(5000)] }],
    });
    const result = await readSampleNotebook(filePath, 1, 2);
    const rendered = renderTextResult({ ...result, path: filePath });
    expect(result.firstTruncatedLine).toBe(2);
    expect(rendered.endLine).toBe(2);
    expect(rendered.truncatedByLineLength).toBe(true);
  });

  test('does not mark an omitted long notebook line as emitted or truncated', async () => {
    const source = [
      ...Array.from(
        { length: 2070 },
        (_, index) => `${'x'.repeat(index < 200 ? 119 : 118)}\n`,
      ),
      'z'.repeat(5000),
    ];
    const filePath = await createNotebookFile({
      cells: [{ cell_type: 'code', source }],
    });
    const result = await readSampleNotebook(filePath, 1, 4096);
    const rendered = renderTextResult({ ...result, path: filePath });
    expect(result.firstTruncatedLine).toBe(2072);
    expect(rendered.endLine).toBeLessThan(result.firstTruncatedLine as number);
    expect(rendered.truncatedByLineLength).toBe(false);
    expect(rendered.output).not.toContain('One or more lines were truncated');
  });

  test('falls back to streaming text for large notebooks before parsing', async () => {
    const contents = `${'{not valid json}\n'}${'x'.repeat(MAX_PARSED_NOTEBOOK_BYTES + 1)}`;
    const filePath = await createRawNotebookFile(contents);
    const result = await readSampleNotebook(filePath, 1, 1);

    expect(result.kind).toBe('notebook');
    expect(result.mode).toBe('raw-fallback');
    expect(result.content).toContain('{not valid json}');
    expect(result.totalLines).toBeUndefined();
    expect(result.hasMore).toBe(true);
  });

  test('falls back to raw text when a small notebook cannot be parsed as JSON', async () => {
    const filePath = await createRawNotebookFile('{not valid json');
    const result = await readSampleNotebook(filePath, 1, 10);

    expect(result.kind).toBe('notebook');
    expect(result.mode).toBe('raw-fallback');
    expect(result.content).toContain('{not valid json');
  });

  test('falls back to raw text for valid JSON that is not a notebook', async () => {
    const filePath = await createRawNotebookFile('{"hello":"not a notebook"}');
    const result = await readSampleNotebook(filePath, 1, 10);

    expect(result.kind).toBe('notebook');
    expect(result.mode).toBe('raw-fallback');
    expect(result.content).toContain('"hello"');
  });

  test('restarts raw fallback from byte zero after a shared parse attempt', async () => {
    const filePath = await createRawNotebookFile('{"hello":"not a notebook"}');
    const handle = await open(filePath, 'r');

    try {
      const result = await readNotebook(
        1,
        10,
        handle,
        (await handle.stat()).size,
      );

      expect(result.mode).toBe('raw-fallback');
      expect(result.content).toContain('"hello"');
    } finally {
      await handle.close();
    }
  });

  test('falls back to raw text when cells contain non-object values', async () => {
    const filePath = await createNotebookFile({ cells: [42, null, 'oops'] });
    const result = await readSampleNotebook(filePath, 1, 10);

    expect(result.mode).toBe('raw-fallback');
    expect(result.content).toContain('42');
  });

  test('falls back to raw text when a cell type spans multiple lines', async () => {
    const filePath = await createNotebookFile({
      cells: [
        {
          cell_type: 'code\nextra',
          source: ['print(1)'],
        },
      ],
    });
    const result = await readSampleNotebook(filePath, 1, 10);

    expect(result.kind).toBe('notebook');
    expect(result.mode).toBe('raw-fallback');
    expect(result.content).toContain('code');
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
    const result = await readSampleNotebook(filePath, 1, 10);

    expect(result.content).toBe('# Cell 1 (code)\nalpha\nbeta');
    expect(result.totalLines).toBe(3);
  });
});
