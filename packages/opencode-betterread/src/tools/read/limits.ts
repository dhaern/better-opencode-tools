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

type OutputBudgetState = { chars: number; bytes: number };

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

export function createOutputBudgetState(): OutputBudgetState {
  return { chars: 0, bytes: 0 };
}

export function appendLineWithinOutputBudget(
  lines: string[],
  state: OutputBudgetState,
  line: string,
): boolean {
  const separatorCost = lines.length === 0 ? 0 : 1;
  const nextChars = state.chars + separatorCost + line.length;
  if (nextChars > MAX_OUTPUT_CHARS) return false;
  const nextBytes =
    state.bytes + separatorCost + Buffer.byteLength(line, 'utf8');
  if (nextBytes > MAX_OUTPUT_BYTES) return false;
  lines.push(line);
  state.chars = nextChars;
  state.bytes = nextBytes;
  return true;
}

export function selectBudgetedLines(
  lines: string[],
  offset: number,
  limit: number,
): {
  selected: string[];
  truncatedByBytes: boolean;
  truncatedByLineLength: boolean;
  hasMore: boolean;
} {
  const startIndex = Math.max(offset - 1, 0);
  const selected: string[] = [];
  const budget = createOutputBudgetState();
  let truncatedByBytes = false;
  let truncatedByLineLength = false;
  for (const line of lines.slice(startIndex, startIndex + limit)) {
    const normalized = truncateLine(line);
    if (!appendLineWithinOutputBudget(selected, budget, normalized.value)) {
      truncatedByBytes = true;
      break;
    }
    truncatedByLineLength ||= normalized.truncated;
  }
  return {
    selected,
    truncatedByBytes,
    truncatedByLineLength,
    hasMore: truncatedByBytes || startIndex + selected.length < lines.length,
  };
}

export function fitsOutputBudget(content: string): boolean {
  if (content.length > MAX_OUTPUT_CHARS) return false;
  return Buffer.byteLength(content, 'utf8') <= MAX_OUTPUT_BYTES;
}
