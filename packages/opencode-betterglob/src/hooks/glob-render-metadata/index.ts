const TRUNCATED_RE =
  /^\(Results are truncated: (showing first \d+ results|reached the \d+-result limit)\. Consider using a more specific path or pattern\.\)$/;
const STATUS_RE =
  /^Search (timed out before completing|was cancelled before completing|stopped before completing)\.$/;

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

export function parseGlobOutputSummary(output: string): {
  count: number;
  truncated: boolean;
} {
  if (STATUS_RE.test(output.trim())) return { count: 0, truncated: false };
  if (output === 'No files found') return { count: 0, truncated: false };
  if (output.startsWith('glob search failed.\n'))
    return { count: 0, truncated: false };

  const lines = output.split(/\r?\n/);
  if (lines.find((line) => line.length > 0) === 'No files found') {
    return { count: 0, truncated: false };
  }
  const truncated = lines.some((line) => TRUNCATED_RE.test(line));
  const count = lines.filter((line) => {
    if (line.length === 0) return false;
    if (TRUNCATED_RE.test(line)) return false;
    if (STATUS_RE.test(line)) return false;
    return true;
  }).length;

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

      const parsed = parseGlobOutputSummary(output.output);
      const metadata = isRecord(output.metadata) ? output.metadata : {};
      if (typeof metadata.count !== 'number') metadata.count = parsed.count;
      metadata.truncated = Boolean(metadata.truncated) || parsed.truncated;
      output.metadata = metadata;

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
