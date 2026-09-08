import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crossSpawn, isMissingExecutableError } from '../../utils/compat';
import { waitForProcessOutputWithAbortGrace } from '../../utils/process-output';
import { isSupervisorError } from '../../utils/process-supervisor';
import {
  computeSha256,
  computeSha256Async,
  InvalidCachedBinaryError,
  MAX_CACHE_METADATA_BYTES,
  readRegularFile,
  readRegularFileSync,
  throwIfAborted,
} from './install-io';

export interface InstalledRipgrepMetadata {
  version: string;
  assetName: string;
  archiveSha256: string;
  binarySha256: string;
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

export function getRipgrepMetadataPath(): string {
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

export async function validateCachedBinaryAsync(
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

export async function validateInstalledBinaryAsync(
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
