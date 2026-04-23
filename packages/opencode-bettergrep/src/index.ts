import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { createGrepRenderMetadataHook } from './hooks/grep-render-metadata';
import {
  createGrepTool,
  formatGrepResult,
  GREP_DESCRIPTION,
  GREP_TOOL_ID,
  getInstalledRipgrepPath,
  getRipgrepBinaryName,
  getRipgrepCacheDir,
  installLatestStableRipgrep,
  normalizeGrepInput,
  resolveGrepCli,
  resolveGrepCliWithAutoInstall,
} from './tools/grep';

const server: Plugin = async (ctx) => {
  const grep = createGrepTool(ctx);
  const grepRenderMetadataHook = createGrepRenderMetadataHook();

  return {
    tool: {
      grep,
    },

    'tool.execute.after': async (input, output) => {
      await grepRenderMetadataHook['tool.execute.after'](
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
  id: 'opencode-bettergrep',
  server,
} satisfies PluginModule;

export {
  createGrepRenderMetadataHook,
  createGrepTool,
  formatGrepResult,
  GREP_DESCRIPTION,
  GREP_TOOL_ID,
  getInstalledRipgrepPath,
  getRipgrepBinaryName,
  getRipgrepCacheDir,
  installLatestStableRipgrep,
  normalizeGrepInput,
  resolveGrepCli,
  resolveGrepCliWithAutoInstall,
};
