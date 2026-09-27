import { OUTPUT_CAPPED_NOTE } from './constants';
import {
  escapeStructuredSingleLineValue,
  escapeStructuredTagValue,
} from './formatter';
import type { DirectoryReadResult } from './types';

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

export function escapeDirectoryEntry(entry: string): string {
  return escapeStructuredSingleLineValue(entry);
}

export function buildDirectoryOutput(
  displayPath: string,
  entries: string[],
  footer: string,
): string {
  return [
    `<path>${escapeStructuredTagValue(displayPath)}</path>`,
    '<type>directory</type>',
    '<entries>',
    entries.map(escapeDirectoryEntry).join('\n'),
    '</entries>',
    footer,
  ].join('\n');
}

export function formatDirectoryResult(result: DirectoryReadResult): string {
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
