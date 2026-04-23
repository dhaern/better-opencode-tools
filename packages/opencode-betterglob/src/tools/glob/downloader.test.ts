/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  getInstalledRipgrepPath,
  getRipgrepBinaryName,
  getRipgrepCacheDir,
} from './downloader';

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeFakeRipgrep(binary: string): void {
  const script = '#!/bin/sh\necho ripgrep 14.1.1\n';
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
}

describe('tools/glob/downloader', () => {
  const originalCacheHome = process.env.XDG_CACHE_HOME;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCacheHome;

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupCache(): { binary: string; metadata: string } {
    if (process.platform === 'win32') {
      throw new Error('downloader cache tests are not supported on win32');
    }

    const cacheRoot = path.join(
      process.cwd(),
      `.tmp-downloader-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    tempDirs.push(cacheRoot);
    process.env.XDG_CACHE_HOME = cacheRoot;

    const dir = getRipgrepCacheDir();
    mkdirSync(dir, { recursive: true });

    return {
      binary: path.join(dir, getRipgrepBinaryName()),
      metadata: path.join(dir, '.ripgrep-metadata.json'),
    };
  }

  test('returns a valid cached ripgrep binary', () => {
    const { binary, metadata } = setupCache();
    writeFakeRipgrep(binary);
    writeFileSync(
      metadata,
      JSON.stringify({
        version: '14.1.1',
        assetName: 'ripgrep.tar.gz',
        archiveSha256: 'a'.repeat(64),
        binarySha256: sha256(binary),
      }),
    );

    expect(getInstalledRipgrepPath()).toBe(binary);
    expect(existsSync(binary)).toBe(true);
    expect(existsSync(metadata)).toBe(true);
  });

  test('does not repair or delete invalid cache during read-only probe', () => {
    const { binary, metadata } = setupCache();
    writeFakeRipgrep(binary);
    writeFileSync(
      metadata,
      JSON.stringify({
        version: '14.1.1',
        assetName: 'ripgrep.tar.gz',
        archiveSha256: 'a'.repeat(64),
        binarySha256: 'b'.repeat(64),
      }),
    );

    expect(getInstalledRipgrepPath({ repair: false })).toBeNull();
    expect(existsSync(binary)).toBe(true);
    expect(existsSync(metadata)).toBe(true);
  });

  test('repairs invalid cache by removing binary and metadata', () => {
    const { binary, metadata } = setupCache();
    writeFakeRipgrep(binary);
    writeFileSync(
      metadata,
      JSON.stringify({
        version: '14.1.1',
        assetName: 'ripgrep.tar.gz',
        archiveSha256: 'a'.repeat(64),
        binarySha256: 'b'.repeat(64),
      }),
    );

    expect(getInstalledRipgrepPath()).toBeNull();
    expect(existsSync(binary)).toBe(false);
    expect(existsSync(metadata)).toBe(false);
  });
});
