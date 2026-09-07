import path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { runOpenCodeSideEffect } from '../../utils/opencode-effects';
import { READ_TOOL_ID } from './constants';

type AskContext = Pick<ToolContext, 'ask' | 'directory' | 'worktree'>;

function contains(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
  return true;
}

function isEffectiveBoundary(root: string): boolean {
  const resolvedRoot = path.resolve(root);
  return resolvedRoot !== path.parse(resolvedRoot).root;
}

function containsWithinBoundary(root: string, target: string): boolean {
  return isEffectiveBoundary(root) && contains(root, target);
}

export function isWithinProjectBoundary(
  ctx: AskContext,
  target: string,
): boolean {
  if (containsWithinBoundary(ctx.directory, target)) return true;
  return containsWithinBoundary(ctx.worktree, target);
}

export function selectExternalPermissionTarget(input: {
  ctx: AskContext;
  resolvedPath: string;
  accessPath: string;
}): string | undefined {
  const candidates = [...new Set([input.accessPath, input.resolvedPath])];

  return candidates.find(
    (candidate) => !isWithinProjectBoundary(input.ctx, candidate),
  );
}

// The host wildcard matcher only treats * and ? as glob operators (a
// backslash acts as an escape, so it is rejected too); characters like [],
// () and {} are matched literally and must stay usable in permission paths.
const GLOB_META_CHARS = /[*?\\]/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\[^\\]+\\[^\\]+/;

function isWindowsStylePath(candidate: string): boolean {
  return WINDOWS_DRIVE_PATH.test(candidate) || WINDOWS_UNC_PATH.test(candidate);
}

function normalizePermissionPathSeparators(permissionPath: string): string {
  if (path.sep === '\\') return permissionPath.replaceAll('\\', '/');
  return isWindowsStylePath(permissionPath)
    ? permissionPath.replaceAll('\\', '/')
    : permissionPath;
}

function normalizePermissionGlobPath(parentDir: string): string {
  const normalized = normalizePermissionPathSeparators(parentDir);
  if (normalized === '/') return normalized;
  return normalized.replace(/\/+$/g, '');
}

export function assertSafePermissionPath(permissionPath: string): string {
  if (GLOB_META_CHARS.test(permissionPath)) {
    throw new Error(
      `Cannot request a safe read permission for a path with wildcard metacharacters: ${permissionPath}`,
    );
  }

  return permissionPath;
}

export function permissionGlob(parentDir: string): string {
  const literalParent = assertSafePermissionPath(
    normalizePermissionGlobPath(parentDir),
  );

  return literalParent.endsWith('/')
    ? `${literalParent}*`
    : `${literalParent}/*`;
}

export async function askExternalDirectoryPermission(input: {
  ctx: AskContext;
  targetPath: string;
  kind: 'file' | 'directory';
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  if (isWithinProjectBoundary(input.ctx, input.targetPath)) return false;

  const parentDir =
    input.kind === 'directory'
      ? input.targetPath
      : path.dirname(input.targetPath);
  const glob = permissionGlob(parentDir);

  await runOpenCodeSideEffect(
    input.ctx.ask({
      permission: 'external_directory',
      patterns: [glob],
      always: [glob],
      metadata: {
        filepath: input.targetPath,
        parentDir,
        kind: input.kind,
        ...(input.metadata ?? {}),
      },
    }),
  );

  return true;
}

// The native read tool asks for permission with the target path relative to
// the worktree, so host rules like `secrets/*` match the evaluated pattern.
// Mirror that contract; keep `always` scoped to the specific file instead of
// the native blanket `*` so "always allow" stays per-file.
export async function askReadPermission(input: {
  ctx: Pick<ToolContext, 'ask' | 'worktree'>;
  requestedPath: string;
  resolvedPath: string;
  accessPath: string;
  realPath?: string;
  offset: number;
  limit: number;
}): Promise<void> {
  const worktree = input.ctx.worktree;
  const accessPath = normalizePermissionPathSeparators(input.accessPath);
  // Normalize before relativizing so Windows-style paths relativize
  // correctly on every platform; like the native tool, an external target
  // keeps its `../` relative form.
  const relativeOrAbsolute = worktree
    ? path.relative(normalizePermissionPathSeparators(worktree), accessPath) ||
      '.'
    : accessPath;
  const permissionPath = assertSafePermissionPath(relativeOrAbsolute);

  await runOpenCodeSideEffect(
    input.ctx.ask({
      permission: READ_TOOL_ID,
      patterns: [permissionPath],
      always: [permissionPath],
      metadata: {
        filePath: input.requestedPath,
        resolved_path: input.resolvedPath,
        access_path: input.accessPath,
        ...(input.realPath ? { real_path: input.realPath } : {}),
        offset: input.offset,
        limit: input.limit,
      },
    }),
  );
}
