/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test';
import {
  askReadPermission,
  escapePermissionPathLiteral,
  isWithinProjectBoundary,
  permissionGlob,
  selectExternalPermissionTarget,
} from './permissions';

describe('tools/read/permissions', () => {
  test('escapes glob metacharacters already present in Unix paths', () => {
    expect(permissionGlob('/tmp/[abc]?{x}(y)!+@*')).toBe(
      '/tmp/\\[abc\\]\\?\\{x\\}\\(y\\)\\!\\+\\@\\*/*',
    );
  });

  test('preserves literal POSIX backslashes instead of treating them as separators', () => {
    expect(permissionGlob('/tmp/a\\b')).toBe('/tmp/a\\\\b/*');
    expect(permissionGlob('/tmp/a\\b')).not.toContain('/tmp/a/b/*');
  });

  test('normalizes Windows separators while preserving only the final wildcard', () => {
    expect(permissionGlob('C:\\Users\\ann\\[docs]\\file?')).toBe(
      'C:/Users/ann/\\[docs\\]/file\\?/*',
    );
  });

  test('escapes literal read permission paths without adding wildcards', () => {
    expect(escapePermissionPathLiteral('/tmp/a*.txt')).toBe('/tmp/a\\*.txt');
    expect(escapePermissionPathLiteral('/tmp/foo[bar].env')).toBe(
      '/tmp/foo\\[bar\\].env',
    );
    const backslashPattern = escapePermissionPathLiteral('/tmp/a\\b[1].txt');
    expect(backslashPattern).toBe('/tmp/a\\\\b\\[1\\].txt');
    expect(backslashPattern).not.toContain('/tmp/a/b');
  });

  test('uses escaped literal paths for read permission prompts', async () => {
    const ask = mock(async () => undefined);

    await askReadPermission({
      ctx: { ask } as any,
      requestedPath: '/tmp/a\\b[1].txt',
      resolvedPath: '/tmp/a\\b[1].txt',
      accessPath: '/tmp/a\\b[1].txt',
      offset: 1,
      limit: 10,
    });

    const request = (
      ask.mock.calls[0] as unknown as [
        {
          patterns: string[];
          always: string[];
        },
      ]
    )[0];
    expect(request.patterns).toEqual(['/tmp/a\\\\b\\[1\\].txt']);
    expect(request.always).toEqual(['/tmp/a\\\\b\\[1\\].txt']);
    expect(request.patterns[0]).not.toContain('/tmp/a/b');
  });

  test('does not treat filesystem root as an effective project boundary', () => {
    const ctx = {
      ask: async () => undefined,
      directory: '/',
      worktree: '/',
    };

    expect(isWithinProjectBoundary(ctx as any, '/tmp/outside.txt')).toBe(false);
    expect(
      selectExternalPermissionTarget({
        ctx: ctx as any,
        resolvedPath: '/tmp/outside.txt',
        accessPath: '/tmp/outside.txt',
      }),
    ).toBe('/tmp/outside.txt');
  });

  test('still respects a non-root worktree when directory is root', () => {
    const ctx = {
      ask: async () => undefined,
      directory: '/',
      worktree: '/workspace/project',
    };

    expect(
      isWithinProjectBoundary(ctx as any, '/workspace/project/file.txt'),
    ).toBe(true);
    expect(isWithinProjectBoundary(ctx as any, '/tmp/outside.txt')).toBe(false);
  });
});
