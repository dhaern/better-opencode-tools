import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { sniffMime } from './binary';
import type { ImageInfoResult } from './types';

function parsePng(buffer: Buffer): { width?: number; height?: number } {
  if (buffer.length < 24) return {};
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseGif(buffer: Buffer): { width?: number; height?: number } {
  if (buffer.length < 10) return {};
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function parseWebp(buffer: Buffer): { width?: number; height?: number } {
  const header = buffer.subarray(12, 16).toString('ascii');
  if (header === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  return {};
}

function parseJpeg(buffer: Buffer): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const size = buffer.readUInt16BE(offset + 2);
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += size + 2;
  }
  return {};
}

export async function readImageInfo(
  resolvedPath: string,
  handle?: FileHandle,
  signal?: AbortSignal,
): Promise<ImageInfoResult> {
  signal?.throwIfAborted();
  const file = handle ?? (await open(resolvedPath, 'r'));
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      signal?.throwIfAborted();
      const result = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    signal?.throwIfAborted();
    const sample = buffer.subarray(0, bytesRead);
    const mime = sniffMime(sample) ?? 'application/octet-stream';
    const fileStat = await file.stat();

    const dimensions =
      mime === 'image/png'
        ? parsePng(sample)
        : mime === 'image/jpeg'
          ? parseJpeg(sample)
          : mime === 'image/gif'
            ? parseGif(sample)
            : mime === 'image/webp'
              ? parseWebp(sample)
              : {};

    return {
      kind: 'image',
      path: resolvedPath,
      mime,
      sizeBytes: fileStat.size,
      ...dimensions,
    };
  } finally {
    // The verified descriptor is owned by the engine; only close handles we
    // opened ourselves.
    if (!handle) await file.close();
  }
}
