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
  statSync,
} from 'node:fs';
import { readFile as readFileAsync, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sync as whichSync } from 'which';
import { extractZip, getZipExtractionSupportError } from '../../utils';
import {
  type CrossSpawnResult,
  crossSpawn,
  TERMINATE_HARD_WAIT_MS,
  terminateProcess,
  waitForProcessOutputWithAbortGrace,
  withTimeout,
} from '../../utils/compat';
import { readTextStream } from './json-stream';

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
const INSTALL_LOCK_WAIT_MS = 50;
const INSTALL_LOCK_TIMEOUT_MS = 30_000;
const INSTALL_LOCK_STALE_MS = 10 * 60_000;
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
  if (signal?.aborted) {
    throw createAbortError();
  }
}

async function waitForExitAndStderr(
  proc: CrossSpawnResult,
  stderrPromise: Promise<string>,
): Promise<{ exitCode: number; stderr: string }> {
  const [exitResult, stderrResult] = await Promise.allSettled([
    proc.exited,
    stderrPromise,
  ]);

  return {
    exitCode: exitResult.status === 'fulfilled' ? exitResult.value : 1,
    stderr: stderrResult.status === 'fulfilled' ? stderrResult.value : '',
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
    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
    return localAppData || join(homedir(), 'AppData', 'Local');
  }

  return process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
}

export function getRipgrepCacheDir(): string {
  return join(getCacheBaseDir(), 'opencode-bettergrep', 'grep', 'bin');
}

function getRipgrepMetadataPath(): string {
  return join(getRipgrepCacheDir(), '.ripgrep-metadata.json');
}

function getRipgrepInstallLockPath(): string {
  return join(getRipgrepCacheDir(), '.ripgrep-install.lock');
}

export function getRipgrepBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

export function getInstalledRipgrepPath(): string | null {
  if (existsSync(getRipgrepInstallLockPath())) {
    return null;
  }

  const binaryPath = join(getRipgrepCacheDir(), getRipgrepBinaryName());
  if (!existsSync(binaryPath)) {
    return null;
  }

  // Readers are non-destructive: cache cleanup only happens under the
  // install lock so a concurrent publisher cannot have its valid install
  // deleted between this check and a later deletion.
  try {
    validateCachedBinary(binaryPath);
    return binaryPath;
  } catch {
    return null;
  }
}

async function probeCommand(
  command: string[],
  signal?: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  throwIfAborted(signal);
  let proc: CrossSpawnResult;
  try {
    proc = crossSpawn(command, { stdout: 'pipe', stderr: 'pipe' });
  } catch {
    return { exitCode: 1, stdout: '', stderr: '' };
  }

  const stdoutPromise = readTextStream(proc.proc.stdout, 1_000_000);
  const stderrPromise = readTextStream(proc.proc.stderr, 1_000_000);
  const exitPromise = proc.exited.then(
    (exitCode) => ({ kind: 'exit' as const, exitCode }),
    () => ({ kind: 'exit' as const, exitCode: 1 }),
  );
  let resolveStop: (() => void) | undefined;
  const stopPromise = new Promise<{ kind: 'stop' }>((resolve) => {
    resolveStop = () => resolve({ kind: 'stop' });
  });
  const onAbort = () => {
    resolveStop?.();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutId = setTimeout(
    () => {
      resolveStop?.();
    },
    Math.max(1, timeoutMs),
  );
  timeoutId.unref?.();

  let outcome: { kind: 'exit'; exitCode: number } | { kind: 'stop' };
  try {
    outcome = await Promise.race([exitPromise, stopPromise]);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }

  if (outcome.kind === 'stop') {
    // Escalate SIGTERM -> SIGKILL so probes never hang on stubborn children.
    await terminateProcess(proc);
  }

  // Bound the post-stop drain: descendants inheriting the pipes can keep
  // stdout/stderr open after the direct child is gone. When the drain
  // deadline passes, force-destroy the pipes; readers keep whatever was
  // already collected instead of waiting for the descendants.
  const drain = Promise.all([
    stdoutPromise.catch(() => ''),
    stderrPromise.catch(() => ''),
  ]) as Promise<[string, string]>;
  if ((await withTimeout(drain, TERMINATE_HARD_WAIT_MS)) === 'timeout') {
    proc.proc.stdout?.destroy();
    proc.proc.stderr?.destroy();
  }
  const [stdout, stderr] = await drain;

  throwIfAborted(signal);
  return {
    exitCode: outcome.kind === 'exit' ? outcome.exitCode : 1,
    stdout,
    stderr,
  };
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

function computeSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function computeSha256Async(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const bytes = await readFileAsync(filePath);
  throwIfAborted(signal);
  return createHash('sha256').update(bytes).digest('hex');
}

function readInstalledMetadata(): InstalledRipgrepMetadata {
  return JSON.parse(
    readFileSync(getRipgrepMetadataPath(), 'utf8'),
  ) as InstalledRipgrepMetadata;
}

async function readInstalledMetadataAsync(
  signal?: AbortSignal,
): Promise<InstalledRipgrepMetadata> {
  throwIfAborted(signal);
  return JSON.parse(
    await readFileAsync(getRipgrepMetadataPath(), 'utf8'),
  ) as InstalledRipgrepMetadata;
}

function validateCachedBinary(binaryPath: string): void {
  const metadata = readInstalledMetadata();
  const binarySha256 = computeSha256(binaryPath);

  if (binarySha256 !== metadata.binarySha256) {
    throw new Error('Cached ripgrep binary failed SHA-256 verification.');
  }

  validateInstalledBinary(binaryPath);
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

function findBinaryRecursive(
  directory: string,
  binaryName: string,
): string | null {
  try {
    const entries = readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);

      if (entry.isFile() && entry.name === binaryName) {
        return entryPath;
      }

      if (entry.isDirectory()) {
        const nested = findBinaryRecursive(entryPath, binaryName);
        if (nested) {
          return nested;
        }
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

async function selectReleaseAsset(
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

async function downloadArchive(
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

async function extractTarGz(
  archivePath: string,
  destinationDir: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const proc = crossSpawn(['tar', '-xzf', archivePath, '-C', destinationDir], {
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const stderrPromise = proc.stderr();
  // Abort-gated cleanup grace: healthy-but-slow extractions have NO implicit
  // duration cap; termination + bounded pipe drain only run after a real
  // abort, so descendants inheriting the pipes cannot hang the wait either.
  const output = await waitForProcessOutputWithAbortGrace(
    proc,
    waitForExitAndStderr(proc, stderrPromise),
    signal,
  );
  if (output === 'aborted') {
    throw createAbortError();
  }
  const { exitCode, stderr } = output;

  if (signal?.aborted) {
    throw createAbortError();
  }

  if (exitCode !== 0) {
    throw new Error(`ripgrep extraction failed (exit ${exitCode}): ${stderr}`);
  }
}

async function extractArchive(
  archivePath: string,
  destinationDir: string,
  extension: ArchiveExtension,
  signal?: AbortSignal,
): Promise<void> {
  if (extension === 'zip') {
    await extractZip(archivePath, destinationDir, signal);
    return;
  }

  await extractTarGz(archivePath, destinationDir, signal);
}

function ensureExecutable(binaryPath: string): void {
  if (process.platform !== 'win32') {
    chmodSync(binaryPath, 0o755);
  }
}

function validateInstalledBinary(
  binaryPath: string,
  signal?: AbortSignal,
): void {
  throwIfAborted(signal);
  const result = spawnSync(binaryPath, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  throwIfAborted(signal);

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

async function validateInstalledBinaryAsync(
  binaryPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await probeCommand([binaryPath, '--version'], signal);
  if (result.exitCode !== 0) {
    throw new Error(
      `Installed ripgrep binary failed validation with exit ${String(result.exitCode)}.`,
    );
  }

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (!output.includes('ripgrep')) {
    throw new Error('Installed binary did not identify itself as ripgrep.');
  }
}

async function validateCachedBinaryAsync(
  binaryPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const metadata = await readInstalledMetadataAsync(signal);
  const binarySha256 = await computeSha256Async(binaryPath, signal);

  if (binarySha256 !== metadata.binarySha256) {
    throw new Error('Cached ripgrep binary failed SHA-256 verification.');
  }

  await validateInstalledBinaryAsync(binaryPath, signal);
}

export async function getInstalledRipgrepPathAsync(
  signal?: AbortSignal,
): Promise<string | null> {
  throwIfAborted(signal);
  if (existsSync(getRipgrepInstallLockPath())) {
    return null;
  }

  const binaryPath = join(getRipgrepCacheDir(), getRipgrepBinaryName());
  if (!existsSync(binaryPath)) {
    return null;
  }

  try {
    await validateCachedBinaryAsync(binaryPath, signal);
    return binaryPath;
  } catch (error) {
    if (signal?.aborted) throw error;
    // Non-destructive: deletion only happens under the install lock so a
    // concurrent publisher cannot lose a valid install to this reader.
    return null;
  }
}

async function acquireInstallLock(signal?: AbortSignal): Promise<() => void> {
  const cacheDir = getRipgrepCacheDir();
  const lockPath = getRipgrepInstallLockPath();
  mkdirSync(cacheDir, { recursive: true });
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;

  while (true) {
    throwIfAborted(signal);
    try {
      mkdirSync(lockPath);
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      const code =
        typeof error === 'object' && error && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
      if (code !== 'EEXIST') throw error;

      try {
        if (Date.now() - statSync(lockPath).mtimeMs > INSTALL_LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for ripgrep installation lock.');
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, INSTALL_LOCK_WAIT_MS);
      });
    }
  }
}

async function getInstalledPathWhileLocked(
  binaryPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!existsSync(binaryPath)) return null;

  try {
    await validateCachedBinaryAsync(binaryPath, signal);
    return binaryPath;
  } catch (error) {
    if (signal?.aborted) throw error;
    rmSync(binaryPath, { force: true });
    rmSync(getRipgrepMetadataPath(), { force: true });
    return null;
  }
}

function ensureArchiveSupport(extension: ArchiveExtension): void {
  if (extension === 'zip') {
    const zipError = getZipExtractionSupportError();
    if (zipError) {
      throw new Error(zipError);
    }
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
  const existing = await getInstalledRipgrepPathAsync(signal);
  if (existing) {
    return existing;
  }

  const release = await fetchLatestRelease(signal);
  const { asset, version, archiveSha256 } = await selectReleaseAsset(
    release,
    signal,
  );
  const extension = (
    asset.name?.endsWith('.zip') ? 'zip' : 'tar.gz'
  ) as ArchiveExtension;
  ensureArchiveSupport(extension);
  const cacheDir = getRipgrepCacheDir();
  const binaryName = getRipgrepBinaryName();
  const finalPath = join(cacheDir, binaryName);
  const metadataPath = getRipgrepMetadataPath();
  const tmpRoot = join(
    cacheDir,
    `.install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const archivePath = join(tmpRoot, asset.name ?? 'ripgrep-archive');
  const extractDir = join(tmpRoot, 'extract');
  const stagedBinaryPath = join(tmpRoot, binaryName);

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });

  try {
    await downloadArchive(
      asset.browser_download_url as string,
      archivePath,
      signal,
    );
    if ((await computeSha256Async(archivePath, signal)) !== archiveSha256) {
      throw new Error(
        'Downloaded ripgrep archive failed SHA-256 verification.',
      );
    }
    await extractArchive(archivePath, extractDir, extension, signal);
    throwIfAborted(signal);

    const extractedBinaryPath = findBinaryRecursive(extractDir, binaryName);
    if (!extractedBinaryPath) {
      throw new Error('ripgrep binary was not found after extraction.');
    }

    renameSync(extractedBinaryPath, stagedBinaryPath);
    ensureExecutable(stagedBinaryPath);
    await validateInstalledBinaryAsync(stagedBinaryPath, signal);
    const binarySha256 = await computeSha256Async(stagedBinaryPath, signal);
    throwIfAborted(signal);

    const releaseLock = await acquireInstallLock(signal);
    try {
      const installedBeforePublish = await getInstalledPathWhileLocked(
        finalPath,
        signal,
      );
      if (installedBeforePublish) {
        return installedBeforePublish;
      }

      renameSync(stagedBinaryPath, finalPath);
      const metadataTempPath = `${metadataPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await writeFile(
          metadataTempPath,
          JSON.stringify({
            version,
            assetName: asset.name ?? binaryName,
            archiveSha256,
            binarySha256,
          } satisfies InstalledRipgrepMetadata),
        );
        rmSync(metadataPath, { force: true });
        renameSync(metadataTempPath, metadataPath);
      } finally {
        rmSync(metadataTempPath, { force: true });
      }

      await validateCachedBinaryAsync(finalPath, signal);
      return finalPath;
    } finally {
      releaseLock();
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(dirname(finalPath), { recursive: true });
  }
}
