interface ToolExecuteAfterInput {
  tool: string;
  args?: {
    filePath?: unknown;
  };
}

interface ToolExecuteAfterOutput {
  title?: unknown;
  metadata?: Record<string, unknown>;
  output?: unknown;
}

function sanitize(value: string, maxLength = 160): string {
  const text = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

// Last "N: " numbered content line actually present in the rendered output.
function lastRenderedLineNumber(output: string): number | undefined {
  let last: number | undefined;
  for (const line of output.split('\n')) {
    const match = /^(\d+): /u.exec(line) ?? /^(\d+):$/u.exec(line);
    if (match) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value) && value > (last ?? 0)) last = value;
    }
  }
  return last;
}

export function createReadRenderMetadataHook() {
  return {
    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'read') return;

      if (output.metadata) {
        const hasMore = output.metadata.has_more === true;
        const truncatedByBytes = output.metadata.truncated_by_bytes === true;
        const truncatedByLineLength =
          output.metadata.truncated_by_line_length === true;
        const alreadyTruncated = output.metadata.truncated === true;

        // The host truncates tool output after the plugin returns and marks it
        // with `outputPath`; when that happens the rendered text no longer
        // reaches end_line, so resync the window metadata with what was
        // actually delivered.
        if (
          alreadyTruncated &&
          typeof output.metadata.outputPath === 'string'
        ) {
          const text = typeof output.output === 'string' ? output.output : '';
          const lastLine = lastRenderedLineNumber(text);
          if (
            lastLine !== undefined &&
            typeof output.metadata.end_line === 'number' &&
            lastLine < output.metadata.end_line
          ) {
            output.metadata.end_line = lastLine;
            output.metadata.has_more = true;
          }
        }

        output.metadata.truncated =
          output.metadata.truncated === true ||
          hasMore ||
          output.metadata.has_more === true ||
          truncatedByBytes ||
          truncatedByLineLength;
      }

      if (typeof output.title === 'string' && output.title.length > 0) return;
      if (typeof input.args?.filePath !== 'string') return;
      if (input.args.filePath.length === 0) return;

      output.title = sanitize(input.args.filePath);
    },
  };
}
