interface ToolExecuteAfterInput {
  tool: string;
  args?: {
    pattern?: unknown;
  };
}

interface ToolExecuteAfterOutput {
  title?: unknown;
  output: unknown;
  metadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sanitize(value: string, maxLength = 160): string {
  const text = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

// Text-level fallback used only when the authoritative metadata is missing
// (e.g. the tool crashed before attaching it). Counting lines is unreliable
// for paths containing newlines, so it never overwrites real values.
const TRUNCATED_RE =
  /^\(Results are truncated: (showing first \d+ results|reached the \d+-result limit)\. Consider using a more specific path or pattern\.\)$/;
const STATUS_RE =
  /^Search (timed out before completing|was cancelled before completing|stopped before completing)\.$/;
const FAILED_RE = /^glob search failed\./;

export function parseGlobOutputSummary(output: string): {
  count: number;
  truncated: boolean;
} {
  const text = output.trim();
  if (
    STATUS_RE.test(text) ||
    text === 'No files found' ||
    FAILED_RE.test(text)
  ) {
    return { count: 0, truncated: false };
  }

  const lines = output.split(/\r?\n/);
  // "No files found" followed by a status note (timeout/cancel) is still a
  // zero-result search; paths are absolute so this cannot hide real rows.
  if (lines.find((line) => line.length > 0) === 'No files found') {
    return { count: 0, truncated: false };
  }
  const truncated = lines.some((line) => TRUNCATED_RE.test(line));
  const count = lines.filter(
    (line) =>
      line.length > 0 && !TRUNCATED_RE.test(line) && !STATUS_RE.test(line),
  ).length;

  return { count, truncated };
}

export function createGlobRenderMetadataHook() {
  return {
    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'glob') return;
      if (typeof output.output !== 'string') return;

      const hadMetadata = isRecord(output.metadata);
      const metadata: Record<string, unknown> = hadMetadata
        ? (output.metadata as Record<string, unknown>)
        : {};
      const parsed = parseGlobOutputSummary(output.output);

      // Heuristic text parsing only fills genuinely absent fields: a file
      // name containing newlines can mimic a status note, so authoritative
      // plugin metadata is never second-guessed by line counting.
      if (typeof metadata.search_truncated !== 'boolean') {
        metadata.search_truncated = parsed.truncated;
      }
      if (typeof metadata.count !== 'number') metadata.count = parsed.count;
      if (!hadMetadata) {
        metadata.truncated = parsed.truncated;
        output.metadata = metadata;
      } else {
        // Presentation flag only: host truncation OR search truncation.
        metadata.truncated =
          Boolean(metadata.truncated) ||
          metadata.search_truncated === true ||
          (!hadMetadata && parsed.truncated);
      }

      if (
        (typeof output.title !== 'string' || output.title.length === 0) &&
        typeof input.args?.pattern === 'string' &&
        input.args.pattern.length > 0
      ) {
        output.title = sanitize(input.args.pattern);
      }
    },
  };
}
