import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { FAST_PATH_MAX_BYTES, MAX_LINE_LENGTH } from './constants';
import {
  appendLineWithinOutputBudget,
  createOutputBudgetState,
  truncateLine,
} from './limits';
import type { TextReadResult } from './types';

const CHUNK_BYTES = 1024 * 1024;
const LF = 0x0a;
const CR = 0x0d;
// Bytes kept per selected line: enough to decode MAX_LINE_LENGTH + 1 UTF-16
// units from any UTF-8 input, so truncation is decided exactly.
const MAX_LINE_BYTES = (MAX_LINE_LENGTH + 1) * 4;

// Scans line breaks on raw bytes (CR/LF never occur inside UTF-8 sequences)
// and decodes only the selected window; earlier lines are counted, never
// decoded. With `countAll` the scan continues to EOF after the window closes
// so small files report an exact total. Positioned reads keep a shared
// handle's cursor untouched.
async function scanText(
  handle: FileHandle,
  offset: number,
  limit: number,
  countAll: boolean,
  size: number,
  signal?: AbortSignal,
): Promise<Omit<TextReadResult, 'path'>> {
  const selected: string[] = [];
  const budget = createOutputBudgetState();
  const buffer = Buffer.allocUnsafe(
    Math.min(CHUNK_BYTES, Math.max(size + 1, 64 * 1024)),
  );
  let parts: Buffer[] = [];
  let partBytes = 0;
  let lines = 0;
  let lineOpen = false;
  let skipLF = false;
  let closed = false;
  let hasMore = false;
  let truncatedByBytes = false;
  let truncatedByLineLength = false;
  let firstTruncatedLine: number | undefined;
  let position = 0;

  const finishLine = (): void => {
    lines += 1;
    lineOpen = false;
    if (closed || lines < offset) return;
    const bytes =
      parts.length === 1 ? parts[0] : Buffer.concat(parts, partBytes);
    const line = truncateLine(bytes.toString('utf8'));
    parts = [];
    partBytes = 0;
    if (!appendLineWithinOutputBudget(selected, budget, line.value)) {
      truncatedByBytes = hasMore = closed = true;
      return;
    }
    if (line.truncated) {
      truncatedByLineLength = true;
      firstTruncatedLine ??= lines;
    }
    if (selected.length >= limit) closed = true;
  };

  scan: for (;;) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    const chunk = buffer.subarray(0, bytesRead);
    let index = skipLF && chunk[0] === LF ? 1 : 0;
    skipLF = false;
    // Next known break positions; each is searched at most once per chunk
    // position, so LF-only or CR-only input stays linear.
    let nextLF = -2;
    let nextCR = -2;
    while (index < chunk.length) {
      // Any byte at a line start after the window closed proves more input.
      if (closed && !lineOpen) {
        hasMore = true;
        if (!countAll) break scan;
      }
      if (nextLF !== -1 && nextLF < index) nextLF = chunk.indexOf(LF, index);
      if (nextCR !== -1 && nextCR < index) nextCR = chunk.indexOf(CR, index);
      const brk =
        nextLF === -1
          ? nextCR
          : nextCR === -1
            ? nextLF
            : Math.min(nextLF, nextCR);
      const end = brk === -1 ? chunk.length : brk;
      const selecting = !closed && lines + 1 >= offset;
      if (selecting && partBytes < MAX_LINE_BYTES) {
        const piece = chunk.subarray(
          index,
          Math.min(end, index + MAX_LINE_BYTES - partBytes),
        );
        parts.push(piece);
        partBytes += piece.length;
      }
      if (brk === -1) {
        // The read buffer is reused: copy the open line's bytes out of it.
        if (selecting && parts.length > 0)
          parts.push(Buffer.from(parts.pop() as Buffer));
        lineOpen = true;
        break;
      }
      finishLine();
      index = brk + 1;
      if (chunk[brk] === CR) {
        if (index === chunk.length) skipLF = true;
        else if (chunk[index] === LF) index += 1;
      }
    }
  }
  if (lineOpen && !(closed && !countAll)) finishLine();

  return {
    kind: 'text',
    content: selected.join('\n'),
    startLine: offset,
    endLine: offset + selected.length - 1,
    totalLines: countAll || !hasMore ? lines : undefined,
    truncatedByBytes,
    truncatedByLineLength,
    firstTruncatedLine,
    hasMore,
  };
}

async function readText(
  resolvedPath: string,
  offset: number,
  limit: number,
  streaming: boolean,
  signal?: AbortSignal,
  handle?: FileHandle,
  size?: number,
): Promise<TextReadResult> {
  signal?.throwIfAborted();
  const file = handle ?? (await open(resolvedPath, 'r'));
  try {
    const fileSize = size ?? (await file.stat()).size;
    const countAll = !streaming && fileSize <= FAST_PATH_MAX_BYTES;
    return {
      ...(await scanText(file, offset, limit, countAll, fileSize, signal)),
      path: resolvedPath,
    };
  } finally {
    if (!handle) await file.close().catch(() => undefined);
  }
}

export function readTextFile(
  resolvedPath: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  handle?: FileHandle,
  size?: number,
): Promise<TextReadResult> {
  return readText(resolvedPath, offset, limit, false, signal, handle, size);
}

// Streaming semantics regardless of size: stops at the window and reports an
// exact total only when EOF was reached.
export function readTextFileStreaming(
  resolvedPath: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  handle?: FileHandle,
  size?: number,
): Promise<TextReadResult> {
  return readText(resolvedPath, offset, limit, true, signal, handle, size);
}
