import { describe, expect, test } from 'bun:test';
import { getPlatformCandidatesAsync, platformCandidates } from './rg-release';

describe('ripgrep platform candidates', () => {
  test('maps the platform/arch/libc matrix without probing unsupported Linux arch', async () => {
    for (const [platform, arch, libc, targets] of [
      ['darwin', 'arm64', 'gnu', ['aarch64-apple-darwin']],
      ['darwin', 'x64', 'gnu', ['x86_64-apple-darwin']],
      ['win32', 'arm64', 'gnu', ['aarch64-pc-windows-msvc']],
      ['win32', 'x64', 'gnu', ['x86_64-pc-windows-msvc']],
      [
        'linux',
        'arm64',
        'gnu',
        ['aarch64-unknown-linux-gnu', 'aarch64-unknown-linux-musl'],
      ],
      [
        'linux',
        'arm64',
        'musl',
        ['aarch64-unknown-linux-musl', 'aarch64-unknown-linux-gnu'],
      ],
      [
        'linux',
        'x64',
        'gnu',
        ['x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl'],
      ],
      [
        'linux',
        'x64',
        'musl',
        ['x86_64-unknown-linux-musl', 'x86_64-unknown-linux-gnu'],
      ],
      ['linux', 'mips64', 'gnu', []],
    ] as const) {
      expect({
        platform,
        arch,
        libc,
        targets: platformCandidates(platform, arch, libc).map(
          (item) => item.target,
        ),
      }).toEqual({
        platform,
        arch,
        libc,
        targets: [...targets],
      });
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
  });
});
