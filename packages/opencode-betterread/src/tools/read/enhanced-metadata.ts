import { ATTACHMENT_UNAVAILABLE_NOTE } from './constants';
import { escapeDirectoryEntry } from './directory-output';
import {
  escapeStructuredSingleLineValue,
  type RenderedTextResult,
  renderTextResult,
} from './formatter';
import type {
  DirectoryReadResult,
  ImageInfoResult,
  NotebookReadResult,
  PdfReadResult,
  TextReadResult,
} from './types';

type MetadataPath = { filePath: string; realPath?: string };

export function buildStaticMetadata(
  input: MetadataPath & { kind: string },
  preview: string,
  truncated: boolean,
): Record<string, unknown> {
  return {
    enhancedBy: 'opencode-betterread',
    enhancedPath: input.filePath,
    resolved_path: input.filePath,
    ...(input.realPath && input.realPath !== input.filePath
      ? { real_path: input.realPath }
      : {}),
    kind: input.kind,
    loaded: [],
    preview,
    truncated,
  };
}

export function buildTextMetadata(
  input: MetadataPath,
  result: TextReadResult | NotebookReadResult,
  rendered: RenderedTextResult = renderTextResult(result),
): Record<string, unknown> {
  return {
    ...buildStaticMetadata(
      { ...input, kind: result.kind },
      rendered.preview,
      rendered.truncated,
    ),
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
  input: MetadataPath,
  result: DirectoryReadResult,
): Record<string, unknown> {
  return {
    ...buildStaticMetadata(
      { ...input, kind: result.kind },
      result.entries.slice(0, 20).map(escapeDirectoryEntry).join('\n'),
      result.hasMore || result.truncatedByBytes,
    ),
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

export function buildPdfMetadata(
  input: MetadataPath,
  result: PdfReadResult,
): Record<string, unknown> {
  return {
    ...buildStaticMetadata(
      { ...input, kind: result.kind },
      result.pageCount !== undefined
        ? `PDF metadata extracted (${result.pageCount} pages)`
        : 'PDF metadata extracted',
      false,
    ),
    page_count: result.pageCount,
    attachment_support: 'embedded',
    attachment_note: ATTACHMENT_UNAVAILABLE_NOTE,
  };
}

export function buildImageMetadata(
  input: MetadataPath,
  result: ImageInfoResult,
): Record<string, unknown> {
  return {
    ...buildStaticMetadata(
      { ...input, kind: result.kind },
      `Image metadata extracted: ${escapeStructuredSingleLineValue(result.path)}`,
      false,
    ),
    mime: result.mime,
    size_bytes: result.sizeBytes,
    width: result.width,
    height: result.height,
    attachment_support: 'embedded',
    attachment_note: ATTACHMENT_UNAVAILABLE_NOTE,
  };
}
