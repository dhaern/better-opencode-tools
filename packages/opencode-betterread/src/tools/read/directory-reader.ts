import type { Dirent } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildDirectoryFooter, buildDirectoryOutput } from './directory-output';
import { getDirectoryLimit } from './limits';
import { fitsOutputBudget } from './output-budget';
import { escapeStructuredSingleLineValue } from './structured-escape';
import type { DirectoryReadResult } from './types';

const MAX_DIRECTORY_SCAN_ENTRIES = 65_536;

type ScannedDirectoryEntry = {
  name: string;
  dirent: Dirent;
  // True for real directories and for symlinks that resolve to a directory,
  // matching the trailing "/" convention of the native read tool.
  dirLike: boolean;
};

type DirectoryScanResult = {
  entries: ScannedDirectoryEntry[];
  totalEntries: number;
  totalEntriesKnown: boolean;
};

type ReadDirectoryOptions = {
  scanDirectoryEntries?: (resolvedPath: string) => Promise<DirectoryScanResult>;
};

function directoryPaginationLimitMessage(resolvedPath: string): string {
  return [
    `Directory exceeds the exact scan limit of ${MAX_DIRECTORY_SCAN_ENTRIES} entries: ${escapeStructuredSingleLineValue(path.normalize(resolvedPath))}.`,
    'Only offset=1 is supported when the scan is bounded; exact pagination beyond the first window is not supported.',
    'Use a more specific path.',
  ].join(' ');
}

async function isDirLike(
  resolvedPath: string,
  entry: Dirent,
): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path.join(resolvedPath, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

async function scanDirectoryEntries(
  resolvedPath: string,
): Promise<DirectoryScanResult> {
  const directory = await opendir(resolvedPath);
  const entries: ScannedDirectoryEntry[] = [];

  try {
    while (entries.length < MAX_DIRECTORY_SCAN_ENTRIES) {
      const entry = await directory.read();
      if (!entry) {
        return {
          entries,
          totalEntries: entries.length,
          totalEntriesKnown: true,
        };
      }

      entries.push({
        name: entry.name,
        dirent: entry,
        dirLike: await isDirLike(resolvedPath, entry),
      });
    }

    const nextEntry = await directory.read();
    if (nextEntry) {
      return {
        entries,
        totalEntries: entries.length,
        totalEntriesKnown: false,
      };
    }

    return {
      entries,
      totalEntries: entries.length,
      totalEntriesKnown: true,
    };
  } finally {
    await directory.close();
  }
}

function formatDirectoryEntry(entry: ScannedDirectoryEntry): string {
  return entry.dirLike ? `${entry.name}/` : entry.name;
}

// Largest prefix of `entries` whose rendered output still fits the byte/char
// budget, found by binary search instead of rebuilding the output once per
// dropped entry (which is quadratic on large directories).
function budgetedDirectoryEntries(
  normalizedPath: string,
  entries: string[],
  buildFooter: (entriesCount: number) => string,
): { selected: string[]; truncatedByBytes: boolean } {
  const build = (count: number): string =>
    buildDirectoryOutput(
      normalizedPath,
      entries.slice(0, count),
      buildFooter(count),
    );

  if (entries.length === 0 || fitsOutputBudget(build(entries.length))) {
    return { selected: entries, truncatedByBytes: false };
  }
  if (!fitsOutputBudget(build(0))) {
    return { selected: [], truncatedByBytes: true };
  }

  let low = 0;
  let high = entries.length;
  while (low + 1 < high) {
    const mid = low + ((high - low) >> 1);
    if (fitsOutputBudget(build(mid))) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return { selected: entries.slice(0, low), truncatedByBytes: true };
}

export async function readDirectory(
  resolvedPath: string,
  offset: number,
  limit: number,
  options: ReadDirectoryOptions = {},
): Promise<DirectoryReadResult> {
  const directoryLimit = getDirectoryLimit(limit);
  const startIndex = Math.max(offset - 1, 0);
  const scan = await (options.scanDirectoryEntries ?? scanDirectoryEntries)(
    resolvedPath,
  );

  if (!scan.totalEntriesKnown && offset > 1) {
    throw new Error(directoryPaginationLimitMessage(resolvedPath));
  }

  const sortedEntries = scan.entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const visible = sortedEntries
    .slice(startIndex, startIndex + directoryLimit)
    .map(formatDirectoryEntry);
  const normalizedPath = path.normalize(resolvedPath);

  const { selected, truncatedByBytes } = budgetedDirectoryEntries(
    normalizedPath,
    visible,
    (entriesCount) =>
      buildDirectoryFooter({
        offset,
        entriesCount,
        totalEntries: scan.totalEntries,
        totalEntriesKnown: scan.totalEntriesKnown,
        hasMore:
          !scan.totalEntriesKnown ||
          startIndex + entriesCount < sortedEntries.length,
        truncatedByBytes: true,
      }),
  );

  const hasMore =
    truncatedByBytes ||
    !scan.totalEntriesKnown ||
    startIndex + selected.length < sortedEntries.length;

  return {
    kind: 'directory',
    path: normalizedPath,
    entries: selected,
    offset,
    limit: directoryLimit,
    totalEntries: scan.totalEntries,
    totalEntriesKnown: scan.totalEntriesKnown,
    hasMore,
    truncatedByBytes,
  };
}
