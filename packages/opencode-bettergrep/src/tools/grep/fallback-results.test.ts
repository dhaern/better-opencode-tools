import { describe, expect, spyOn, test } from 'bun:test';
import { createSortedAdmission, sortFiles } from './fallback-results';
import { createFileMatch } from './result-utils';
import type { GrepFileMatch } from './types';

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledPaths(count: number, seed: number): string[] {
  const paths = Array.from(
    { length: count },
    (_, index) => `/repo/src/file-${String(index).padStart(5, '0')}.ts`,
  );
  const random = mulberry32(seed);
  for (let index = paths.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const upper = paths[index] as string;
    const lower = paths[swap] as string;
    paths[index] = lower;
    paths[swap] = upper;
  }
  return paths;
}

function fileFor(absolutePath: string): GrepFileMatch {
  return createFileMatch({
    file: absolutePath,
    absolutePath,
    replayPath: absolutePath,
    nonUtf8Path: false,
    pathKey: `utf8:${absolutePath}`,
  });
}

describe('tools/grep/fallback-results sorted admission', () => {
  test('sorts non-UTF8 path identities by decoded bytes, not base64 text', () => {
    const make = (byte: number) => {
      const absolutePath = `bytes:base64:${Buffer.from([47, 114, 101, 112, 111, 47, byte]).toString('base64')}`;
      return createFileMatch({
        file: absolutePath,
        absolutePath,
        pathKey: absolutePath,
      });
    };
    const low = make(0x80);
    const high = make(0xff);
    expect(
      sortFiles([high, low], { sortBy: 'path', sortOrder: 'asc' }),
    ).toEqual([low, high]);
  });

  test('top-500 of 20000 shuffled paths admits exact order with bounded compares', () => {
    const candidates = shuffledPaths(20_000, 0x5eed);
    const expected = [...candidates].sort().slice(0, 500);

    const files = new Map<string, GrepFileMatch>();
    const admission = createSortedAdmission(files, 500, 1);
    const compare = spyOn(Buffer, 'compare');
    try {
      for (const candidate of candidates) {
        admission.admit(fileFor(candidate));
      }
      expect(compare.mock.calls.length).toBeLessThan(250_000);
    } finally {
      compare.mockRestore();
    }

    expect(admission.dropped()).toBe(true);
    expect([...files.values()].map((file) => file.absolutePath).sort()).toEqual(
      expected,
    );
  });

  test('descending admission keeps the largest paths', () => {
    const candidates = shuffledPaths(2_000, 42);
    const expected = [...candidates].sort().slice(-100);

    const files = new Map<string, GrepFileMatch>();
    const admission = createSortedAdmission(files, 100, -1);
    for (const candidate of candidates) {
      admission.admit(fileFor(candidate));
    }

    expect(admission.dropped()).toBe(true);
    expect([...files.values()].map((file) => file.absolutePath).sort()).toEqual(
      expected,
    );
  });

  test('duplicate admission returns true without growing the set', () => {
    const files = new Map<string, GrepFileMatch>();
    const admission = createSortedAdmission(files, 2, 1);
    expect(admission.admit(fileFor('/repo/b.ts'))).toBe(true);
    expect(admission.admit(fileFor('/repo/a.ts'))).toBe(true);
    expect(admission.admit(fileFor('/repo/a.ts'))).toBe(true);
    expect(files.size).toBe(2);
    expect(admission.dropped()).toBe(false);
  });
});
