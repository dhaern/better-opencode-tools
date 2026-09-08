import { O_NONBLOCK, O_RDONLY } from 'node:constants';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { type FileHandle, open, rm } from 'node:fs/promises';
import { isMissingExecutableError } from '../../utils/compat';

export function createAbortError(): Error {
  const error = new Error('ripgrep auto-install was aborted');
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    throw createAbortError();
  }
}

export class InvalidCachedBinaryError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(detail, options);
    this.name = 'InvalidCachedBinaryError';
  }
}

export function computeSha256(file: string): string {
  return createHash('sha256').update(readRegularFileSync(file)).digest('hex');
}

export const MAX_CACHE_METADATA_BYTES = 64 * 1024;
export const MAX_CACHE_BINARY_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;

export const MAX_EXTRACTED_ENTRIES = 100_000;

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

export async function readRegularFile(
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

export async function computeSha256Async(
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

export async function writeMetadataFile(
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

export function readRegularFileSync(
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
