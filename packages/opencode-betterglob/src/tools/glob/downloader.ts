import { O_NONBLOCK, O_RDONLY } from 'node:constants';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  access,
  chmod,
  type FileHandle,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { extractZip, getZipExtractionSupportErrorAsync } from '../../utils';
import {
  crossSpawn,
  isMissingExecutableError,
  waitForProcessOutputWithAbortGrace,
} from '../../utils/compat';
import { isSupervisorError } from '../../utils/process-supervisor';
import { commandSucceeds } from '../../utils/zip-extractor';

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
    if (signal.reason instanceof Error) throw signal.reason;
    throw createAbortError();
  }
}

class InvalidCachedBinaryError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(detail, options);
    this.name = 'InvalidCachedBinaryError';
  }
}

function isInstalledRipgrepMetadata(
  value: unknown,
): value is InstalledRipgrepMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const metadata = value as Record<string, unknown>;
  return (
    typeof metadata.version === 'string' &&
    metadata.version.length > 0 &&
    typeof metadata.assetName === 'string' &&
    metadata.assetName.length > 0 &&
    typeof metadata.archiveSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(metadata.archiveSha256) &&
    typeof metadata.binarySha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(metadata.binarySha256)
  );
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
  _options: { repair?: boolean } = {},
): string | null {
  const binary = join(getRipgrepCacheDir(), getRipgrepBinaryName());
  if (!existsSync(binary)) return null;

  try {
    validateCachedBinary(binary);
    return binary;
  } catch {
    // Non-destructive by default: a mid-publication cache (binary renamed,
    // metadata not yet visible) must not trigger deletion by readers. Only
    // the async publisher, held under the install lock, may purge. The
    // synchronous compatibility option is retained as a safe no-op because
    // it cannot acquire that lock without blocking.
    return null;
  }
}

export async function getInstalledRipgrepPathAsync(
  signal?: AbortSignal,
): Promise<string | null> {
  throwIfAborted(signal);
  const binary = join(getRipgrepCacheDir(), getRipgrepBinaryName());

  try {
    await validateCachedBinaryAsync(binary, signal);
    return binary;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof InvalidCachedBinaryError) return null;
    throw error;
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
  return createHash('sha256').update(readRegularFileSync(file)).digest('hex');
}

// Cross-process publication lock built on proper-lockfile: atomic acquisition
// with an mtime heartbeat (stale detection) and compromise reporting. Held
// only for the short publish phase (never during download). Acquisition is
// raced against the caller's AbortSignal; a lock acquired after the signal
// fired is released immediately instead of being used.
const LOCK_STALE_MS = 60_000;
const MAX_CACHE_METADATA_BYTES = 64 * 1024;
const MAX_CACHE_BINARY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;

async function withInstallLock<T>(
  dir: string,
  fn: (signal: AbortSignal, canonicalDir: string) => Promise<T>,
  signal?: AbortSignal,
  acquireLock: typeof lock = lock,
): Promise<T> {
  throwIfAborted(signal);
  await mkdir(dir, { recursive: true });
  throwIfAborted(signal);

  // Lock and publish through the same canonical directory identity. A
  // lexical alias may otherwise create a different `.lock` path for the
  // same physical cache.
  const canonicalDir = await realpath(dir);
  throwIfAborted(signal);
  const compromised = new AbortController();
  const operationSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    compromised.signal,
  ]);

  const acquired = acquireLock(canonicalDir, {
    stale: LOCK_STALE_MS,
    update: Math.floor(LOCK_STALE_MS / 2),
    retries: { retries: 60, factor: 1, minTimeout: 100, maxTimeout: 250 },
    realpath: true,
    onCompromised: (error) => {
      if (!compromised.signal.aborted) compromised.abort(error);
    },
  });

  let release: () => Promise<void>;
  let removeAbortListener: () => void = () => undefined;
  try {
    const abort = new Promise<never>((_, reject) => {
      if (operationSignal.aborted) reject(operationSignal.reason);
      else {
        const onAbort = () => reject(operationSignal.reason);
        operationSignal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () =>
          operationSignal.removeEventListener('abort', onAbort);
      }
    });
    release = await Promise.race([acquired, abort]);
  } catch (error) {
    // The acquisition may still complete after the race was lost; release
    // it so the lock is not held by a dead waiter.
    acquired.then(
      (rel: () => Promise<void>) => {
        rel().catch(() => undefined);
      },
      () => undefined,
    );
    throw error;
  } finally {
    removeAbortListener();
  }

  try {
    throwIfAborted(operationSignal);
    const result = await fn(operationSignal, canonicalDir);
    throwIfAborted(operationSignal);
    return result;
  } finally {
    await release().catch(() => undefined);
  }
}

async function withRegularFile<T>(
  file: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
  callback: (handle: FileHandle, size: number) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const flags = process.platform === 'win32' ? O_RDONLY : O_RDONLY | O_NONBLOCK;
  let handle: FileHandle;
  try {
    handle = await open(file, flags);
  } catch (error) {
    if (isMissingExecutableError(error)) {
      throw new InvalidCachedBinaryError(`Cached file is missing: ${file}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    throwIfAborted(signal);
    const initial = await handle.stat();
    if (!initial.isFile()) {
      throw new InvalidCachedBinaryError(
        `Cached file is not a regular file: ${file}`,
      );
    }
    if (
      !Number.isSafeInteger(initial.size) ||
      initial.size < 0 ||
      initial.size > maxBytes
    ) {
      throw new InvalidCachedBinaryError(
        `Cached file exceeds its size limit: ${file}`,
      );
    }

    const result = await callback(handle, initial.size);
    throwIfAborted(signal);
    const final = await handle.stat();
    if (final.size !== initial.size) {
      throw new InvalidCachedBinaryError(
        `Cached file changed while it was being read: ${file}`,
      );
    }
    return result;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof InvalidCachedBinaryError) throw error;
    if (isMissingExecutableError(error)) {
      throw new InvalidCachedBinaryError(`Cached file disappeared: ${file}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readRegularFile(
  file: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  return withRegularFile(file, maxBytes, signal, async (handle, size) => {
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < size) {
      throwIfAborted(signal);
      const length = Math.min(HASH_CHUNK_BYTES, size - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) {
        throw new InvalidCachedBinaryError(
          `Cached file ended before its declared size: ${file}`,
        );
      }
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return Buffer.concat(chunks, size);
  });
}

async function computeSha256Async(
  file: string,
  signal?: AbortSignal,
  maxBytes = MAX_CACHE_BINARY_BYTES,
): Promise<string> {
  return withRegularFile(file, maxBytes, signal, async (handle, size) => {
    const hash = createHash('sha256');
    let position = 0;
    while (position < size) {
      throwIfAborted(signal);
      const length = Math.min(HASH_CHUNK_BYTES, size - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) {
        throw new InvalidCachedBinaryError(
          `Cached file ended before its declared size: ${file}`,
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  });
}

async function writeMetadataFile(
  file: string,
  contents: string,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const handle = await open(file, 'wx', 0o600);
  let written = false;
  try {
    throwIfAborted(signal);
    await handle.writeFile(contents, { signal });
    throwIfAborted(signal);
    written = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!written) await rm(file, { force: true }).catch(() => undefined);
  }
}

function readRegularFileSync(
  file: string,
  maxBytes = MAX_CACHE_BINARY_BYTES,
): Buffer {
  const flags = process.platform === 'win32' ? O_RDONLY : O_RDONLY | O_NONBLOCK;
  const fd = openSync(file, flags);
  try {
    const initial = fstatSync(fd);
    if (!initial.isFile()) {
      throw new Error(`Cached file is not a regular file: ${file}`);
    }
    if (
      !Number.isSafeInteger(initial.size) ||
      initial.size < 0 ||
      initial.size > maxBytes
    ) {
      throw new Error(`Cached file exceeds its size limit: ${file}`);
    }

    const chunks: Buffer[] = [];
    let position = 0;
    while (position < initial.size) {
      const length = Math.min(HASH_CHUNK_BYTES, initial.size - position);
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, buffer, 0, length, position);
      if (bytesRead === 0) {
        throw new Error(`Cached file ended before its declared size: ${file}`);
      }
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const final = fstatSync(fd);
    if (final.size !== initial.size) {
      throw new Error(`Cached file changed while it was being read: ${file}`);
    }
    return Buffer.concat(chunks, initial.size);
  } finally {
    closeSync(fd);
  }
}

function readInstalledMetadata(): InstalledRipgrepMetadata {
  const parsed: unknown = JSON.parse(
    readRegularFileSync(
      getRipgrepMetadataPath(),
      MAX_CACHE_METADATA_BYTES,
    ).toString('utf8'),
  );
  if (!isInstalledRipgrepMetadata(parsed)) {
    throw new InvalidCachedBinaryError(
      'Cached ripgrep metadata has an invalid structure.',
    );
  }
  return parsed;
}

async function readInstalledMetadataAsync(
  signal?: AbortSignal,
  metadata = getRipgrepMetadataPath(),
): Promise<InstalledRipgrepMetadata> {
  const data = await readRegularFile(
    metadata,
    MAX_CACHE_METADATA_BYTES,
    signal,
  );
  try {
    const parsed: unknown = JSON.parse(data.toString('utf8'));
    if (!isInstalledRipgrepMetadata(parsed)) {
      throw new InvalidCachedBinaryError(
        `Cached ripgrep metadata has an invalid structure: ${metadata}`,
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new InvalidCachedBinaryError(
        `Cached metadata is not valid JSON: ${metadata}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function validateCachedBinary(binary: string): void {
  const metadata = readInstalledMetadata();
  if (computeSha256(binary) !== metadata.binarySha256) {
    throw new Error('Cached ripgrep binary failed SHA-256 verification.');
  }

  // The synchronous compatibility probe verifies cache integrity only. The
  // execution path uses getInstalledRipgrepPathAsync(), which also validates
  // that the executable identifies itself as ripgrep without blocking the
  // event loop.
}

async function validateCachedBinaryAsync(
  binary: string,
  signal?: AbortSignal,
  metadataPath = getRipgrepMetadataPath(),
): Promise<void> {
  throwIfAborted(signal);
  const metadata = await readInstalledMetadataAsync(signal, metadataPath);
  if ((await computeSha256Async(binary, signal)) !== metadata.binarySha256) {
    throw new InvalidCachedBinaryError(
      'Cached ripgrep binary failed SHA-256 verification.',
    );
  }

  await validateInstalledBinaryAsync(binary, signal);
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

const MAX_EXTRACTED_ENTRIES = 100_000;

async function findBinaryRecursive(
  dir: string,
  binary: string,
  signal?: AbortSignal,
  state: { entries: number } = { entries: 0 },
): Promise<string | null> {
  throwIfAborted(signal);
  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      throwIfAborted(signal);
      state.entries += 1;
      if (state.entries > MAX_EXTRACTED_ENTRIES) {
        throw new Error('ripgrep archive contains too many extracted entries.');
      }
      const file = join(dir, entry.name);

      if (entry.isFile() && entry.name === binary) return file;

      if (entry.isDirectory()) {
        const nested = await findBinaryRecursive(file, binary, signal, state);
        if (nested) return nested;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (error instanceof Error && error.message.includes('too many')) {
      throw error;
    }
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

async function selectReleaseAssetAsync(
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
  await writeFile(file, Buffer.from(buffer), { signal });
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
    detached: process.platform !== 'win32',
    killProcessGroup: process.platform !== 'win32',
  });

  const stderrPromise = proc.stderr();
  const { exitCode, stderr } = await waitForProcessOutputWithAbortGrace(
    proc,
    stderrPromise,
    signal,
  );

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

async function ensureExecutable(binary: string): Promise<void> {
  if (process.platform !== 'win32') await chmod(binary, 0o755);
}

async function validateInstalledBinaryAsync(
  binary: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const proc = crossSpawn([binary, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
    detached: process.platform !== 'win32',
    killProcessGroup: process.platform !== 'win32',
  });
  const stdoutPromise = proc.stdout();
  const stderrPromise = proc.stderr();
  let result: Awaited<ReturnType<typeof waitForProcessOutputWithAbortGrace>>;
  try {
    result = await waitForProcessOutputWithAbortGrace(
      proc,
      stderrPromise,
      signal,
      stdoutPromise,
      { killGraceMs: 250, postCloseDrainMs: 250 },
    );
  } catch (error) {
    throwIfAborted(signal);
    if (isSupervisorError(error)) throw error;
    if (isMissingExecutableError(error)) {
      throw new InvalidCachedBinaryError(
        `Cached executable is missing: ${binary}`,
        { cause: error },
      );
    }
    throw error;
  }
  throwIfAborted(signal);

  if (result.aborted || result.exitCode !== 0) {
    throw new InvalidCachedBinaryError(
      `Installed ripgrep binary failed validation with exit ${String(result.exitCode)}.`,
    );
  }

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (!output.includes('ripgrep')) {
    throw new InvalidCachedBinaryError(
      'Installed binary did not identify itself as ripgrep.',
    );
  }
}

async function ensureArchiveSupport(
  extension: ArchiveExtension,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (extension === 'zip') {
    const error = await getZipExtractionSupportErrorAsync(signal);
    if (error) throw new Error(error);
    return;
  }

  if (!(await commandSucceeds('tar', ['--version'], signal))) {
    throw new Error(
      'ripgrep auto-install requires tar to extract .tar.gz archives.',
    );
  }
}

export interface PublishStagedBinaryInput {
  dir: string;
  final: string;
  metadata: string;
  staged: string;
  version: string;
  assetName: string;
  archiveSha256: string;
  binarySha256: string;
  /** Test seam for exercising cancellation during the metadata write. */
  writeMetadata?: (file: string, contents: string) => Promise<void>;
  /** Test seam for deterministic lock compromise reporting. */
  acquireLock?: typeof lock;
}

/**
 * Publishes a staged binary under the cross-process install lock. An
 * existing INVALID cache is repaired here — under the lock — instead of
 * being left behind to block publication. Exported for deterministic
 * concurrency/abort testing without network access.
 */
export async function publishStagedBinary(
  input: PublishStagedBinaryInput,
  signal?: AbortSignal,
): Promise<void> {
  const { dir } = input;

  await withInstallLock(
    dir,
    async (lockSignal, canonicalDir) => {
      const final = join(canonicalDir, basename(input.final));
      const metadata = join(canonicalDir, basename(input.metadata));
      const stagedDir = await realpath(dirname(input.staged));
      const staged = join(stagedDir, basename(input.staged));
      throwIfAborted(lockSignal);
      // Only the lock holder recovers abandoned attempts, including the old
      // fixed-name temporary. New attempts never reuse a predecessor's path.
      const temporaryPrefix = `${basename(metadata)}.tmp`;
      const staleBefore = Date.now() - LOCK_STALE_MS;
      for (const entry of await readdir(canonicalDir)) {
        throwIfAborted(lockSignal);
        if (
          entry === temporaryPrefix ||
          (entry.startsWith(`${temporaryPrefix}-`) &&
            /^[0-9a-f-]{36}$/.test(entry.slice(temporaryPrefix.length + 1)))
        ) {
          const orphan = join(canonicalDir, entry);
          try {
            const details = await stat(orphan);
            if (details.mtimeMs <= staleBefore) {
              await rm(orphan, { force: true });
            }
          } catch {
            // A concurrent cleanup may have removed it already.
          }
        }
      }
      throwIfAborted(lockSignal);
      const existingValid = await (async () => {
        try {
          await validateCachedBinaryAsync(final, lockSignal, metadata);
          return true;
        } catch (error) {
          throwIfAborted(lockSignal);
          if (error instanceof InvalidCachedBinaryError) return false;
          throw error;
        }
      })();
      throwIfAborted(lockSignal);

      if (!existingValid) {
        const temporary = `${metadata}.tmp-${randomUUID()}`;
        // Remove the invalid remnants first so a crash between the two
        // renames leaves no binary-without-metadata combination.
        try {
          await rm(final, { force: true });
          throwIfAborted(lockSignal);
          await rm(metadata, { force: true });
          throwIfAborted(lockSignal);
          // Metadata first, binary second: a reader that sees the binary can
          // always find matching metadata; readers are non-destructive, so
          // intermediate states just read as "not installed".
          const writeMetadata =
            input.writeMetadata ??
            ((file, contents) => writeMetadataFile(file, contents, lockSignal));
          await writeMetadata(
            temporary,
            JSON.stringify({
              version: input.version,
              assetName: input.assetName,
              archiveSha256: input.archiveSha256,
              binarySha256: input.binarySha256,
            } satisfies InstalledRipgrepMetadata),
          );
          // The abort race lands exactly here: a signal fired while the
          // metadata write was pending must stop publication before the
          // first rename makes anything visible.
          throwIfAborted(lockSignal);
          await rename(temporary, metadata);
          throwIfAborted(lockSignal);
          await rename(staged, final);
          throwIfAborted(lockSignal);
        } finally {
          // Never clean shared paths here: after compromise they may belong
          // to a successor. Partial publication is repaired under its lock.
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      }
    },
    signal,
    input.acquireLock,
  );
}

export async function installLatestStableRipgrep(
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const existing = await getInstalledRipgrepPathAsync(signal);
  if (existing) return existing;

  const release = await fetchLatestRelease(signal);
  const { asset, version, archiveSha256 } = await selectReleaseAssetAsync(
    release,
    signal,
  );
  const extension = (
    asset.name?.endsWith('.zip') ? 'zip' : 'tar.gz'
  ) as ArchiveExtension;
  await ensureArchiveSupport(extension, signal);

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

  await mkdir(dir, { recursive: true });
  await mkdir(extract, { recursive: true });

  try {
    await downloadArchive(
      asset.browser_download_url as string,
      archive,
      signal,
    );
    if (
      (await computeSha256Async(archive, signal, MAX_ARCHIVE_BYTES)) !==
      archiveSha256
    ) {
      throw new Error(
        'Downloaded ripgrep archive failed SHA-256 verification.',
      );
    }
    await extractArchive(archive, extract, extension, signal);
    throwIfAborted(signal);

    const extracted = await findBinaryRecursive(extract, binary, signal);
    if (!extracted)
      throw new Error('ripgrep binary was not found after extraction.');

    await rename(extracted, staged);
    throwIfAborted(signal);
    await ensureExecutable(staged);
    await validateInstalledBinaryAsync(staged, signal);
    const binarySha256 = await computeSha256Async(staged, signal);
    throwIfAborted(signal);

    await publishStagedBinary(
      {
        dir,
        final,
        metadata,
        staged,
        version,
        assetName: asset.name ?? binary,
        archiveSha256,
        binarySha256,
      },
      signal,
    );

    const installed = await getInstalledRipgrepPathAsync(signal);
    if (!installed)
      throw new Error('ripgrep binary was not installed successfully.');
    return installed;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
