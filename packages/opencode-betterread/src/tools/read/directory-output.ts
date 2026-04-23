import {
  escapeStructuredSingleLineValue,
  escapeStructuredTagValue,
} from './structured-escape';

const OUTPUT_CAPPED_NOTE = '(Output capped by byte budget.)';

type DirectoryFooterInput = {
  offset: number;
  entriesCount: number;
  totalEntries: number;
  totalEntriesKnown?: boolean;
  hasMore: boolean;
  truncatedByBytes: boolean;
};

function appendOutputCappedNote(
  message: string,
  truncatedByBytes: boolean,
): string {
  return truncatedByBytes ? `${message}\n${OUTPUT_CAPPED_NOTE}` : message;
}

export function buildDirectoryFooter(input: DirectoryFooterInput): string {
  const totalEntriesKnown = input.totalEntriesKnown ?? true;

  if (
    input.entriesCount === 0 &&
    totalEntriesKnown &&
    input.offset > Math.max(input.totalEntries, 1)
  ) {
    return `(Offset ${input.offset} is out of range for this directory (${input.totalEntries} entries))`;
  }

  if (!totalEntriesKnown) {
    if (input.entriesCount === 0) {
      return appendOutputCappedNote(
        `(No entries returned from a bounded directory scan of at least ${input.totalEntries} entries. Exact pagination beyond the first window is not supported; use a more specific path.)`,
        input.truncatedByBytes,
      );
    }

    return appendOutputCappedNote(
      `(Showing entries ${input.offset}-${input.offset + input.entriesCount - 1} of at least ${input.totalEntries} from a bounded directory scan. Exact pagination beyond the first window is not supported; use a more specific path.)`,
      input.truncatedByBytes,
    );
  }

  if (input.hasMore) {
    const base = `(Showing entries ${input.offset}-${input.offset + input.entriesCount - 1} of ${input.totalEntries}. Use offset=${input.offset + input.entriesCount} to continue.)`;
    return appendOutputCappedNote(base, input.truncatedByBytes);
  }

  return `(End of directory - ${input.totalEntries} entries)`;
}

export function buildDirectoryOutput(
  resolvedPath: string,
  entries: string[],
  footer: string,
): string {
  return [
    `<path>${escapeStructuredTagValue(resolvedPath)}</path>`,
    '<type>directory</type>',
    '<entries>',
    entries.map(escapeDirectoryEntry).join('\n'),
    '</entries>',
    footer,
  ].join('\n');
}

export function escapeDirectoryEntry(entry: string): string {
  return escapeStructuredSingleLineValue(entry);
}
