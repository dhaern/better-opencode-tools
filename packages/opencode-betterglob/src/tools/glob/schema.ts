import { tool } from '@opencode-ai/plugin';
import { DEFAULT_GLOB_LIMIT, DEFAULT_GLOB_TIMEOUT_MS } from './constants';

const z = tool.schema;

export const globArgsSchema: Record<string, unknown> = {
  pattern: z
    .string()
    .min(1)
    .describe('The glob pattern to match files against'),
  path: z
    .string()
    .optional()
    .describe(
      'The directory to search in. If not specified, the current working directory will be used. Must be a valid directory path if provided.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_GLOB_LIMIT)
    .describe('Maximum number of file paths to return.'),
  sort_by: z
    .enum(['mtime', 'path', 'none'])
    .default('mtime')
    .describe('Ordering mode. mtime orders by modification time.'),
  sort_order: z
    .enum(['desc', 'asc'])
    .optional()
    .describe('Ordering direction.'),
  hidden: z
    .boolean()
    .default(true)
    .describe(
      'Include hidden files and directories while respecting rg ignore rules.',
    ),
  follow_symlinks: z
    .boolean()
    .default(false)
    .describe('Follow symbolic links.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_GLOB_TIMEOUT_MS)
    .describe('Timeout in milliseconds for the rg process after it starts.'),
};
