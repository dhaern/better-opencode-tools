import type { Plugin } from '@opencode/plugin';
import type { PluginInput } from '@opencode-ai/plugin';
import { createGlobTool } from '../tools/glob/tool';
import { initLogger } from '../utils/logger';
import { adaptTool } from './adapter';

export const setup: Plugin.Plugin['setup'] = async (ctx) => {
  initLogger(ctx.location.project.id);
  const legacy = createGlobTool({
    directory: ctx.location.directory,
    worktree: ctx.location.project.directory,
  } as unknown as PluginInput);
  const adapted = adaptTool(ctx, 'glob', legacy);
  await ctx.tool.transform((editor) => editor.add(adapted));
};
