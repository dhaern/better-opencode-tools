/// <reference types="bun-types" />

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { lock } from 'proper-lockfile';
import {
  getInstalledRipgrepPath,
  getInstalledRipgrepPathAsync,
  getRipgrepBinaryName,
  getRipgrepCacheDir,
  installLatestStableRipgrep,
  type PublishStagedBinaryInput,
  publishStagedBinary,
} from './downloader';

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeFakeRipgrep(binary: string): void {
  const script = '#!/bin/sh\necho ripgrep 14.1.1\n';
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  // Explicit skip instead of a mid-test throw: Windows runs report these
  // as skipped, not failed.
  const testPosix = (process.platform === 'win32' ? test.skip : test) as (
    name: string,
    fn: () => void | Promise<void>,
  ) => void;

  function setupCache(): { binary: string; metadata: string } {
    // Hermetic: scratch dirs live under the OS temp dir, never inside the
    // repository working tree.
    const cacheRoot = path.join(
      os.tmpdir(),
      `opencode-betterglob-downloader-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  function stage(
    binary: string,
    metadata: string,
    name: string,
  ): PublishStagedBinaryInput {
    const dir = path.dirname(binary);
    const staged = path.join(dir, name);
    writeFakeRipgrep(staged);
    return {
      dir,
      final: binary,
      metadata,
      staged,
      version: '14.1.1',
      assetName: 'ripgrep.tar.gz',
      archiveSha256: 'a'.repeat(64),
      binarySha256: sha256(staged),
    };
  }

  (process.platform === 'linux' && ['arm64', 'x64'].includes(process.arch)
    ? test
    : test.skip)(
    'installs through the real automatic path without synchronous filesystem I/O',
    async () => {
      const { binary } = setupCache();
      const dir = path.dirname(binary);
      const source = path.join(dir, 'archive-source');
      mkdirSync(source);
      writeFakeRipgrep(path.join(source, getRipgrepBinaryName()));
      const archive = path.join(dir, 'fixture.tar.gz');
      await promisify(execFile)('tar', [
        '-czf',
        archive,
        '-C',
        source,
        getRipgrepBinaryName(),
      ]);
      const bytes = readFileSync(archive);
      const digest = `sha256:${sha256(archive)}`;
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
          async (url: Parameters<typeof fetch>[0]) => {
            if (String(url).endsWith('/releases/latest')) {
              return Response.json({
                tag_name: '14.1.1',
                assets: ['gnu', 'musl'].map((libc) => ({
                  name: `ripgrep-14.1.1-${arch}-unknown-linux-${libc}.tar.gz`,
                  browser_download_url:
                    'https://fixture.invalid/ripgrep.tar.gz',
                  digest,
                })),
              });
            }
            expect(String(url)).toBe('https://fixture.invalid/ripgrep.tar.gz');
            return new Response(bytes);
          },
          { preconnect: () => undefined },
        ),
      );
      const syncCalls = [
        spyOn(fs, 'existsSync'),
        spyOn(fs, 'statSync'),
        spyOn(fs, 'lstatSync'),
        spyOn(fs, 'accessSync'),
        spyOn(fs, 'openSync'),
        spyOn(fs, 'fstatSync'),
        spyOn(fs, 'readSync'),
        spyOn(fs, 'readFileSync'),
        spyOn(fs, 'renameSync'),
        spyOn(fs, 'rmSync'),
      ];
      try {
        expect(await installLatestStableRipgrep()).toBe(binary);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const call of syncCalls) expect(call).not.toHaveBeenCalled();
      } finally {
        for (const call of syncCalls) call.mockRestore();
        fetchMock.mockRestore();
      }
    },
  );

  testPosix(
    'recovers orphan metadata temporaries only under the lock',
    async () => {
      const { binary, metadata } = setupCache();
      const input = stage(binary, metadata, 'staged-rg');
      const orphans = [`${metadata}.tmp`, `${metadata}.tmp-${randomUUID()}`];
      const staleTime = new Date(Date.now() - 120_000);
      for (const orphan of orphans) {
        writeFileSync(orphan, 'orphan');
        utimesSync(orphan, staleTime, staleTime);
      }
      const unrelated = `${metadata}.tmp-not-an-install-attempt`;
      writeFileSync(unrelated, 'keep');

      expect(await getInstalledRipgrepPathAsync()).toBeNull();
      for (const orphan of orphans) expect(existsSync(orphan)).toBe(true);
      let checkedUnderLock = false;
      input.acquireLock = async (file, options) => {
        const release = await lock(file, options);
        for (const orphan of orphans) expect(existsSync(orphan)).toBe(true);
        checkedUnderLock = true;
        return release;
      };
      await publishStagedBinary(input);

      expect(checkedUnderLock).toBe(true);
      for (const orphan of orphans) expect(existsSync(orphan)).toBe(false);
      expect(readFileSync(unrelated, 'utf8')).toBe('keep');
      expect(await getInstalledRipgrepPathAsync()).toBe(binary);
    },
  );

  testPosix(
    'serializes simultaneous publishers through a directory alias',
    async () => {
      const { binary, metadata } = setupCache();
      const first = stage(binary, metadata, 'first-rg');
      const aliasDir = `${first.dir}-alias`;
      symlinkSync(first.dir, aliasDir, 'dir');
      const second = stage(
        path.join(aliasDir, path.basename(binary)),
        path.join(aliasDir, path.basename(metadata)),
        'second-rg',
      );
      const writing = deferred();
      const finish = deferred();
      const acquiring = deferred();
      let writes = 0;
      first.writeMetadata = async (file, contents) => {
        writes += 1;
        await writeFile(file, contents, { flag: 'wx' });
        writing.resolve();
        await finish.promise;
      };
      second.acquireLock = (file, options) => {
        expect(file).toBe(first.dir);
        acquiring.resolve();
        return lock(file, options);
      };
      second.writeMetadata = async () => {
        writes += 1;
        throw new Error('second publisher must reuse the valid cache');
      };
      const a = publishStagedBinary(first);
      await writing.promise;
      const b = publishStagedBinary(second);
      await acquiring.promise;
      expect(existsSync(binary)).toBe(false);
      finish.resolve();
      await Promise.all([a, b]);
      expect(writes).toBe(1);
      expect(existsSync(first.staged)).toBe(false);
      expect(existsSync(second.staged)).toBe(true);
      expect(await getInstalledRipgrepPathAsync()).toBe(binary);
      expect(
        readdirSync(first.dir).filter((name) => name.includes('.tmp')),
      ).toEqual([]);
    },
  );

  testPosix(
    'compromised publisher never removes its successor temporary',
    async () => {
      const { binary, metadata } = setupCache();
      const first = stage(binary, metadata, 'first-rg');
      const second = stage(binary, metadata, 'second-rg');
      const writingFirst = deferred();
      const writingSecond = deferred();
      const finishFirst = deferred();
      const finishSecond = deferred();
      const compromised = Object.assign(new Error('lock ownership lost'), {
        code: 'ECOMPROMISED',
      });
      let loseLock!: () => Promise<void>;
      let firstTmp = '';
      let secondTmp = '';
      first.acquireLock = async (file, options) => {
        const release = await lock(file, options);
        let lost = false;
        loseLock = async () => {
          await release();
          lost = true;
          // Simulate proper-lockfile's heartbeat callback without wall-clock waits.
          expect(() => options?.onCompromised?.(compromised)).not.toThrow();
        };
        return async () => {
          if (!lost) await release();
          else throw new Error('Lock is already released');
        };
      };
      first.writeMetadata = async (file, contents) => {
        firstTmp = file;
        await writeFile(file, contents, { flag: 'wx' });
        writingFirst.resolve();
        await finishFirst.promise;
      };
      second.writeMetadata = async (file, contents) => {
        secondTmp = file;
        await writeFile(file, contents, { flag: 'wx' });
        writingSecond.resolve();
        await finishSecond.promise;
      };
      const a = publishStagedBinary(first);
      const outcome = a.then(
        () => null,
        (error: unknown) => error,
      );
      await writingFirst.promise;
      await loseLock();
      const b = publishStagedBinary(second);
      await writingSecond.promise;
      expect(secondTmp).not.toBe(firstTmp);
      finishFirst.resolve();
      expect(await outcome).toBe(compromised);
      expect(existsSync(firstTmp)).toBe(false);
      expect(existsSync(secondTmp)).toBe(true);
      expect(existsSync(first.staged)).toBe(true);
      expect(existsSync(metadata)).toBe(false);
      finishSecond.resolve();
      await b;
      expect(existsSync(secondTmp)).toBe(false);
      expect(await getInstalledRipgrepPathAsync()).toBe(binary);
    },
  );

  testPosix(
    'observes compromise during acquisition and releases a late lock',
    async () => {
      const { binary, metadata } = setupCache();
      const input = stage(binary, metadata, 'staged-rg');
      const acquiring = deferred();
      const acquired = deferred();
      const released = deferred();
      const error = Object.assign(new Error('acquisition compromised'), {
        code: 'ECOMPROMISED',
      });
      let compromise!: () => void;
      input.acquireLock = async (_file, options) => {
        compromise = () => options?.onCompromised?.(error);
        acquiring.resolve();
        await acquired.promise;
        return async () => released.resolve();
      };
      const pending = publishStagedBinary(input);
      await acquiring.promise;
      expect(compromise).not.toThrow();
      await expect(pending).rejects.toThrow('acquisition compromised');
      acquired.resolve();
      await released.promise;
      expect(existsSync(binary)).toBe(false);
      expect(existsSync(metadata)).toBe(false);
      expect(existsSync(input.staged)).toBe(true);
    },
  );

  testPosix('returns a valid cached ripgrep binary', async () => {
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
    expect(await getInstalledRipgrepPathAsync()).toBe(binary);
    expect(existsSync(binary)).toBe(true);
    expect(existsSync(metadata)).toBe(true);
  });

  testPosix(
    'classifies structurally invalid metadata as corrupt cache',
    async () => {
      const { binary, metadata } = setupCache();
      writeFakeRipgrep(binary);
      writeFileSync(metadata, 'null');

      expect(await getInstalledRipgrepPathAsync()).toBeNull();

      const input = stage(binary, metadata, 'staged-rg');
      await publishStagedBinary(input);
      expect(await getInstalledRipgrepPathAsync()).toBe(binary);
    },
  );

  testPosix(
    'does not repair or delete invalid cache during read-only probe',
    () => {
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
    },
  );

  testPosix('does not repair invalid cache through the legacy sync API', () => {
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

    // The async publisher performs repair under its proper-lockfile lock.
    // The synchronous compatibility API cannot safely acquire that lock.
    expect(getInstalledRipgrepPath({ repair: true })).toBeNull();
    expect(existsSync(binary)).toBe(true);
    expect(existsSync(metadata)).toBe(true);
  });

  testPosix('default reads never repair invalid cache', () => {
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
    expect(existsSync(binary)).toBe(true);
    expect(existsSync(metadata)).toBe(true);
  });

  testPosix(
    'publishes a staged binary over a corrupt cache under the lock',
    async () => {
      const { binary, metadata } = setupCache();
      // Corrupt existing cache: binary present, metadata hash mismatched.
      writeFakeRipgrep(binary);
      writeFileSync(
        metadata,
        JSON.stringify({
          version: '0.0.0',
          assetName: 'old.tar.gz',
          archiveSha256: 'a'.repeat(64),
          binarySha256: 'b'.repeat(64),
        }),
      );

      // Stage a valid new binary in the same cache dir.
      const stagingDir = path.join(path.dirname(binary), 'staging');
      mkdirSync(stagingDir);
      const staged = path.join(stagingDir, 'staged-rg');
      writeFakeRipgrep(staged);
      const stagedHash = sha256(staged);

      await publishStagedBinary({
        dir: path.dirname(binary),
        final: binary,
        metadata,
        staged,
        version: '14.1.1',
        assetName: 'ripgrep.tar.gz',
        archiveSha256: 'a'.repeat(64),
        binarySha256: stagedHash,
      });

      // The corrupt cache was replaced under the lock, not left blocking.
      expect(getInstalledRipgrepPath()).toBe(binary);
      expect(existsSync(staged)).toBe(false);
    },
  );

  testPosix(
    'refuses to publish after an abort while waiting for the lock',
    async () => {
      const { binary, metadata } = setupCache();
      const dir = path.dirname(binary);
      const staged = path.join(dir, 'staged-rg');
      writeFakeRipgrep(staged);

      // Hold the same proper-lockfile lock used by the publisher.
      const release = await lock(dir, {
        realpath: false,
        stale: 60_000,
        update: 30_000,
      });

      const controller = new AbortController();
      try {
        const pending = publishStagedBinary(
          {
            dir,
            final: binary,
            metadata,
            staged,
            version: '14.1.1',
            assetName: 'ripgrep.tar.gz',
            archiveSha256: 'a'.repeat(64),
            binarySha256: sha256(staged),
          },
          controller.signal,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort();

        await expect(pending).rejects.toThrow(/aborted|abort/i);
        expect(existsSync(binary)).toBe(false);
        expect(existsSync(metadata)).toBe(false);
      } finally {
        await release();
      }
    },
  );

  testPosix(
    'does not rename a staged binary after metadata write aborts',
    async () => {
      const { binary, metadata } = setupCache();
      const dir = path.dirname(binary);
      const staged = path.join(dir, 'staged-rg');
      writeFakeRipgrep(staged);

      let releaseWrite!: () => void;
      let markWriteStarted!: () => void;
      const writeStarted = new Promise<void>((resolve) => {
        markWriteStarted = resolve;
      });
      const controller = new AbortController();
      const pending = publishStagedBinary(
        {
          dir,
          final: binary,
          metadata,
          staged,
          version: '14.1.1',
          assetName: 'ripgrep.tar.gz',
          archiveSha256: 'a'.repeat(64),
          binarySha256: sha256(staged),
          writeMetadata: async (file, contents) => {
            markWriteStarted();
            await new Promise<void>((resolve) => {
              releaseWrite = resolve;
            });
            writeFileSync(file, contents);
          },
        },
        controller.signal,
      );

      await writeStarted;
      controller.abort();
      releaseWrite();

      await expect(pending).rejects.toThrow(/aborted|abort/i);
      expect(existsSync(binary)).toBe(false);
      expect(existsSync(metadata)).toBe(false);
      expect(existsSync(`${metadata}.tmp`)).toBe(false);
      expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual(
        [],
      );
    },
  );

  testPosix(
    'uses one canonical lock for a symlinked cache directory',
    async () => {
      const { binary, metadata } = setupCache();
      const realDir = path.dirname(binary);
      const aliasRoot = path.join(
        os.tmpdir(),
        `opencode-betterglob-alias-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      tempDirs.push(aliasRoot);
      mkdirSync(aliasRoot, { recursive: true });
      const aliasDir = path.join(aliasRoot, 'bin');
      symlinkSync(realDir, aliasDir, 'dir');

      const staged = path.join(aliasDir, 'staged-rg');
      writeFakeRipgrep(staged);
      await publishStagedBinary({
        dir: aliasDir,
        final: path.join(aliasDir, getRipgrepBinaryName()),
        metadata: path.join(aliasDir, '.ripgrep-metadata.json'),
        staged,
        version: '14.1.1',
        assetName: 'ripgrep.tar.gz',
        archiveSha256: 'a'.repeat(64),
        binarySha256: sha256(staged),
      });

      expect(getInstalledRipgrepPath()).toBe(binary);
      expect(existsSync(metadata)).toBe(true);
      expect(existsSync(staged)).toBe(false);
    },
  );
});
