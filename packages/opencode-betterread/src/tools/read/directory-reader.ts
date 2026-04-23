import type { Dirent } from 'node:fs';
import { opendir } from 'node:fs/promises';
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

      entries.push({ name: entry.name, dirent: entry });
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
  if (entry.dirent.isDirectory()) return `${entry.name}/`;
  return entry.name;
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
  const visible = sortedEntries.slice(startIndex, startIndex + directoryLimit);
  const selected = visible.map(formatDirectoryEntry);
  let truncatedByBytes = false;
  const normalizedPath = path.normalize(resolvedPath);

  while (selected.length > 0) {
    const hasMore =
      truncatedByBytes ||
      !scan.totalEntriesKnown ||
      startIndex + selected.length < sortedEntries.length;
    const footer = buildDirectoryFooter({
      offset,
      entriesCount: selected.length,
      totalEntries: scan.totalEntries,
      totalEntriesKnown: scan.totalEntriesKnown,
      hasMore,
      truncatedByBytes,
    });

    if (
      fitsOutputBudget(buildDirectoryOutput(normalizedPath, selected, footer))
    ) {
      break;
    }

    selected.pop();
    truncatedByBytes = true;
  }

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
