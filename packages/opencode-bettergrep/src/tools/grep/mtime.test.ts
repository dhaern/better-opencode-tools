import { expect, test } from 'bun:test';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import which from 'which';
import { executeMtimeMode, sortFilesByMtime } from './mtime';
import { normalizeGrepInput } from './normalize';
import { createFileMatch } from './result-utils';
import { setAbortKind } from './runtime';
import { createRepoContext, createTempTracker } from './test-helpers';

const temps = createTempTracker();
const systemRg = which.sync('rg', { nothrow: false });
const systemCli = {
  path: systemRg,
  backend: 'rg',
  source: 'system-rg',
} as const;

function mtimeInput(root: string, overrides: Record<string, unknown> = {}) {
  return normalizeGrepInput(
    {
      pattern: 'needle',
      path: root,
      output_mode: 'content',
      sort_by: 'mtime',
      fixed_strings: true,
      ...overrides,
    },
    createRepoContext(root) as never,
  );
}

function seedRepo(fileCount: number): string {
  const root = temps.createDir('bettergrep-mtime');
  for (let index = 0; index < fileCount; index += 1) {
    const name = `f${String(index).padStart(4, '0')}.txt`;
    const file = path.join(root, name);
    writeFileSync(file, `needle ${index}\n`);
    // Distinct, second-spaced mtimes via utimesSync: no sleeps, and coarse
    // filesystem timestamp granularity cannot tie them.
    const stamp = new Date(Date.UTC(2021, 0, 2, 0, 0, index));
    utimesSync(file, stamp, stamp);
  }
  return root;
}

test('mtime content replay batches 130 files into at most 3 replay invocations with -j1', async () => {
  const root = seedRepo(130);
  const dir = temps.createDir('bettergrep-mtime-wrapper');
  const logPath = path.join(dir, 'invocations.log');
  const wrapperPath = path.join(dir, 'rg-wrapper.sh');
  writeFileSync(
    wrapperPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      `exec ${JSON.stringify(systemRg)} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const result = await executeMtimeMode(
    mtimeInput(root),
    new AbortController().signal,
    { path: wrapperPath, backend: 'rg', source: 'system-rg' },
  );

  expect(result.totalFiles).toBe(130);
  expect(result.totalMatches).toBe(130);
  const invocations = readFileSync(logPath, 'utf8').trim().split('\n');
  // Discovery (1) plus content replay in batches of 64: 64 + 64 + 2.
  const replayInvocations = invocations.slice(1);
  expect(replayInvocations.length).toBeLessThanOrEqual(3);
  expect(replayInvocations.join('\n')).toContain('-j1');
});

test.each([
  'asc',
  'desc',
] as const)('mtime ordering %s keeps replayed matches ordered', async (sortOrder) => {
  const root = seedRepo(8);
  const result = await executeMtimeMode(
    mtimeInput(root, { sort_order: sortOrder }),
    new AbortController().signal,
    systemCli,
  );

  expect(result.totalFiles).toBe(8);
  const names = result.files.map((file) => path.basename(file.absolutePath));
  const ordered = [...names].sort();
  expect(names).toEqual(sortOrder === 'asc' ? ordered : ordered.reverse());
});

test('mtime replay retries a failed batch file by file with global numbering', async () => {
  const root = seedRepo(10);
  const dir = temps.createDir('bettergrep-mtime-flaky');
  const countPath = path.join(dir, 'attempts.log');
  const wrapperPath = path.join(dir, 'rg-flaky.sh');
  writeFileSync(
    wrapperPath,
    [
      '#!/bin/sh',
      `printf 'x\\n' >> ${JSON.stringify(countPath)}`,
      // Fail only multi-file replay batches; discovery and single-file
      // retries succeed.
      'args="$*"',
      'case "$args" in',
      '*f0009.txt*f0008.txt*) echo "boom" 1>&2; exit 2;;',
      'esac',
      `exec ${JSON.stringify(systemRg)} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const result = await executeMtimeMode(
    mtimeInput(root),
    new AbortController().signal,
    { path: wrapperPath, backend: 'rg', source: 'system-rg' },
  );

  expect(result.totalFiles).toBe(10);
  expect(result.totalMatches).toBe(10);
  expect(
    result.warnings.some((warning) =>
      warning.startsWith('Skipped mtime replay batch '),
    ),
  ).toBe(true);
  expect(result.replayBatchCount).toBeGreaterThan(1);
});

test.each([
  'content',
  'count',
  'files_with_matches',
] as const)('mtime %s mode orders files by mtime', async (outputMode) => {
  const root = seedRepo(6);
  const result = await executeMtimeMode(
    mtimeInput(root, { output_mode: outputMode }),
    new AbortController().signal,
    systemCli,
  );

  expect(result.totalFiles).toBe(6);
  expect(result.files.map((file) => file.matchCount)).toEqual([
    1, 1, 1, 1, 1, 1,
  ]);
});

test('mtime replay stops at a mid-replay limit', async () => {
  // 70 files span two replay batches; the limit fires in the first batch and
  // the second batch must never run.
  const root = seedRepo(70);
  const dir = temps.createDir('bettergrep-mtime-limit');
  const logPath = path.join(dir, 'invocations.log');
  const wrapperPath = path.join(dir, 'rg-wrapper.sh');
  writeFileSync(
    wrapperPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      `exec ${JSON.stringify(systemRg)} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const result = await executeMtimeMode(
    mtimeInput(root, { max_results: 5 }),
    new AbortController().signal,
    { path: wrapperPath, backend: 'rg', source: 'system-rg' },
  );

  expect(result.limitReached).toBe(true);
  expect(result.totalMatches).toBeLessThanOrEqual(5);
  const invocations = readFileSync(logPath, 'utf8').trim().split('\n');
  // Discovery plus exactly one replay batch: the mid-replay limit breaks the
  // loop instead of running the second batch.
  expect(invocations.length).toBe(2);
});

test('mtime sort warns on deleted files and orders them last', async () => {
  const missing = createFileMatch({
    file: 'gone.txt',
    absolutePath: '/no/such/dir/gone.txt',
    pathKey: 'utf8:/no/such/dir/gone.txt',
  });
  const sorted = await sortFilesByMtime(
    [missing],
    { sortOrder: 'asc' },
    new AbortController().signal,
    Date.now() + 10_000,
  );

  expect(sorted.files).toEqual([missing]);
  expect(
    sorted.warnings.some((warning) => warning.includes('Could not stat')),
  ).toBe(true);
});

test('mtime replay skips non-replayable paths with a warning', async () => {
  const root = temps.createDir('bettergrep-mtime-nonutf8');
  writeFileSync(path.join(root, 'good.txt'), 'needle\n');
  const rawName = Buffer.from([
    0x77, 0xff, 0x69, 0x72, 0x64, 0x2e, 0x74, 0x78, 0x74,
  ]);
  writeFileSync(
    Buffer.concat([Buffer.from(`${root}/`), rawName]),
    Buffer.from('needle\n'),
  );

  const result = await executeMtimeMode(
    mtimeInput(root),
    new AbortController().signal,
    systemCli,
  );

  expect(result.warnings.some((warning) => warning.includes('non-UTF8'))).toBe(
    true,
  );
});

test('mtime sort with an expired deadline reports a timeout', async () => {
  const file = createFileMatch({
    file: 'a.txt',
    absolutePath: '/tmp/a.txt',
    pathKey: 'utf8:/tmp/a.txt',
  });
  const sorted = await sortFilesByMtime(
    [file],
    { sortOrder: 'asc' },
    new AbortController().signal,
    Date.now() - 1_000,
  );

  expect(sorted.timedOut).toBe(true);
});

test('mtime replay propagates an aborted timeout signal', async () => {
  const root = seedRepo(4);
  const controller = new AbortController();
  setAbortKind(controller.signal, 'timeout');
  controller.abort();
  const result = await executeMtimeMode(
    mtimeInput(root),
    controller.signal,
    systemCli,
  );

  expect(result.timedOut).toBe(true);
});
