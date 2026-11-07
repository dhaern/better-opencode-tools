/// <reference types="bun-types" />
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as compat from './compat';
import { extractZip, getZipExtractionSupportError } from './zip-extractor';

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

afterEach(() => {
  process.env.PATH = originalPath;
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createUnzipWrapper(script: string): {
  archivePath: string;
  destinationDir: string;
  wrapperDir: string;
} {
  const wrapperDir = mkdtempSync(
    path.join(tmpdir(), 'opencode-bettergrep-unzip-'),
  );
  tempDirs.push(wrapperDir);
  const wrapperPath = path.join(wrapperDir, 'unzip');
  writeFileSync(wrapperPath, `#!/bin/sh\n${script}\n`);
  chmodSync(wrapperPath, 0o755);
  const destinationDir = path.join(wrapperDir, 'destination');
  mkdirSync(destinationDir);

  return {
    archivePath: path.join(wrapperDir, 'archive.zip'),
    destinationDir,
    wrapperDir,
  };
}

describe('utils/zip-extractor process lifetime', () => {
  test.skipIf(process.platform !== 'win32')(
    'uses System32 tar for the probe and extraction',
    async () => {
      const root = process.env.SystemRoot;
      const probe = spyOn(childProcess, 'spawnSync');
      const spawn = spyOn(compat, 'crossSpawn').mockReturnValue({
        stderr: async () => '',
        exited: Promise.resolve(0),
      } as never);
      try {
        expect(getZipExtractionSupportError()).toBeUndefined();
        await extractZip('archive.zip', 'destination');
        const tar = path.join(
          process.env.SystemRoot as string,
          'System32',
          'tar.exe',
        );
        expect(probe.mock.calls[0]?.[0]).toBe(tar);
        expect(spawn.mock.calls[0]?.[0][0]).toBe(tar);
        delete process.env.SystemRoot;
        probe.mockReturnValue({ status: 0 } as never);
        expect(getZipExtractionSupportError()).toBeUndefined();
        await extractZip('archive.zip', 'destination');
        expect(probe.mock.calls.slice(1).map(([command]) => command)).toEqual([
          'where',
          'pwsh',
          'where',
        ]);
        expect(spawn.mock.calls[1]?.[0][0]).toBe('pwsh');
      } finally {
        if (root === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = root;
        probe.mockRestore();
        spawn.mockRestore();
      }
    },
  );

  test('does not reject a healthy extraction that exceeds cleanup grace', async () => {
    if (process.platform === 'win32') return;

    const { archivePath, destinationDir, wrapperDir } =
      createUnzipWrapper('sleep 0.05\nexit 0');
    process.env.PATH = `${wrapperDir}:${originalPath ?? ''}`;

    await extractZip(archivePath, destinationDir);
  });

  test('aborting extraction terminates and bounds a stubborn extractor', async () => {
    if (process.platform === 'win32') return;

    const { archivePath, destinationDir, wrapperDir } = createUnzipWrapper(
      'trap "" TERM\nsleep 1\nexit 0',
    );
    process.env.PATH = `${wrapperDir}:${originalPath ?? ''}`;
    const controller = new AbortController();
    const started = Date.now();
    const extraction = extractZip(
      archivePath,
      destinationDir,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 25);

    let error: unknown;
    try {
      await extraction;
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
