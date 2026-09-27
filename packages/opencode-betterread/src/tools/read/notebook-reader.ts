import type { FileHandle } from 'node:fs/promises';
import { readBoundedBytes } from './attachments';
import { MAX_PARSED_NOTEBOOK_BYTES } from './constants';
import type { ReadOutputLimits } from './limits';
import {
  LEGACY_OUTPUT_LIMITS,
  selectBudgetedLines,
  splitLogicalLines,
} from './limits';
import { readTextWindow } from './text-reader';
import type { NotebookReadResult } from './types';

type NotebookCell = { cell_type: string; source?: string[] | string };

// Every cell must be a plain object whose type is a single logical line;
// anything else is not a well-formed notebook and is rendered raw instead
// (multi-line cell types would desynchronize the line accounting).
function isNotebookCell(cell: unknown): cell is NotebookCell {
  if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) {
    return false;
  }
  const type = (cell as { cell_type?: unknown }).cell_type;
  return typeof type === 'string' && type.length > 0 && !/[\r\n]/.test(type);
}

export function shouldParseNotebook(sizeBytes: number): boolean {
  return sizeBytes <= MAX_PARSED_NOTEBOOK_BYTES;
}

function notebookLines(raw: string): string[] {
  const cells = (JSON.parse(raw) as { cells?: unknown } | null)?.cells;
  // Valid JSON that is not a notebook falls back to the raw reader instead of
  // silently rendering an empty document.
  if (!Array.isArray(cells) || !cells.every(isNotebookCell)) {
    throw new Error('Not a valid notebook structure');
  }
  const lines: string[] = [];
  for (const [index, cell] of cells.entries()) {
    const source = Array.isArray(cell.source)
      ? cell.source.join('')
      : typeof cell.source === 'string'
        ? cell.source
        : '';
    if (source.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`# Cell ${index + 1} (${cell.cell_type})`);
    for (const line of splitLogicalLines(source)) lines.push(line);
  }
  return lines;
}

export async function readNotebook(
  offset: number,
  limit: number,
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
  outputLimits: ReadOutputLimits = LEGACY_OUTPUT_LIMITS,
): Promise<Omit<NotebookReadResult, 'path'>> {
  signal?.throwIfAborted();
  if (shouldParseNotebook(size)) {
    try {
      const raw = await readBoundedBytes(
        handle,
        MAX_PARSED_NOTEBOOK_BYTES,
        signal,
        size,
      );
      const lines = notebookLines(raw.toString('utf8'));
      const selection = selectBudgetedLines(
        lines,
        offset,
        Math.min(limit, outputLimits.maxLines),
        outputLimits.maxBytes,
      );
      return {
        kind: 'notebook',
        mode: 'parsed',
        content: selection.selected.join('\n'),
        startLine: offset,
        endLine: offset + selection.selected.length - 1,
        totalLines: lines.length,
        truncatedByBytes: selection.truncatedByBytes,
        truncatedByLineLength: selection.truncatedByLineLength,
        firstTruncatedLine: selection.firstTruncatedLine,
        hasMore: selection.hasMore,
      };
    } catch {
      signal?.throwIfAborted();
    }
  }
  return {
    ...(await readTextWindow(
      handle,
      offset,
      limit,
      { size, outputLimits },
      signal,
    )),
    kind: 'notebook',
    mode: 'raw-fallback',
  };
}
