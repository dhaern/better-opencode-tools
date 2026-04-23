import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { createReadRenderMetadataHook } from './hooks/read-render-metadata';
import {
  createReadTool,
  READ_DESCRIPTION,
  READ_TOOL_ID,
  readArgsSchema,
} from './tools/read';

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
