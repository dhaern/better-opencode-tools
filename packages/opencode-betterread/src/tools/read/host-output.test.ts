/// <reference types="bun-types" />
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import plugin from '../../index';
import { executeRead } from './engine';

const roots: string[] = [];
const root = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'br-host-output-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const DEFAULT_LINES = 2000;
const DEFAULT_BYTES = 51_200;
const hostWouldTruncate = (
  output: string,
  lines = DEFAULT_LINES,
  bytes = DEFAULT_BYTES,
) => output.split('\n').length > lines || Buffer.byteLength(output) > bytes;

async function server(directory: string, config?: unknown) {
  const hooks = await plugin.server({
    directory,
    worktree: directory,
    client: {},
  } as any);
  if (config !== undefined) await hooks.config?.(config as any);
  const ask = mock(async () => undefined);
  return {
    hooks,
    read: async (filePath: string) =>
      hooks.tool?.read.execute({ filePath }, {
        directory,
        worktree: directory,
        ask,
        abort: new AbortController().signal,
      } as any) as Promise<{
        output: string;
        metadata: Record<string, unknown>;
      }>,
  };
}

describe('host-aware output budgets', () => {
  test('defaults keep 900×60 text under host byte cap with pagination', async () => {
    const directory = root();
    const file = path.join(directory, 'rows.txt');
    writeFileSync(
      file,
      Array.from({ length: 900 }, () => 'x'.repeat(60)).join('\n'),
    );
    const { read, hooks } = await server(directory);
    const result = await read(file);
    expect(hostWouldTruncate(result.output)).toBe(false);
    expect(result.output).toContain('Use offset=');
    expect(result.metadata.has_more).toBe(true);
    expect(result.metadata.truncated_by_bytes).toBe(true);
    const after = hooks['tool.execute.after'];
    const delivered = { ...result, title: '' };
    await after?.({ tool: 'read', args: { filePath: file } } as any, delivered);
    expect(delivered.metadata.truncated).toBe(true);
  });

  test('defaults keep 2500×10 text and 3000 entries below host line cap', async () => {
    const directory = root();
    const file = path.join(directory, 'short.txt');
    writeFileSync(
      file,
      Array.from({ length: 2500 }, () => 'x'.repeat(10)).join('\n'),
    );
    const listing = path.join(directory, 'listing');
    mkdirSync(listing);
    for (let i = 0; i < 3000; i++)
      writeFileSync(
        path.join(listing, `entry-${String(i).padStart(4, '0')}`),
        '',
      );
    const { read } = await server(directory);
    for (const target of [file, listing]) {
      const result = await read(target);
      expect(hostWouldTruncate(result.output)).toBe(false);
      expect(result.output).toContain('Use offset=');
      expect(result.metadata.has_more).toBe(true);
      expect(result.metadata.truncated_by_bytes).toBe(true);
    }
  });

  test('defaults paginate parsed notebooks before the host line limit', async () => {
    const directory = root();
    const file = path.join(directory, 'cells.ipynb');
    writeFileSync(
      file,
      JSON.stringify({
        cells: [
          {
            cell_type: 'code',
            source: Array.from({ length: 2500 }, () => 'a\n'),
          },
        ],
      }),
    );
    const result = await (await server(directory)).read(file);
    expect(result.metadata.notebookMode).toBe('parsed');
    expect(hostWouldTruncate(result.output)).toBe(false);
    expect(result.output).toContain('Use offset=');
  });

  test('an ample tool_output config keeps the old direct-execute output intact', async () => {
    const directory = root();
    const file = path.join(directory, 'ample.txt');
    writeFileSync(
      file,
      Array.from({ length: 900 }, () => 'x'.repeat(60)).join('\n'),
    );
    const legacy = await executeRead({ args: { filePath: file }, directory });
    const { read } = await server(directory, {
      tool_output: { max_lines: 4000, max_bytes: 1_000_000 },
    });
    const result = await read(file);
    expect(result.output).toBe(legacy.output);
    expect(result.metadata).toEqual(legacy.metadata);
    const utf8 = path.join(directory, 'ample-utf8.txt');
    writeFileSync(
      utf8,
      Array.from({ length: 1200 }, () => '€'.repeat(150)).join('\n'),
    );
    const legacyUtf8 = await executeRead({
      args: { filePath: utf8 },
      directory,
    });
    const configuredUtf8 = await read(utf8);
    expect(configuredUtf8.output === legacyUtf8.output).toBe(true);
    expect(configuredUtf8.metadata).toEqual(legacyUtf8.metadata);
  });

  test('missing and invalid config use defaults, without sharing budgets between instances', async () => {
    const directory = root();
    const file = path.join(directory, 'defaults.txt');
    writeFileSync(
      file,
      Array.from({ length: 900 }, () => 'x'.repeat(60)).join('\n'),
    );
    const invalid = await server(directory, {
      tool_output: { max_lines: -1, max_bytes: 'not-a-number' },
    });
    const ample = await server(directory, {
      tool_output: { max_lines: 4000, max_bytes: 1_000_000 },
    });
    const absent = await server(directory);
    const [a, b, c] = await Promise.all([
      invalid.read(file),
      ample.read(file),
      absent.read(file),
    ]);
    expect(a.output).toBe(c.output);
    expect(hostWouldTruncate(a.output)).toBe(false);
    expect(b.output.length).toBeGreaterThan(a.output.length);
  });

  test('includes framing, footer and cap note in exact host line/byte limits', async () => {
    const directory = root();
    const file = path.join(directory, 'edges.txt');
    writeFileSync(
      file,
      Array.from({ length: 10 }, () => 'x'.repeat(300)).join('\n'),
    );
    const legacy = await executeRead({ args: { filePath: file }, directory });
    const bytes = Buffer.byteLength(legacy.output);
    const exact = (
      await server(directory, {
        tool_output: { max_lines: 100, max_bytes: bytes },
      })
    ).read(file);
    expect((await exact).output).toBe(legacy.output);
    const tight = await (
      await server(directory, {
        tool_output: { max_lines: 8, max_bytes: bytes - 1 },
      })
    ).read(file);
    expect(hostWouldTruncate(tight.output, 8, bytes - 1)).toBe(false);
    expect(tight.output).toContain('Use offset=');
    expect(tight.metadata.truncated_by_bytes).toBe(true);
  });
});
