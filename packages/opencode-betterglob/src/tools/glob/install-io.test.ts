import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSha256Async,
  fileStamp,
  InvalidCachedBinaryError,
  readRegularFile,
} from './install-io';

test('reads and hashes the same bounded regular file, rejecting excess and non-files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'betterglob-io-'));
  const file = join(dir, 'fixture');
  writeFileSync(file, 'hello');
  try {
    expect((await readRegularFile(file, 5)).toString()).toBe('hello');
    expect(await computeSha256Async(file)).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(await fileStamp(file)).toMatch(/^[^:]+:[^:]+:5:/);
    await expect(readRegularFile(file, 4)).rejects.toThrow(
      'Cached file exceeds its size limit:',
    );
    await expect(computeSha256Async(file, undefined, 4)).rejects.toBeInstanceOf(
      InvalidCachedBinaryError,
    );
    if (process.platform !== 'win32')
      await expect(readRegularFile(dir, 1024)).rejects.toThrow(
        'Cached file is not a regular file:',
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
