import type { Plugin } from '@opencode/plugin';
import type { PluginInput } from '@opencode-ai/plugin';
import { parseGrepSummary } from '../hooks/grep-render-metadata';
import { createGrepTool } from '../tools/grep/tool';
import { adaptTool } from './adapter';

export const setup: Plugin.Plugin['setup'] = async (ctx) => {
  const legacy = createGrepTool({
    directory: ctx.location.directory,
    worktree: ctx.location.project.directory,
  } as unknown as PluginInput);
  const adapted = adaptTool(ctx, 'grep', legacy, {
    metadata(metadata, output) {
      Object.assign(metadata, parseGrepSummary(output) ?? {});
    },
  });
  await ctx.tool.transform((editor) => editor.add(adapted));
};
