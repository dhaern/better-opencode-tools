import {
  DEFAULT_DIRECTORY_LIMIT,
  DEFAULT_OFFSET,
  DEFAULT_READ_LIMIT,
  MAX_DIRECTORY_LIMIT,
  MAX_LINE_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_CHARS,
  MAX_READ_LIMIT,
} from './constants';
import type { NormalizedReadArgs, ReadArgs } from './types';

export type ReadOutputLimits = { maxLines: number; maxBytes: number };
export const LEGACY_OUTPUT_LIMITS = {
  maxLines: Infinity,
  maxBytes: MAX_OUTPUT_BYTES,
};
export function hostOutputLimits(config?: unknown): ReadOutputLimits {
  const output = (config as { tool_output?: Record<string, unknown> } | null)
    ?.tool_output;
  const valid = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : fallback;
  return {
    maxLines: valid(output?.max_lines, 2000),
    maxBytes: Math.min(MAX_OUTPUT_BYTES, valid(output?.max_bytes, 51_200)),
  };
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const coerced =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(coerced)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(coerced)));
}

export function normalizeReadArgs(input: ReadArgs): NormalizedReadArgs {
  const filePath = (input as { filePath?: unknown }).filePath;
  return {
    filePath: typeof filePath === 'string' ? filePath : '',
    offset: clampInteger(
      input.offset,
      DEFAULT_OFFSET,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    limit: clampInteger(input.limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT),
  };
}

export function getDirectoryLimit(limit: number | undefined): number {
  return clampInteger(limit, DEFAULT_DIRECTORY_LIMIT, 1, MAX_DIRECTORY_LIMIT);
}

export function truncateLine(line: string): {
  value: string;
  truncated: boolean;
} {
  return line.length <= MAX_LINE_LENGTH
    ? { value: line, truncated: false }
    : { value: `${line.slice(0, MAX_LINE_LENGTH)}…`, truncated: true };
}

export function splitLogicalLines(raw: string): string[] {
  if (raw.length === 0) return [];
  const lines = raw.split(/\r\n|\n|\r/);
  if (raw.endsWith('\n') || raw.endsWith('\r')) lines.pop();
  return lines;
}

// Include the newline separator when budgeting each selected line.
export function createOutputBudget(maxBytes = MAX_OUTPUT_BYTES) {
  let chars = 0;
  let bytes = 0;
  let count = 0;
  return {
    tryAdd(line: string): boolean {
      const separatorCost = count === 0 ? 0 : 1;
      const nextChars = chars + separatorCost + line.length;
      if (nextChars > MAX_OUTPUT_CHARS) return false;
      const nextBytes = bytes + separatorCost + Buffer.byteLength(line, 'utf8');
      if (nextBytes > maxBytes) return false;
      chars = nextChars;
      bytes = nextBytes;
      count += 1;
      return true;
    },
  };
}

export function selectBudgetedLines(
  lines: string[],
  offset: number,
  limit: number,
  maxBytes = MAX_OUTPUT_BYTES,
): {
  selected: string[];
  truncatedByBytes: boolean;
  truncatedByLineLength: boolean;
  firstTruncatedLine?: number;
  hasMore: boolean;
} {
  const startIndex = Math.max(offset - 1, 0);
  const selected: string[] = [];
  const budget = createOutputBudget(maxBytes);
  let truncatedByBytes = false;
  let truncatedByLineLength = false;
  let firstTruncatedLine: number | undefined;
  for (const line of lines.slice(startIndex, startIndex + limit)) {
    const normalized = truncateLine(line);
    if (!budget.tryAdd(normalized.value)) {
      truncatedByBytes = true;
      break;
    }
    selected.push(normalized.value);
    if (normalized.truncated) {
      truncatedByLineLength = true;
      firstTruncatedLine ??= offset + selected.length - 1;
    }
  }
  return {
    selected,
    truncatedByBytes,
    truncatedByLineLength,
    firstTruncatedLine,
    hasMore: truncatedByBytes || startIndex + selected.length < lines.length,
  };
}
