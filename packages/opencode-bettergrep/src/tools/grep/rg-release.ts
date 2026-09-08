import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { probeCommand, throwIfAborted } from './install-probe';

interface RipgrepReleaseAsset {
  name?: string;
  browser_download_url?: string;
  digest?: string;
}

interface RipgrepReleaseResponse {
  tag_name?: string;
  assets?: RipgrepReleaseAsset[];
}

export type ArchiveExtension = 'tar.gz' | 'zip';

interface PlatformCandidate {
  target: string;
  extension: ArchiveExtension;
}

function parseSha256Digest(value: string | undefined): string {
  const normalized = value
    ?.trim()
    .replace(/^sha256:/i, '')
    .toLowerCase();

  if (!normalized || !/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      'Latest ripgrep release metadata is missing a valid SHA-256 digest.',
    );
  }

  return normalized;
}

async function detectLinuxLibc(signal?: AbortSignal): Promise<'gnu' | 'musl'> {
  const muslLoaders = [
    '/lib/ld-musl-x86_64.so.1',
    '/lib/ld-musl-aarch64.so.1',
    '/usr/glibc-compat/lib/ld-musl-x86_64.so.1',
    '/usr/glibc-compat/lib/ld-musl-aarch64.so.1',
  ];

  if (muslLoaders.some((candidate) => existsSync(candidate))) {
    return 'musl';
  }

  try {
    const result = await probeCommand(['ldd', '--version'], signal);
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();

    if (output.includes('musl')) {
      return 'musl';
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Ignore and fall back to gnu.
  }

  return 'gnu';
}

async function getPlatformCandidates(
  signal?: AbortSignal,
): Promise<PlatformCandidate[]> {
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') {
      return [{ target: 'aarch64-apple-darwin', extension: 'tar.gz' }];
    }

    if (process.arch === 'x64') {
      return [{ target: 'x86_64-apple-darwin', extension: 'tar.gz' }];
    }

    return [];
  }

  if (process.platform === 'win32') {
    if (process.arch === 'arm64') {
      return [{ target: 'aarch64-pc-windows-msvc', extension: 'zip' }];
    }

    if (process.arch === 'x64') {
      return [{ target: 'x86_64-pc-windows-msvc', extension: 'zip' }];
    }

    return [];
  }

  if (process.platform === 'linux') {
    const libc = await detectLinuxLibc(signal);

    if (process.arch === 'arm64') {
      return libc === 'musl'
        ? [
            { target: 'aarch64-unknown-linux-musl', extension: 'tar.gz' },
            { target: 'aarch64-unknown-linux-gnu', extension: 'tar.gz' },
          ]
        : [
            { target: 'aarch64-unknown-linux-gnu', extension: 'tar.gz' },
            { target: 'aarch64-unknown-linux-musl', extension: 'tar.gz' },
          ];
    }

    if (process.arch === 'x64') {
      return libc === 'musl'
        ? [
            { target: 'x86_64-unknown-linux-musl', extension: 'tar.gz' },
            { target: 'x86_64-unknown-linux-gnu', extension: 'tar.gz' },
          ]
        : [
            { target: 'x86_64-unknown-linux-gnu', extension: 'tar.gz' },
            { target: 'x86_64-unknown-linux-musl', extension: 'tar.gz' },
          ];
    }
  }

  return [];
}

export async function fetchLatestRelease(
  signal?: AbortSignal,
): Promise<RipgrepReleaseResponse> {
  const response = await fetch(
    'https://api.github.com/repos/BurntSushi/ripgrep/releases/latest',
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'opencode-bettergrep',
      },
      redirect: 'follow',
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to resolve latest ripgrep release: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as RipgrepReleaseResponse;
  if (!payload.tag_name || !Array.isArray(payload.assets)) {
    throw new Error('Latest ripgrep release metadata is incomplete.');
  }

  return payload;
}

export async function selectReleaseAsset(
  release: RipgrepReleaseResponse,
  signal?: AbortSignal,
): Promise<{
  asset: RipgrepReleaseAsset;
  version: string;
  archiveSha256: string;
}> {
  const version = release.tag_name?.replace(/^v/i, '');
  if (!version) {
    throw new Error('Latest ripgrep release is missing a version tag.');
  }

  const assets = release.assets ?? [];
  const candidates = await getPlatformCandidates(signal);

  if (candidates.length === 0) {
    throw new Error(
      `Unsupported platform for ripgrep auto-install: ${process.platform}-${process.arch}`,
    );
  }

  for (const candidate of candidates) {
    const expectedName = `ripgrep-${version}-${candidate.target}.${candidate.extension}`;
    const asset = assets.find((item) => item.name === expectedName);

    if (asset?.browser_download_url) {
      return {
        asset,
        version,
        archiveSha256: parseSha256Digest(asset.digest),
      };
    }
  }

  throw new Error(
    `No ripgrep asset is available for ${process.platform}-${process.arch}.`,
  );
}

export async function downloadArchive(
  url: string,
  destinationPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { redirect: 'follow', signal });

  if (!response.ok) {
    throw new Error(
      `Failed to download ripgrep archive: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  throwIfAborted(signal);
  await writeFile(destinationPath, Buffer.from(arrayBuffer));
}
