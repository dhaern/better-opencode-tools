import { access, writeFile } from 'node:fs/promises';
import { crossSpawn, isMissingExecutableError } from '../../utils/compat';
import { waitForProcessOutputWithAbortGrace } from '../../utils/process-output';
import { isSupervisorError } from '../../utils/process-supervisor';
import { createAbortError, throwIfAborted } from './install-io';

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

async function detectLinuxLibcAsync(
  signal?: AbortSignal,
): Promise<'gnu' | 'musl'> {
  const loaders = [
    '/lib/ld-musl-x86_64.so.1',
    '/lib/ld-musl-aarch64.so.1',
    '/usr/glibc-compat/lib/ld-musl-x86_64.so.1',
    '/usr/glibc-compat/lib/ld-musl-aarch64.so.1',
  ];

  throwIfAborted(signal);
  for (const file of loaders) {
    const exists = await access(file).then(
      () => true,
      () => false,
    );
    throwIfAborted(signal);
    if (exists) return 'musl';
  }

  try {
    const proc = crossSpawn(['ldd', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      detached: process.platform !== 'win32',
      killProcessGroup: process.platform !== 'win32',
    });
    const stdoutPromise = proc.stdout();
    const stderrPromise = proc.stderr();
    const result = await waitForProcessOutputWithAbortGrace(
      proc,
      stderrPromise,
      signal,
      stdoutPromise,
      { killGraceMs: 250, postCloseDrainMs: 250 },
    );
    if (signal?.aborted) throw createAbortError();
    if (result.aborted) return 'gnu';
    return `${result.stdout}\n${result.stderr}`.toLowerCase().includes('musl')
      ? 'musl'
      : 'gnu';
  } catch (error) {
    if (isSupervisorError(error)) throw error;
    if (signal?.aborted) throw createAbortError();
    if (isMissingExecutableError(error)) return 'gnu';
    throw error;
  }
}

function getPlatformCandidates(): PlatformCandidate[] {
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

  return [];
}

async function getPlatformCandidatesAsync(
  signal?: AbortSignal,
): Promise<PlatformCandidate[]> {
  if (process.platform !== 'linux') return getPlatformCandidates();

  const libc = await detectLinuxLibcAsync(signal);
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
        'user-agent': 'opencode-betterglob',
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

export async function selectReleaseAssetAsync(
  release: RipgrepReleaseResponse,
  signal?: AbortSignal,
): Promise<{
  asset: RipgrepReleaseAsset;
  version: string;
  archiveSha256: string;
}> {
  throwIfAborted(signal);
  const version = release.tag_name?.replace(/^v/i, '');
  if (!version) {
    throw new Error('Latest ripgrep release is missing a version tag.');
  }

  for (const candidate of await getPlatformCandidatesAsync(signal)) {
    throwIfAborted(signal);
    const name = `ripgrep-${version}-${candidate.target}.${candidate.extension}`;
    const asset = release.assets?.find((item) => item.name === name);

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
  file: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { redirect: 'follow', signal });

  if (!response.ok) {
    throw new Error(
      `Failed to download ripgrep archive: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const buffer = await response.arrayBuffer();
  throwIfAborted(signal);
  await writeFile(file, Buffer.from(buffer), { signal });
}
