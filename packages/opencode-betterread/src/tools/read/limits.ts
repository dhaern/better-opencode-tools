import {
  DEFAULT_DIRECTORY_LIMIT,
  DEFAULT_OFFSET,
  DEFAULT_READ_LIMIT,
  MAX_DIRECTORY_LIMIT,
  MAX_READ_LIMIT,
} from './constants';
import type { NormalizedReadArgs, ReadArgs } from './types';

function normalizeFilePath(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const coerced =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(coerced)) return fallback;
  const normalized = Math.trunc(coerced);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

export function normalizeReadArgs(input: ReadArgs): NormalizedReadArgs {
  return {
    filePath: normalizeFilePath((input as { filePath?: unknown }).filePath),
    offset: clampInteger(
      input.offset,
      DEFAULT_OFFSET,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    limit: clampInteger(input.limit, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT),
  };
}

export function getDirectoryLimit(limit: number | undefined): number {
  return clampInteger(limit, DEFAULT_DIRECTORY_LIMIT, 1, MAX_DIRECTORY_LIMIT);
}
