/// <reference types="bun-types" />
import { expect, test } from 'bun:test';
import plugin, * as exports from './index';

test('public module exposes exactly the grep contract and registers its hook', async () => {
  expect(Object.keys(exports).sort()).toEqual([
    'GREP_DESCRIPTION',
    'GREP_TOOL_ID',
    'createGrepRenderMetadataHook',
    'createGrepTool',
    'default',
    'formatGrepResult',
    'getInstalledRipgrepPath',
    'getRipgrepBinaryName',
    'getRipgrepCacheDir',
    'installLatestStableRipgrep',
    'normalizeGrepInput',
    'resolveGrepCli',
    'resolveGrepCliWithAutoInstall',
  ]);
  expect(plugin).toEqual({ id: 'opencode-bettergrep', server: plugin.server });
  const registered = await plugin.server({
    directory: process.cwd(),
    worktree: process.cwd(),
  } as never);
  expect(Object.keys(registered).sort()).toEqual([
    'tool',
    'tool.execute.after',
  ]);
  expect(Object.keys(registered.tool ?? {})).toEqual(['grep']);
  expect(typeof registered['tool.execute.after']).toBe('function');
});
