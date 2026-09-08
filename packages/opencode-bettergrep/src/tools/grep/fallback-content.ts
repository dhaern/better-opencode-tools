import {
  consumeNullPrefixedLinesStream,
  type ParsedContentRecord,
  parseContentLine,
} from './fallback-records';
import {
  comparePathBytes,
  createFileMatchFromInfo,
  createSortedAdmission,
  ensureFileMatchBytes,
} from './fallback-results';
import { buildPathFromBytes } from './path-utils';
import { type GrepProcess, killProcess } from './runtime';
import type {
  GrepContextLine,
  GrepFileMatch,
  GrepMatch,
  NormalizedGrepInput,
} from './types';

function toContextLine(record: ParsedContentRecord): GrepContextLine {
  return {
    lineNumber: record.lineNumber,
    text: record.text,
  };
}

function pushRollingContext(
  target: GrepContextLine[],
  line: GrepContextLine,
  maxItems: number,
): void {
  if (maxItems <= 0) {
    return;
  }

  target.push(line);
  if (target.length > maxItems) {
    target.splice(0, target.length - maxItems);
  }
}

function appendTrailingContext(
  match: GrepMatch | undefined,
  line: GrepContextLine,
  maxItems: number,
): void {
  if (!match || maxItems <= 0) {
    return;
  }

  if (
    line.lineNumber <= match.lineNumber ||
    line.lineNumber - match.lineNumber > maxItems
  ) {
    return;
  }

  const byLineNumber = new Map<number, GrepContextLine>();
  for (const existing of match.after) {
    if (
      existing.lineNumber > match.lineNumber &&
      existing.lineNumber - match.lineNumber <= maxItems
    ) {
      byLineNumber.set(existing.lineNumber, existing);
    }
  }
  byLineNumber.set(line.lineNumber, line);
  match.after = [...byLineNumber.values()]
    .sort((left, right) => left.lineNumber - right.lineNumber)
    .slice(0, maxItems);
}

export async function consumeContentOutput(
  stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
  proc: GrepProcess,
  input: Pick<
    NormalizedGrepInput,
    | 'afterContext'
    | 'beforeContext'
    | 'cwd'
    | 'maxResults'
    | 'outputMode'
    | 'sortBy'
    | 'sortOrder'
    | 'worktree'
  >,
): Promise<{
  files: GrepFileMatch[];
  skippedLines: number;
  limitReached: boolean;
}> {
  const files = new Map<string, GrepFileMatch>();
  const withContext = input.beforeContext > 0 || input.afterContext > 0;
  const sorted = input.sortBy === 'path';
  const direction = input.sortOrder === 'desc' ? (-1 as const) : (1 as const);
  let skippedLines = 0;
  let visibleMatches = 0;
  let limitReached = false;
  let beforeBuffer: GrepContextLine[] = [];
  let retainedBudget = input.maxResults;
  let matchesCapped = false;
  const admission = sorted
    ? createSortedAdmission(files, input.maxResults, direction, (evicted) => {
        // Return the evicted file's retained matches to the global budget
        // so the better-ordered replacement can retain its own matches:
        // retention must follow result priority, not arrival order.
        retainedBudget += evicted.matches.length;
        visibleMatches -= evicted.matches.length;
      })
    : null;

  /**
   * Worst file currently RETAINING matches that `file` outranks: its matches
   * are the ones to displace when the global budget is exhausted.
   */
  const worstRetainingFile = (file: GrepFileMatch): GrepFileMatch | null => {
    let worst: GrepFileMatch | null = null;
    for (const candidate of files.values()) {
      if (candidate === file || candidate.matches.length === 0) continue;
      if (comparePathBytes(file, candidate) * direction >= 0) continue;
      if (!worst || comparePathBytes(candidate, worst) * direction > 0) {
        worst = candidate;
      }
    }
    return worst;
  };
  // The last RETAINED match that can still receive trailing context; matches
  // discarded by the budget must not become context targets.
  let lastRetainedMatch: GrepMatch | undefined;
  let lastRetainedMatchFilePath: string | undefined;
  let lastMatchFilePath: string | undefined;

  const resetGroupState = () => {
    beforeBuffer = [];
    lastRetainedMatch = undefined;
    lastRetainedMatchFilePath = undefined;
    lastMatchFilePath = undefined;
  };

  const stopForLimit = () => {
    limitReached = true;
    if (!sorted) {
      killProcess(proc);
    }
  };

  const tryAdmitFile = (rawPath: Uint8Array): GrepFileMatch | null => {
    if (!admission) {
      return ensureFileMatchBytes(files, rawPath, input);
    }

    const pathInfo = buildPathFromBytes(rawPath, input.cwd, input.worktree);
    const existing = files.get(pathInfo.pathKey);
    if (existing) return existing;

    const created = createFileMatchFromInfo(pathInfo);
    if (!admission.admit(created)) {
      return null;
    }
    return created;
  };

  // GLOBAL retained-match budget with priority displacement: total retention
  // stays O(maxResults), and matches of worse-ranked files are dropped in
  // favor of better-ordered arrivals instead of honoring arrival order.
  const appendBoundedMatch = (
    file: GrepFileMatch,
    match: GrepMatch,
  ): boolean => {
    file.matchCount += 1;
    if (retainedBudget <= 0) {
      const worst = worstRetainingFile(file);
      if (!worst) {
        matchesCapped = true;
        return false;
      }
      const removed = worst.matches.pop();
      if (!removed) {
        matchesCapped = true;
        return false;
      }
      matchesCapped = true;
      worst.matchCount = Math.max(0, worst.matchCount - 1);
      visibleMatches -= 1;
      // Rebuild the surviving match's trailing context from every known line
      // carried by the displaced match. A single popped line is insufficient
      // when the requested context spans several lines or contains gaps.
      const survivor = worst.matches[worst.matches.length - 1];
      if (survivor && input.afterContext > 0) {
        const contextCandidates = [
          ...removed.before,
          { lineNumber: removed.lineNumber, text: removed.lineText },
          ...removed.after,
        ]
          .filter(
            (line) =>
              line.lineNumber > survivor.lineNumber &&
              line.lineNumber - survivor.lineNumber <= input.afterContext,
          )
          .sort((left, right) => left.lineNumber - right.lineNumber);

        for (const line of contextCandidates) {
          appendTrailingContext(survivor, line, input.afterContext);
        }
      }
      if (
        lastRetainedMatchFilePath === (worst.pathKey ?? worst.absolutePath) &&
        lastRetainedMatch === removed
      ) {
        lastRetainedMatch = survivor;
        if (!survivor) {
          lastRetainedMatchFilePath = undefined;
        }
      }
    } else {
      retainedBudget -= 1;
    }
    file.matches.push(match);
    visibleMatches += 1;
    return true;
  };

  await consumeNullPrefixedLinesStream(stdout, (record) => {
    if (record === '--') {
      if (!withContext) {
        skippedLines += 1;
        return true;
      }

      if (limitReached && !sorted) {
        stopForLimit();
        return false;
      }

      resetGroupState();
      return true;
    }

    const parsed = parseContentLine(record.filePath, record.line, withContext);
    if (!parsed) {
      skippedLines += 1;
      return true;
    }
    const file = tryAdmitFile(parsed.filePath);
    if (!file) {
      // Sorted mode: this path lost admission against better candidates.
      return true;
    }
    const filePathKey = file.pathKey ?? file.absolutePath;

    if (withContext) {
      if (lastMatchFilePath && filePathKey !== lastMatchFilePath) {
        if (limitReached && !sorted) {
          stopForLimit();
          return false;
        }

        resetGroupState();
      }

      if (parsed.isMatch) {
        if (limitReached && !sorted) {
          // A discarded match can still serve as trailing context of the
          // last retained match, matching ripgrep's adjacent-match output.
          if (
            input.afterContext > 0 &&
            lastRetainedMatch &&
            filePathKey === lastMatchFilePath
          ) {
            appendTrailingContext(
              lastRetainedMatch,
              toContextLine(parsed),
              input.afterContext,
            );
            if (lastRetainedMatch.after.length >= input.afterContext) {
              stopForLimit();
              return false;
            }
            return true;
          }
          stopForLimit();
          return false;
        }

        const match: GrepMatch = {
          lineNumber: parsed.lineNumber,
          lineText: parsed.text,
          submatches: [],
          before:
            input.beforeContext > 0
              ? beforeBuffer.slice(-input.beforeContext)
              : [],
          after: [],
        };

        const retained = appendBoundedMatch(file, match);
        if (retained) {
          lastRetainedMatch = match;
          lastRetainedMatchFilePath = filePathKey;
        } else if (
          input.afterContext > 0 &&
          lastRetainedMatch &&
          filePathKey === lastMatchFilePath
        ) {
          appendTrailingContext(
            lastRetainedMatch,
            toContextLine(parsed),
            input.afterContext,
          );
        }
        lastMatchFilePath = filePathKey;
        beforeBuffer = [];

        if (visibleMatches >= input.maxResults) {
          limitReached = true;
          if (input.afterContext <= 0 && !sorted) {
            stopForLimit();
            return false;
          }
        }

        return true;
      }

      // Both context lines AND discarded matches (discarded by the budget)
      // can serve as trailing context of the last retained match, matching
      // ripgrep behavior when adjacent lines also match.
      const contextLine = toContextLine(parsed);
      if (
        lastRetainedMatch &&
        (filePathKey === lastRetainedMatchFilePath ||
          filePathKey === lastMatchFilePath)
      ) {
        appendTrailingContext(
          lastRetainedMatch,
          contextLine,
          input.afterContext,
        );
      }
      pushRollingContext(beforeBuffer, contextLine, input.beforeContext);

      if (
        limitReached &&
        !sorted &&
        (!lastRetainedMatch ||
          filePathKey !== lastMatchFilePath ||
          lastRetainedMatch.after.length >= input.afterContext)
      ) {
        stopForLimit();
        return false;
      }

      return true;
    }

    appendBoundedMatch(file, {
      lineNumber: parsed.lineNumber,
      lineText: parsed.text,
      submatches: [],
      before: [],
      after: [],
    });
    if (visibleMatches >= input.maxResults && !sorted) {
      stopForLimit();
      return false;
    }
    return true;
  });

  if (sorted && (admission?.dropped() || matchesCapped)) {
    limitReached = true;
  }

  return {
    files: [...files.values()],
    skippedLines,
    limitReached,
  };
}
