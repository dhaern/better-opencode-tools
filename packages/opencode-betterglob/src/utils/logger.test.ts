/// <reference types="bun-types" />

import { expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initLogger, logAsync } from './logger';

test('initializes, cleans old logs and writes without synchronous I/O', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'betterglob-logger-'));
  const previous = process.env.OPENCODE_LOG_DIR;
  process.env.OPENCODE_LOG_DIR = dir;
  const old = path.join(dir, 'opencode-betterglob.old.log');
  await writeFile(old, 'old');
  await utimes(old, new Date(0), new Date(0));
  const syncCalls = [
    spyOn(fs, 'mkdirSync'),
    spyOn(fs, 'readdirSync'),
    spyOn(fs, 'statSync'),
    spyOn(fs, 'unlinkSync'),
    spyOn(fs, 'appendFileSync'),
  ];
  try {
    initLogger('async-test');
    await logAsync('installation failed', { error: 'test failure' });
    const file = path.join(dir, 'opencode-betterglob.async-test.log');
    const contents = await readFile(file, 'utf8');
    expect(contents).toContain('installation failed {"error":"test failure"}');
    await expect(readFile(old)).rejects.toThrow();
    await logAsync('cancelled entry', undefined, AbortSignal.abort());
    expect(await readFile(file, 'utf8')).toBe(contents);
    for (const call of syncCalls) expect(call).not.toHaveBeenCalled();
  } finally {
    for (const call of syncCalls) call.mockRestore();
    if (previous === undefined) delete process.env.OPENCODE_LOG_DIR;
    else process.env.OPENCODE_LOG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
