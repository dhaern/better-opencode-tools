import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { createReadRenderMetadataHook } from './hooks/read-render-metadata';
import { READ_DESCRIPTION, READ_TOOL_ID } from './tools/read/constants';
import { hostOutputLimits } from './tools/read/limits';
import { createReadTool, readArgsSchema } from './tools/read/tool';

const server: Plugin = async (ctx) => {
  let outputLimits = hostOutputLimits();
  const read = createReadTool({ ...ctx, readOutputLimits: () => outputLimits });
  const hook = createReadRenderMetadataHook();

  return {
    config: async (config) => {
      outputLimits = hostOutputLimits(config);
    },
    tool: {
      read,
    },

    ...hook,
  };
};

export default {
  id: 'opencode-betterread',
  server,
} satisfies PluginModule;

export {
  createReadRenderMetadataHook,
  createReadTool,
  READ_DESCRIPTION,
  READ_TOOL_ID,
  readArgsSchema,
};
