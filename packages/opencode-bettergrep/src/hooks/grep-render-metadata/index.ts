import { sanitizeTitle } from '../../tools/grep/path-utils';
import {
  FILE_SUMMARY_RE_SOURCE,
  MATCH_SUMMARY_RE_SOURCE,
  MTIME_NO_VISIBLE_RE_SOURCE,
  NO_RESULTS_RE_SOURCE,
} from '../../tools/grep/summary';

const FILE_SUMMARY_RE = new RegExp(FILE_SUMMARY_RE_SOURCE);
const MATCH_SUMMARY_RE = new RegExp(MATCH_SUMMARY_RE_SOURCE);
const NO_RESULTS_RE = new RegExp(NO_RESULTS_RE_SOURCE);
const MTIME_NO_VISIBLE_RE = new RegExp(MTIME_NO_VISIBLE_RE_SOURCE);

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

export function parseGrepSummary(output: string): {
  matches: number;
  files: number;
} | null {
  const lines = output.split(/\r?\n/, 6);
  for (const line of lines) {
    const fileMatch = FILE_SUMMARY_RE.exec(line);
    if (fileMatch) {
      const files = Number.parseInt(fileMatch[1] ?? '0', 10);
      return { matches: files, files };
    }

    const matchSummary = MATCH_SUMMARY_RE.exec(line);
    if (matchSummary) {
      return {
        matches: Number.parseInt(matchSummary[1] ?? '0', 10),
        files: Number.parseInt(matchSummary[2] ?? '0', 10),
      };
    }
  }

  const firstLine = lines.find((line) => line.length > 0);
  if (
    firstLine &&
    (NO_RESULTS_RE.test(firstLine) || MTIME_NO_VISIBLE_RE.test(firstLine))
  ) {
    return { matches: 0, files: 0 };
  }

  return null;
}

export function createGrepRenderMetadataHook() {
  return {
    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'grep') return;
      if (typeof output.output !== 'string') return;

      const counts = parseGrepSummary(output.output);
      const metadata = isRecord(output.metadata) ? output.metadata : {};
      if (counts) {
        metadata.matches = counts.matches;
        metadata.files = counts.files;
      }
      // The host adapter overwrites `truncated` with its own output-truncation
      // flag. Preserve the plugin-owned search truncation under its own key
      // and expose the combined state.
      if (typeof metadata.search_truncated === 'boolean') {
        metadata.truncated =
          metadata.truncated === true || metadata.search_truncated;
      }
      output.metadata = metadata;

      if (
        (typeof output.title !== 'string' || output.title.length === 0) &&
        typeof input.args?.pattern === 'string' &&
        input.args.pattern.length > 0
      ) {
        output.title = sanitizeTitle(input.args.pattern);
      }
    },
  };
}
