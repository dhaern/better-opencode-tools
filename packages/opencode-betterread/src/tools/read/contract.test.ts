/// <reference types="bun-types" />
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as publicModule from '../../index';
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_CHARS } from './constants';
import { formatDirectoryResult, readDirectory } from './directory-reader';
import { executeRead } from './engine';
import { buildDirectoryMetadata, renderTextResult } from './formatter';
import { createOutputBudget } from './limits';
import { createExecutionContext } from './test-helpers';
import { createReadTool } from './tool';

const root = mkdtempSync(path.join(tmpdir(), 'betterread-contract-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repo = path.join(root, 'repo');
mkdirSync(repo);

function fixture(name: string, content: string | Buffer): string {
  const filePath = path.join(repo, name);
  writeFileSync(filePath, content);
  return filePath;
}

function canonical(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(root, '<root>');
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function contract(output: string, metadata: Record<string, unknown>) {
  return {
    outputSha256: createHash('sha256')
      .update(output.replaceAll(root, '<root>'))
      .digest('hex'),
    metadataJson: JSON.stringify(canonical(metadata)),
  };
}

const charCap = fixture(
  'chars.txt',
  `${Array.from({ length: 1100 }, () => 'a'.repeat(300)).join('\n')}\n`,
);
const byteCap = fixture(
  'bytes.txt',
  `${Array.from({ length: 1500 }, () => '€'.repeat(200)).join('\n')}\n`,
);
const boundary = fixture('boundary.txt', `${'x\n'.repeat(10001)}last`);
const eof = fixture('eof.txt', 'one\ntwo\n');
const empty = fixture('empty.txt', '');
const notebook = fixture(
  'large.ipynb',
  JSON.stringify({
    cells: Array.from({ length: 1200 }, () => ({
      cell_type: 'code',
      source: ['€'.repeat(180)],
    })),
  }),
);
const image = Buffer.alloc(40);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image);
image.writeUInt32BE(7, 16);
image.writeUInt32BE(11, 20);
const png = fixture('picture.png', image);
const pdf = fixture('document.pdf', '%PDF-1.4\n%%EOF\n');
const binary = fixture('opaque.dat', Buffer.from([0x00, 0x01, 0x02, 0x03]));

test.each([
  ['characters cap', charCap, 1, 16384],
  ['UTF-8 byte cap', byteCap, 1, 16384],
  ['number width 9999 to 10000', boundary, 9998, 5],
  ['end of file', eof, 2, 1],
  ['empty file', empty, 1, 10],
  ['notebook budget', notebook, 1, 16384],
  ['PNG attachment', png, 1, 10],
  ['PDF attachment', pdf, 1, 10],
  ['binary sample', binary, 1, 10],
] as const)('%s contract', async (_name, filePath, offset, limit) => {
  const result = await executeRead({
    args: { filePath, offset, limit },
    directory: repo,
  });
  expect(contract(result.output, result.metadata)).toMatchSnapshot();
});

test('out-of-range offset error is stable', async () => {
  const error = await executeRead({
    args: { filePath: eof, offset: 4 },
    directory: repo,
  }).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(canonical((error as Error).message)).toMatchSnapshot();
});

test('line separator counts against the exact character cap', () => {
  const selected: string[] = [];
  const budget = createOutputBudget();
  expect(budget.tryAdd('a'.repeat(MAX_OUTPUT_CHARS - 1))).toBe(true);
  selected.push('a'.repeat(MAX_OUTPUT_CHARS - 1));
  const second = budget.tryAdd('b');
  expect({
    outputSha256: createHash('sha256')
      .update(selected.join('\n'))
      .digest('hex'),
    metadataJson: JSON.stringify({ second }),
  }).toMatchSnapshot();
  expect(createOutputBudget().tryAdd('é'.repeat(MAX_OUTPUT_CHARS))).toBe(true);
});

test('UTF-8 multibyte output obeys the byte budget independently of characters', () => {
  const result = {
    kind: 'text' as const,
    path: '/tmp/multibyte.txt',
    content: Array.from({ length: 50 }, () => '€'.repeat(4096)).join('\n'),
    startLine: 1,
    endLine: 50,
    totalLines: 50,
    truncatedByBytes: false,
    truncatedByLineLength: false,
    hasMore: false,
  };
  const rendered = renderTextResult(result);
  expect(Buffer.byteLength(rendered.output, 'utf8')).toBeLessThanOrEqual(
    MAX_OUTPUT_BYTES,
  );
  expect(
    contract(rendered.output, {
      endLine: rendered.endLine,
      truncated: rendered.truncated,
      hasMore: rendered.hasMore,
      truncatedByBytes: rendered.truncatedByBytes,
    }),
  ).toMatchSnapshot();
});

test('a fully rendered text output fits when it equals the character cap', () => {
  const result = {
    kind: 'text' as const,
    path: '/tmp/exact-fit.txt',
    content: '',
    startLine: 1,
    endLine: 1,
    totalLines: 1,
    truncatedByBytes: false,
    truncatedByLineLength: false,
    hasMore: false,
  };
  const overhead = renderTextResult(result).output.length;
  const rendered = renderTextResult({
    ...result,
    content: 'a'.repeat(MAX_OUTPUT_CHARS - overhead),
  });
  expect(rendered.output.length).toBe(MAX_OUTPUT_CHARS);
  expect(rendered.truncatedByBytes).toBe(false);
});

test('the exact continuation footer is included when selecting a line at 9 to 10', () => {
  const first = Array.from(
    { length: 8 },
    (_, index) => `${index + 1}: ${'x'.repeat(10)}`,
  );
  const frame = `<path>/tmp/footer.txt</path>\n<type>file</type>\n<content>\n${first.join('\n')}\n9: \n</content>\n(Showing lines 1-9. Use offset=10 to continue.)\n(Output capped by byte budget.)`;
  const ninth = 'a'.repeat(MAX_OUTPUT_CHARS - frame.length);
  const rendered = renderTextResult({
    kind: 'text',
    path: '/tmp/footer.txt',
    content: `${first.map((line) => line.slice(3)).join('\n')}\n${ninth}\n${'b'.repeat(100)}`,
    startLine: 1,
    endLine: 10,
    totalLines: 10,
    truncatedByBytes: false,
    truncatedByLineLength: false,
    hasMore: false,
  });
  expect(rendered.endLine).toBe(9);
  expect(rendered.output.length).toBe(MAX_OUTPUT_CHARS);
});

test('directory escaped names are budgeted before rendering', async () => {
  const directory = '/tmp/betterread-escaped-contract';
  const entries = Array.from({ length: 3000 }, (_, index) => ({
    name: `entry${index.toString().padStart(5, '0')}${'&< >\n'.repeat(15)}`,
    dirent: {
      isDirectory: () => false,
      isSymbolicLink: () => false,
    } as any,
  }));
  const result = await readDirectory(directory, 1, 4096, {
    scanDirectoryEntries: async () => ({
      entries,
      totalEntries: entries.length,
      totalEntriesKnown: true,
    }),
  });
  const output = formatDirectoryResult(result);
  expect(output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  expect(
    contract(output, buildDirectoryMetadata({ filePath: directory }, result)),
  ).toMatchSnapshot();
});

test('directory trim budgets the truncation note, not the full-page footer', async () => {
  const directory = '/tmp/betterread-note-contract';
  const entries = Array.from({ length: 20000 }, (_, index) => ({
    name: `n${index.toString().padStart(5, '0')}${'e'.repeat(14)}`,
    dirent: {
      isDirectory: () => false,
      isSymbolicLink: () => false,
    } as any,
  }));
  const result = await readDirectory(directory, 1, 30000, {
    scanDirectoryEntries: async () => ({
      entries,
      totalEntries: entries.length,
      totalEntriesKnown: true,
    }),
  });
  const output = formatDirectoryResult(result);
  expect(output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  expect(result.truncatedByBytes).toBe(true);
  expect(
    contract(output, {
      selected: result.entries.length,
      truncatedByBytes: result.truncatedByBytes,
    }),
  ).toMatchSnapshot();
});

test('directory escaping, ASCII, multibyte and bounded scan contracts', async () => {
  const directory = path.join(repo, 'listing');
  mkdirSync(directory);
  for (const name of ['alpha', 'a&< >\nb', 'éclair', 'zeta']) {
    fixture(path.join('listing', name), 'x');
  }
  const actual = await executeRead({
    args: { filePath: directory },
    directory: repo,
  });
  expect(contract(actual.output, actual.metadata)).toMatchSnapshot();

  const bounded = await readDirectory(directory, 1, 10, {
    scanDirectoryEntries: async () => ({
      entries: [],
      totalEntries: 65_536,
      totalEntriesKnown: false,
    }),
  });
  const output = formatDirectoryResult(bounded);
  const metadata = buildDirectoryMetadata({ filePath: directory }, bounded);
  expect(contract(output, metadata)).toMatchSnapshot();
});

test('public exports and server shape stay stable', async () => {
  expect(Object.keys(publicModule).sort()).toMatchSnapshot();
  expect({
    id: publicModule.default.id,
    keys: Object.keys(publicModule.default),
  }).toMatchSnapshot();
  const server = await publicModule.default.server({
    directory: repo,
    worktree: repo,
    client: {},
  } as any);
  expect({
    keys: Object.keys(server),
    tools: Object.keys(server.tool ?? {}),
  }).toMatchSnapshot();
});

test('read and external_directory ask payloads stay exact', async () => {
  const outside = path.join(root, 'outside');
  mkdirSync(outside);
  fixture('prompt.txt', 'prompt');
  const outsideFile = path.join(outside, 'external.txt');
  writeFileSync(outsideFile, 'external');
  const read = createReadTool({
    directory: repo,
    worktree: repo,
    client: {},
  } as any);
  const insideCtx = createExecutionContext(repo);
  await read.execute(
    { filePath: path.join(repo, 'prompt.txt') },
    insideCtx as any,
  );
  const outsideCtx = createExecutionContext(repo);
  await read.execute({ filePath: outsideFile }, outsideCtx as any);
  expect(
    JSON.stringify(
      canonical(insideCtx.ask.mock.calls.map(([payload]) => payload)),
    ),
  ).toMatchSnapshot();
  expect(
    JSON.stringify(
      canonical(outsideCtx.ask.mock.calls.map(([payload]) => payload)),
    ),
  ).toMatchSnapshot();
});
