import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadArchive } from './downloader';
import {
  detectLinuxLibcAsync,
  getPlatformCandidatesAsync,
  platformCandidates,
} from './rg-release';

describe('ripgrep platform candidates', () => {
  test('maps the platform/arch/libc matrix without probing unsupported Linux arch', async () => {
    for (const [platform, arch, libc, primary] of [
      ['darwin', 'arm64', 'gnu', 'aarch64-apple-darwin'],
      ['darwin', 'x64', 'gnu', 'x86_64-apple-darwin'],
      ['win32', 'arm64', 'gnu', 'aarch64-pc-windows-msvc'],
      ['win32', 'x64', 'gnu', 'x86_64-pc-windows-msvc'],
      ['linux', 'arm64', 'gnu', 'aarch64-unknown-linux-gnu'],
      ['linux', 'arm64', 'musl', 'aarch64-unknown-linux-musl'],
      ['linux', 'x64', 'gnu', 'x86_64-unknown-linux-gnu'],
      ['linux', 'x64', 'musl', 'x86_64-unknown-linux-musl'],
      ['linux', 'mips64', 'gnu', ''],
    ] as const) {
      const targets = platformCandidates(platform, arch, libc).map(
        (item) => item.target,
      );
      expect(targets).toEqual(
        primary
          ? platform === 'linux'
            ? [
                primary,
                primary.replace(
                  /-(gnu|musl)$/,
                  libc === 'gnu' ? '-musl' : '-gnu',
                ),
              ]
            : [primary]
          : [],
      );
    }
    let probed = false;
    expect(
      await getPlatformCandidatesAsync(
        undefined,
        'linux',
        'mips64',
        async () => {
          probed = true;
          return 'gnu';
        },
      ),
    ).toEqual([]);
    expect(probed).toBe(false);
    for (const [stdout, stderr, expected] of [
      ['ldd (GNU libc) 2.39', '', 'gnu'],
      ['', 'musl libc (aarch64)', 'musl'],
    ] as const) {
      const actual = await detectLinuxLibcAsync(undefined, {
        exists: async () => false,
        run: async () => ({ exitCode: 0, stdout, stderr, aborted: false }),
      });
      expect(actual).toBe(expected);
    }
  });

  test('bounds a live archive stream before EOF and deletes partial output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'betterglob-download-'));
    const file = join(dir, 'incomplete.tar.gz');
    const chunk = new Uint8Array(512);
    const maxBytes = 1024;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (request.url.endsWith('/exact'))
          return new Response(new Uint8Array(maxBytes));
        if (request.url.endsWith('/oversize'))
          return new Response(new Uint8Array(maxBytes + 1));
        return new Response(
          new ReadableStream({
            async pull(controller) {
              await Bun.sleep(10);
              controller.enqueue(chunk);
            },
          }),
        );
      },
    });
    const abort = new AbortController();
    const deadline = setTimeout(
      () => abort.abort(new Error('download hung')),
      500,
    );
    try {
      await expect(
        downloadArchive(`${server.url}archive`, file, abort.signal, maxBytes),
      ).rejects.toThrow(`Cached file exceeds its size limit: ${file}`);
      expect(existsSync(file)).toBe(false);
      const exact = join(dir, 'exact.tar.gz');
      await downloadArchive(`${server.url}exact`, exact, undefined, maxBytes);
      await expect(
        downloadArchive(`${server.url}exact`, dir),
      ).rejects.toMatchObject({
        code: 'EISDIR',
      });
      expect(readFileSync(exact).byteLength).toBe(maxBytes);
      const oversized = join(dir, 'oversized.tar.gz');
      const rejected = downloadArchive(
        `${server.url}oversize`,
        oversized,
        undefined,
        maxBytes,
      );
      await expect(rejected).rejects.toThrow(
        `Cached file exceeds its size limit: ${oversized}`,
      );
      expect(existsSync(oversized)).toBe(false);
    } finally {
      clearTimeout(deadline);
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
