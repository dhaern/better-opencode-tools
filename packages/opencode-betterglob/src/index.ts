import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { createGlobRenderMetadataHook } from './hooks/glob-render-metadata';
import { createGlobTool } from './tools/glob';
import { initLogger } from './utils';

const server: Plugin = async (ctx) => {
  initLogger(ctx.project.id);
  const glob = createGlobTool(ctx);
  const hook = createGlobRenderMetadataHook();

  return {
    tool: {
      glob,
    },

    'tool.execute.after': async (input, output) => {
      await hook['tool.execute.after'](
        input as {
          tool: string;
          args?: { pattern?: unknown };
        },
        output as {
          title?: unknown;
          output: unknown;
          metadata?: unknown;
        },
      );
    },
  };
};

export default {
  id: 'opencode-betterglob',
  server,
} satisfies PluginModule;
