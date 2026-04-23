import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { FAST_PATH_MAX_BYTES, MAX_LINE_LENGTH } from './constants';
import {
  appendLineWithinOutputBudget,
  createOutputBudgetState,
  selectBudgetedLines,
  splitLogicalLines,
} from './output-budget';
import type { TextReadResult } from './types';

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
): Promise<TextReadResult> {
  const raw = await readFile(resolvedPath, 'utf8');
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

async function readStreamingPath(
  resolvedPath: string,
  offset: number,
  limit: number,
  mtimeMs: number,
): Promise<TextReadResult> {
  const stream = createReadStream(resolvedPath, { encoding: 'utf8' });
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

  function stopWithMore(): void {
    hasMore = true;
    stopped = true;
    stream.destroy();
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

  for await (const chunk of stream) {
    processChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    if (stopped) {
      break;
    }
  }

  if (!stopped) {
    if (pendingCarriageReturn) {
      pendingCarriageReturn = false;
      finishCurrentLine();
    } else if (currentLineStarted) {
      finishCurrentLine();
    }
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
): Promise<TextReadResult> {
  const fileStat = await stat(resolvedPath);
  if (fileStat.size <= FAST_PATH_MAX_BYTES) {
    return readFastPath(resolvedPath, offset, limit, fileStat.mtimeMs);
  }
  return readStreamingPath(resolvedPath, offset, limit, fileStat.mtimeMs);
}

export async function readTextFileStreaming(
  resolvedPath: string,
  offset: number,
  limit: number,
): Promise<TextReadResult> {
  const fileStat = await stat(resolvedPath);
  return readStreamingPath(resolvedPath, offset, limit, fileStat.mtimeMs);
}
