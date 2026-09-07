/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test';
import {
  askReadPermission,
  assertSafePermissionPath,
  isWithinProjectBoundary,
  permissionGlob,
  selectExternalPermissionTarget,
} from './permissions';

describe('tools/read/permissions', () => {
  test('rejects wildcard metacharacters in permission paths', () => {
    expect(() => permissionGlob('/tmp/[abc]?{x}(y)!+*')).toThrow(
      /wildcard metacharacters/,
    );
  });

  test('allows scoped package paths containing @', () => {
    const scopedPath =
      '/tmp/project/node_modules/@opencode-ai/plugin/package.json';

    expect(assertSafePermissionPath(scopedPath)).toBe(scopedPath);
    expect(
      permissionGlob('/tmp/project/node_modules/@opencode-ai/plugin'),
    ).toBe('/tmp/project/node_modules/@opencode-ai/plugin/*');
  });

  test('allows bracket, brace and paren characters the host matches literally', () => {
    // Wildcard.match treats []{}()+ as literals; only * ? \ are operators.
    expect(assertSafePermissionPath('/tmp/app/(auth)/page.tsx')).toBe(
      '/tmp/app/(auth)/page.tsx',
    );
    expect(assertSafePermissionPath('/tmp/app/[id]/page.tsx')).toBe(
      '/tmp/app/[id]/page.tsx',
    );
    expect(assertSafePermissionPath('/tmp/lib/a+b.ts')).toBe('/tmp/lib/a+b.ts');
    expect(permissionGlob('/tmp/app/(auth)')).toBe('/tmp/app/(auth)/*');
  });

  test('rejects literal POSIX backslashes instead of using unsafe escapes', () => {
    expect(() => permissionGlob('/tmp/a\\b')).toThrow(
      /wildcard metacharacters/,
    );
  });

  test('normalizes Windows separators while preserving only the final wildcard', () => {
    expect(permissionGlob('C:\\Users\\ann\\docs\\file')).toBe(
      'C:/Users/ann/docs/file/*',
    );
    // Backslash is an escape character in the host matcher, so raw
    // Windows-style paths must be rejected; askReadPermission normalizes
    // separators before the safety check.
    expect(() => assertSafePermissionPath('C:\\Users\\ann\\file.txt')).toThrow(
      /wildcard metacharacters/,
    );
  });

  test('askReadPermission normalizes Windows separators and relativizes to the worktree', async () => {
    const ask = mock(async () => undefined);

    await askReadPermission({
      ctx: { ask, worktree: 'C:\\repo' } as any,
      requestedPath: 'C:\\repo\\src\\file.ts',
      resolvedPath: 'C:\\repo\\src\\file.ts',
      accessPath: 'C:\\repo\\src\\file.ts',
      offset: 1,
      limit: 10,
    });

    const request = (
      ask.mock.calls[0] as unknown as [{ patterns: string[] }]
    )[0];
    expect(request.patterns).toEqual(['src/file.ts']);
  });

  test('allows non-ASCII paths and safe punctuation in permissions', () => {
    const safePath = '/tmp/café/文件,name;ok.txt';

    expect(assertSafePermissionPath(safePath)).toBe(safePath);
    expect(permissionGlob('/tmp/café/文件,name;ok')).toBe(
      '/tmp/café/文件,name;ok/*',
    );
  });

  test('rejects real glob operators in read permission paths', () => {
    expect(() => assertSafePermissionPath('/tmp/a*.txt')).toThrow(
      /wildcard metacharacters/,
    );
    expect(() => assertSafePermissionPath('/tmp/a?.txt')).toThrow(
      /wildcard metacharacters/,
    );
  });

  test('uses safe literal paths for read permission prompts', async () => {
    const ask = mock(async () => undefined);

    await askReadPermission({
      ctx: { ask } as any,
      requestedPath: '/tmp/abc.txt',
      resolvedPath: '/tmp/abc.txt',
      accessPath: '/tmp/abc.txt',
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
    expect(request.patterns).toEqual(['/tmp/abc.txt']);
    expect(request.always).toEqual(['/tmp/abc.txt']);
  });

  test('fails closed when read permission path cannot be represented safely', async () => {
    const ask = mock(async () => undefined);

    await expect(
      askReadPermission({
        ctx: { ask } as any,
        requestedPath: '/tmp/a*.txt',
        resolvedPath: '/tmp/a*.txt',
        accessPath: '/tmp/a*.txt',
        offset: 1,
        limit: 10,
      }),
    ).rejects.toThrow(/wildcard metacharacters/);
    expect(ask).not.toHaveBeenCalled();
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
