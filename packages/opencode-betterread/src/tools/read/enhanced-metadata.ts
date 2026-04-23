import { ATTACHMENT_UNAVAILABLE_NOTE } from './constants';
import { escapeDirectoryEntry } from './directory-output';
import { renderTextResult } from './formatter';
import { escapeStructuredSingleLineValue } from './structured-escape';
import type {
  DirectoryReadResult,
  ImageInfoResult,
  NotebookReadResult,
  PdfReadResult,
  TextReadResult,
} from './types';

function baseMetadata(input: {
  filePath: string;
  realPath?: string;
  kind: string;
}): Record<string, unknown> {
  return {
    enhancedBy: 'opencode-betterread',
    enhancedPath: input.filePath,
    resolved_path: input.filePath,
    ...(input.realPath && input.realPath !== input.filePath
      ? { real_path: input.realPath }
      : {}),
    kind: input.kind,
    loaded: [],
  };
}

export function buildTextMetadata(
  input: { filePath: string; realPath?: string },
  result: TextReadResult | NotebookReadResult,
): Record<string, unknown> {
  const rendered = renderTextResult(result);

  return {
    ...baseMetadata({
      filePath: input.filePath,
      realPath: input.realPath,
      kind: result.kind,
    }),
    preview: rendered.preview,
    truncated: rendered.truncated,
    start_line: rendered.startLine,
    end_line: rendered.endLine,
    total_lines: result.totalLines,
    has_more: rendered.hasMore,
    truncated_by_bytes: rendered.truncatedByBytes,
    truncated_by_line_length: rendered.truncatedByLineLength,
    ...(result.kind === 'notebook' ? { notebookMode: result.mode } : {}),
  };
}

export function buildDirectoryMetadata(
  input: { filePath: string; realPath?: string },
  result: DirectoryReadResult,
): Record<string, unknown> {
  return {
    ...baseMetadata({
      filePath: input.filePath,
      realPath: input.realPath,
      kind: result.kind,
    }),
    preview: result.entries.slice(0, 20).map(escapeDirectoryEntry).join('\n'),
    truncated: result.hasMore || result.truncatedByBytes,
    offset: result.offset,
    limit: result.limit,
    total_entries: result.totalEntries,
    total_entries_known: result.totalEntriesKnown,
    ...(result.totalEntriesKnown
      ? {}
      : { scanned_entries: result.totalEntries }),
    entry_count: result.entries.length,
    has_more: result.hasMore,
    truncated_by_bytes: result.truncatedByBytes,
  };
}

export function buildStaticMetadata(
  input: { filePath: string; realPath?: string; kind: string },
  preview: string,
  truncated: boolean,
): Record<string, unknown> {
  return {
    ...baseMetadata(input),
    preview,
    truncated,
  };
}

export function buildPdfMetadata(
  input: { filePath: string; realPath?: string },
  result: PdfReadResult,
): Record<string, unknown> {
  const preview =
    result.pageCount !== undefined
      ? `PDF metadata extracted (${result.pageCount} pages)`
      : 'PDF metadata extracted';

  return {
    ...buildStaticMetadata({ ...input, kind: result.kind }, preview, false),
    page_count: result.pageCount,
    attachment_support: 'unavailable',
    attachment_note: ATTACHMENT_UNAVAILABLE_NOTE,
  };
}

export function buildImageMetadata(
  input: { filePath: string; realPath?: string },
  result: ImageInfoResult,
): Record<string, unknown> {
  return {
    ...buildStaticMetadata(
      { ...input, kind: result.kind },
      `Image metadata extracted: ${escapeStructuredSingleLineValue(
        result.path,
      )}`,
      false,
    ),
    mime: result.mime,
    size_bytes: result.sizeBytes,
    width: result.width,
    height: result.height,
    attachment_support: 'unavailable',
    attachment_note: ATTACHMENT_UNAVAILABLE_NOTE,
  };
}
