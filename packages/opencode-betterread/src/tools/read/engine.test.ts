/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBoundedBytes } from './attachments';
import {
  ATTACHMENT_DATA_URL_NOTE,
  FAST_PATH_MAX_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_CHARS,
} from './constants';
import { executeRead, inspectReadTarget } from './engine';

const tempDirs: string[] = [];
const tinyPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x08, 0x02,
  0x00, 0x00, 0x00,
]);

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'betterread-engine-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('executeRead', () => {
  test('stops attachment reads immediately when aborted during the first read', async () => {
    const controller = new AbortController();
    let reads = 0;
    const handle = {
      read: async (buffer: Buffer, offset: number) => {
        reads += 1;
        if (reads === 1) controller.abort();
        const bytesRead = reads < 4 ? 1 : 0;
        if (bytesRead) buffer[offset] = 0x61;
        return { buffer, bytesRead };
      },
    } as any;
    const error = await readBoundedBytes(handle, 100, controller.signal).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(reads).toBe(1);
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  test('closes each verified descriptor after repeated reads on Linux', async () => {
    if (process.platform !== 'linux') return;
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'fd.txt');
    await writeFile(filePath, 'sample\n');
    const before = (await readdir('/proc/self/fd')).length;
    for (let index = 0; index < 20; index += 1) {
      await executeRead({ args: { filePath }, directory });
    }
    const after = (await readdir('/proc/self/fd')).length;
    expect(after - before).toBe(0);
  });

  test('counts all lines of an exactly 1 MiB file even for a one-line window', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'exact-1m.txt');
    const bytes = Buffer.concat([
      Buffer.alloc(FAST_PATH_MAX_BYTES - 2, 0x61),
      Buffer.from('\nb'),
    ]);
    expect(bytes.length).toBe(FAST_PATH_MAX_BYTES);
    await writeFile(filePath, bytes);
    const result = await executeRead({
      args: { filePath, limit: 1 },
      directory,
    });
    expect(result.metadata.total_lines).toBe(2);
    expect(result.metadata.has_more).toBe(true);
  });

  test('allows an attachment size hint equal to the cap without rejecting it', async () => {
    const payload = Buffer.from('0123456789');
    let reads = 0;
    const handle = {
      read: async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        reads += 1;
        const bytesRead = Math.min(
          length,
          Math.max(0, payload.length - position),
        );
        payload.copy(buffer, offset, position, position + bytesRead);
        return { buffer, bytesRead };
      },
    } as any;
    expect(
      await readBoundedBytes(handle, payload.length, undefined, payload.length),
    ).toEqual(payload);
    expect(reads).toBeGreaterThan(0);
  });

  test('shows the requested path for both text and notebooks through a linked directory', async () => {
    const directory = await createWorkspace();
    const canonical = path.join(directory, 'canonical');
    const alias = path.join(directory, 'alias');
    await mkdir(canonical);
    await writeFile(path.join(canonical, 'sample.txt'), 'hello\n');
    await writeFile(
      path.join(canonical, 'sample.ipynb'),
      JSON.stringify({ cells: [{ cell_type: 'code', source: ['hello\n'] }] }),
    );
    await symlink(canonical, alias, 'dir');

    for (const file of ['sample.txt', 'sample.ipynb']) {
      const requested = path.join(alias, file);
      const result = await executeRead({
        args: { filePath: requested },
        directory,
      });
      expect(result.output.startsWith(`<path>${requested}</path>`)).toBe(true);
      expect(result.metadata.resolved_path).toBe(requested);
      expect(result.metadata.real_path).toBe(path.join(canonical, file));
    }
  });

  test('grows past a stale attachment size hint and still enforces the cap', async () => {
    const payload = Buffer.from('0123456789abcdefghijklmn');
    const handle = {
      read: async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const bytesRead = Math.max(
          0,
          Math.min(length, payload.length - position),
        );
        payload.copy(buffer, offset, position, position + bytesRead);
        return { buffer, bytesRead };
      },
    } as any;

    expect(await readBoundedBytes(handle, 64, undefined, 4)).toEqual(payload);
    expect(
      await readBoundedBytes(handle, payload.length, undefined, 4),
    ).toEqual(payload);
    await expect(readBoundedBytes(handle, 10, undefined, 4)).rejects.toThrow(
      'Embedded attachment exceeds the 10 byte limit',
    );
  });

  test('rejects an over-cap size hint without reading', async () => {
    let reads = 0;
    const handle = {
      read: async () => {
        reads += 1;
        return { buffer: Buffer.alloc(0), bytesRead: 0 };
      },
    } as any;

    await expect(readBoundedBytes(handle, 10, undefined, 11)).rejects.toThrow(
      'Embedded attachment exceeds the 10 byte limit',
    );
    expect(reads).toBe(0);
  });

  test('reads an attachment of known size with one data read', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'large.png');
    const bytes = Buffer.concat([tinyPng, Buffer.alloc(3 * 1024 * 1024, 1)]);
    await writeFile(filePath, bytes);
    const file = await open(filePath, 'r');
    let reads = 0;
    const handle = {
      read: (...args: Parameters<typeof file.read>) => {
        reads += 1;
        return file.read(...args);
      },
    } as any;

    try {
      expect(
        await readBoundedBytes(
          handle,
          20 * 1024 * 1024,
          undefined,
          bytes.length,
        ),
      ).toEqual(bytes);
      expect(reads).toBeLessThanOrEqual(3);
    } finally {
      await file.close();
    }
  });

  test('does not misclassify text with BM or high-bit signatures as images/PDFs', async () => {
    const directory = await createWorkspace();
    const cases: [string, Buffer | string][] = [
      ['bm25.md', 'BM25 ranking notes\n'],
      ['bmw.md', 'BMW notes on vehicle history\n'],
      ['latin1-gif.txt', Buffer.from('ÇÉÆ¸¹á text\n', 'latin1')],
      [
        'high-gif.txt',
        Buffer.concat([
          Buffer.from('GIF89a').map((byte) => byte | 0x80),
          Buffer.from(' text\n'),
        ]),
      ],
      [
        'high-pdf.txt',
        Buffer.concat([
          Buffer.from('%PDF-').map((byte) => byte | 0x80),
          Buffer.from(' text\n'),
        ]),
      ],
    ];
    for (const [name, contents] of cases) {
      const filePath = path.join(directory, name);
      await writeFile(filePath, contents);
      const result = await executeRead({ args: { filePath }, directory });
      expect(result.metadata.kind).toBe('text');
      expect(result.attachments).toBeUndefined();
    }
    const invalidBmp = Buffer.alloc(58);
    invalidBmp.write('BM');
    invalidBmp.writeUInt32LE(24, 14);
    const filePath = path.join(directory, 'invalid.bmp');
    await writeFile(filePath, invalidBmp);
    expect(
      (await executeRead({ args: { filePath }, directory })).metadata.kind,
    ).not.toBe('image');
  });

  test('embeds BMP images with a valid DIB header', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'tiny.bmp');
    const bmp = Buffer.alloc(58);
    bmp.write('BM', 0, 'latin1');
    bmp.writeUInt32LE(40, 14);
    await writeFile(filePath, bmp);

    const result = await executeRead({ args: { filePath }, directory });

    expect(result.output).toContain('<mime>image/bmp</mime>');
    expect(result.attachments?.[0]?.url).toBe(
      `data:image/bmp;base64,${bmp.toString('base64')}`,
    );
  });

  test('keeps the largest directory prefix within the output budget', async () => {
    const directory = await createWorkspace();
    await Promise.all(
      Array.from({ length: 1100 }, (_, index) =>
        writeFile(
          path.join(
            directory,
            `${String(index).padStart(5, '0')}-${'n'.repeat(244)}`,
          ),
          '',
        ),
      ),
    );
    const result = await executeRead({
      args: { filePath: directory, limit: 16384 },
      directory,
    });

    expect(result.metadata.truncated_by_bytes).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(MAX_OUTPUT_CHARS - result.output.length).toBeLessThan(251);
  });

  test('budgets directory output with the displayed symlink path', async () => {
    const directory = await createWorkspace();
    const target = path.join(directory, 'target');
    await mkdir(target);
    await Promise.all(
      Array.from({ length: 1100 }, (_, index) =>
        writeFile(
          path.join(
            target,
            `${String(index).padStart(5, '0')}-${'n'.repeat(244)}`,
          ),
          '',
        ),
      ),
    );
    const parent = path.join(directory, 'a'.repeat(200), 'b'.repeat(200));
    await mkdir(parent, { recursive: true });
    const link = path.join(parent, 'link');
    await symlink(target, link);

    const result = await executeRead({
      args: { filePath: link, limit: 16384 },
      directory,
    });

    expect(result.output.startsWith(`<path>${link}</path>`)).toBe(true);
    expect(result.metadata.truncated_by_bytes).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  });

  test('keeps numbered text lines intact when the output cap is reached', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'numbered.txt');
    await writeFile(
      filePath,
      `${Array.from({ length: 1100 }, () => 'a'.repeat(300)).join('\n')}\n`,
    );

    const result = await executeRead({
      args: { filePath, limit: 16384 },
      directory,
    });

    expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(MAX_OUTPUT_CHARS - result.output.length).toBeLessThan(306);
    expect(result.metadata.truncated_by_bytes).toBe(true);
    const numbered = result.output.match(/^\d+: a+$/gm) ?? [];
    expect(numbered.length).toBeGreaterThan(800);
    expect(
      numbered.every(
        (line, index) => line === `${index + 1}: ${'a'.repeat(300)}`,
      ),
    ).toBe(true);
  });
  test('preserves attachment bytes when a handle returns short reads', async () => {
    const expected = Buffer.from('short attachment payload');
    let reads = 0;
    const handle = {
      read: async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        reads += 1;
        const available = expected.length - position;
        const bytesRead = Math.max(0, Math.min(3, length, available));
        if (bytesRead > 0) {
          expected.copy(buffer, offset, position, position + bytesRead);
        }
        return { buffer, bytesRead };
      },
    } as any;

    const actual = await readBoundedBytes(handle, expected.length);

    expect(actual).toEqual(expected);
    expect(reads).toBeGreaterThan(1);
  });

  test('keeps missing paths beneath external symlinked directories canonical', async () => {
    const directory = await createWorkspace();
    const outside = await createWorkspace();
    const linkedDir = path.join(directory, 'linked');
    const missingPath = path.join(linkedDir, 'secrett.txt');
    await writeFile(path.join(outside, 'secret.txt'), 'secret\n', 'utf8');
    await symlink(outside, linkedDir);

    const inspection = await inspectReadTarget({
      args: {
        filePath: missingPath,
      },
      directory,
    });

    expect(inspection.exists).toBe(false);
    expect(inspection.resolvedPath).toBe(missingPath);
    expect(inspection.accessPath).toBe(path.join(outside, 'secrett.txt'));
    expect(inspection.realPath).toBe(path.join(outside, 'secrett.txt'));
    expect(inspection).not.toHaveProperty('similarPaths');

    await expect(
      executeRead({ args: { filePath: missingPath }, directory, inspection }),
    ).rejects.toThrow(path.join(outside, 'secret.txt'));
  });

  test('does not read a regular file ancestor for child paths', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'note.txt');
    const requestedPath = path.join(filePath, 'child.txt');
    await writeFile(filePath, 'parent content\n', 'utf8');

    const inspection = await inspectReadTarget({
      args: { filePath: requestedPath },
      directory,
    });

    expect(inspection.exists).toBe(false);
    expect(inspection.accessPath).toBe(requestedPath);
    expect(inspection.realPath).toBeUndefined();

    await expect(
      executeRead({ args: { filePath: requestedPath }, directory, inspection }),
    ).rejects.toThrow('File not found:');
  });

  test('does not read a symlinked file ancestor for child paths', async () => {
    const directory = await createWorkspace();
    const outside = await createWorkspace();
    const outsideFile = path.join(outside, 'note.txt');
    const linkedFile = path.join(directory, 'linked-note.txt');
    const requestedPath = path.join(linkedFile, 'child.txt');
    const canonicalMissingPath = path.join(outsideFile, 'child.txt');
    await writeFile(outsideFile, 'external parent content\n', 'utf8');
    await symlink(outsideFile, linkedFile);

    const inspection = await inspectReadTarget({
      args: { filePath: requestedPath },
      directory,
    });

    expect(inspection.exists).toBe(false);
    expect(inspection.accessPath).toBe(canonicalMissingPath);
    expect(inspection.realPath).toBe(canonicalMissingPath);

    await expect(
      executeRead({ args: { filePath: requestedPath }, directory, inspection }),
    ).rejects.toThrow('File not found:');
  });

  test('reads through the inspected access path after a symlink is retargeted', async () => {
    const directory = await createWorkspace();
    const firstTargetDir = await createWorkspace();
    const secondTargetDir = await createWorkspace();
    const firstTarget = path.join(firstTargetDir, 'secret.txt');
    const secondTarget = path.join(secondTargetDir, 'secret.txt');
    const linked = path.join(directory, 'linked.txt');

    await writeFile(firstTarget, 'alpha\n', 'utf8');
    await writeFile(secondTarget, 'beta\n', 'utf8');
    await symlink(firstTarget, linked);

    const inspection = await inspectReadTarget({
      args: { filePath: linked },
      directory,
    });

    await rm(linked, { force: true });
    await symlink(secondTarget, linked);

    const result = await executeRead({
      args: { filePath: linked },
      directory,
      inspection,
    });

    expect(result.output).toContain('<path>');
    expect(result.output).toContain(linked);
    expect(result.output).toContain('1: alpha');
    expect(result.output).not.toContain('1: beta');
    expect(result.metadata.real_path).toBe(firstTarget);
  });

  test('rejects special files before attempting to open them', async () => {
    if (process.platform !== 'linux') return;

    const directory = await createWorkspace();
    const fifoPath = path.join(directory, 'queue.fifo');
    execFileSync('mkfifo', [fifoPath]);

    const inspection = await inspectReadTarget({
      args: { filePath: fifoPath },
      directory,
    });

    expect(inspection.exists).toBe(true);
    expect(inspection.kind).toBe('special');

    await expect(
      executeRead({ args: { filePath: fifoPath }, directory, inspection }),
    ).rejects.toThrow(`Cannot read special file: ${fifoPath}`);
  });

  test('formats directory listings', async () => {
    const directory = await createWorkspace();
    await mkdir(path.join(directory, 'subdir'));
    await writeFile(path.join(directory, 'a.txt'), 'hello', 'utf8');

    const result = await executeRead({
      args: { filePath: directory, offset: 1, limit: 10 },
      directory,
    });

    expect(result.output).toContain('<type>directory</type>');
    expect(result.output).toContain('a.txt');
    expect(result.output).toContain('subdir/');
    expect(result.metadata.kind).toBe('directory');
  });

  test('returns an explicit message for out-of-range directory offsets', async () => {
    const directory = await createWorkspace();
    await writeFile(path.join(directory, 'a.txt'), 'hello', 'utf8');

    const result = await executeRead({
      args: { filePath: directory, offset: 10, limit: 10 },
      directory,
    });

    expect(result.output).toContain(
      'Offset 10 is out of range for this directory (1 entries)',
    );
  });

  test('escapes unsafe paths in missing-file errors and suggestions', async () => {
    const directory = await createWorkspace();
    await writeFile(
      path.join(directory, 'bad\n<suggestion>&.txt'),
      'hello',
      'utf8',
    );

    const message = await executeRead({
      args: { filePath: path.join(directory, 'bad\n<missing>&.txt') },
      directory,
    }).then(
      () => '',
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );

    expect(message).toContain('File not found:');
    expect(message).toContain('bad\\n&lt;missing&gt;&amp;.txt');
    expect(message).toContain('bad\\n&lt;suggestion&gt;&amp;.txt');
    expect(message).not.toContain('bad\n<missing>&.txt');
    expect(message).not.toContain('bad\n<suggestion>&.txt');
    expect(message.split('\n')).toHaveLength(3);
  });

  test('recomputes preview and truncated metadata from the direct text output', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'window.txt');
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8');

    const result = await executeRead({
      args: { filePath, offset: 2, limit: 1 },
      directory,
    });

    expect(result.metadata.preview).toBe('2: two');
    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.loaded).toEqual([]);
  });

  test('reports line-length truncation honestly in output and metadata', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'long-line.txt');
    await writeFile(filePath, `${'x'.repeat(5000)}\n`, 'utf8');

    const result = await executeRead({
      args: { filePath, offset: 1, limit: 10 },
      directory,
    });

    expect(result.output).toContain('…');
    expect(result.output).toContain('truncated to 4096 characters');
    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.truncated_by_line_length).toBe(true);
    expect(result.metadata.has_more).toBe(false);
  });

  test('throws when a file offset is beyond the available range', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'short.txt');
    await writeFile(filePath, 'one\ntwo\n', 'utf8');

    await expect(
      executeRead({
        args: { filePath, offset: 3, limit: 10 },
        directory,
      }),
    ).rejects.toThrow('Offset 3 is out of range for this file (2 lines)');
  });

  test('sets notebook mode metadata for parsed notebooks', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'notebook.ipynb');
    await writeFile(
      filePath,
      JSON.stringify({ cells: [{ cell_type: 'code', source: ['alpha'] }] }),
      'utf8',
    );

    const result = await executeRead({
      args: { filePath, offset: 1, limit: 10 },
      directory,
    });

    expect(result.output).toContain('<type>notebook</type>');
    expect(result.metadata.notebookMode).toBe('parsed');
  });

  test('treats uppercase .IPYNB files as notebooks too', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'NOTEBOOK.IPYNB');
    await writeFile(
      filePath,
      JSON.stringify({ cells: [{ cell_type: 'code', source: ['alpha'] }] }),
      'utf8',
    );

    const result = await executeRead({
      args: { filePath, offset: 1, limit: 10 },
      directory,
    });

    expect(result.output).toContain('<type>notebook</type>');
    expect(result.metadata.notebookMode).toBe('parsed');
  });

  test('keeps enhanced text output under the final byte budget', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'budget.txt');
    const line = 'x'.repeat(120);
    await writeFile(
      filePath,
      `${Array.from({ length: 4096 }, () => line).join('\n')}\n`,
      'utf8',
    );

    const result = await executeRead({
      args: { filePath, offset: 1, limit: 4096 },
      directory,
    });

    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    );
    expect(result.output).toContain('(Output capped by byte budget.)');
    expect(result.metadata.truncated).toBe(true);
  });

  test('syncs metadata end_line with the final emitted text window', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'budget-end-line.txt');
    const line = 'x'.repeat(120);
    await writeFile(
      filePath,
      `${Array.from({ length: 4096 }, () => line).join('\n')}\n`,
      'utf8',
    );

    const result = await executeRead({
      args: { filePath, offset: 1, limit: 4096 },
      directory,
    });

    const matches = Array.from(result.output.matchAll(/^(\d+): /gm));
    const lastMatch = matches[matches.length - 1];

    if (!lastMatch) {
      throw new Error('Expected at least one emitted line');
    }

    expect(result.metadata.end_line).toBe(Number(lastMatch[1]));
  });

  test('syncs metadata has_more and truncated_by_bytes with the final emitted text window', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'budget-metadata.txt');
    await writeFile(
      filePath,
      `${Array.from({ length: 32768 }, () => 'x').join('\n')}\n`,
      'utf8',
    );

    const result = await executeRead({
      args: { filePath, offset: 1, limit: 32768 },
      directory,
    });

    expect(result.output).toContain('(Output capped by byte budget.)');
    expect(result.output).toContain('Use offset=');
    expect(result.metadata.has_more).toBe(true);
    expect(result.metadata.truncated_by_bytes).toBe(true);
    expect(result.metadata.truncated).toBe(true);
  });

  test('returns structured image metadata and attachment', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'tiny.png');
    await writeFile(filePath, tinyPng);

    const result = await executeRead({
      args: { filePath },
      directory,
    });

    expect(result.output).toContain('<type>image</type>');
    expect(result.output).toContain('<dimensions>2x3</dimensions>');
    expect(result.metadata.attachment_support).toBe('embedded');
    expect(result.attachments).toEqual([
      {
        type: 'file',
        mime: 'image/png',
        url: `data:image/png;base64,${tinyPng.toString('base64')}`,
        filename: 'tiny.png',
      },
    ]);
  });

  test('names symlinked image attachments after the requested file', async () => {
    const directory = await createWorkspace();
    const canonical = path.join(directory, 'photo.png');
    const requested = path.join(directory, 'link.png');
    await writeFile(canonical, tinyPng);
    await symlink(canonical, requested);

    const result = await executeRead({
      args: { filePath: requested },
      directory,
    });
    expect(result.output).toContain(`<path>${requested}</path>`);
    expect(result.metadata.real_path).toBe(canonical);
    expect(result.attachments).toEqual([
      {
        type: 'file',
        mime: 'image/png',
        url: `data:image/png;base64,${tinyPng.toString('base64')}`,
        filename: 'link.png',
      },
    ]);
  });

  test('escapes unsafe image summaries and previews', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'tiny\n<unsafe>&.png');
    await writeFile(filePath, tinyPng);

    const result = await executeRead({
      args: { filePath },
      directory,
    });

    expect(result.output).toContain(
      'Image metadata extracted: tiny\\n&lt;unsafe&gt;&amp;.png',
    );
    expect(result.output).not.toContain('tiny\n<unsafe>&.png');
    expect(result.metadata.preview).toContain('tiny\\n&lt;unsafe&gt;&amp;.png');
    expect(result.metadata.preview).not.toContain('tiny\n<unsafe>&.png');
    expect((result.metadata.preview as string).split('\n')).toHaveLength(1);
  });

  test('returns PDF metadata and attachment', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'sample.pdf');
    await writeFile(filePath, '%PDF-1.4\n', 'utf8');

    const result = await executeRead({
      args: { filePath },
      directory,
    });

    expect(result.output).toContain('<type>pdf</type>');
    expect(result.output).toContain(ATTACHMENT_DATA_URL_NOTE);
    expect(result.metadata.attachment_support).toBe('embedded');
    expect(result.attachments).toEqual([
      {
        type: 'file',
        mime: 'application/pdf',
        url: `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n').toString('base64')}`,
        filename: 'sample.pdf',
      },
    ]);
  });

  test('returns a binary placeholder for unsupported binary files', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'sample.avif');
    await writeFile(
      filePath,
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
    );

    const result = await executeRead({
      args: { filePath },
      directory,
    });

    expect(result.output).toContain('Binary file detected');
    expect(result.metadata.kind).toBe('binary');
  });

  test('escapes unsafe binary placeholders and previews', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'sample\n<binary>&.dat');
    await writeFile(filePath, Buffer.from([0x61, 0x00, 0x62]));

    const result = await executeRead({
      args: { filePath },
      directory,
    });

    expect(result.output).toContain('sample\\n&lt;binary&gt;&amp;.dat');
    expect(result.output).not.toContain('sample\n<binary>&.dat');
    expect(result.output.split('\n')).toHaveLength(1);
    expect(result.metadata.preview).toBe(result.output);
  });

  test('detects binary data even when the file extension looks textual', async () => {
    const directory = await createWorkspace();
    const filePath = path.join(directory, 'sample.txt');
    await writeFile(filePath, Buffer.from([0x61, 0x62, 0x00, 0x63, 0x64]));

    const result = await executeRead({
      args: { filePath },
      directory,
    });

    expect(result.output).toContain('Binary file detected');
    expect(result.metadata.kind).toBe('binary');
  });
});
