import type { FileHandle } from 'node:fs/promises';
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { FAST_PATH_MAX_BYTES, MAX_LINE_LENGTH } from './constants';
import {
  appendLineWithinOutputBudget,
  createOutputBudgetState,
  selectBudgetedLines,
  splitLogicalLines,
} from './output-budget';
import type { TextReadResult } from './types';

const STREAM_CHUNK_BYTES = 64 * 1024;

function buildTextResult(
  resolvedPath: string,
  lines: string[],
  startLine: number,
  totalLines: number | undefined,
  truncatedByBytes: boolean,
  truncatedByLineLength: boolean,
  mtimeMs: number,
  hasMore: boolean,
): TextReadResult {
  const endLine =
    lines.length === 0 ? startLine - 1 : startLine + lines.length - 1;
  return {
    kind: 'text',
    path: resolvedPath,
    content: lines.join('\n'),
    startLine,
    endLine,
    totalLines,
    truncatedByBytes,
    truncatedByLineLength,
    hasMore,
    mtimeMs,
  };
}

async function readFastPath(
  resolvedPath: string,
  offset: number,
  limit: number,
  mtimeMs: number,
  signal?: AbortSignal,
  handle?: FileHandle,
): Promise<TextReadResult> {
  signal?.throwIfAborted();
  const file = handle ?? (await open(resolvedPath, 'r'));
  const ownsHandle = !handle;
  let raw: string;
  try {
    raw = (await readAllFileBytes(file, signal)).toString('utf8');
  } finally {
    if (ownsHandle) await file.close().catch(() => undefined);
  }
  signal?.throwIfAborted();
  const split = splitLogicalLines(raw);
  const { selected, truncatedByBytes, truncatedByLineLength, hasMore } =
    selectBudgetedLines(split, offset, limit);

  return buildTextResult(
    resolvedPath,
    selected,
    offset,
    split.length,
    truncatedByBytes,
    truncatedByLineLength,
    mtimeMs,
    hasMore,
  );
}

// Read a file through explicitly positioned operations. Keeping the position
// explicit makes this safe to reuse after a parser has consumed the same
// descriptor and lets cancellation be checked between bounded chunks.
export async function readAllFileBytes(
  handle: FileHandle,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const chunkBuffer = Buffer.alloc(STREAM_CHUNK_BYTES);
  let position = 0;

  for (;;) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      chunkBuffer,
      0,
      chunkBuffer.length,
      position,
    );
    if (bytesRead === 0) break;
    position += bytesRead;
    chunks.push(Buffer.from(chunkBuffer.subarray(0, bytesRead)));
  }

  signal?.throwIfAborted();
  return Buffer.concat(chunks);
}

// Reads the file with explicitly positioned handle reads. A shared handle is
// consumed without moving its cursor and never handed to a stream, so the
// engine keeps single ownership of the descriptor lifecycle; when no handle
// is provided (direct API use) a private one is opened and closed here.
async function readStreamingPath(
  resolvedPath: string,
  offset: number,
  limit: number,
  mtimeMs: number,
  signal?: AbortSignal,
  sharedHandle?: FileHandle,
): Promise<TextReadResult> {
  signal?.throwIfAborted();
  const handle = sharedHandle ?? (await open(resolvedPath, 'r'));
  const ownsHandle = !sharedHandle;
  signal?.throwIfAborted();
  const decoder = new StringDecoder('utf8');
  const selected: string[] = [];
  const budget = createOutputBudgetState();
  let lineNumber = 0;
  let truncatedByBytes = false;
  let truncatedByLineLength = false;
  let hasMore = false;
  let currentLine = '';
  let currentLineTruncated = false;
  let currentLineStarted = false;
  let pendingCarriageReturn = false;
  let stopped = false;
  let aborted = false;

  const onAbort = (): void => {
    aborted = true;
    hasMore = true;
    stopped = true;
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  function stopWithMore(): void {
    hasMore = true;
    stopped = true;
  }

  function appendChunkToCurrentLine(chunk: string): void {
    if (chunk.length === 0 || stopped) return;

    currentLineStarted = true;

    if (lineNumber + 1 < offset) {
      return;
    }

    if (selected.length >= limit) {
      stopWithMore();
      return;
    }

    if (currentLine.length >= MAX_LINE_LENGTH) {
      currentLineTruncated = true;
      return;
    }

    const remaining = MAX_LINE_LENGTH - currentLine.length;
    if (chunk.length <= remaining) {
      currentLine += chunk;
      return;
    }

    currentLine += chunk.slice(0, remaining);
    currentLineTruncated = true;
  }

  function finishCurrentLine(): void {
    if (stopped) return;

    lineNumber += 1;
    if (lineNumber >= offset) {
      if (selected.length >= limit) {
        stopWithMore();
        return;
      }

      const normalized = currentLineTruncated ? `${currentLine}…` : currentLine;
      if (!appendLineWithinOutputBudget(selected, budget, normalized)) {
        truncatedByBytes = true;
        stopWithMore();
        return;
      }

      truncatedByLineLength ||= currentLineTruncated;
    }

    currentLine = '';
    currentLineTruncated = false;
    currentLineStarted = false;
  }

  function processChunk(chunk: string): void {
    let index = 0;

    if (pendingCarriageReturn) {
      pendingCarriageReturn = false;
      finishCurrentLine();
      if (stopped) return;
      if (chunk.startsWith('\n')) {
        index = 1;
      }
    }

    while (index < chunk.length && !stopped) {
      const carriageReturnIndex = chunk.indexOf('\r', index);
      const lineFeedIndex = chunk.indexOf('\n', index);
      const nextBreakIndex =
        carriageReturnIndex === -1
          ? lineFeedIndex
          : lineFeedIndex === -1
            ? carriageReturnIndex
            : Math.min(carriageReturnIndex, lineFeedIndex);

      if (nextBreakIndex === -1) {
        appendChunkToCurrentLine(chunk.slice(index));
        break;
      }

      appendChunkToCurrentLine(chunk.slice(index, nextBreakIndex));
      if (stopped) break;

      if (chunk[nextBreakIndex] === '\r') {
        if (
          nextBreakIndex + 1 < chunk.length &&
          chunk[nextBreakIndex + 1] === '\n'
        ) {
          finishCurrentLine();
          index = nextBreakIndex + 2;
          continue;
        }

        if (nextBreakIndex + 1 >= chunk.length) {
          pendingCarriageReturn = true;
          break;
        }
      }

      finishCurrentLine();
      index = nextBreakIndex + 1;
    }
  }

  try {
    const chunkBuffer = Buffer.alloc(STREAM_CHUNK_BYTES);
    let position = 0;
    // Positioned reads: the shared handle cursor is never moved, and each
    // short read just means fewer bytes this round.
    for (;;) {
      if (aborted) throw new Error('Read aborted');
      const { bytesRead } = await handle.read(
        chunkBuffer,
        0,
        chunkBuffer.length,
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      processChunk(decoder.write(chunkBuffer.subarray(0, bytesRead)));
      if (stopped) break;
    }
    if (!stopped) {
      const tail = decoder.end();
      if (tail.length > 0) {
        processChunk(tail);
      }
    }

    if (aborted) throw new Error('Read aborted');

    if (!stopped) {
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false;
        finishCurrentLine();
      } else if (currentLineStarted) {
        finishCurrentLine();
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (ownsHandle) await handle.close().catch(() => undefined);
  }

  return buildTextResult(
    resolvedPath,
    selected,
    offset,
    hasMore ? undefined : lineNumber,
    truncatedByBytes,
    truncatedByLineLength,
    mtimeMs,
    hasMore,
  );
}

export async function readTextFile(
  resolvedPath: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  handle?: FileHandle,
): Promise<TextReadResult> {
  signal?.throwIfAborted();
  const fileStat = handle ? await handle.stat() : await stat(resolvedPath);
  if (fileStat.size <= FAST_PATH_MAX_BYTES) {
    return readFastPath(
      resolvedPath,
      offset,
      limit,
      fileStat.mtimeMs,
      signal,
      handle,
    );
  }
  return readStreamingPath(
    resolvedPath,
    offset,
    limit,
    fileStat.mtimeMs,
    signal,
    handle,
  );
}

export async function readTextFileStreaming(
  resolvedPath: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  handle?: FileHandle,
): Promise<TextReadResult> {
  signal?.throwIfAborted();
  const fileStat = handle ? await handle.stat() : await stat(resolvedPath);
  return readStreamingPath(
    resolvedPath,
    offset,
    limit,
    fileStat.mtimeMs,
    signal,
    handle,
  );
}
