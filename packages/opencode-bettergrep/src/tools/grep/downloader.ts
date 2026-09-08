import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { extractZip, getZipExtractionSupportError } from '../../utils';
import {
  crossSpawn,
  waitForProcessOutputWithAbortGrace,
} from '../../utils/compat';
import {
  createAbortError,
  hasExecutable,
  throwIfAborted,
  waitForExitAndStderr,
} from './install-probe';
import {
  acquireInstallLock,
  computeSha256Async,
  ensureExecutable,
  getInstalledPathWhileLocked,
  getInstalledRipgrepPathAsync,
  getRipgrepBinaryName,
  getRipgrepCacheDir,
  getRipgrepMetadataPath,
  type InstalledRipgrepMetadata,
  validateCachedBinaryAsync,
  validateInstalledBinaryAsync,
} from './rg-cache';
import {
  type ArchiveExtension,
  downloadArchive,
  fetchLatestRelease,
  selectReleaseAsset,
} from './rg-release';

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
