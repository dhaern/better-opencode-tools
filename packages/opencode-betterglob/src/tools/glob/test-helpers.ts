/// <reference types="bun-types" />
import { afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetGlobCliResolverForTests } from './resolver';

function createTempPath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

export function createTempDir(prefix = 'opencode-betterglob'): string {
  const dir = createTempPath(prefix);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createTempRepo(): string {
  const dir = createTempDir('opencode-betterglob');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
  writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  return dir;
}

export function createTempTracker(options: { resetResolver?: boolean } = {}) {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }

    if (options.resetResolver) resetGlobCliResolverForTests();
    mock.restore();
  });

  return {
    add<T extends string>(dir: T): T {
      dirs.push(dir);
      return dir;
    },
    createDir(prefix?: string): string {
      const dir = createTempDir(prefix);
      dirs.push(dir);
      return dir;
    },
    createRepo(): string {
      const dir = createTempRepo();
      dirs.push(dir);
      return dir;
    },
  };
}

export function createRepoContext(directory: string, worktree = directory) {
  return {
    directory,
    worktree,
  } as const;
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
