import { extname } from 'node:path';
import { SAMPLE_BYTES } from './constants';

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.go',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

// A BM prefix alone is common in ordinary text. Require a recognized DIB
// header before treating it as a bitmap.
const BMP_DIB_HEADER_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124]);

function startsWithBytes(
  sample: Buffer,
  signature: string,
  offset = 0,
): boolean {
  return (
    sample.length >= offset + signature.length &&
    sample
      .subarray(offset, offset + signature.length)
      .equals(Buffer.from(signature, 'latin1'))
  );
}

export function sniffMime(sample: Buffer): string | undefined {
  if (
    sample.length >= 8 &&
    sample
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    sample.length >= 3 &&
    sample[0] === 0xff &&
    sample[1] === 0xd8 &&
    sample[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (startsWithBytes(sample, 'GIF87a') || startsWithBytes(sample, 'GIF89a'))
    return 'image/gif';
  if (
    sample.length >= 12 &&
    startsWithBytes(sample, 'RIFF') &&
    startsWithBytes(sample, 'WEBP', 8)
  ) {
    return 'image/webp';
  }
  if (
    startsWithBytes(sample, 'BM') &&
    sample.length >= 18 &&
    BMP_DIB_HEADER_SIZES.has(sample.readUInt32LE(14))
  ) {
    return 'image/bmp';
  }
  if (startsWithBytes(sample, '%PDF-')) {
    return 'application/pdf';
  }
  return undefined;
}

export function isImageMime(mime: string | undefined): boolean {
  return typeof mime === 'string' && mime.startsWith('image/');
}

export function isPdfMime(mime: string | undefined): boolean {
  return mime === 'application/pdf';
}

export function isNotebookPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.ipynb');
}

function suspiciousByteRatio(sample: Buffer): number {
  const length = Math.min(sample.length, SAMPLE_BYTES);
  if (length === 0) return 0;

  let suspicious = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = sample[index];
    if (byte === 0) return 1;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }

  return suspicious / length;
}

export function isProbablyBinary(filePath: string, sample: Buffer): boolean {
  if (sample.length === 0) return false;

  const mime = sniffMime(sample);
  if (mime) return !mime.startsWith('text/');

  const extension = extname(filePath).toLowerCase();
  const threshold =
    TEXT_EXTENSIONS.has(extension) || isNotebookPath(filePath) ? 0.3 : 0.1;

  return suspiciousByteRatio(sample) > threshold;
}
