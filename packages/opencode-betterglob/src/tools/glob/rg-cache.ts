import { homedir } from 'node:os';
import { join } from 'node:path';
import { throwIfAborted } from '../../utils/abort';
import {
  isMissingExecutableError,
  runProcess,
} from '../../utils/process-output';
import { isSupervisorError } from '../../utils/process-supervisor';
import { validatedStamps } from '../../utils/stamped-probe';
import {
  computeSha256Async,
  fileStamp,
  InvalidCachedBinaryError,
  MAX_CACHE_METADATA_BYTES,
  readRegularFile,
} from './install-io';

export interface InstalledRipgrepMetadata {
  version: string;
  assetName: string;
  archiveSha256: string;
  binarySha256: string;
}

const cacheStamp = async (binary: string, metadata: string) => {
  const stamps = await Promise.all([fileStamp(binary), fileStamp(metadata)]);
  return stamps[0] && stamps[1]
    ? `${binary}:${stamps[0]}:${metadata}:${stamps[1]}`
    : undefined;
};

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

export async function validateCachedBinaryAsync(
  binary: string,
  signal?: AbortSignal,
  metadataPath = getRipgrepMetadataPath(),
): Promise<void> {
  throwIfAborted(signal);
  const stamp = await cacheStamp(binary, metadataPath);
  throwIfAborted(signal);
  if (stamp && validatedStamps.has(`managed:${stamp}`)) return;
  const metadata = await readInstalledMetadataAsync(signal, metadataPath);
  if ((await computeSha256Async(binary, signal)) !== metadata.binarySha256) {
    throw new InvalidCachedBinaryError(
      'Cached ripgrep binary failed SHA-256 verification.',
    );
  }

  await validateInstalledBinaryAsync(binary, signal);
  if (stamp) validatedStamps.add(`managed:${stamp}`);
}

export async function probeRipgrepVersion(
  binary: string,
  signal?: AbortSignal,
): Promise<{ valid: boolean; exitCode: number; aborted: boolean }> {
  const result = await runProcess(
    [binary, '--version'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      killGraceMs: 250,
      postCloseDrainMs: 250,
    },
    signal,
  );
  return {
    valid:
      result.exitCode === 0 &&
      `${result.stdout}\n${result.stderr}`.toLowerCase().includes('ripgrep'),
    exitCode: result.exitCode,
    aborted: result.aborted,
  };
}

export async function validateInstalledBinaryAsync(
  binary: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let result: Awaited<ReturnType<typeof probeRipgrepVersion>>;
  try {
    result = await probeRipgrepVersion(binary, signal);
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

  if (!result.valid) {
    throw new InvalidCachedBinaryError(
      'Installed binary did not identify itself as ripgrep.',
    );
  }
}
