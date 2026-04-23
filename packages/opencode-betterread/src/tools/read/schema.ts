import { tool } from '@opencode-ai/plugin';
import {
  DEFAULT_OFFSET,
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
} from './constants';

const z = tool.schema;

export const readArgsSchema: Record<string, unknown> = {
  filePath: z
    .string()
    .min(1)
    .describe(
      'The path to the file or directory to read. Accepts absolute paths, paths relative to the current session directory, and `~/` home-relative paths.',
    ),
  offset: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_OFFSET)
    .describe('The line number to start reading from (1-indexed).'),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_READ_LIMIT)
    .default(DEFAULT_READ_LIMIT)
    .describe(
      `The maximum number of lines to read (defaults to ${DEFAULT_READ_LIMIT}).`,
    ),
};
