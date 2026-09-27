import type { Plugin, PluginModule } from '@opencode-ai/plugin';
import { createGrepRenderMetadataHook } from './hooks/grep-render-metadata';
import { GREP_DESCRIPTION, GREP_TOOL_ID } from './tools/grep/constants';
import { installLatestStableRipgrep } from './tools/grep/downloader';
import { formatGrepResult } from './tools/grep/format';
import { normalizeGrepInput } from './tools/grep/normalize';
import {
  resolveGrepCli,
  resolveGrepCliWithAutoInstall,
} from './tools/grep/resolver';
import {
  getInstalledRipgrepPath,
  getRipgrepBinaryName,
  getRipgrepCacheDir,
} from './tools/grep/rg-cache';
import { createGrepTool } from './tools/grep/tool';

const server: Plugin = async (ctx) => ({
  tool: { grep: createGrepTool(ctx) },
  'tool.execute.after': createGrepRenderMetadataHook()['tool.execute.after'],
});

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
