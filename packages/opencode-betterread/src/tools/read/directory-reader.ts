import type { Dirent } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_CHARS,
  OUTPUT_CAPPED_NOTE,
} from './constants';
import {
  escapeDirectoryEntry,
  escapeStructuredSingleLineValue,
  escapeStructuredTagValue,
} from './formatter';
import type { ReadOutputLimits } from './limits';
import { getDirectoryLimit, LEGACY_OUTPUT_LIMITS } from './limits';
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
  outputLimits?: ReadOutputLimits;
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
  let totalEntriesKnown = true;
  try {
    while (entries.length < MAX_DIRECTORY_SCAN_ENTRIES) {
      signal?.throwIfAborted();
      const entry = await directory.read();
      if (!entry) break;
      entries.push({ name: entry.name, dirent: entry });
    }
    if (entries.length === MAX_DIRECTORY_SCAN_ENTRIES)
      totalEntriesKnown = !(await directory.read());
  } finally {
    await directory.close();
  }
  return { entries, totalEntries: entries.length, totalEntriesKnown };
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

type DirectoryFooterInput = {
  offset: number;
  entriesCount: number;
  totalEntries: number;
  totalEntriesKnown?: boolean;
  hasMore: boolean;
  truncatedByBytes: boolean;
};

export function buildDirectoryFooter(input: DirectoryFooterInput): string {
  const known = input.totalEntriesKnown ?? true;
  if (
    input.entriesCount === 0 &&
    known &&
    input.offset > Math.max(input.totalEntries, 1)
  ) {
    return `(Offset ${input.offset} is out of range for this directory (${input.totalEntries} entries))`;
  }
  if (known && !input.hasMore) {
    return `(End of directory - ${input.totalEntries} entries)`;
  }
  const range = `${input.offset}-${input.offset + input.entriesCount - 1}`;
  const message = known
    ? `(Showing entries ${range} of ${input.totalEntries}. Use offset=${input.offset + input.entriesCount} to continue.)`
    : input.entriesCount === 0
      ? `(No entries returned from a bounded directory scan of at least ${input.totalEntries} entries. Exact pagination beyond the first window is not supported; use a more specific path.)`
      : `(Showing entries ${range} of at least ${input.totalEntries} from a bounded directory scan. Exact pagination beyond the first window is not supported; use a more specific path.)`;
  return input.truncatedByBytes ? `${message}\n${OUTPUT_CAPPED_NOTE}` : message;
}

export function buildDirectoryOutput(
  displayPath: string,
  entries: string[],
  footer: string,
  escapedEntries = entries.map(escapeDirectoryEntry),
): string {
  return [
    `<path>${escapeStructuredTagValue(displayPath)}</path>`,
    '<type>directory</type>',
    '<entries>',
    escapedEntries.join('\n'),
    '</entries>',
    footer,
  ].join('\n');
}

export function formatDirectoryResult(result: DirectoryReadResult): string {
  if (result.formattedOutput !== undefined) return result.formattedOutput;
  return buildDirectoryOutput(
    result.path,
    result.entries,
    buildDirectoryFooter({
      offset: result.offset,
      entriesCount: result.entries.length,
      totalEntries: result.totalEntries,
      totalEntriesKnown: result.totalEntriesKnown,
      hasMore: result.hasMore,
      truncatedByBytes: result.truncatedByBytes,
    }),
  );
}

// Measure each escaped entry once. The full page uses its actual footer flags;
// a shortened page uses the exact footer and truncation note for its count.
function budgetedDirectoryEntries(
  normalizedPath: string,
  entries: string[],
  buildFooter: (entriesCount: number, truncatedByBytes: boolean) => string,
  outputLimits: ReadOutputLimits,
): { selected: string[]; truncatedByBytes: boolean; formattedOutput: string } {
  const escapedPath = escapeStructuredTagValue(normalizedPath);
  const frame = `<path>${escapedPath}</path>\n<type>directory</type>\n<entries>\n\n</entries>\n`;
  let chars = frame.length;
  let bytes = Buffer.byteLength(frame, 'utf8');
  const maxBytes = Math.min(MAX_OUTPUT_BYTES, outputLimits.maxBytes);
  const fits = (footer: string, count: number): boolean =>
    chars + footer.length <= MAX_OUTPUT_CHARS &&
    bytes + Buffer.byteLength(footer, 'utf8') <= maxBytes &&
    5 + Math.max(1, count) + (footer.includes('\n') ? 1 : 0) <=
      outputLimits.maxLines;
  let selectedCount = 0;
  let checking = fits(buildFooter(0, true), 0);
  const escapedEntries: string[] = [];
  for (const entry of entries) {
    const escaped = escapeDirectoryEntry(entry);
    chars += escaped.length + (escapedEntries.length === 0 ? 0 : 1);
    bytes +=
      Buffer.byteLength(escaped, 'utf8') +
      (escapedEntries.length === 0 ? 0 : 1);
    escapedEntries.push(escaped);
    if (
      checking &&
      fits(buildFooter(escapedEntries.length, true), escapedEntries.length)
    ) {
      selectedCount = escapedEntries.length;
    } else {
      checking = false;
    }
  }
  const truncatedByBytes =
    entries.length > 0 &&
    !fits(buildFooter(entries.length, false), entries.length);
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
  const outputLimits = options.outputLimits ?? LEGACY_OUTPUT_LIMITS;
  const directoryLimit = Math.min(
    getDirectoryLimit(limit),
    outputLimits.maxLines,
  );
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
  const hasMore = (count: number, truncated: boolean): boolean =>
    truncated ||
    !scan.totalEntriesKnown ||
    startIndex + count < scan.entries.length;

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
          hasMore: hasMore(entriesCount, truncated),
          truncatedByBytes: truncated,
        }),
      outputLimits,
    );

  return {
    kind: 'directory',
    path: normalizedPath,
    entries: selected,
    offset,
    limit: directoryLimit,
    totalEntries: scan.totalEntries,
    totalEntriesKnown: scan.totalEntriesKnown,
    hasMore: hasMore(selected.length, truncatedByBytes),
    truncatedByBytes,
    formattedOutput,
  };
}
