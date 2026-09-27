import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import {
  DEFAULT_OFFSET,
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  READ_DESCRIPTION,
} from './constants';
import { executeRead, inspectReadTarget } from './engine';
import type { ReadOutputLimits } from './limits';
import { hostOutputLimits } from './limits';
import {
  askExternalDirectoryPermission,
  askReadPermission,
  selectExternalPermissionTarget,
} from './permissions';
import type { ReadArgs } from './types';

const z = tool.schema;

export const readArgsSchema: Record<string, unknown> = {
  filePath: z
    .string()
    .min(1)
    .describe(
      'The path to the file or directory to read. Accepts absolute paths, paths relative to the current session directory, and `~/` home-relative paths.',
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_OFFSET)
    .describe('The line number to start reading from (1-indexed).'),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_READ_LIMIT)
    .default(DEFAULT_READ_LIMIT)
    .describe(
      `The maximum number of lines to read (defaults to ${DEFAULT_READ_LIMIT}).`,
    ),
};

export function createReadTool(
  pluginCtx: PluginInput & {
    readOutputLimits?: () => ReadOutputLimits;
  },
): ToolDefinition {
  return tool({
    description: READ_DESCRIPTION,
    args: readArgsSchema as Parameters<typeof tool>[0]['args'],
    async execute(args, ctx) {
      ctx.abort?.throwIfAborted();
      const directory = ctx.directory ?? pluginCtx.directory;
      const permissionCtx = {
        ask: ctx.ask,
        directory,
        worktree: ctx.worktree ?? pluginCtx.worktree,
      };
      const inspection = await inspectReadTarget({
        args: args as unknown as ReadArgs,
        directory,
      });
      const {
        args: normalized,
        resolvedPath,
        accessPath,
        realPath,
      } = inspection;
      const externalTarget = selectExternalPermissionTarget({
        ctx: permissionCtx,
        resolvedPath,
        accessPath,
      });
      if (externalTarget) {
        await askExternalDirectoryPermission({
          ctx: permissionCtx,
          targetPath: externalTarget,
          kind: inspection.kind === 'directory' ? 'directory' : 'file',
          metadata: {
            requested_path: normalized.filePath,
            resolved_path: resolvedPath,
            access_path: accessPath,
            ...(realPath ? { real_path: realPath } : {}),
            exists: inspection.exists,
          },
        });
      }
      await askReadPermission({
        ctx: permissionCtx,
        requestedPath: normalized.filePath,
        resolvedPath,
        accessPath,
        realPath,
        offset: normalized.offset,
        limit: normalized.limit,
      });

      // executeRead opens the target once after the asks and verifies the
      // descriptor against the inspected identity (TOCTOU closes there).
      const result = await executeRead({
        args: normalized,
        directory,
        inspection,
        signal: ctx.abort,
        outputLimits: pluginCtx.readOutputLimits?.() ?? hostOutputLimits(),
      });
      return {
        output: result.output,
        metadata: result.metadata,
        ...(result.attachments ? { attachments: result.attachments } : {}),
      };
    },
  });
}
