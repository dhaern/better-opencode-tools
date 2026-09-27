import type { Dirent } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_CHARS } from './constants';
import {
  buildDirectoryFooter,
  buildDirectoryOutput,
  escapeDirectoryEntry,
} from './directory-output';
import {
  escapeStructuredSingleLineValue,
  escapeStructuredTagValue,
} from './formatter';
import { getDirectoryLimit } from './limits';
import type { DirectoryReadResult } from './types';

const MAX_DIRECTORY_SCAN_ENTRIES = 65_536;
// Bound concurrent symlink stats so wide windows do not flood the thread pool.
const STAT_BATCH_SIZE = 256;

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
  displayPath?: string;
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
): Promise<string> {
  if (entry.dirent.isDirectory()) return `${entry.name}/`;
  if (entry.dirent.isSymbolicLink()) {
    try {
      if ((await stat(path.join(resolvedPath, entry.name))).isDirectory()) {
        return `${entry.name}/`;
      }
    } catch {
      // Broken symlink: render without decoration.
    }
  }
  return entry.name;
}

// Measure each escaped entry once. The full page uses its actual footer flags;
// a shortened page uses the exact footer and truncation note for its count.
function budgetedDirectoryEntries(
  normalizedPath: string,
  entries: string[],
  buildFooter: (entriesCount: number, truncatedByBytes: boolean) => string,
): { selected: string[]; truncatedByBytes: boolean; formattedOutput: string } {
  const escapedPath = escapeStructuredTagValue(normalizedPath);
  const frame = `<path>${escapedPath}</path>\n<type>directory</type>\n<entries>\n\n</entries>\n`;
  let chars = frame.length;
  let bytes = Buffer.byteLength(frame, 'utf8');
  const fits = (footer: string): boolean =>
    chars + footer.length <= MAX_OUTPUT_CHARS &&
    bytes + Buffer.byteLength(footer, 'utf8') <= MAX_OUTPUT_BYTES;
  let selectedCount = 0;
  let checking = fits(buildFooter(0, true));
  const escapedEntries: string[] = [];
  for (const entry of entries) {
    const escaped = escapeDirectoryEntry(entry);
    chars += escaped.length + (escapedEntries.length === 0 ? 0 : 1);
    bytes +=
      Buffer.byteLength(escaped, 'utf8') +
      (escapedEntries.length === 0 ? 0 : 1);
    escapedEntries.push(escaped);
    if (checking && fits(buildFooter(escapedEntries.length, true))) {
      selectedCount = escapedEntries.length;
    } else {
      checking = false;
    }
  }
  const truncatedByBytes =
    entries.length > 0 && !fits(buildFooter(entries.length, false));
  const selected = truncatedByBytes ? entries.slice(0, selectedCount) : entries;
  return {
    selected,
    truncatedByBytes,
    formattedOutput: buildDirectoryOutput(
      normalizedPath,
      selected,
      buildFooter(selected.length, truncatedByBytes),
      truncatedByBytes
        ? escapedEntries.slice(0, selectedCount)
        : escapedEntries,
    ),
  };
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
  for (let index = 0; index < visibleDirents.length; index += STAT_BATCH_SIZE) {
    signal?.throwIfAborted();
    visible.push(
      ...(await Promise.all(
        visibleDirents
          .slice(index, index + STAT_BATCH_SIZE)
          .map((entry) => formatDirectoryEntry(resolvedPath, entry)),
      )),
    );
  }
  signal?.throwIfAborted();
  const normalizedPath = path.normalize(options.displayPath ?? resolvedPath);

  const { selected, truncatedByBytes, formattedOutput } =
    budgetedDirectoryEntries(
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
    formattedOutput,
  };
}
