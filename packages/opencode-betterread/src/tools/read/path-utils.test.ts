/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { listSimilarPaths, resolveAccessPath } from './path-utils';
import { createTempTracker } from './test-helpers';

describe('tools/read/path-utils', () => {
  const temps = createTempTracker();

  test('fails closed when realpath reports a non-missing error', async () => {
    const directory = temps.createDir('opencode-betterread-loop');
    const loopPath = path.join(directory, 'loop');
    temps.createSymlink(loopPath, loopPath);

    let caught: unknown;
    try {
      await resolveAccessPath(loopPath);
    } catch (error) {
      caught = error;
    }

    expect((caught as NodeJS.ErrnoException | undefined)?.code).toBe('ELOOP');
  });

  test('does not enumerate degenerate root paths for suggestions', async () => {
    const directory = temps.createDir('opencode-betterread-root-similar');

    await expect(listSimilarPaths(path.parse(directory).root)).resolves.toEqual(
      [],
    );
  });

  test('still suggests nearby sibling paths in normal directories', async () => {
    const directory = temps.createDir('opencode-betterread-similar');
    const similarPath = path.join(directory, 'alpha.txt');
    writeFileSync(similarPath, 'alpha\n');
    writeFileSync(path.join(directory, 'beta.txt'), 'beta\n');

    await expect(
      listSimilarPaths(path.join(directory, 'alpah.txt')),
    ).resolves.toEqual([similarPath]);
  });
});
