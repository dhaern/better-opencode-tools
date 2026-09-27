import type { FileHandle } from 'node:fs/promises';
import { MAX_LINE_LENGTH } from './constants';
import { createOutputBudget, truncateLine } from './limits';
import type { TextReadResult } from './types';

const CHUNK_BYTES = 1024 * 1024;
const LF = 0x0a;
const CR = 0x0d;
// Bytes kept per selected line: enough to decode MAX_LINE_LENGTH + 1 UTF-16
// units from any UTF-8 input, so truncation is decided exactly.
const MAX_LINE_BYTES = (MAX_LINE_LENGTH + 1) * 4;

export type ReadTextOptions = { countAll?: boolean; size: number };

// Decode only the selected window; count earlier lines on raw CR/LF bytes.
// Positioned reads keep the caller's file descriptor cursor untouched.
export async function readTextWindow(
  handle: FileHandle,
  offset: number,
  limit: number,
  options: ReadTextOptions,
  signal?: AbortSignal,
): Promise<Omit<TextReadResult, 'path'>> {
  signal?.throwIfAborted();
  const { size, countAll = false } = options;
  const selected: string[] = [];
  const budget = createOutputBudget();
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
    if (!budget.tryAdd(line.value)) {
      truncatedByBytes = hasMore = closed = true;
      return;
    }
    selected.push(line.value);
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
