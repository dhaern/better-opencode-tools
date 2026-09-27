import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import which from 'which';
import { ensureSupervisorRuntime } from '../../utils/process-output';
import { resolveGlobCliAsync } from './resolver';
import {
  getRipgrepBinaryName,
  getRipgrepCacheDir,
  getRipgrepMetadataPath,
} from './rg-cache';

describe.skipIf(process.platform === 'win32' || !process.versions.bun)(
  'positive resolver memoization',
  () => {
    const originalPath = process.env.PATH;
    const originalCache = process.env.XDG_CACHE_HOME;
    const dirs: string[] = [];
    afterEach(() => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = originalCache;
      for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
    });

    function temp() {
      const dir = path.join(
        os.tmpdir(),
        `betterglob-perf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(dir, { recursive: true });
      dirs.push(dir);
      return dir;
    }
    const probes = (file: string) =>
      existsSync(file) ? readFileSync(file, 'utf8').length : 0;
    const script = (counter: string) =>
      `#!/bin/sh\nprintf x >> '${counter}'\necho 'ripgrep 15.2.0'\n`;
    const metadata = (binary: string) =>
      JSON.stringify({
        version: '15.2.0',
        assetName: 'rg.tar.gz',
        archiveSha256: 'a'.repeat(64),
        binarySha256: createHash('sha256')
          .update(readFileSync(binary))
          .digest('hex'),
      });

    test('checks PATH each time but probes an unchanged system binary once', async () => {
      const dir = temp();
      const node = await which('node');
      symlinkSync(node, path.join(dir, 'node'));
      const counter = path.join(dir, 'probes');
      writeFileSync(path.join(dir, 'rg'), script(counter), { mode: 0o755 });
      process.env.PATH = dir;
      expect((await resolveGlobCliAsync()).source).toBe('system-rg');
      expect((await resolveGlobCliAsync()).source).toBe('system-rg');
      expect(probes(counter)).toBe(1);
      const plantedDir = temp();
      symlinkSync(node, path.join(plantedDir, 'node'));
      const planted = path.join(plantedDir, 'rg');
      writeFileSync(planted, script(path.join(plantedDir, 'probes')), {
        mode: 0o755,
      });
      process.env.PATH = `${plantedDir}:${dir}`;
      expect((await resolveGlobCliAsync()).path).toBe(planted);
      process.env.PATH = dir;
      writeFileSync(path.join(dir, 'rg'), `${script(counter)}# new bytes\n`, {
        mode: 0o755,
      });
      expect((await resolveGlobCliAsync()).source).toBe('system-rg');
      expect(probes(counter)).toBe(2);
      const binary = path.join(dir, 'rg');
      const fixed = new Date('2020-01-02T03:04:05Z');
      utimesSync(binary, fixed, fixed);
      expect((await resolveGlobCliAsync()).source).toBe('system-rg');
      expect(probes(counter)).toBe(3);
      const bytes = readFileSync(binary, 'utf8');
      writeFileSync(binary, bytes.replace('ripgrep 15.2.0', 'not-rip 15.2.0'));
      utimesSync(binary, fixed, fixed);
      expect((await resolveGlobCliAsync()).source).toBe('missing-rg');
      expect(probes(counter)).toBe(4);
      expect((await resolveGlobCliAsync()).source).toBe('missing-rg');
      expect(probes(counter)).toBe(5);
      const replacement = path.join(dir, 'replacement');
      writeFileSync(replacement, bytes, { mode: 0o755 });
      utimesSync(replacement, fixed, fixed);
      renameSync(replacement, binary);
      expect(statSync(binary).isFile()).toBe(true);
      expect((await resolveGlobCliAsync()).source).toBe('system-rg');
      expect(probes(counter)).toBe(6);
    });

    test('managed positive stamp covers both binary and metadata, but never caches invalidity', async () => {
      const dir = temp();
      symlinkSync(await which('node'), path.join(dir, 'node'));
      process.env.PATH = dir;
      process.env.XDG_CACHE_HOME = dir;
      const cache = getRipgrepCacheDir();
      mkdirSync(cache, { recursive: true });
      const binary = path.join(cache, getRipgrepBinaryName());
      const counter = path.join(dir, 'managed-probes');
      writeFileSync(binary, script(counter), { mode: 0o755 });
      const meta = getRipgrepMetadataPath();
      writeFileSync(meta, metadata(binary));
      expect((await resolveGlobCliAsync()).source).toBe('managed-rg');
      expect((await resolveGlobCliAsync()).source).toBe('managed-rg');
      expect(probes(counter)).toBe(1);
      writeFileSync(
        meta,
        JSON.stringify({ ...JSON.parse(metadata(binary)), version: '15.2.1' }),
      );
      expect((await resolveGlobCliAsync()).source).toBe('managed-rg');
      expect(probes(counter)).toBe(2);
      writeFileSync(binary, `${script(counter)}# appended\n`, { mode: 0o755 });
      expect((await resolveGlobCliAsync()).source).toBe('missing-rg');
      writeFileSync(meta, metadata(binary));
      expect((await resolveGlobCliAsync()).source).toBe('managed-rg');
      expect(probes(counter)).toBe(3);
      chmodSync(binary, 0o700);
      expect((await resolveGlobCliAsync()).source).toBe('managed-rg');
      expect(probes(counter)).toBe(4);
      const planted = path.join(dir, 'rg');
      const systemProbes = path.join(dir, 'system-probes');
      writeFileSync(planted, script(systemProbes), { mode: 0o755 });
      expect((await resolveGlobCliAsync()).source).toBe('system-rg');
      expect(probes(systemProbes)).toBe(1);
    });

    test('runtime positives are scoped to PATH and executable stamp; failures are never memoized', async () => {
      const dir = temp();
      const counter = path.join(dir, 'runtime-probes');
      const node = path.join(dir, 'node');
      writeFileSync(
        node,
        `#!/bin/sh\nprintf x >> '${counter}'\necho -n betterglob-node-supervisor\n`,
        { mode: 0o755 },
      );
      process.env.PATH = dir;
      await ensureSupervisorRuntime();
      await ensureSupervisorRuntime();
      expect(probes(counter)).toBe(1);
      process.env.PATH = `${dir}:${originalPath}`;
      await ensureSupervisorRuntime();
      expect(probes(counter)).toBe(2);
      writeFileSync(node, `#!/bin/sh\nprintf x >> '${counter}'\nexit 1\n`, {
        mode: 0o755,
      });
      await expect(ensureSupervisorRuntime()).rejects.toThrow(
        /infrastructure unavailable/,
      );
      await expect(ensureSupervisorRuntime()).rejects.toThrow(
        /infrastructure unavailable/,
      );
      expect(probes(counter)).toBe(4);
    });
  },
);
