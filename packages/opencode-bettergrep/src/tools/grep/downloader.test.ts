/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getInstalledRipgrepPath, getRipgrepCacheDir } from './downloader';
import { createTempDir } from './test-helpers';

const originalCacheHome = process.env.XDG_CACHE_HOME;
const tempDirs: string[] = [];

afterEach(() => {
  process.env.XDG_CACHE_HOME = originalCacheHome;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function setupCache(binaryContent: string, metadata?: object): string {
  const cacheHome = createTempDir('opencode-bettergrep-cache');
  tempDirs.push(cacheHome);
  process.env.XDG_CACHE_HOME = cacheHome;

  const cacheDir = getRipgrepCacheDir();
  mkdirSync(cacheDir, { recursive: true });

  const binaryPath = path.join(
    cacheDir,
    process.platform === 'win32' ? 'rg.exe' : 'rg',
  );
  writeFileSync(binaryPath, binaryContent);
  if (process.platform !== 'win32') {
    chmodSync(binaryPath, 0o755);
  }

  if (metadata) {
    writeFileSync(
      path.join(cacheDir, '.ripgrep-metadata.json'),
      JSON.stringify(metadata),
    );
  }

  return binaryPath;
}

describe('tools/grep/downloader', () => {
  test('returns cached ripgrep when binary and metadata pass verification', () => {
    const binary = '#!/bin/sh\necho "ripgrep 15.1.0"\n';
    const binaryPath = setupCache(binary, {
      version: '15.1.0',
      assetName: 'ripgrep-15.1.0-x86_64-unknown-linux-gnu.tar.gz',
      archiveSha256: sha256('archive'),
      binarySha256: sha256(binary),
    });

    expect(getInstalledRipgrepPath()).toBe(binaryPath);
  });

  test('rejects cached ripgrep when metadata is missing', () => {
    const binary = '#!/bin/sh\necho "ripgrep 15.1.0"\n';
    const binaryPath = setupCache(binary);

    expect(getInstalledRipgrepPath()).toBeNull();
    expect(existsSync(binaryPath)).toBe(false);
  });

  test('rejects cached ripgrep when binary digest does not match metadata', () => {
    const binary = '#!/bin/sh\necho "ripgrep 15.1.0"\n';
    const binaryPath = setupCache(binary, {
      version: '15.1.0',
      assetName: 'ripgrep-15.1.0-x86_64-unknown-linux-gnu.tar.gz',
      archiveSha256: sha256('archive'),
      binarySha256: sha256('different'),
    });

    expect(getInstalledRipgrepPath()).toBeNull();
    expect(existsSync(binaryPath)).toBe(false);
  });
});
