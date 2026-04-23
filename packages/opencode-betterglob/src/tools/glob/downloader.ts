import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sync as whichSync } from 'which';
import { extractZip, getZipExtractionSupportError } from '../../utils';
import { type CrossSpawnResult, crossSpawn } from '../../utils/compat';

interface RipgrepReleaseAsset {
  name?: string;
  browser_download_url?: string;
  digest?: string;
}

interface RipgrepReleaseResponse {
  tag_name?: string;
  assets?: RipgrepReleaseAsset[];
}

type ArchiveExtension = 'tar.gz' | 'zip';
const PROBE_TIMEOUT_MS = 5_000;

interface PlatformCandidate {
  target: string;
  extension: ArchiveExtension;
}

interface InstalledRipgrepMetadata {
  version: string;
  assetName: string;
  archiveSha256: string;
  binarySha256: string;
}

function createAbortError(): Error {
  const error = new Error('ripgrep auto-install was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

async function waitForExitAndStderr(
  proc: CrossSpawnResult,
  stderrPromise: Promise<string>,
): Promise<{ exitCode: number; stderr: string }> {
  const [exit, stderr] = await Promise.allSettled([proc.exited, stderrPromise]);

  return {
    exitCode: exit.status === 'fulfilled' ? exit.value : 1,
    stderr: stderr.status === 'fulfilled' ? stderr.value : '',
  };
}

function hasExecutable(name: string): boolean {
  try {
    const resolved = whichSync(name, { nothrow: true });
    return Array.isArray(resolved)
      ? (resolved[0] ?? '').length > 0
      : (resolved ?? '').length > 0;
  } catch {
    return false;
  }
}

function getCacheBaseDir(): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || process.env.APPDATA;
    return local || join(homedir(), 'AppData', 'Local');
  }

  return process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
}

export function getRipgrepCacheDir(): string {
  return join(getCacheBaseDir(), 'opencode-betterglob', 'glob', 'bin');
}

function getRipgrepMetadataPath(): string {
  return join(getRipgrepCacheDir(), '.ripgrep-metadata.json');
}

export function getRipgrepBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

export function getInstalledRipgrepPath(
  options: { repair?: boolean } = {},
): string | null {
  const binary = join(getRipgrepCacheDir(), getRipgrepBinaryName());
  if (!existsSync(binary)) return null;

  try {
    validateCachedBinary(binary);
    return binary;
  } catch {
    if (options.repair === false) return null;
    rmSync(binary, { force: true });
    rmSync(getRipgrepMetadataPath(), { force: true });
    return null;
  }
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

function computeSha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readInstalledMetadata(): InstalledRipgrepMetadata {
  return JSON.parse(
    readFileSync(getRipgrepMetadataPath(), 'utf8'),
  ) as InstalledRipgrepMetadata;
}

function validateCachedBinary(binary: string): void {
  const metadata = readInstalledMetadata();
  if (computeSha256(binary) !== metadata.binarySha256) {
    throw new Error('Cached ripgrep binary failed SHA-256 verification.');
  }

  validateInstalledBinary(binary);
}

function detectLinuxLibc(): 'gnu' | 'musl' {
  const loaders = [
    '/lib/ld-musl-x86_64.so.1',
    '/lib/ld-musl-aarch64.so.1',
    '/usr/glibc-compat/lib/ld-musl-x86_64.so.1',
    '/usr/glibc-compat/lib/ld-musl-aarch64.so.1',
  ];

  if (loaders.some((file) => existsSync(file))) return 'musl';

  try {
    const result = spawnSync('ldd', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    });
    if (result.error || result.status === null) return 'gnu';
    const output =
      `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`.toLowerCase();

    if (output.includes('musl')) return 'musl';
  } catch {
    // Fall back to gnu.
  }

  return 'gnu';
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

  if (process.platform === 'linux') {
    const libc = detectLinuxLibc();

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

function findBinaryRecursive(dir: string, binary: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const file = join(dir, entry.name);

      if (entry.isFile() && entry.name === binary) return file;

      if (entry.isDirectory()) {
        const nested = findBinaryRecursive(file, binary);
        if (nested) return nested;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function fetchLatestRelease(
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

function selectReleaseAsset(release: RipgrepReleaseResponse): {
  asset: RipgrepReleaseAsset;
  version: string;
  archiveSha256: string;
} {
  const version = release.tag_name?.replace(/^v/i, '');
  if (!version)
    throw new Error('Latest ripgrep release is missing a version tag.');

  for (const candidate of getPlatformCandidates()) {
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

async function downloadArchive(
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
  await writeFile(file, Buffer.from(buffer));
}

async function extractTarGz(
  archive: string,
  dir: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const proc = crossSpawn(['tar', '-xzf', archive, '-C', dir], {
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      // Process may have exited.
    }
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  const stderrPromise = proc.stderr();
  const { exitCode, stderr } = await waitForExitAndStderr(proc, stderrPromise);
  signal?.removeEventListener('abort', onAbort);

  if (signal?.aborted) throw createAbortError();
  if (exitCode !== 0) {
    throw new Error(`ripgrep extraction failed (exit ${exitCode}): ${stderr}`);
  }
}

async function extractArchive(
  archive: string,
  dir: string,
  extension: ArchiveExtension,
  signal?: AbortSignal,
): Promise<void> {
  if (extension === 'zip') {
    await extractZip(archive, dir, signal);
    return;
  }

  await extractTarGz(archive, dir, signal);
}

function ensureExecutable(binary: string): void {
  if (process.platform !== 'win32') chmodSync(binary, 0o755);
}

function validateInstalledBinary(binary: string, signal?: AbortSignal): void {
  throwIfAborted(signal);
  const result = spawnSync(binary, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PROBE_TIMEOUT_MS,
  });
  throwIfAborted(signal);

  if (result.error || result.status === null) {
    throw new Error(
      `Installed ripgrep binary failed validation: ${result.error?.message ?? 'validation timed out'}.`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `Installed ripgrep binary failed validation with exit ${String(result.status)}.`,
    );
  }

  const output =
    `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`.toLowerCase();
  if (!output.includes('ripgrep')) {
    throw new Error('Installed binary did not identify itself as ripgrep.');
  }
}

function ensureArchiveSupport(extension: ArchiveExtension): void {
  if (extension === 'zip') {
    const error = getZipExtractionSupportError();
    if (error) throw new Error(error);
    return;
  }

  if (!hasExecutable('tar')) {
    throw new Error(
      'ripgrep auto-install requires tar to extract .tar.gz archives.',
    );
  }
}

export async function installLatestStableRipgrep(
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const existing = getInstalledRipgrepPath();
  if (existing) return existing;

  const release = await fetchLatestRelease(signal);
  const { asset, version, archiveSha256 } = selectReleaseAsset(release);
  const extension = (
    asset.name?.endsWith('.zip') ? 'zip' : 'tar.gz'
  ) as ArchiveExtension;
  ensureArchiveSupport(extension);

  const dir = getRipgrepCacheDir();
  const binary = getRipgrepBinaryName();
  const final = join(dir, binary);
  const metadata = getRipgrepMetadataPath();
  const tmp = join(
    dir,
    `.install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const archive = join(tmp, asset.name ?? 'ripgrep-archive');
  const extract = join(tmp, 'extract');
  const staged = join(tmp, binary);

  mkdirSync(dir, { recursive: true });
  mkdirSync(extract, { recursive: true });

  try {
    await downloadArchive(
      asset.browser_download_url as string,
      archive,
      signal,
    );
    if (computeSha256(archive) !== archiveSha256) {
      throw new Error(
        'Downloaded ripgrep archive failed SHA-256 verification.',
      );
    }
    await extractArchive(archive, extract, extension, signal);
    throwIfAborted(signal);

    const extracted = findBinaryRecursive(extract, binary);
    if (!extracted)
      throw new Error('ripgrep binary was not found after extraction.');

    renameSync(extracted, staged);
    ensureExecutable(staged);
    validateInstalledBinary(staged, signal);
    const binarySha256 = computeSha256(staged);
    throwIfAborted(signal);

    if (!existsSync(final)) {
      renameSync(staged, final);
      await writeFile(
        metadata,
        JSON.stringify({
          version,
          assetName: asset.name ?? binary,
          archiveSha256,
          binarySha256,
        } satisfies InstalledRipgrepMetadata),
      );
    }

    const installed = getInstalledRipgrepPath();
    if (!installed)
      throw new Error('ripgrep binary was not installed successfully.');
    return installed;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(dirname(final), { recursive: true });
  }
}
