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
  if (
    sample.length >= 6 &&
    sample.subarray(0, 6).toString('ascii') === 'GIF87a'
  )
    return 'image/gif';
  if (
    sample.length >= 6 &&
    sample.subarray(0, 6).toString('ascii') === 'GIF89a'
  )
    return 'image/gif';
  if (
    sample.length >= 12 &&
    sample.subarray(0, 4).toString('ascii') === 'RIFF' &&
    sample.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (sample.length >= 2 && sample.subarray(0, 2).toString('ascii') === 'BM') {
    return 'image/bmp';
  }
  if (
    sample.length >= 5 &&
    sample.subarray(0, 5).toString('ascii') === '%PDF-'
  ) {
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
