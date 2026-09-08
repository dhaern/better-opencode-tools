/// <reference types="bun-types" />

import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  commandSucceeds,
  extractZip,
  getZipExtractionSupportErrorAsync,
} from './zip-extractor';

test('rejects pre-aborted probes and extraction before spawning', async () => {
  const signal = AbortSignal.abort();
  await expect(commandSucceeds('unused', [], signal)).rejects.toThrow(
    /aborted/i,
  );
  await expect(getZipExtractionSupportErrorAsync(signal)).rejects.toThrow(
    /aborted/i,
  );
  await expect(extractZip('unused.zip', 'unused', signal)).rejects.toThrow(
    /aborted/i,
  );
});

(process.platform === 'win32' ? test.skip : test)(
  'probes unzip asynchronously using its supported version option',
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'betterglob-unzip-'));
    const previous = process.env.PATH;
    await writeFile(path.join(dir, 'unzip'), '#!/bin/sh\n[ "$1" = "-v" ]\n', {
      mode: 0o755,
    });
    process.env.PATH = previous ? `${dir}${path.delimiter}${previous}` : dir;
    try {
      expect(await getZipExtractionSupportErrorAsync()).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('cancels an in-flight command probe while observing both output pipes', async () => {
  const controller = new AbortController();
  const pending = commandSucceeds(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    controller.signal,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await expect(pending).rejects.toThrow(/aborted/i);
});
