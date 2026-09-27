import type { GrepSearchResult, NormalizedGrepInput } from './types';

export function pluralize(
  count: number,
  singular: string,
  plural = singular.endsWith('match') ? `${singular}es` : `${singular}s`,
): string {
  return count === 1 ? singular : plural;
}

// Parse-back patterns for the summaries built below. They live next to the
// literals they recognize so the hook cannot drift from the formatter; the
// hook test pins every formatGrepResult variant against them.
export const FILE_SUMMARY_RE_SOURCE = String.raw`^Found (\d+) matching file(?:s)?\.$`;
export const MATCH_SUMMARY_RE_SOURCE = String.raw`^Found (\d+)(?: total)? match(?:es)? across (\d+) file(?:s)?\.$`;
export const NO_RESULTS_RE_SOURCE = String.raw`^(?:No matches found\.|No files found\.|No visible (?:results|files) were collected before the search stopped\.)$`;
export const MTIME_NO_VISIBLE_RE_SOURCE = String.raw`^(?:mtime (?:sorting|replay|discovery) could not produce visible results after discovering \d+ candidate file(?:s)?\.|Search stopped during mtime (?:sorting|replay|discovery) after discovering \d+ candidate file(?:s)? before replay produced visible results\.)$`;

export function buildPrimarySummary(result: GrepSearchResult): string {
  switch (result.matchKind) {
    case 'file':
      return `Found ${result.totalMatches} matching ${pluralize(result.totalMatches, 'file')}.`;
    case 'occurrence':
      return `Found ${result.totalMatches} total ${pluralize(result.totalMatches, 'match')} across ${result.totalFiles} ${pluralize(result.totalFiles, 'file')}.`;
    default:
      return `Found ${result.totalMatches} ${pluralize(result.totalMatches, 'match')} across ${result.totalFiles} ${pluralize(result.totalFiles, 'file')}.`;
  }
}

export function buildLimitNote(
  input: NormalizedGrepInput,
  result: GrepSearchResult,
): string {
  if (result.matchKind === 'file' || result.outputMode === 'count') {
    return `Stopped after collecting ${input.maxResults} matching ${pluralize(input.maxResults, 'file')} (global limit).`;
  }

  return `Stopped after collecting ${input.maxResults} ${pluralize(input.maxResults, 'match')} (global limit).`;
}
