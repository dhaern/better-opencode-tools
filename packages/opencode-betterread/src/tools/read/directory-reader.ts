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
  signal?: AbortSignal,
): Promise<DirectoryScanResult> {
  signal?.throwIfAborted();
  const directory = await opendir(resolvedPath);
  const entries: ScannedDirectoryEntry[] = [];

  try {
    while (entries.length < MAX_DIRECTORY_SCAN_ENTRIES) {
      // Cooperative cancellation: a scan aborted by the user stops instead
      // of walking up to 65k entries with the signal already fired.
      signal?.throwIfAborted();
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

// Trailing "/" for real directories and for symlinks that resolve to a
// directory, matching the native read tool. Only called for entries in the
// visible window so the extra stat cost stays bounded.
async function formatDirectoryEntry(
  resolvedPath: string,
  entry: ScannedDirectoryEntry,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (entry.dirent.isDirectory()) return `${entry.name}/`;
  if (entry.dirent.isSymbolicLink()) {
    try {
      signal?.throwIfAborted();
      if ((await stat(path.join(resolvedPath, entry.name))).isDirectory()) {
        return `${entry.name}/`;
      }
    } catch {
      // Broken symlink: render without decoration.
    }
  }
  return entry.name;
}

// Largest prefix of `entries` whose rendered output still fits the byte/char
// budget, found by binary search instead of rebuilding the output once per
// dropped entry (which is quadratic on large directories). The full page is
// first checked with its real footer flags; the truncation note is only
// budgeted once an actual cut is needed.
function budgetedDirectoryEntries(
  normalizedPath: string,
  entries: string[],
  buildFooter: (entriesCount: number, truncatedByBytes: boolean) => string,
): { selected: string[]; truncatedByBytes: boolean } {
  const build = (count: number, truncatedByBytes: boolean): string =>
    buildDirectoryOutput(
      normalizedPath,
      entries.slice(0, count),
      buildFooter(count, truncatedByBytes),
    );

  if (entries.length === 0 || fitsOutputBudget(build(entries.length, false))) {
    return { selected: entries, truncatedByBytes: false };
  }
  if (!fitsOutputBudget(build(0, true))) {
    return { selected: [], truncatedByBytes: true };
  }

  let low = 0;
  let high = entries.length;
  while (low + 1 < high) {
    const mid = low + ((high - low) >> 1);
    if (fitsOutputBudget(build(mid, true))) {
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
  signal?: AbortSignal,
): Promise<DirectoryReadResult> {
  signal?.throwIfAborted();
  const directoryLimit = getDirectoryLimit(limit);
  const startIndex = Math.max(offset - 1, 0);
  const scan = await (options.scanDirectoryEntries ?? scanDirectoryEntries)(
    resolvedPath,
    signal,
  );
  signal?.throwIfAborted();

  if (!scan.totalEntriesKnown && offset > 1) {
    throw new Error(directoryPaginationLimitMessage(resolvedPath));
  }

  const sortedEntries = scan.entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const visibleDirents = sortedEntries.slice(
    startIndex,
    startIndex + directoryLimit,
  );
  const visible: string[] = [];
  for (const entry of visibleDirents) {
    signal?.throwIfAborted();
    visible.push(await formatDirectoryEntry(resolvedPath, entry, signal));
  }
  signal?.throwIfAborted();
  const normalizedPath = path.normalize(resolvedPath);

  const { selected, truncatedByBytes } = budgetedDirectoryEntries(
    normalizedPath,
    visible,
    (entriesCount, truncated) =>
      buildDirectoryFooter({
        offset,
        entriesCount,
        totalEntries: scan.totalEntries,
        totalEntriesKnown: scan.totalEntriesKnown,
        hasMore:
          truncated ||
          !scan.totalEntriesKnown ||
          startIndex + entriesCount < sortedEntries.length,
        truncatedByBytes: truncated,
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
