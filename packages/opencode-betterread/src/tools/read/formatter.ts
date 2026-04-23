import path from 'node:path';
import { ATTACHMENT_UNAVAILABLE_NOTE, MAX_LINE_LENGTH } from './constants';
import { buildDirectoryFooter, buildDirectoryOutput } from './directory-output';
import { fitsOutputBudget } from './output-budget';
import {
  escapeStructuredSingleLineValue,
  escapeStructuredTagValue,
} from './structured-escape';
import type {
  DirectoryReadResult,
  ImageInfoResult,
  NotebookReadResult,
  PdfReadResult,
  TextReadResult,
} from './types';

const OUTPUT_CAPPED_NOTE = '(Output capped by byte budget.)';
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

function materializeContentLines(content: string, lineCount: number): string[] {
  if (lineCount === 0) return [];

  const lines = content.length === 0 ? [''] : content.split('\n');
  if (lines.length >= lineCount) return lines.slice(0, lineCount);

  return lines.concat(
    Array.from({ length: lineCount - lines.length }, () => ''),
  );
}

export function numberContentLines(
  content: string,
  startLine: number,
  lineCount?: number,
): string {
  const lines =
    lineCount === undefined
      ? content.length === 0
        ? []
        : content.split('\n')
      : materializeContentLines(content, lineCount);

  if (lines.length === 0) return '';

  return lines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
}

function selectedLineCount(
  result: TextReadResult | NotebookReadResult,
): number {
  if (result.endLine < result.startLine) return 0;
  return result.endLine - result.startLine + 1;
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

function buildTextNotes(input: {
  truncatedByLineLength: boolean;
  cappedByBudget: boolean;
}): string[] {
  const notes: string[] = [];

  if (input.truncatedByLineLength) {
    notes.push(LINE_TRUNCATED_NOTE);
  }

  if (input.cappedByBudget) {
    notes.push(OUTPUT_CAPPED_NOTE);
  }

  return notes;
}

function buildTextOutput(
  pathValue: string,
  type: 'file' | 'notebook',
  numberedLines: string[],
  footer: string,
  notes: string[],
): string {
  const contentBlock =
    numberedLines.length === 0
      ? '<content>\n</content>'
      : `<content>\n${numberedLines.join('\n')}\n</content>`;

  return [
    `<path>${escapeStructuredTagValue(pathValue)}</path>`,
    `<type>${type}</type>`,
    contentBlock,
    footer,
    ...notes,
  ].join('\n');
}

export function renderTextResult(
  result: TextReadResult | NotebookReadResult,
): RenderedTextResult {
  const type = result.kind === 'notebook' ? 'notebook' : 'file';
  const numberedContent = numberContentLines(
    result.content,
    result.startLine,
    selectedLineCount(result),
  );
  const numberedLines =
    numberedContent.length === 0 ? [] : numberedContent.split('\n');
  const fullFooter = formatFooter(
    result.startLine,
    result.endLine,
    result.totalLines,
    result.hasMore,
  );
  const fullNotes = buildTextNotes({
    truncatedByLineLength: result.truncatedByLineLength,
    cappedByBudget: result.truncatedByBytes,
  });
  const fullOutput = buildTextOutput(
    result.path,
    type,
    numberedLines,
    fullFooter,
    fullNotes,
  );

  if (fitsOutputBudget(fullOutput)) {
    return {
      output: fullOutput,
      preview: numberedLines.slice(0, 20).join('\n'),
      truncated:
        result.hasMore ||
        result.truncatedByBytes ||
        result.truncatedByLineLength,
      hasMore: result.hasMore,
      truncatedByBytes: result.truncatedByBytes,
      truncatedByLineLength: result.truncatedByLineLength,
      startLine: result.startLine,
      endLine: result.endLine,
    };
  }

  const selected: string[] = [];

  for (const line of numberedLines) {
    const candidateLines = [...selected, line];
    const candidateFooter = formatFooter(
      result.startLine,
      result.startLine + candidateLines.length - 1,
      result.totalLines,
      true,
    );
    const candidateNotes = buildTextNotes({
      truncatedByLineLength: result.truncatedByLineLength,
      cappedByBudget: true,
    });
    const candidateOutput = buildTextOutput(
      result.path,
      type,
      candidateLines,
      candidateFooter,
      candidateNotes,
    );

    if (!fitsOutputBudget(candidateOutput)) break;
    selected.push(line);
  }

  const endLine =
    selected.length === 0
      ? result.startLine - 1
      : result.startLine + selected.length - 1;
  const footer = formatFooter(
    result.startLine,
    endLine,
    result.totalLines,
    true,
  );

  return {
    output: buildTextOutput(
      result.path,
      type,
      selected,
      footer,
      buildTextNotes({
        truncatedByLineLength: result.truncatedByLineLength,
        cappedByBudget: true,
      }),
    ),
    preview: selected.slice(0, 20).join('\n'),
    truncated: true,
    hasMore: true,
    truncatedByBytes: true,
    truncatedByLineLength: result.truncatedByLineLength,
    startLine: result.startLine,
    endLine,
  };
}

export function formatTextResult(
  result: TextReadResult | NotebookReadResult,
): string {
  return renderTextResult(result).output;
}

export function formatDirectoryResult(result: DirectoryReadResult): string {
  const footer = buildDirectoryFooter({
    offset: result.offset,
    entriesCount: result.entries.length,
    totalEntries: result.totalEntries,
    totalEntriesKnown: result.totalEntriesKnown,
    hasMore: result.hasMore,
    truncatedByBytes: result.truncatedByBytes,
  });

  return buildDirectoryOutput(result.path, result.entries, footer);
}

export function formatImageInfoResult(result: ImageInfoResult): string {
  const parts = [
    `<path>${escapeStructuredTagValue(result.path)}</path>`,
    '<type>image</type>',
    `<mime>${escapeStructuredTagValue(result.mime)}</mime>`,
    `<size>${result.sizeBytes}</size>`,
  ];
  if (result.width !== undefined && result.height !== undefined) {
    parts.push(`<dimensions>${result.width}x${result.height}</dimensions>`);
  }
  parts.push(
    `Image metadata extracted: ${escapeStructuredSingleLineValue(
      path.basename(result.path),
    )}`,
  );
  return parts.join('\n');
}

export function formatPdfResult(result: PdfReadResult): string {
  return [
    `<path>${escapeStructuredTagValue(result.path)}</path>`,
    '<type>pdf</type>',
    result.pageCount !== undefined
      ? `<page_count>${result.pageCount}</page_count>`
      : undefined,
    ATTACHMENT_UNAVAILABLE_NOTE,
  ]
    .filter(Boolean)
    .join('\n');
}
