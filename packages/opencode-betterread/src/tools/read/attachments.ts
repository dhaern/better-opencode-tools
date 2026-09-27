import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { SAMPLE_BYTES } from './constants';
import type { ReadExecutionResult } from './types';

type Attachment = NonNullable<ReadExecutionResult['attachments']>[number];
type Dimensions = { width?: number; height?: number };

// Largest file header inspected for image dimensions.
const IMAGE_HEADER_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// BITMAPCOREHEADER/INFOHEADER/V2-V5 sizes: a bare "BM" prefix is common text.
const BMP_DIB_HEADER_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const TEXT_EXTENSIONS = new Set(
  '.c .cc .cpp .css .go .html .java .js .json .jsx .md .mjs .py .rb .rs .sh .sql .svg .toml .ts .tsx .txt .xml .yaml .yml'.split(
    ' ',
  ),
);

// Exact byte comparison: 'ascii' decoding would clear the high bit and let
// non-ASCII bytes match an ASCII signature.
function startsWith(sample: Buffer, signature: string, at = 0): boolean {
  return sample.toString('latin1', at, at + signature.length) === signature;
}

export function sniffMime(sample: Buffer): string | undefined {
  if (sample.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
    return 'image/jpeg';
  }
  if (startsWith(sample, 'GIF87a') || startsWith(sample, 'GIF89a')) {
    return 'image/gif';
  }
  if (startsWith(sample, 'RIFF') && startsWith(sample, 'WEBP', 8)) {
    return 'image/webp';
  }
  if (
    startsWith(sample, 'BM') &&
    sample.length >= 18 &&
    BMP_DIB_HEADER_SIZES.has(sample.readUInt32LE(14))
  ) {
    return 'image/bmp';
  }
  if (startsWith(sample, '%PDF-')) return 'application/pdf';
  return undefined;
}

export function isNotebookPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.ipynb');
}

// Called only after image/PDF signatures and notebooks were ruled out.
export function isProbablyBinary(filePath: string, sample: Buffer): boolean {
  const length = Math.min(sample.length, SAMPLE_BYTES);
  if (length === 0) return false;
  let suspicious = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = sample[index];
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  const threshold = TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    ? 0.3
    : 0.1;
  return suspicious / length > threshold;
}

function jpegDimensions(buffer: Buffer): Dimensions {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    if (JPEG_SOF_MARKERS.has(buffer[offset + 1])) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += buffer.readUInt16BE(offset + 2) + 2;
  }
  return {};
}

// Dimensions come from the first IMAGE_HEADER_BYTES only, like a header probe.
export function imageDimensions(mime: string, bytes: Buffer): Dimensions {
  const header = bytes.subarray(0, IMAGE_HEADER_BYTES);
  switch (mime) {
    case 'image/png':
      return header.length < 24
        ? {}
        : { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
    case 'image/gif':
      return header.length < 10
        ? {}
        : { width: header.readUInt16LE(6), height: header.readUInt16LE(8) };
    case 'image/webp':
      return startsWith(header, 'VP8X', 12) && header.length >= 30
        ? {
            width: 1 + header.readUIntLE(24, 3),
            height: 1 + header.readUIntLE(27, 3),
          }
        : {};
    case 'image/jpeg':
      return jpegDimensions(header);
    default:
      return {};
  }
}

// Read straight into a single positioned buffer sized for the known file,
// growing only when a size hint is stale. One extra byte detects an over-cap
// file, while short reads and cancellation remain supported.
export async function readBoundedBytes(
  handle: FileHandle,
  cap: number,
  signal?: AbortSignal,
  sizeHint = 64 * 1024,
): Promise<Buffer> {
  let buffer = Buffer.allocUnsafe(Math.min(cap, sizeHint) + 1);
  let total = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (total === buffer.length) {
      if (total > cap) break;
      const grown = Buffer.allocUnsafe(Math.min(cap + 1, buffer.length * 2));
      buffer.copy(grown, 0, 0, total);
      buffer = grown;
    }
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.length - total,
      total,
    );
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > cap) {
    throw new Error(`Embedded attachment exceeds the ${cap} byte limit`);
  }
  signal?.throwIfAborted();
  return buffer.subarray(0, total);
}

// The host only delivers attachments whose URL is an embedded `data:` URL
// (message-v2 filters `url.startsWith("data:")`), so embed bytes like the
// native read tool does; callers read them capped by
// MAX_EMBEDDED_ATTACHMENT_BYTES.
export function dataAttachment(
  filePath: string,
  mime: string,
  bytes: Buffer,
): Attachment {
  return {
    type: 'file',
    mime,
    url: `data:${mime};base64,${bytes.toString('base64')}`,
    filename: path.basename(filePath),
  };
}
