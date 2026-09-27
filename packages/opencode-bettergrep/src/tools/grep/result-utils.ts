import type {
  GrepContextLine,
  GrepFileMatch,
  GrepMatchKind,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

export function getMatchKind(
  outputMode: NormalizedGrepInput['outputMode'],
): GrepMatchKind {
  if (outputMode === 'files_with_matches') {
    return 'file';
  }

  if (outputMode === 'count') {
    return 'occurrence';
  }

  return 'match';
}

export function createEmptyResult(
  input: NormalizedGrepInput,
  command?: string[],
): GrepSearchResult {
  return {
    files: [],
    totalMatches: 0,
    totalFiles: 0,
    outputMode: input.outputMode,
    matchKind: getMatchKind(input.outputMode),
    truncated: false,
    limitReached: false,
    timedOut: false,
    cancelled: false,
    exitCode: 0,
    retryCount: 0,
    command,
    cwd: input.cwd,
    stderr: '',
    warnings: [],
  };
}

export interface FileMatchInfo {
  file: string;
  absolutePath: string;
  replayPath?: string;
  nonUtf8Path?: boolean;
  pathKey?: string;
}

/**
 * Single file-match factory for every result model (ripgrep, GNU fallback,
 * mtime discovery). Optional fields stay absent when undefined so each
 * backend keeps its exact observable shape.
 */
export function createFileMatch(info: FileMatchInfo): GrepFileMatch {
  return {
    file: info.file,
    absolutePath: info.absolutePath,
    ...(info.replayPath !== undefined ? { replayPath: info.replayPath } : {}),
    ...(info.nonUtf8Path !== undefined
      ? { nonUtf8Path: info.nonUtf8Path }
      : {}),
    ...(info.pathKey !== undefined ? { pathKey: info.pathKey } : {}),
    matchCount: 0,
    matches: [],
  };
}

/**
 * Bounded context-line buffer shared by the ripgrep and GNU fallback result
 * models. keepFirst retains the earliest lines (trailing `after` context);
 * otherwise the latest lines are retained (rolling `before` context).
 */
export function appendContextLine(
  target: GrepContextLine[],
  line: GrepContextLine,
  maxItems: number,
  keepFirst: boolean,
  dedupeAdjacent: boolean,
): void {
  if (maxItems <= 0) {
    return;
  }

  const last = target[target.length - 1];
  if (
    dedupeAdjacent &&
    last &&
    last.lineNumber === line.lineNumber &&
    last.text === line.text
  ) {
    return;
  }

  if (keepFirst) {
    if (target.length >= maxItems) {
      return;
    }
    target.push(line);
    return;
  }

  target.push(line);
  if (target.length > maxItems) {
    target.splice(0, target.length - maxItems);
  }
}

export function hasVisibleResults(
  result: Pick<GrepSearchResult, 'totalFiles' | 'totalMatches'>,
): boolean {
  return result.totalFiles > 0 || result.totalMatches > 0;
}

export function applySuccessfulStderr(
  result: GrepSearchResult,
  stderr: string,
  exitCode: number,
): void {
  if (stderr.length > 0 && exitCode === 0) {
    result.warnings.push(stderr);
    result.stderr = '';
  }
}

export function finalizeNonFatalExit(
  result: GrepSearchResult,
  exitCode: number,
  stderr = result.stderr,
): GrepSearchResult | undefined {
  if (exitCode === 0) {
    return result;
  }

  if (exitCode === 1 && !hasVisibleResults(result) && stderr.length === 0) {
    return result;
  }

  if (hasVisibleResults(result)) {
    const detail = result.stderr || `rg exited with code ${String(exitCode)}`;
    result.truncated = true;
    result.warnings.push(`Partial ripgrep failure: ${detail}`);
    result.stderr = '';
    return result;
  }

  return undefined;
}

export function countVisibleMatches(files: GrepFileMatch[]): number {
  return files.reduce((sum, file) => sum + file.matches.length, 0);
}

export function countOccurrences(files: GrepFileMatch[]): number {
  return files.reduce((sum, file) => sum + file.matchCount, 0);
}

export function trimFilesToLineLimit(
  files: GrepFileMatch[],
  maxResults: number,
): GrepFileMatch[] {
  let remaining = maxResults;
  const trimmed: GrepFileMatch[] = [];

  for (const file of files) {
    if (remaining <= 0) {
      break;
    }

    if (file.matches.length <= remaining) {
      trimmed.push(file);
      remaining -= file.matches.length;
      continue;
    }

    trimmed.push({
      ...file,
      matchCount: Math.min(file.matchCount, remaining),
      matches: file.matches.slice(0, remaining),
    });
    remaining = 0;
  }

  return trimmed;
}

export function finalizeMtimeContentResult(
  input: NormalizedGrepInput,
  files: GrepFileMatch[],
  baseResult: GrepSearchResult,
  moreDueToLimit: boolean,
): GrepSearchResult {
  const limitedFiles = trimFilesToLineLimit(files, input.maxResults);
  const visibleMatches = countVisibleMatches(limitedFiles);
  const hiddenByTrim = files.some((file, index) => {
    const visible = limitedFiles[index];
    return visible ? visible.matches.length < file.matches.length : true;
  });
  const limitReached =
    baseResult.limitReached || moreDueToLimit || hiddenByTrim;

  return {
    ...baseResult,
    files: limitedFiles,
    totalMatches: visibleMatches,
    totalFiles: limitedFiles.length,
    matchKind: 'match',
    truncated: baseResult.truncated || limitReached,
    limitReached,
  };
}

export function finalizeMtimeSimpleResult(
  input: NormalizedGrepInput,
  files: GrepFileMatch[],
  baseResult: GrepSearchResult,
  moreDueToLimit: boolean,
): GrepSearchResult {
  const limitedFiles = files.slice(0, input.maxResults);
  const totalMatches =
    input.outputMode === 'count'
      ? countOccurrences(limitedFiles)
      : limitedFiles.length;
  const limitReached = baseResult.limitReached || moreDueToLimit;

  return {
    ...baseResult,
    files: limitedFiles,
    totalMatches,
    totalFiles: limitedFiles.length,
    matchKind: getMatchKind(input.outputMode),
    truncated: baseResult.truncated || limitReached,
    limitReached,
  };
}
