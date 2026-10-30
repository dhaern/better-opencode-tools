import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { createReadRenderMetadataHook } from './hooks/read-render-metadata';
import { READ_DESCRIPTION, READ_TOOL_ID } from './tools/read/constants';
import { hostOutputLimits } from './tools/read/limits';
import { createReadTool, readArgsSchema } from './tools/read/tool';
import { setup } from './v2/plugin';

const server: Plugin = async (ctx) => {
  let outputLimits = hostOutputLimits();

  return {
    config: async (config) => {
      outputLimits = hostOutputLimits(config);
    },
    tool: {
      read: createReadTool({ ...ctx, readLimits: () => outputLimits }),
    },

    ...createReadRenderMetadataHook(),
  };
};

export default {
  id: 'opencode-betterread',
  server,
  setup,
} satisfies PluginModule & { setup: typeof setup };

export {
  createReadRenderMetadataHook,
  createReadTool,
  READ_DESCRIPTION,
  READ_TOOL_ID,
  readArgsSchema,
};
