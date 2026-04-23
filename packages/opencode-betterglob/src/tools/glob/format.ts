import { TRUNCATED_NOTE } from './constants';
import type { GlobSearchResult, NormalizedGlobInput } from './types';

export function buildTruncatedNote(limit: number): string {
  return TRUNCATED_NOTE.replace('{limit}', String(limit));
}

function statusNote(result: GlobSearchResult): string | undefined {
  if (result.timedOut) return 'Search timed out before completing.';
  if (result.cancelled) return 'Search was cancelled before completing.';
  if (result.incomplete) return 'Search stopped before completing.';
  return undefined;
}

export function formatGlobResult(
  input: NormalizedGlobInput,
  result: GlobSearchResult,
): string {
  if (result.error) return `glob search failed.\n${result.error}`;

  const note = statusNote(result);
  if (result.files.length === 0) {
    return note ?? 'No files found';
  }

  const lines = [...result.files];
  if (result.truncated) {
    lines.push('', buildTruncatedNote(input.limit));
  }
  if (note) lines.push('', note);
  return lines.join('\n');
}
