import { access } from 'node:fs/promises';
import { createAbortError, throwIfAborted } from '../../utils/abort';
import {
  isMissingExecutableError,
  runProcess,
} from '../../utils/process-output';
import { isSupervisorError } from '../../utils/process-supervisor';

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
  if (!normalized || !/^[0-9a-f]{64}$/.test(normalized))
    throw new Error(
      'Latest ripgrep release metadata is missing a valid SHA-256 digest.',
    );
  return normalized;
}

export async function detectLinuxLibcAsync(
  signal?: AbortSignal,
  deps: {
    exists?: (file: string) => Promise<boolean>;
    run?: typeof runProcess;
  } = {},
): Promise<'gnu' | 'musl'> {
  const loaders = [
    '/lib/ld-musl-x86_64.so.1',
    '/lib/ld-musl-aarch64.so.1',
    '/usr/glibc-compat/lib/ld-musl-x86_64.so.1',
    '/usr/glibc-compat/lib/ld-musl-aarch64.so.1',
  ];

  throwIfAborted(signal);
  for (const file of loaders) {
    const exists = await (deps.exists?.(file) ??
      access(file).then(
        () => true,
        () => false,
      ));
    throwIfAborted(signal);
    if (exists) return 'musl';
  }

  try {
    const result = await (deps.run ?? runProcess)(
      ['ldd', '--version'],
      { killGraceMs: 250, postCloseDrainMs: 250 },
      signal,
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

export function platformCandidates(
  platform: NodeJS.Platform,
  arch: string,
  libc: 'gnu' | 'musl' = 'gnu',
): PlatformCandidate[] {
  const cpu =
    arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
  if (!cpu) return [];
  if (platform === 'darwin')
    return [{ target: `${cpu}-apple-darwin`, extension: 'tar.gz' }];
  if (platform === 'win32')
    return [{ target: `${cpu}-pc-windows-msvc`, extension: 'zip' }];
  if (platform !== 'linux') return [];
  const alternate = libc === 'gnu' ? 'musl' : 'gnu';
  return [libc, alternate].map((variant) => ({
    target: `${cpu}-unknown-linux-${variant}`,
    extension: 'tar.gz' as const,
  }));
}

export async function getPlatformCandidatesAsync(
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  detectLibc = detectLinuxLibcAsync,
): Promise<PlatformCandidate[]> {
  const libc =
    platform === 'linux' && (arch === 'arm64' || arch === 'x64')
      ? await detectLibc(signal)
      : 'gnu';
  return platformCandidates(platform, arch, libc);
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

  if (!response.ok)
    throw new Error(
      `Failed to resolve latest ripgrep release: HTTP ${response.status} ${response.statusText}`,
    );

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
