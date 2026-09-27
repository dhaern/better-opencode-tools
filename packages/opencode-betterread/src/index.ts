import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { createReadRenderMetadataHook } from './hooks/read-render-metadata';
import { READ_DESCRIPTION, READ_TOOL_ID } from './tools/read/constants';
import { createReadTool, readArgsSchema } from './tools/read/tool';

const server: Plugin = async (ctx) => {
  const read = createReadTool(ctx);
  const hook = createReadRenderMetadataHook();

  return {
    tool: {
      read,
    },

    'tool.execute.after': async (input, output) => {
      await hook['tool.execute.after'](
        input as {
          tool: string;
          args?: { filePath?: unknown };
        },
        output as {
          title?: unknown;
        },
      );
    },
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
