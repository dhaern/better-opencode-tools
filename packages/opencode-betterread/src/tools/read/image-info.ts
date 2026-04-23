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
): Promise<ImageInfoResult> {
  const file = await open(resolvedPath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
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
    await file.close();
  }
}
