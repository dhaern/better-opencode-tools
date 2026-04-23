/// <reference types="bun-types" />
import { afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function createTempPath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

export function createTempDir(prefix = 'opencode-betterread'): string {
  const dir = createTempPath(prefix);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createTempRepo(): string {
  const dir = createTempDir('opencode-betterread');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'src', 'example.ts'),
    [
      "import { createTool } from './tool';",
      'const target = createTool();',
      'export { target };',
      '',
    ].join('\n'),
  );
  return dir;
}

export function createTempTracker() {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }

    mock.restore();
  });

  return {
    add<T extends string>(dir: T): T {
      tempDirs.push(dir);
      return dir;
    },
    createDir(prefix?: string): string {
      const dir = createTempDir(prefix);
      tempDirs.push(dir);
      return dir;
    },
    createRepo(): string {
      const dir = createTempRepo();
      tempDirs.push(dir);
      return dir;
    },
    createSymlink(target: string, linkPath: string): string {
      symlinkSync(target, linkPath);
      return linkPath;
    },
  };
}

export function createExecutionContext(
  directory: string,
  worktree = directory,
) {
  return {
    ask: mock(async () => undefined),
    metadata: mock(() => undefined),
    abort: new AbortController().signal,
    directory,
    worktree,
    sessionID: 'session-1',
    messageID: 'message-1',
    agent: 'explorer',
  } as const;
}
