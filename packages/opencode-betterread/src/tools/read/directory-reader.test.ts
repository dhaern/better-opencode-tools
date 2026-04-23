/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readDirectory } from './directory-reader';

const BOUNDED_SCAN_ENTRY_COUNT = 65_536;
const tempDirs: string[] = [];
const fileDirent = {
  isDirectory: () => false,
} as any;
let boundedScanEntries:
  | {
      name: string;
      dirent: typeof fileDirent;
    }[]
  | undefined;

function getBoundedScanEntries() {
  boundedScanEntries ??= Array.from(
    { length: BOUNDED_SCAN_ENTRY_COUNT },
    (_, index) => ({
      name: `entry-${String(BOUNDED_SCAN_ENTRY_COUNT - index - 1).padStart(5, '0')}.txt`,
      dirent: fileDirent,
    }),
  );

  return boundedScanEntries;
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'betterread-dir-'));
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

describe('readDirectory', () => {
  test('keeps exact totals for small fully scanned directories', async () => {
    const directory = await createTempDirectory();
    await mkdir(path.join(directory, 'subdir'));
    await writeFile(path.join(directory, 'b.txt'), 'b', 'utf8');
    await writeFile(path.join(directory, 'a.txt'), 'a', 'utf8');

    const result = await readDirectory(directory, 2, 2);

    expect(result.entries).toEqual(['b.txt', 'subdir/']);
    expect(result.totalEntries).toBe(3);
    expect(result.totalEntriesKnown).toBe(true);
    expect(result.hasMore).toBe(false);
  });

  test('paginates globally sorted directories without duplicates across pages', async () => {
    const directory = await createTempDirectory();
    for (let index = 299; index >= 0; index -= 1) {
      await writeFile(
        path.join(directory, `entry-${String(index).padStart(3, '0')}.txt`),
        'x',
        'utf8',
      );
    }

    const firstPage = await readDirectory(directory, 1, 30);
    const secondPage = await readDirectory(directory, 31, 30);
    const expectedFirstPage = Array.from(
      { length: 30 },
      (_, index) => `entry-${String(index).padStart(3, '0')}.txt`,
    );
    const expectedSecondPage = Array.from(
      { length: 30 },
      (_, index) => `entry-${String(index + 30).padStart(3, '0')}.txt`,
    );

    expect(firstPage.entries).toEqual(expectedFirstPage);
    expect(secondPage.entries).toEqual(expectedSecondPage);
    expect(firstPage.entries[0]).toBe('entry-000.txt');
    expect(firstPage.totalEntries).toBe(300);
    expect(firstPage.totalEntriesKnown).toBe(true);
    expect(secondPage.totalEntries).toBe(300);
    expect(secondPage.totalEntriesKnown).toBe(true);
    expect(new Set([...firstPage.entries, ...secondPage.entries]).size).toBe(
      60,
    );
  });

  test('returns an honest first window for bounded scans that exceed the exact cap', async () => {
    const result = await readDirectory('/tmp/huge', 1, 5, {
      scanDirectoryEntries: async () => ({
        entries: getBoundedScanEntries(),
        totalEntries: BOUNDED_SCAN_ENTRY_COUNT,
        totalEntriesKnown: false,
      }),
    });

    expect(result.entries).toEqual([
      'entry-00000.txt',
      'entry-00001.txt',
      'entry-00002.txt',
      'entry-00003.txt',
      'entry-00004.txt',
    ]);
    expect(result.totalEntries).toBe(BOUNDED_SCAN_ENTRY_COUNT);
    expect(result.totalEntriesKnown).toBe(false);
    expect(result.hasMore).toBe(true);
  });

  test('fails explicitly for offset>1 when the directory scan is bounded', async () => {
    await expect(
      readDirectory('/tmp/huge', 2, 5, {
        scanDirectoryEntries: async () => ({
          entries: getBoundedScanEntries(),
          totalEntries: BOUNDED_SCAN_ENTRY_COUNT,
          totalEntriesKnown: false,
        }),
      }),
    ).rejects.toThrow(
      /Only offset=1 is supported when the scan is bounded; exact pagination beyond the first window is not supported\. Use a more specific path\./,
    );
  });

  test('does not add a trailing slash for symlinks to directories', async () => {
    const directory = await createTempDirectory();
    const outside = await createTempDirectory();
    const linkedDir = path.join(directory, 'linked-dir');

    await mkdir(path.join(outside, 'nested'));
    await symlink(outside, linkedDir);

    const result = await readDirectory(directory, 1, 10);

    expect(result.entries).toEqual(['linked-dir']);
  });
});
