import path from 'node:path';
import {
  ATTACHMENT_UNAVAILABLE_NOTE,
  MAX_LINE_LENGTH,
  OUTPUT_CAPPED_NOTE,
} from './constants';
import { fitsOutputBudget } from './limits';
import type {
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
): string {
  const end = result.startLine + numberedLines.length - 1;
  return [
    `<path>${escapeStructuredTagValue(result.path)}</path>`,
    `<type>${result.kind === 'notebook' ? 'notebook' : 'file'}</type>`,
    numberedLines.length === 0
      ? '<content>\n</content>'
      : `<content>\n${numberedLines.join('\n')}\n</content>`,
    formatFooter(result.startLine, end, result.totalLines, hasMore),
    ...(result.truncatedByLineLength ? [LINE_TRUNCATED_NOTE] : []),
    ...(cappedByBudget ? [OUTPUT_CAPPED_NOTE] : []),
  ].join('\n');
}

// Renders the reader window; when numbering and framing push it past the
// output budget, keeps the largest fitting prefix (binary search instead of
// one rebuild per line, which is quadratic on large windows).
export function renderTextResult(
  result: TextReadResult | NotebookReadResult,
): RenderedTextResult {
  const numberedLines =
    result.endLine < result.startLine
      ? []
      : result.content
          .split('\n')
          .map((line, index) => `${result.startLine + index}: ${line}`);
  const fullOutput = buildTextOutput(
    result,
    numberedLines,
    result.hasMore,
    result.truncatedByBytes,
  );
  const rendered = {
    truncatedByLineLength: result.truncatedByLineLength,
    startLine: result.startLine,
  };
  if (fitsOutputBudget(fullOutput)) {
    return {
      ...rendered,
      output: fullOutput,
      preview: numberedLines.slice(0, 20).join('\n'),
      truncated:
        result.hasMore ||
        result.truncatedByBytes ||
        result.truncatedByLineLength,
      hasMore: result.hasMore,
      truncatedByBytes: result.truncatedByBytes,
      endLine: result.endLine,
    };
  }

  const build = (count: number) =>
    buildTextOutput(result, numberedLines.slice(0, count), true, true);
  let low = 0;
  if (fitsOutputBudget(build(0))) {
    let high = numberedLines.length;
    while (low + 1 < high) {
      const mid = low + ((high - low) >> 1);
      if (fitsOutputBudget(build(mid))) low = mid;
      else high = mid;
    }
  }
  return {
    ...rendered,
    output: build(low),
    preview: numberedLines.slice(0, Math.min(low, 20)).join('\n'),
    truncated: true,
    hasMore: true,
    truncatedByBytes: true,
    endLine: result.startLine + low - 1,
  };
}

export function formatTextResult(
  result: TextReadResult | NotebookReadResult,
): string {
  return renderTextResult(result).output;
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
    ATTACHMENT_UNAVAILABLE_NOTE,
  ].join('\n');
}
