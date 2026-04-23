import {
  MAX_LINE_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_CHARS,
} from './constants';

type OutputBudgetState = {
  chars: number;
  bytes: number;
};

export function truncateLine(line: string): {
  value: string;
  truncated: boolean;
} {
  if (line.length <= MAX_LINE_LENGTH) {
    return {
      value: line,
      truncated: false,
    };
  }

  return {
    value: `${line.slice(0, MAX_LINE_LENGTH)}…`,
    truncated: true,
  };
}

export function splitLogicalLines(raw: string): string[] {
  if (raw.length === 0) return [];

  const lines = raw.split(/\r\n|\n|\r/);
  if (raw.endsWith('\n') || raw.endsWith('\r')) {
    lines.pop();
  }
  return lines;
}

export function createOutputBudgetState(): OutputBudgetState {
  return {
    chars: 0,
    bytes: 0,
  };
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
    const normalizedLine = truncateLine(line);
    if (!appendLineWithinOutputBudget(selected, budget, normalizedLine.value)) {
      truncatedByBytes = true;
      break;
    }

    truncatedByLineLength ||= normalizedLine.truncated;
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
