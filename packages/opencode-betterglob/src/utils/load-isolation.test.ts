import { expect, test } from 'bun:test';
import path from 'node:path';

test('plugin import and Promise-ask execution do not load effect/lockfile or patch globals', () => {
  const script = `
    import fs from 'node:fs';
    const before = { emit: process.emit, reallyExit: process.reallyExit, close: fs.close };
    const snapshot = () => ({
      effectLoaded: Object.keys(require.cache).some(x => /effect\\/dist/.test(x)),
      lockfileLoaded: Object.keys(require.cache).some(x => x.includes('proper-lockfile')),
      emitPatched: process.emit !== before.emit,
      reallyExitPatched: process.reallyExit !== before.reallyExit,
      fsClosePatched: fs.close !== before.close,
    });
    await import('./src/index.ts');
    const atImport = snapshot();
    const { createGlobTool } = await import('./src/tools/glob/tool.ts');
    const cwd = process.cwd();
    const glob = createGlobTool({directory: cwd, worktree: cwd}, {
      resolveCli: () => ({ path: 'rg', backend: 'rg', source: 'system-rg' }),
      run: async input => ({ files: [], count: 0, backend: 'rg', truncated: false,
        incomplete: false, timedOut: false, cancelled: false, exitCode: 0,
        cwd: input.searchPath, stderr: '' }),
    });
    await glob.execute({pattern: '*.ts', path: 'src'}, {
      ask: () => Promise.resolve(), metadata: () => undefined,
      abort: new AbortController().signal, directory: cwd, worktree: cwd,
      sessionID: 's', messageID: 'm', agent: 'a',
    });
    console.log(JSON.stringify({atImport, afterPromise: snapshot()}));
  `;
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: path.resolve(import.meta.dir, '../..'),
  });
  expect(result.exitCode).toBe(0);
  const snapshots = JSON.parse(result.stdout.toString()) as Record<
    string,
    Record<string, boolean>
  >;
  for (const when of ['atImport', 'afterPromise']) {
    expect(snapshots[when]).toEqual({
      effectLoaded: false,
      lockfileLoaded: false,
      emitPatched: false,
      reallyExitPatched: false,
      fsClosePatched: false,
    });
  }
});
