interface ToolExecuteAfterInput {
  tool: string;
  args?: {
    filePath?: unknown;
  };
}

interface ToolExecuteAfterOutput {
  title?: unknown;
  metadata?: Record<string, unknown>;
}

function sanitize(value: string, maxLength = 160): string {
  const text = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
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
        const alreadyTruncated = output.metadata.truncated === true;
        output.metadata.truncated =
          alreadyTruncated || hasMore || truncatedByBytes;
      }

      if (typeof output.title === 'string' && output.title.length > 0) return;
      if (typeof input.args?.filePath !== 'string') return;
      if (input.args.filePath.length === 0) return;

      output.title = sanitize(input.args.filePath);
    },
  };
}
