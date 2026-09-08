import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { probeCommand, throwIfAborted } from './install-probe';

const INSTALL_LOCK_WAIT_MS = 50;

const INSTALL_LOCK_TIMEOUT_MS = 30_000;

const INSTALL_LOCK_STALE_MS = 10 * 60_000;

export interface InstalledRipgrepMetadata {
  version: string;
  assetName: string;
  archiveSha256: string;
  binarySha256: string;
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

export function getRipgrepMetadataPath(): string {
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

function computeSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export async function computeSha256Async(
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

export function ensureExecutable(binaryPath: string): void {
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

export async function validateInstalledBinaryAsync(
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

export async function validateCachedBinaryAsync(
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

export async function acquireInstallLock(
  signal?: AbortSignal,
): Promise<() => void> {
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

export async function getInstalledPathWhileLocked(
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
