import path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { Effect } from 'effect';
import { READ_TOOL_ID } from './constants';

type AskContext = Pick<ToolContext, 'ask' | 'directory' | 'worktree'>;

export async function executePermissionEffect<T>(
  value: T | Promise<T> | Effect.Effect<T>,
): Promise<T> {
  if (Effect.isEffect(value)) return Effect.runPromise(value);
  return Promise.resolve(value);
}

function contains(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
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

const GLOB_META_CHARS = /([\\*?[\]{}()!+@])/g;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\[^\\]+\\[^\\]+/;

function isWindowsStylePath(parentDir: string): boolean {
  return WINDOWS_DRIVE_PATH.test(parentDir) || WINDOWS_UNC_PATH.test(parentDir);
}

function normalizePermissionGlobPath(parentDir: string): string {
  const normalized = isWindowsStylePath(parentDir)
    ? parentDir.replaceAll('\\', '/')
    : parentDir;
  if (normalized === '/') return normalized;
  return normalized.replace(/\/+$/g, '');
}

function escapeGlobLiteral(value: string): string {
  return value.replace(GLOB_META_CHARS, '\\$1');
}

export function escapePermissionPathLiteral(permissionPath: string): string {
  return escapeGlobLiteral(permissionPath);
}

function escapePermissionGlobLiteral(permissionPath: string): string {
  return escapeGlobLiteral(normalizePermissionGlobPath(permissionPath));
}

export function permissionGlob(parentDir: string): string {
  const literalParent = escapePermissionGlobLiteral(parentDir);

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

  await executePermissionEffect(
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

export async function askReadPermission(input: {
  ctx: Pick<ToolContext, 'ask'>;
  requestedPath: string;
  resolvedPath: string;
  accessPath: string;
  realPath?: string;
  offset: number;
  limit: number;
}): Promise<void> {
  const permissionPath = escapePermissionPathLiteral(input.accessPath);

  await executePermissionEffect(
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
