import path from 'node:path';
import {
  ATTACHMENT_DATA_URL_NOTE,
  MAX_LINE_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_CHARS,
  OUTPUT_CAPPED_NOTE,
} from './constants';
import { LEGACY_OUTPUT_LIMITS, type ReadOutputLimits } from './limits';
import type {
  DirectoryReadResult,
  ImageInfoResult,
  NotebookReadResult,
  PdfReadResult,
  TextReadResult,
} from './types';

const LINE_TRUNCATED_NOTE = `(One or more lines were truncated to ${MAX_LINE_LENGTH} characters.)`;

export type RenderedTextResult = {
  output: string;
  preview: string;
  truncated: boolean;
  hasMore: boolean;
  truncatedByBytes: boolean;
  truncatedByLineLength: boolean;
  startLine: number;
  endLine: number;
};

export function escapeStructuredTagValue(value: string): string {
  return value
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Like escapeStructuredTagValue, but also escapes backslashes so the \r/\n
// escapes stay unambiguous on a single line.
export function escapeStructuredSingleLineValue(value: string): string {
  return escapeStructuredTagValue(value.replaceAll('\\', '\\\\'));
}

function formatFooter(
  start: number,
  end: number,
  total: number | undefined,
  hasMore: boolean,
): string {
  if (end < start) {
    if (total === 0 && !hasMore) return '(End of file - 0 lines)';
    return '(No lines in selected range)';
  }
  if (total !== undefined && !hasMore) {
    return `(End of file - showing lines ${start}-${end} of ${total})`;
  }
  return `(Showing lines ${start}-${end}. Use offset=${end + 1} to continue.)`;
}

function buildTextOutput(
  result: TextReadResult | NotebookReadResult,
  numberedLines: string[],
  hasMore: boolean,
  cappedByBudget: boolean,
  truncatedLineShown: boolean,
): string {
  const end = result.startLine + numberedLines.length - 1;
  return [
    `<path>${escapeStructuredTagValue(result.path)}</path>`,
    `<type>${result.kind === 'notebook' ? 'notebook' : 'file'}</type>`,
    numberedLines.length === 0
      ? '<content>\n</content>'
      : `<content>\n${numberedLines.join('\n')}\n</content>`,
    formatFooter(result.startLine, end, result.totalLines, hasMore),
    ...(truncatedLineShown ? [LINE_TRUNCATED_NOTE] : []),
    ...(cappedByBudget ? [OUTPUT_CAPPED_NOTE] : []),
  ].join('\n');
}

// Renders the reader window; when numbering and framing push it past the
// output budget, walks line costs once and keeps the largest fitting prefix.
export function renderTextResult(
  result: TextReadResult | NotebookReadResult,
  outputLimits: ReadOutputLimits = LEGACY_OUTPUT_LIMITS,
): RenderedTextResult {
  const rawLines =
    result.endLine < result.startLine ? [] : result.content.split('\n');
  const numberedLines: string[] = [];
  const truncatedLineShown = (count: number): boolean =>
    result.firstTruncatedLine === undefined
      ? result.truncatedByLineLength
      : count > 0 && result.firstTruncatedLine <= result.startLine + count - 1;
  const frame = `<path>${escapeStructuredTagValue(result.path)}</path>\n<type>${result.kind === 'notebook' ? 'notebook' : 'file'}</type>\n<content>\n</content>\n`;
  const baseChars = frame.length;
  const baseBytes = Buffer.byteLength(frame, 'utf8');
  const maxBytes = Math.min(MAX_OUTPUT_BYTES, outputLimits.maxBytes);
  const noteChars = 1 + LINE_TRUNCATED_NOTE.length;
  const cappedFooterChars =
    `(Showing lines ${result.startLine}-. Use offset= to continue.)\n${OUTPUT_CAPPED_NOTE}`
      .length;
  let endDigits = String(result.startLine).length;
  let nextDigits = String(result.startLine + 1).length;
  let endThreshold = 10 ** endDigits;
  let nextThreshold = 10 ** nextDigits;
  const emptyTail = `${formatFooter(result.startLine, result.startLine - 1, undefined, true)}${truncatedLineShown(0) ? `\n${LINE_TRUNCATED_NOTE}` : ''}\n${OUTPUT_CAPPED_NOTE}`;
  let chars = 0;
  let bytes = 0;
  const asciiContent =
    Buffer.byteLength(result.content, 'utf8') === result.content.length;
  let selected = 0;
  let checking =
    baseChars + emptyTail.length <= MAX_OUTPUT_CHARS &&
    baseBytes + emptyTail.length <= maxBytes &&
    6 + (truncatedLineShown(0) ? 1 : 0) <= outputLimits.maxLines;
  let fullTooLarge = false;
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = `${result.startLine + index}: ${rawLines[index]}`;
    numberedLines.push(line);
    chars += line.length + 1;
    bytes += (asciiContent ? line.length : Buffer.byteLength(line, 'utf8')) + 1;
    if (baseChars + chars > MAX_OUTPUT_CHARS || baseBytes + bytes > maxBytes) {
      fullTooLarge = true;
      break;
    }
    if (!checking) continue;
    const end = result.startLine + index;
    if (end >= endThreshold) {
      endDigits += 1;
      endThreshold *= 10;
    }
    if (end + 1 >= nextThreshold) {
      nextDigits += 1;
      nextThreshold *= 10;
    }
    // The footer's numbers are the only variable-width part; all its bytes
    // are ASCII, so the same exact cost applies to UTF-16 and UTF-8 budgets.
    const footerCost =
      cappedFooterChars +
      endDigits +
      nextDigits +
      (truncatedLineShown(index + 1) ? noteChars : 0);
    checking =
      baseChars + chars + footerCost <= MAX_OUTPUT_CHARS &&
      baseBytes + bytes + footerCost <= maxBytes &&
      7 + index + (truncatedLineShown(index + 1) ? 1 : 0) <=
        outputLimits.maxLines;
    if (checking) selected = index + 1;
  }
  const fullTail = `${formatFooter(result.startLine, result.endLine, result.totalLines, result.hasMore)}${truncatedLineShown(rawLines.length) ? `\n${LINE_TRUNCATED_NOTE}` : ''}${result.truncatedByBytes ? `\n${OUTPUT_CAPPED_NOTE}` : ''}`;
  const fullFits =
    !fullTooLarge &&
    baseChars + chars + fullTail.length <= MAX_OUTPUT_CHARS &&
    baseBytes + bytes + fullTail.length <= maxBytes &&
    4 + rawLines.length + fullTail.split('\n').length <= outputLimits.maxLines;
  const count = fullFits ? numberedLines.length : selected;
  const visible = numberedLines.slice(0, count);
  const hasMore = fullFits ? result.hasMore : true;
  const truncatedByBytes = fullFits ? result.truncatedByBytes : true;
  const truncatedByLineLength = truncatedLineShown(count);
  return {
    startLine: result.startLine,
    output: buildTextOutput(
      result,
      visible,
      hasMore,
      truncatedByBytes,
      truncatedByLineLength,
    ),
    preview: visible.slice(0, 20).join('\n'),
    truncated: hasMore || truncatedByBytes || truncatedByLineLength,
    hasMore,
    truncatedByBytes,
    truncatedByLineLength,
    endLine: fullFits ? result.endLine : result.startLine + count - 1,
  };
}

export function formatImageInfoResult(result: ImageInfoResult): string {
  return [
    `<path>${escapeStructuredTagValue(result.path)}</path>`,
    '<type>image</type>',
    `<mime>${escapeStructuredTagValue(result.mime)}</mime>`,
    `<size>${result.sizeBytes}</size>`,
    ...(result.width !== undefined && result.height !== undefined
      ? [`<dimensions>${result.width}x${result.height}</dimensions>`]
      : []),
    `Image metadata extracted: ${escapeStructuredSingleLineValue(
      path.basename(result.path),
    )}`,
  ].join('\n');
}

export function formatPdfResult(result: PdfReadResult): string {
  return [
    `<path>${escapeStructuredTagValue(result.path)}</path>`,
    '<type>pdf</type>',
    ...(result.pageCount !== undefined
      ? [`<page_count>${result.pageCount}</page_count>`]
      : []),
    ATTACHMENT_DATA_URL_NOTE,
  ].join('\n');
}

export function escapeDirectoryEntry(entry: string): string {
  return /[\\\r\n&<>]/.test(entry)
    ? escapeStructuredSingleLineValue(entry)
    : entry;
}

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
  rendered: RenderedTextResult,
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
    attachment_note: ATTACHMENT_DATA_URL_NOTE,
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
    attachment_note: ATTACHMENT_DATA_URL_NOTE,
  };
}
