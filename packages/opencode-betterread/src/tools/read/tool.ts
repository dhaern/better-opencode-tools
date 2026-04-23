import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { READ_DESCRIPTION } from './constants';
import { executeRead, inspectReadTarget } from './engine';
import { normalizeReadArgs } from './limits';
import {
  askExternalDirectoryPermission,
  askReadPermission,
  selectExternalPermissionTarget,
} from './permissions';
import { readArgsSchema } from './schema';
import type { ReadArgs } from './types';

interface CreateReadToolOptions {
  inspect?: typeof inspectReadTarget;
  execute?: typeof executeRead;
}

export function createReadTool(
  pluginCtx: PluginInput,
  options: CreateReadToolOptions = {},
): ToolDefinition {
  const inspect = options.inspect ?? inspectReadTarget;
  const execute = options.execute ?? executeRead;
  const argsSchema = readArgsSchema as Parameters<typeof tool>[0]['args'];

  return tool({
    description: READ_DESCRIPTION,
    args: argsSchema,
    async execute(args, ctx) {
      const rawArgs = args as unknown as ReadArgs;
      const normalized = normalizeReadArgs(rawArgs);
      const directory = ctx.directory ?? pluginCtx.directory;
      const worktree = ctx.worktree ?? pluginCtx.worktree;
      const inspection = await inspect({ args: normalized, directory });

      const permissionCtx = {
        ask: ctx.ask,
        directory,
        worktree,
      };
      const externalTarget = selectExternalPermissionTarget({
        ctx: permissionCtx,
        resolvedPath: inspection.resolvedPath,
        accessPath: inspection.accessPath,
      });

      if (externalTarget) {
        await askExternalDirectoryPermission({
          ctx: permissionCtx,
          targetPath: externalTarget,
          kind: inspection.kind === 'directory' ? 'directory' : 'file',
          metadata: {
            requested_path: normalized.filePath,
            resolved_path: inspection.resolvedPath,
            access_path: inspection.accessPath,
            ...(inspection.realPath ? { real_path: inspection.realPath } : {}),
            exists: inspection.exists,
          },
        });
      }

      await askReadPermission({
        ctx,
        requestedPath: normalized.filePath,
        resolvedPath: inspection.resolvedPath,
        accessPath: inspection.accessPath,
        realPath: inspection.realPath,
        offset: normalized.offset,
        limit: normalized.limit,
      });

      const result = await execute({
        args: normalized,
        directory,
        inspection,
      });

      return {
        output: result.output,
        metadata: result.metadata,
      };
    },
  });
}
