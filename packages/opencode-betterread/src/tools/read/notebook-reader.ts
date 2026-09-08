import type { FileHandle } from 'node:fs/promises';
import { open, stat } from 'node:fs/promises';
import { MAX_PARSED_NOTEBOOK_BYTES } from './constants';
import { selectBudgetedLines, splitLogicalLines } from './output-budget';
import { readAllFileBytes, readTextFileStreaming } from './text-reader';
import type { NotebookReadResult } from './types';

type NotebookCell = {
  cell_type?: string;
  source?: string[] | string;
};

function normalizeSource(source: string[] | string | undefined): string {
  if (Array.isArray(source)) return source.join('');
  return typeof source === 'string' ? source : '';
}

// A notebook cell header is a single logical line; multi-line cell types would
// desynchronize the line accounting between generation and rendering.
function isSupportedCell(cell: NotebookCell): boolean {
  return (
    typeof cell.cell_type === 'string' &&
    cell.cell_type.length > 0 &&
    !cell.cell_type.includes('\n') &&
    !cell.cell_type.includes('\r')
  );
}

function isParsedNotebookShape(value: unknown): value is {
  cells: NotebookCell[];
} {
  if (typeof value !== 'object' || value === null) return false;
  const cells = (value as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return false;
  // Every cell must be a plain object; anything else (primitives, null,
  // arrays) is not a well-formed notebook and must fall back to raw.
  return cells.every(
    (cell) =>
      typeof cell === 'object' &&
      cell !== null &&
      !Array.isArray(cell) &&
      isSupportedCell(cell as NotebookCell),
  );
}

function appendNotebookCell(
  lines: string[],
  cell: NotebookCell,
  index: number,
): void {
  const source = normalizeSource(cell.source);
  if (source.length === 0) return;

  if (lines.length > 0) {
    lines.push('');
  }

  lines.push(`# Cell ${index + 1} (${cell.cell_type ?? 'unknown'})`);
  lines.push(...splitLogicalLines(source));
}

export function shouldParseNotebook(sizeBytes: number): boolean {
  return sizeBytes <= MAX_PARSED_NOTEBOOK_BYTES;
}

async function readNotebookFallback(
  resolvedPath: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  handle?: FileHandle,
): Promise<NotebookReadResult> {
  return {
    ...(await readTextFileStreaming(
      resolvedPath,
      offset,
      limit,
      signal,
      handle,
    )),
    kind: 'notebook',
    mode: 'raw-fallback',
  };
}

async function readParsedNotebook(
  resolvedPath: string,
  offset: number,
  limit: number,
  mtimeMs: number,
  signal?: AbortSignal,
  handle?: FileHandle,
): Promise<NotebookReadResult> {
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
  const parsed: unknown = JSON.parse(raw);
  // JSON that is valid but not a notebook (missing/invalid cells) falls back
  // to the raw reader instead of silently rendering an empty document.
  if (!isParsedNotebookShape(parsed)) {
    throw new Error('Not a valid notebook structure');
  }
  const lines: string[] = [];

  for (const [index, cell] of parsed.cells.entries()) {
    appendNotebookCell(lines, cell, index);
  }

  const { selected, truncatedByBytes, truncatedByLineLength, hasMore } =
    selectBudgetedLines(lines, offset, limit);

  return {
    kind: 'notebook',
    mode: 'parsed',
    path: resolvedPath,
    content: selected.join('\n'),
    startLine: offset,
    endLine: selected.length === 0 ? offset - 1 : offset + selected.length - 1,
    totalLines: lines.length,
    truncatedByBytes,
    truncatedByLineLength,
    hasMore,
    mtimeMs,
  };
}

export async function readNotebook(
  resolvedPath: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  handle?: FileHandle,
): Promise<NotebookReadResult> {
  signal?.throwIfAborted();
  const fileStat = handle ? await handle.stat() : await stat(resolvedPath);
  if (!shouldParseNotebook(fileStat.size)) {
    return readNotebookFallback(resolvedPath, offset, limit, signal, handle);
  }

  try {
    return await readParsedNotebook(
      resolvedPath,
      offset,
      limit,
      fileStat.mtimeMs,
      signal,
      handle,
    );
  } catch {
    signal?.throwIfAborted();
    return readNotebookFallback(resolvedPath, offset, limit, signal, handle);
  }
}
