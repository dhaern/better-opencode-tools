import type { Plugin } from '@opencode/plugin';
import type { PluginInput } from '@opencode-ai/plugin';
import { READ_DESCRIPTION } from '../tools/read/constants';
import { hostOutputLimits } from '../tools/read/limits';
import { createReadTool } from '../tools/read/tool';
import { adaptTool } from './adapter';

export const setup: Plugin.Plugin['setup'] = async (ctx) => {
  const legacy = createReadTool({
    directory: ctx.location.directory,
    worktree: ctx.location.project.directory,
    readLimits: () => hostOutputLimits(ctx.options),
  } as unknown as PluginInput & {
    readLimits: () => ReturnType<typeof hostOutputLimits>;
  });
  const { filePath, ...args } = legacy.args;
  const adapted = adaptTool(ctx, 'read', legacy, {
    args: { path: filePath, ...args },
    description: READ_DESCRIPTION.replaceAll('filePath', 'path'),
    input: ({ path, ...rest }) => ({ ...rest, filePath: path }),
  });
  await ctx.tool.transform((editor) => editor.add(adapted));
};
