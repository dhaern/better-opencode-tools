import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createAbortError, throwIfAborted } from '../../utils/abort';
import { runProcess } from '../../utils/process-output';
import {
  commandSucceeds,
  extractZip,
  getZipExtractionSupportErrorAsync,
} from '../../utils/zip-extractor';
import {
  computeSha256Async,
  InvalidCachedBinaryError,
  MAX_ARCHIVE_BYTES,
  MAX_EXTRACTED_ENTRIES,
} from './install-io';
import {
  getInstalledRipgrepPathAsync,
  getRipgrepBinaryName,
  getRipgrepCacheDir,
  getRipgrepMetadataPath,
  validateInstalledBinaryAsync,
} from './rg-cache';
import { publishStagedBinary } from './rg-publication';
import {
  type ArchiveExtension,
  fetchLatestRelease,
  selectReleaseAssetAsync,
} from './rg-release';

export async function downloadArchive(
  url: string,
  file: string,
  signal?: AbortSignal,
  maxBytes = MAX_ARCHIVE_BYTES,
): Promise<void> {
  const response = await fetch(url, { redirect: 'follow', signal });
  if (!response.ok)
    throw new Error(
      `Failed to download ripgrep archive: HTTP ${response.status} ${response.statusText}`,
    );

  let received = 0;
  try {
    const source = response.body
      ? Readable.fromWeb(
          response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
        )
      : Readable.from([]);
    await pipeline(
      source,
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          if (received > maxBytes)
            done(
              new InvalidCachedBinaryError(
                `Cached file exceeds its size limit: ${file}`,
              ),
            );
          else done(null, chunk);
        },
      }),
      createWriteStream(file),
      { signal },
    );
  } catch (error) {
    await rm(file, { force: true });
    throwIfAborted(signal);
    throw error;
  }
}

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

export async function extractTarGz(
  archive: string,
  dir: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const { exitCode, stderr } = await runProcess(
    ['tar', '-xzf', archive, '-C', dir],
    {
      stdout: 'ignore',
      stderr: 'pipe',
    },
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
