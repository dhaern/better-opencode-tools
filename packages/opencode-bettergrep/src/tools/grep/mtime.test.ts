import { expect, jest, test } from 'bun:test';
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

test.each(['content', 'count'] as const)(
  'mtime %s replays 130 files in three invocations (T3)',
  async (outputMode) => {
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
      mtimeInput(root, { output_mode: outputMode }),
      new AbortController().signal,
      { path: wrapperPath, backend: 'rg', source: 'system-rg' },
    );

    expect(result.totalFiles).toBe(130);
    expect(result.totalMatches).toBe(130);
    const invocations = readFileSync(logPath, 'utf8').trim().split('\n');
    // Discovery (1) plus content replay in batches of 64: 64 + 64 + 2.
    const replayInvocations = invocations.slice(1);
    expect(replayInvocations.length).toBe(Math.ceil(130 / 64));
    expect(result.replayBatchCount).toBe(3);
    if (outputMode === 'content') {
      expect(replayInvocations.join('\n')).toContain('-j1');
    }
  },
);

test.each(['asc', 'desc'] as const)(
  'mtime ordering %s keeps replayed matches ordered',
  async (sortOrder) => {
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
  },
);

const NAMES = ['ñ', 'á', 'b', 'a', 'Z', 'café', 'cafe\u0301'];
const BYTE_ORDER = ['Z', 'a', 'b', 'cafe\u0301', 'café', 'á', 'ñ'];

test.each(['asc', 'desc'] as const)(
  'mtime %s breaks equal-timestamp ties by path bytes',
  async (sortOrder) => {
    for (const names of [NAMES, [...NAMES].reverse()]) {
      const files = names.map((name) =>
        createFileMatch({
          file: name,
          absolutePath: `/virtual/${name}`,
          replayPath: `/virtual/${name}`,
          pathKey: `utf8:/virtual/${name}`,
        }),
      );
      for (const statFile of [
        async () => ({ mtimeMs: 1000 }),
        async () => {
          throw new Error('stat failed');
        },
      ]) {
        const sorted = await sortFilesByMtime(
          files,
          { sortOrder },
          new AbortController().signal,
          Date.now() + 10_000,
          statFile,
        );
        expect(sorted.files.map((file) => file.file)).toEqual(BYTE_ORDER);
      }
    }
  },
);

test.each(['content', 'count'] as const)(
  'mtime %s completely recovered batch leaves no error metadata (T1)',
  async (outputMode) => {
    const root = seedRepo(10);
    const dir = temps.createDir('bettergrep-mtime-recovered');
    const wrapperPath = path.join(dir, 'rg-recovered.sh');
    writeFileSync(
      wrapperPath,
      [
        '#!/bin/sh',
        'case "$*" in',
        '*f0009.txt*f0008.txt*) echo "boom" 1>&2; exit 2;;',
        'esac',
        `exec ${JSON.stringify(systemRg)} "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const result = await executeMtimeMode(
      mtimeInput(root, { output_mode: outputMode }),
      new AbortController().signal,
      { path: wrapperPath, backend: 'rg', source: 'system-rg' },
    );
    expect(result.totalFiles).toBe(10);
    expect(result.totalMatches).toBe(10);
    expect(result.truncated).toBe(false);
    expect(result.partialPhase).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.retryCount).toBe(0);
    expect(result.replayBatchCount).toBe(11);
  },
);

test.each(['content', 'count'] as const)(
  'mtime %s permanently failing file reports only the failed retry (T2)',
  async (outputMode) => {
    const root = seedRepo(10);
    const dir = temps.createDir('bettergrep-mtime-unrecovered');
    const wrapperPath = path.join(dir, 'rg-unrecovered.sh');
    writeFileSync(
      wrapperPath,
      [
        '#!/bin/sh',
        'case "$*" in',
        '*f0009.txt*f0008.txt*|*f0003.txt*) echo "boom" 1>&2; exit 2;;',
        'esac',
        `exec ${JSON.stringify(systemRg)} "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const result = await executeMtimeMode(
      mtimeInput(root, { output_mode: outputMode }),
      new AbortController().signal,
      { path: wrapperPath, backend: 'rg', source: 'system-rg' },
    );
    expect(result.totalFiles).toBe(9);
    expect(result.warnings).toEqual(['Skipped mtime replay batch 8: boom']);
    expect(result.truncated).toBe(true);
    expect(result.partialPhase).toBe('replay');
    expect(result.replayBatchCount).toBe(11);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('boom');
  },
);

test.each(['content', 'count', 'files_with_matches'] as const)(
  'mtime %s mode orders files by mtime',
  async (outputMode) => {
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
  },
);

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
    replayPath: '/no/such/dir/gone.txt',
  });
  const sorted = await sortFilesByMtime(
    [missing],
    { sortOrder: 'asc' },
    new AbortController().signal,
    Date.now() + 10_000,
  );

  expect(sorted.files).toEqual([missing]);
  expect(sorted.timedOut).toBe(false);
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

test('a solely non-UTF8 match uses direct fallback before sorting or replay', async () => {
  const root = temps.createDir('bettergrep-mtime-only-nonutf8');
  const file = Buffer.concat([
    Buffer.from(`${root}/`),
    Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74]),
  ]);
  writeFileSync(file, 'needle\n');
  const result = await executeMtimeMode(
    mtimeInput(root),
    new AbortController().signal,
    systemCli,
  );
  expect(result.strategy).toBe('mtime-fallback');
  expect(result.totalMatches).toBe(1);
  expect(result.warnings.join(' ')).toContain('non-UTF8');
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

test('mtime stat pool dispatches past a stalled worker before deadline (T4)', async () => {
  jest.useFakeTimers();
  try {
    const files = Array.from({ length: 32 }, (_, index) =>
      createFileMatch({
        file: `f${index}`,
        absolutePath: `/virtual/f${index}`,
        replayPath: `/virtual/f${index}`,
        pathKey: `utf8:/virtual/f${index}`,
      }),
    );
    let calls = 0;
    const statFile = (filePath: string): Promise<{ mtimeMs: number }> => {
      calls += 1;
      if (filePath === '/virtual/f0') return new Promise(() => {});
      return Promise.resolve({
        mtimeMs: Number(filePath.slice('/virtual/f'.length)),
      });
    };
    const pending = sortFilesByMtime(
      files,
      { sortOrder: 'asc' },
      new AbortController().signal,
      Date.now() + 100,
      statFile,
    );
    for (let round = 0; round < 100; round += 1) await Promise.resolve();
    jest.advanceTimersByTime(100);
    const sorted = await pending;
    expect(calls).toBe(32);
    expect(sorted.timedOut).toBe(true);
    expect(sorted.files.map((file) => file.file)).toEqual(
      files.slice(1).map((file) => file.file),
    );
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test('mtime abort while stat is pending cancels without listeners or timers (T5)', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const add = jest.spyOn(controller.signal, 'addEventListener');
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  try {
    let calls = 0;
    const file = createFileMatch({
      file: 'pending',
      absolutePath: '/virtual/pending',
      replayPath: '/virtual/pending',
      pathKey: 'utf8:/virtual/pending',
    });
    const pending = sortFilesByMtime(
      [file],
      { sortOrder: 'asc' },
      controller.signal,
      Date.now() + 100,
      (): Promise<{ mtimeMs: number }> => {
        calls += 1;
        return new Promise(() => {});
      },
    );
    await Promise.resolve();
    expect(calls).toBe(1);
    controller.abort();
    const sorted = await pending;
    expect(sorted.cancelled).toBe(true);
    expect(sorted.timedOut).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    expect(add.mock.calls.filter(([name]) => name === 'abort').length).toBe(1);
    expect(remove.mock.calls.filter(([name]) => name === 'abort').length).toBe(
      1,
    );
  } finally {
    add.mockRestore();
    remove.mockRestore();
    jest.useRealTimers();
  }
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
