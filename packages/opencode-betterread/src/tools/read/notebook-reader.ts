import { readFile, stat } from 'node:fs/promises';
import { MAX_PARSED_NOTEBOOK_BYTES } from './constants';
import { selectBudgetedLines, splitLogicalLines } from './output-budget';
import { readTextFileStreaming } from './text-reader';
import type { NotebookReadResult } from './types';

type NotebookCell = {
  cell_type?: string;
  source?: string[] | string;
};

function normalizeSource(source: string[] | string | undefined): string {
  if (Array.isArray(source)) return source.join('');
  return typeof source === 'string' ? source : '';
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
): Promise<NotebookReadResult> {
  return {
    ...(await readTextFileStreaming(resolvedPath, offset, limit)),
    kind: 'notebook',
    mode: 'raw-fallback',
  };
}

async function readParsedNotebook(
  resolvedPath: string,
  offset: number,
  limit: number,
  mtimeMs: number,
): Promise<NotebookReadResult> {
  const raw = await readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw) as { cells?: NotebookCell[] };
  const lines: string[] = [];

  for (const [index, cell] of (parsed.cells ?? []).entries()) {
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
): Promise<NotebookReadResult> {
  const fileStat = await stat(resolvedPath);
  if (!shouldParseNotebook(fileStat.size)) {
    return readNotebookFallback(resolvedPath, offset, limit);
  }

  try {
    return await readParsedNotebook(
      resolvedPath,
      offset,
      limit,
      fileStat.mtimeMs,
    );
  } catch {
    return readNotebookFallback(resolvedPath, offset, limit);
  }
}
