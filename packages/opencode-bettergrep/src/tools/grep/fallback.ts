import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { GREP_BINARY } from './constants';
import {
  consumeNullCountPairsBytes,
  consumeNullItemsBytes,
  GrowableByteBuffer,
  readTextStream,
} from './json-stream';
import {
  buildPathFromBytes,
  formatNonUtf8TextDisplay,
  normalizeDisplayText,
  stripSingleLineEnding,
  tryDecodeUtf8,
} from './path-utils';
import { probeExecutable, type ResolvedGrepCli } from './resolver';
import {
  applySuccessfulStderr,
  countOccurrences,
  countVisibleMatches,
  createEmptyResult,
  getMatchKind,
  hasVisibleResults,
  trimFilesToLineLimit,
} from './result-utils';
import { appendContextArgs } from './rg-args';
import {
  AbortWaitError,
  attachTerminationHandlers,
  createFriendlySpawnError,
  type GrepProcess,
  getAbortKind,
  isTransientFailure,
  isTransientStderr,
  killProcess,
  spawnRipgrep,
  toErrorMessage,
  waitForExitAndStderr,
} from './runtime';
import type {
  GrepContextLine,
  GrepFileMatch,
  GrepMatch,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

interface BuiltGrepCommand {
  command: string[];
  warnings: string[];
  patternError?: string;
}

/** Parser helpers for the conservative GNU grep ERE allowlist. */
function isAsciiLetter(char: string): boolean {
  return /^[A-Za-z]$/.test(char);
}

function isAsciiDigit(char: string): boolean {
  return /^[0-9]$/.test(char);
}

function isAsciiClassEndpoint(char: string): boolean {
  return isAsciiLetter(char) || isAsciiDigit(char);
}

function isSameAsciiRangeClass(left: string, right: string): boolean {
  return (
    (isAsciiDigit(left) && isAsciiDigit(right)) ||
    (left >= 'a' && left <= 'z' && right >= 'a' && right <= 'z') ||
    (left >= 'A' && left <= 'Z' && right >= 'A' && right <= 'Z')
  );
}

function isSafeClassLiteral(char: string): boolean {
  return char >= ' ' && char <= '~' && !'[]\\&~^-'.includes(char);
}

function parseEreClass(
  pattern: string,
  start: number,
): { end: number; error?: string } {
  let index = start + 1;
  if (pattern[index] === '^') {
    index += 1;
  }

  let memberCount = 0;
  while (index < pattern.length && pattern[index] !== ']') {
    const char = pattern[index];

    if (char === '[') {
      return {
        end: index,
        error:
          'nested or POSIX character classes are not supported by the GNU grep fallback',
      };
    }

    if (char === '\\') {
      return {
        end: index,
        error:
          'escapes inside character classes are not supported by the GNU grep fallback',
      };
    }

    if (char === '-') {
      if (memberCount === 0 || pattern[index + 1] === ']') {
        memberCount += 1;
        index += 1;
        continue;
      }

      return {
        end: index,
        error:
          'character class ranges must use ASCII letter or digit endpoints in the GNU grep fallback',
      };
    }

    if (!isSafeClassLiteral(char)) {
      return {
        end: index,
        error:
          'character class syntax is outside the supported GNU grep subset',
      };
    }

    const next = pattern[index + 1];
    if (next === '-') {
      const endpoint = pattern[index + 2];
      if (
        endpoint !== undefined &&
        endpoint !== ']' &&
        isAsciiClassEndpoint(char) &&
        isAsciiClassEndpoint(endpoint) &&
        isSameAsciiRangeClass(char, endpoint) &&
        char <= endpoint
      ) {
        index += 3;
        memberCount += 1;
        continue;
      }

      if (endpoint !== ']') {
        return {
          end: index,
          error:
            'character class ranges must use ascending ASCII letter or digit endpoints in the GNU grep fallback',
        };
      }
    }

    memberCount += 1;
    index += 1;
  }

  if (index >= pattern.length) {
    return {
      end: index,
      error: 'unterminated character class cannot be reproduced by GNU grep',
    };
  }

  if (memberCount === 0) {
    return {
      end: index,
      error:
        'empty character classes are not supported by the GNU grep fallback',
    };
  }

  return { end: index + 1 };
}

function parseEreRepetition(
  pattern: string,
  start: number,
): { end: number; error?: string } {
  const match = /^\{([0-9]+)(?:,([0-9]*))?\}/.exec(pattern.slice(start));
  if (!match) {
    return {
      end: start,
      error:
        'bounded repetition must use {n}, {n,}, or {n,m} in the GNU grep fallback',
    };
  }

  const minimum = Number(match[1]);
  const maximum =
    match[2] === undefined || match[2] === '' ? undefined : Number(match[2]);
  if (
    !Number.isSafeInteger(minimum) ||
    (maximum !== undefined &&
      (!Number.isSafeInteger(maximum) || maximum < minimum))
  ) {
    return {
      end: start,
      error:
        'bounded repetition values must be ascending safe integers in the GNU grep fallback',
    };
  }

  return { end: start + match[0].length };
}

/**
 * Translates only a deliberately whitelisted ripgrep regex grammar to ERE.
 * Locale-bound classes, Unicode boundary escapes, multiline input, and
 * constructs without a verified GNU grep equivalent are rejected.
 */
export function translatePatternToEre(pattern: string): {
  ere?: string;
  error?: string;
} {
  let out = '';
  let index = 0;
  let groupDepth = 0;
  let expectAtom = true;
  let canQuantify = false;
  let atAlternativeStart = true;
  const controlEscapes: Record<string, string> = {
    t: '\t',
    r: '\r',
    f: '\f',
    v: '\v',
  };
  const literalEscapes = new Set([
    '.',
    '^',
    '$',
    '*',
    '+',
    '?',
    '(',
    ')',
    '[',
    ']',
    '{',
    '}',
    '|',
    '\\',
    '-',
  ]);

  while (index < pattern.length) {
    const char = pattern[index];

    if (char < ' ' || char === '\x7f') {
      return {
        error:
          'control characters, including literal newlines, cannot be reproduced by the GNU grep fallback',
      };
    }

    if (char === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) {
        return {
          error:
            'pattern ends with a dangling backslash and cannot be translated to GNU grep ERE',
        };
      }
      if (next === 'n') {
        return {
          error:
            '\\n cannot be reproduced by the GNU grep fallback (newlines separate patterns)',
        };
      }
      if (next < ' ' || next === '\x7f') {
        return {
          error:
            'escaped control characters cannot be reproduced by the GNU grep fallback',
        };
      }

      if (next in controlEscapes) {
        out += controlEscapes[next];
      } else if (literalEscapes.has(next)) {
        out += `\\${next}`;
      } else {
        return {
          error: `escape sequence \\${next} is outside the supported GNU grep subset`,
        };
      }
      index += 2;
      expectAtom = false;
      canQuantify = true;
      atAlternativeStart = false;
      continue;
    }

    if (char === '[') {
      const parsed = parseEreClass(pattern, index);
      if (parsed.error) return { error: parsed.error };
      out += pattern.slice(index, parsed.end);
      index = parsed.end;
      expectAtom = false;
      canQuantify = true;
      atAlternativeStart = false;
      continue;
    }

    if (char === '(') {
      groupDepth += 1;
      out += char;
      index += 1;
      expectAtom = true;
      canQuantify = false;
      atAlternativeStart = true;
      continue;
    }

    if (char === ')') {
      if (groupDepth === 0 || expectAtom) {
        return {
          error:
            'unbalanced or empty groups are not supported by the GNU grep fallback',
        };
      }
      groupDepth -= 1;
      out += char;
      index += 1;
      expectAtom = false;
      canQuantify = true;
      atAlternativeStart = false;
      continue;
    }

    if (char === '|') {
      if (expectAtom) {
        return {
          error:
            'empty alternations are not supported by the GNU grep fallback',
        };
      }
      out += char;
      index += 1;
      expectAtom = true;
      canQuantify = false;
      atAlternativeStart = true;
      continue;
    }

    if (char === '*' || char === '+' || char === '?') {
      if (!canQuantify) {
        return {
          error:
            'quantifiers must follow an atom and cannot be possessive in the GNU grep fallback',
        };
      }
      out += char;
      index += 1;
      expectAtom = false;
      canQuantify = false;
      continue;
    }

    if (char === '{') {
      if (!canQuantify) {
        return {
          error:
            'bounded repetitions must follow an atom in the GNU grep fallback',
        };
      }
      const repetition = parseEreRepetition(pattern, index);
      if (repetition.error) return { error: repetition.error };
      out += pattern.slice(index, repetition.end);
      index = repetition.end;
      canQuantify = false;
      continue;
    }

    if (char === '}' || char === ']') {
      return {
        error: `unbalanced ${char} cannot be reproduced by the GNU grep fallback`,
      };
    }

    if (char === '^') {
      if (!atAlternativeStart) {
        return {
          error:
            '^ is only supported at the beginning of an alternation in the GNU grep fallback',
        };
      }
      out += char;
      index += 1;
      expectAtom = false;
      canQuantify = false;
      atAlternativeStart = false;
      continue;
    }

    if (char === '$') {
      const next = pattern[index + 1];
      if (expectAtom || (next !== undefined && next !== ')' && next !== '|')) {
        return {
          error:
            '$ is only supported at the end of an alternation in the GNU grep fallback',
        };
      }
      out += char;
      index += 1;
      canQuantify = false;
      continue;
    }

    out += char;
    index += 1;
    expectAtom = false;
    canQuantify = true;
    atAlternativeStart = false;
  }

  if (groupDepth !== 0 || expectAtom) {
    return {
      error:
        'unterminated group or empty alternation cannot be reproduced by GNU grep',
    };
  }

  return { ere: out };
}

interface ParsedContentRecord {
  filePath: Uint8Array;
  lineNumber: number;
  text: string;
  isMatch: boolean;
}

interface RawContentRecord {
  filePath: Uint8Array;
  line: Uint8Array;
}

type ContentRecord = RawContentRecord | '--';

function isSimpleBasenameGlob(glob: string): boolean {
  return !glob.includes('/') && !glob.includes('\\') && !glob.includes('**');
}

const MAX_BRACE_EXPANSIONS = 64;

interface BraceExpansionBudget {
  left: number;
  degraded: boolean;
}

function expandBraceGlob(glob: string, budget: BraceExpansionBudget): string[] {
  const open = glob.indexOf('{');
  if (open < 0) return [glob];

  let depth = 0;
  let close = -1;
  for (let index = open; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }

  if (close < 0) return [glob];
  const body = glob.slice(open + 1, close);
  const alternatives: string[] = [];
  let partStart = 0;
  depth = 0;
  for (let index = 0; index <= body.length; index += 1) {
    const char = body[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if ((char === ',' && depth === 0) || index === body.length) {
      alternatives.push(body.slice(partStart, index));
      partStart = index + 1;
    }
  }

  if (alternatives.length < 2) return [glob];
  const prefix = glob.slice(0, open);
  const suffix = glob.slice(close + 1);
  const expanded: string[] = [];
  for (const alternative of alternatives) {
    // Check the shared budget BEFORE descending so nested groups cannot
    // explode the call tree exponentially.
    if (budget.left <= 0) {
      budget.degraded = true;
      return [glob];
    }
    budget.left -= 1;
    expanded.push(
      ...expandBraceGlob(`${prefix}${alternative}${suffix}`, budget),
    );
  }
  return expanded;
}

interface GnuGrepCheckResult {
  error?: string;
  cacheable: boolean;
}

interface GnuGrepCheckEntry {
  promise: Promise<GnuGrepCheckResult>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

const GNU_GREP_CACHE = new Map<string, GnuGrepCheckEntry>();

function isAbortLikeFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('cancelled') ||
    message.includes('canceled')
  );
}

function shouldCacheGnuGrepFailure(
  error: unknown,
  stderr?: string,
  firstLine?: string,
): boolean {
  if (isTransientFailure(error) || isAbortLikeFailure(error)) {
    return false;
  }

  if (stderr && isTransientStderr(stderr)) {
    return false;
  }

  if (firstLine !== undefined && firstLine.length === 0) {
    return false;
  }

  return true;
}

function toWebReadableStream(
  stream: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
): ReadableStream<Uint8Array> | undefined {
  if (!stream) {
    return undefined;
  }

  if ('getReader' in stream && typeof stream.getReader === 'function') {
    return stream as ReadableStream<Uint8Array>;
  }

  return Readable.toWeb(
    stream as unknown as Readable,
  ) as unknown as ReadableStream<Uint8Array>;
}

function appendGlobArgs(
  args: string[],
  input: NormalizedGrepInput,
  budget: BraceExpansionBudget,
): void {
  const includeGlobs = [
    ...(input.include ? [input.include] : []),
    ...input.globs.filter((glob) => !glob.startsWith('!')),
  ].filter(isSimpleBasenameGlob);
  const excludeGlobs = [
    ...input.globs
      .filter((glob) => glob.startsWith('!'))
      .map((glob) => glob.slice(1)),
    ...input.excludeGlobs.map((glob) =>
      glob.startsWith('!') ? glob.slice(1) : glob,
    ),
  ].filter(isSimpleBasenameGlob);

  for (const glob of includeGlobs) {
    for (const expanded of expandBraceGlob(glob, budget)) {
      args.push('--include', expanded);
    }
  }

  for (const glob of excludeGlobs) {
    for (const expanded of expandBraceGlob(glob, budget)) {
      args.push('--exclude', expanded);
    }
  }
}

function shouldUseIgnoreCase(input: NormalizedGrepInput): boolean {
  if (input.smartCase) {
    return !/[A-Z]/.test(input.pattern);
  }

  return !input.caseSensitive;
}

function buildUnsupportedWarnings(input: NormalizedGrepInput): string[] {
  const warnings: string[] = [];

  if (input.multiline || input.multilineDotall) {
    warnings.push(
      'GNU grep fallback does not support multiline matching; results may differ from ripgrep.',
    );
  }

  if (input.pcre2) {
    warnings.push(
      'GNU grep fallback does not support ripgrep PCRE2 mode; using grep regex support instead.',
    );
  }

  if (
    input.fileType ||
    input.fileTypes.length > 0 ||
    input.excludeFileTypes.length > 0
  ) {
    warnings.push(
      'GNU grep fallback ignores ripgrep file type filters; use globs for exact control.',
    );
  }

  if (input.maxFilesize) {
    warnings.push(
      'GNU grep fallback ignores max_filesize; large files may still be searched.',
    );
  }

  const pathAwareGlobs = [
    ...(input.include ? [input.include] : []),
    ...input.globs,
    ...input.excludeGlobs,
  ].filter(
    (glob) =>
      !isSimpleBasenameGlob(glob.startsWith('!') ? glob.slice(1) : glob),
  );

  if (pathAwareGlobs.length > 0) {
    warnings.push(
      'GNU grep fallback ignores path-aware glob patterns; only simple basename globs are supported.',
    );
  }

  if (input.sortBy === 'mtime') {
    warnings.push(
      'GNU grep fallback ignores sort_by=mtime; returning unsorted direct results instead.',
    );
  }

  const hasGitIgnore =
    existsSync(path.join(input.worktree, '.gitignore')) ||
    existsSync(path.join(input.worktree, '.git'));
  if (hasGitIgnore) {
    warnings.push(
      'GNU grep fallback does not apply gitignore rules; results may include ignored files.',
    );
  } else {
    warnings.push(
      'GNU grep fallback does not apply ripgrep ignore rules (gitignore or otherwise); results may include ignored files.',
    );
  }

  const braceGlobs = [
    ...(input.include ? [input.include] : []),
    ...input.globs,
    ...input.excludeGlobs,
  ].filter((glob) => /\{[^{}]+,[^{}]+\}/.test(glob));
  if (braceGlobs.length > 0) {
    warnings.push(
      'GNU grep fallback expands simple brace globs; nested or oversized expansions may differ from ripgrep.',
    );
  }

  if (input.outputMode === 'count') {
    warnings.push(
      'GNU grep fallback count mode reports matching lines per file, not ripgrep occurrence counts.',
    );
  }

  return warnings;
}

export function buildGrepCommand(
  input: NormalizedGrepInput,
  binaryPath = GREP_BINARY,
): BuiltGrepCommand {
  const args: string[] = [input.followSymlinks ? '-R' : '-r', '--color=never'];
  const warnings = buildUnsupportedWarnings(input);

  if (input.outputMode === 'content') {
    args.push('-Z', '-H', '-n');
  } else if (input.outputMode === 'files_with_matches') {
    args.push('-Z', '-l');
  } else {
    args.push('-Z', '-H', '-c');
  }

  if (!input.hidden) {
    args.push('--exclude=.*', '--exclude-dir=.*');
  }

  if (input.pattern.includes('\n') || input.pattern.includes('\r')) {
    return {
      command: [binaryPath, ...args],
      warnings,
      patternError:
        'literal line breaks cannot be reproduced by the GNU grep fallback',
    };
  }

  if (shouldUseIgnoreCase(input)) {
    return {
      command: [binaryPath, ...args],
      warnings,
      patternError:
        'case-insensitive matching cannot be reproduced by the GNU grep fallback without changing Unicode case-folding semantics',
    };
  }

  if (input.wordRegexp) {
    return {
      command: [binaryPath, ...args],
      warnings,
      patternError:
        'word_regexp cannot be reproduced by the GNU grep fallback without changing Unicode word-boundary semantics',
    };
  }

  let effectivePattern = input.pattern;
  if (input.fixedStrings) {
    args.push('-F');
  } else {
    const translated = translatePatternToEre(input.pattern);
    if (translated.error) {
      return {
        command: [binaryPath, ...args],
        warnings,
        patternError: `Cannot reproduce this regex with the GNU grep fallback: ${translated.error}. Install ripgrep or use fixed_strings for literal searches.`,
      };
    }
    args.push('-E');
    effectivePattern = translated.ere ?? input.pattern;
  }

  if (input.invertMatch) {
    args.push('-v');
  }

  if (input.maxCountPerFile) {
    args.push('-m', String(input.maxCountPerFile));
  }

  appendContextArgs(args, input);
  const braceBudget: BraceExpansionBudget = {
    left: MAX_BRACE_EXPANSIONS,
    degraded: false,
  };
  appendGlobArgs(args, input, braceBudget);
  if (braceBudget.degraded) {
    warnings.push(
      'GNU grep fallback brace glob expansion exceeded its budget; the original glob was used and may match fewer files.',
    );
  }
  args.push(
    '-e',
    effectivePattern,
    ...(input.searchTargets ?? [input.searchPath]),
  );

  return {
    command: [binaryPath, ...args],
    warnings,
  };
}

function ensureFileMatchBytes(
  files: Map<string, GrepFileMatch>,
  rawPath: Uint8Array,
  input: Pick<NormalizedGrepInput, 'cwd' | 'worktree'>,
): GrepFileMatch {
  const pathInfo = buildPathFromBytes(rawPath, input.cwd, input.worktree);
  const existing = files.get(pathInfo.pathKey);
  if (existing) return existing;

  const created = createFileMatchFromInfo(pathInfo);
  files.set(pathInfo.pathKey, created);
  return created;
}

function createFileMatchFromInfo(pathInfo: {
  displayPath: string;
  absolutePath: string;
  replayPath?: string;
  nonUtf8Path: boolean;
  pathKey: string;
}): GrepFileMatch {
  return {
    file: pathInfo.displayPath,
    absolutePath: pathInfo.absolutePath,
    ...(pathInfo.replayPath ? { replayPath: pathInfo.replayPath } : {}),
    ...(pathInfo.nonUtf8Path ? { nonUtf8Path: true } : {}),
    pathKey: pathInfo.pathKey,
    matchCount: 0,
    matches: [],
  };
}

const PATH_KEY_BYTES_PREFIX = 'bytes:base64:';

/**
 * Recovers the ORIGINAL absolute path bytes: non-UTF-8 paths carry their
 * bytes base64-encoded in pathKey, so sorting must decode them instead of
 * comparing the identity string, which orders non-UTF-8 paths incorrectly.
 */
function absolutePathSortBytes(file: GrepFileMatch): Buffer {
  const key = file.pathKey ?? file.absolutePath;
  if (key.startsWith(PATH_KEY_BYTES_PREFIX)) {
    try {
      return Buffer.from(key.slice(PATH_KEY_BYTES_PREFIX.length), 'base64');
    } catch {
      // Fall through to the utf8 representation.
    }
  }
  if (file.pathKey?.startsWith('utf8:')) {
    return Buffer.from(file.pathKey.slice('utf8:'.length), 'utf8');
  }
  return Buffer.from(file.absolutePath, 'utf8');
}

function comparePathBytes(left: GrepFileMatch, right: GrepFileMatch): number {
  return Buffer.compare(
    absolutePathSortBytes(left),
    absolutePathSortBytes(right),
  );
}

/**
 * Bounded admission for sort_by=path: keeps at most `capacity` files that are
 * the best under bytewise path order, evicting the worst as better paths
 * arrive. Retention stays O(capacity) instead of growing with the full
 * stream.
 */
function createSortedAdmission(
  files: Map<string, GrepFileMatch>,
  capacity: number,
  direction: 1 | -1,
  onEvict?: (file: GrepFileMatch) => void,
): {
  admit: (file: GrepFileMatch) => boolean;
  dropped: () => boolean;
} {
  let dropped = false;

  const worstFile = (): GrepFileMatch | null => {
    let worst: GrepFileMatch | null = null;
    for (const file of files.values()) {
      // Select the MAXIMUM under the directed comparator: that is the worst
      // candidate, i.e. the one closest to eviction.
      if (!worst || comparePathBytes(file, worst) * direction > 0) {
        worst = file;
      }
    }
    return worst;
  };

  return {
    admit(file) {
      const key = file.pathKey ?? file.absolutePath;
      if (files.has(key)) {
        return true;
      }

      if (files.size < capacity) {
        files.set(key, file);
        return true;
      }

      const worst = worstFile();
      if (!worst) {
        files.set(key, file);
        return true;
      }

      if (comparePathBytes(file, worst) * direction < 0) {
        files.delete(worst.pathKey ?? worst.absolutePath);
        onEvict?.(worst);
        files.set(key, file);
        dropped = true;
        return true;
      }

      dropped = true;
      return false;
    },
    dropped: () => dropped,
  };
}

function decodeGrepText(bytes: Uint8Array): string {
  return normalizeDisplayText(
    tryDecodeUtf8(bytes) ?? formatNonUtf8TextDisplay(bytes),
  );
}

function parseContentLine(
  filePath: Uint8Array,
  lineBytes: Uint8Array,
  withContext: boolean,
): ParsedContentRecord | null {
  const line = stripSingleLineEnding(decodeGrepText(lineBytes));
  const match = withContext
    ? line.match(/^(\d+)([:-])(.*)$/)
    : line.match(/^(\d+):(.*)$/);

  if (!match) {
    return null;
  }

  if (withContext) {
    const [, lineNumberText, separator, text] = match;
    return {
      filePath,
      lineNumber: Number.parseInt(lineNumberText, 10),
      text: normalizeDisplayText(text),
      isMatch: separator === ':',
    };
  }

  const [, lineNumberText, text] = match;
  return {
    filePath,
    lineNumber: Number.parseInt(lineNumberText, 10),
    text: normalizeDisplayText(text),
    isMatch: true,
  };
}

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

async function consumeNullPrefixedLinesStream(
  stream: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
  onRecord: (record: ContentRecord) => boolean | undefined,
): Promise<void> {
  const readable = toWebReadableStream(stream);
  if (!readable) {
    return;
  }

  const reader = readable.getReader();
  const buffer = new GrowableByteBuffer();
  let currentPath: Uint8Array | undefined;
  const separator = Uint8Array.from([0x2d, 0x2d, 0x0a]);

  while (true) {
    const { done, value } = await reader.read();
    buffer.append(value);

    while (true) {
      if (currentPath === undefined) {
        // The context group separator must be recognized BEFORE scanning
        // for the next NUL, or it gets glued onto the following path.
        if (buffer.startsWith(separator)) {
          buffer.takePrefix(separator.length);
          if (onRecord('--') === false) {
            await reader.cancel();
            return;
          }
          continue;
        }

        const pathBytes = buffer.takeUntil(0);
        if (pathBytes !== undefined) {
          currentPath = pathBytes;
          continue;
        }

        break;
      }

      const lineBytes = buffer.takeUntil(0x0a);
      if (lineBytes === undefined) break;

      const record: RawContentRecord = {
        filePath: currentPath,
        line: lineBytes,
      };
      currentPath = undefined;
      if (onRecord(record) === false) {
        await reader.cancel();
        return;
      }
    }

    if (done) {
      break;
    }
  }

  if (currentPath !== undefined) {
    const lineBytes = buffer.takeUntil(0x0a);
    if (lineBytes !== undefined) {
      onRecord({
        filePath: currentPath,
        line: lineBytes,
      });
    }
  }
}

async function consumeContentOutput(
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

async function consumeCountOutput(
  stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
  proc: GrepProcess,
  input: Pick<
    NormalizedGrepInput,
    'cwd' | 'maxResults' | 'sortBy' | 'sortOrder' | 'worktree'
  >,
): Promise<{
  files: GrepFileMatch[];
  skippedLines: number;
  limitReached: boolean;
}> {
  const files = new Map<string, GrepFileMatch>();
  let skippedLines = 0;
  let limitReached = false;
  const sorted = input.sortBy === 'path';
  const admission = sorted
    ? createSortedAdmission(
        files,
        input.maxResults,
        input.sortOrder === 'desc' ? -1 : 1,
      )
    : null;

  const admitFile = (filePath: Uint8Array): GrepFileMatch | null => {
    if (!admission) {
      return ensureFileMatchBytes(files, filePath, input);
    }

    const pathInfo = buildPathFromBytes(filePath, input.cwd, input.worktree);
    const existing = files.get(pathInfo.pathKey);
    if (existing) return existing;

    const created = createFileMatchFromInfo(pathInfo);
    return admission.admit(created) ? created : null;
  };

  await consumeNullCountPairsBytes(stdout, (filePath, countText) => {
    if (!/^\d+$/.test(countText)) {
      skippedLines += 1;
      return true;
    }

    const count = Number.parseInt(countText, 10);
    if (count === 0) {
      return true;
    }

    if (!admission) {
      const file = ensureFileMatchBytes(files, filePath, input);
      file.matchCount = count;
      if (files.size >= input.maxResults) {
        limitReached = true;
        killProcess(proc);
        return false;
      }
      return true;
    }

    const file = admitFile(filePath);
    if (!file) {
      return true;
    }
    file.matchCount = count;
    return true;
  });

  if (sorted && admission?.dropped()) {
    limitReached = true;
  }

  return {
    files: [...files.values()],
    skippedLines,
    limitReached,
  };
}

async function consumeFilesOutput(
  stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
  proc: GrepProcess,
  input: Pick<
    NormalizedGrepInput,
    'cwd' | 'maxResults' | 'sortBy' | 'sortOrder' | 'worktree'
  >,
): Promise<{
  files: GrepFileMatch[];
  skippedLines: number;
  limitReached: boolean;
}> {
  const files = new Map<string, GrepFileMatch>();
  let limitReached = false;
  const sorted = input.sortBy === 'path';
  const admission = sorted
    ? createSortedAdmission(
        files,
        input.maxResults,
        input.sortOrder === 'desc' ? -1 : 1,
      )
    : null;

  await consumeNullItemsBytes(stdout, (filePath) => {
    if (filePath.length === 0) {
      return true;
    }

    if (!admission) {
      const file = ensureFileMatchBytes(files, filePath, input);
      file.matchCount = 1;
      if (files.size >= input.maxResults) {
        limitReached = true;
        killProcess(proc);
        return false;
      }
      return true;
    }

    const pathInfo = buildPathFromBytes(filePath, input.cwd, input.worktree);
    if (files.has(pathInfo.pathKey)) {
      return true;
    }

    const created = createFileMatchFromInfo(pathInfo);
    if (!admission.admit(created)) {
      return true;
    }
    created.matchCount = 1;
    return true;
  });

  if (sorted && admission?.dropped()) {
    limitReached = true;
  }

  return {
    files: [...files.values()],
    skippedLines: 0,
    limitReached,
  };
}

function sortFiles(
  files: GrepFileMatch[],
  input: Pick<NormalizedGrepInput, 'sortBy' | 'sortOrder'>,
): GrepFileMatch[] {
  if (input.sortBy !== 'path') {
    return files;
  }

  // Byte-wise ordering over the raw path matches ripgrep's path sort; a
  // locale-aware compare would reorder paths like package.json vs README.md.
  return [...files].sort((left, right) => {
    const direction = input.sortOrder === 'desc' ? -1 : 1;
    return comparePathBytes(left, right) * direction;
  });
}

function finalizeFiles(
  files: GrepFileMatch[],
  input: Pick<NormalizedGrepInput, 'maxResults' | 'outputMode'>,
): {
  files: GrepFileMatch[];
  totalMatches: number;
  totalFiles: number;
  limitReached: boolean;
} {
  if (input.outputMode === 'content') {
    const trimmed = trimFilesToLineLimit(files, input.maxResults);
    const limitReached = files.some((file, index) => {
      const visible = trimmed[index];
      return visible ? visible.matches.length < file.matches.length : true;
    });

    return {
      files: trimmed.map((file) => ({
        ...file,
        // Content mode exposes retained lines, not the number of matches
        // discarded while maintaining sorted top-K admission.
        matchCount: file.matches.length,
      })),
      totalMatches: countVisibleMatches(trimmed),
      totalFiles: trimmed.length,
      limitReached,
    };
  }

  const trimmed = files.slice(0, input.maxResults);
  return {
    files: trimmed,
    totalMatches:
      input.outputMode === 'count' ? countOccurrences(trimmed) : trimmed.length,
    totalFiles: trimmed.length,
    limitReached: trimmed.length < files.length,
  };
}

async function checkGnuGrep(
  binaryPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GnuGrepCheckResult> {
  const probe = await probeExecutable(
    binaryPath,
    ['--version'],
    signal,
    timeoutMs,
  );

  if (probe.timedOut) {
    return {
      error: 'GNU grep validation timed out.',
      cacheable: false,
    };
  }

  const stdout = probe.stdout.trim();
  const { exitCode, stderr } = probe;

  if (exitCode !== 0) {
    const error =
      stderr || `grep --version exited with code ${String(exitCode)}`;
    return {
      error,
      cacheable: shouldCacheGnuGrepFailure(undefined, stderr),
    };
  }

  const firstLine = stdout.split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine.includes('GNU grep')) {
    return {
      error:
        firstLine.length > 0
          ? 'System grep fallback requires GNU grep; the detected grep is not GNU grep.'
          : 'System grep fallback could not validate GNU grep version output.',
      cacheable: shouldCacheGnuGrepFailure(undefined, undefined, firstLine),
    };
  }

  return {
    cacheable: true,
  };
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new AbortWaitError('Search was cancelled before execution started.'),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        new AbortWaitError('Search was cancelled before execution started.'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function ensureGnuGrep(
  binaryPath: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string | undefined> {
  let entry = GNU_GREP_CACHE.get(binaryPath);

  if (!entry) {
    const controller = new AbortController();
    const created: GnuGrepCheckEntry = {
      controller,
      waiters: 0,
      settled: false,
      promise: checkGnuGrep(binaryPath, timeoutMs, controller.signal),
    };
    created.promise = created.promise.then(
      (result) => {
        created.settled = true;
        if (!result.cacheable && GNU_GREP_CACHE.get(binaryPath) === created) {
          GNU_GREP_CACHE.delete(binaryPath);
        }
        return result;
      },
      (error) => {
        created.settled = true;
        if (GNU_GREP_CACHE.get(binaryPath) === created) {
          GNU_GREP_CACHE.delete(binaryPath);
        }
        throw error;
      },
    );
    // Early waiters can abandon the shared check; keep its rejection handled.
    void created.promise.catch(() => undefined);
    GNU_GREP_CACHE.set(binaryPath, created);
    entry = created;
  }

  entry.waiters += 1;
  try {
    return (await raceWithAbort(entry.promise, signal)).error;
  } finally {
    entry.waiters = Math.max(0, entry.waiters - 1);
    if (entry.waiters === 0 && !entry.settled) {
      // Remove the entry BEFORE aborting so a new caller cannot join a check
      // that is already being cancelled.
      if (GNU_GREP_CACHE.get(binaryPath) === entry) {
        GNU_GREP_CACHE.delete(binaryPath);
      }
      entry.controller.abort();
    }
  }
}

export async function executeGrepFallback(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  const {
    command,
    warnings: commandWarnings,
    patternError,
  } = buildGrepCommand(input, cli.path);
  const baseResult = createEmptyResult(input, command);

  if (signal.aborted) {
    return {
      ...baseResult,
      backend: 'grep',
      truncated: true,
      timedOut: getAbortKind(signal) === 'timeout',
      cancelled: getAbortKind(signal) !== 'timeout',
      warnings: [...commandWarnings],
    };
  }

  if (patternError) {
    return {
      ...baseResult,
      backend: 'grep',
      error: patternError,
      warnings: [...commandWarnings],
    };
  }

  const grepError = await ensureGnuGrep(cli.path, signal, input.timeoutMs);
  if (grepError) {
    return {
      ...baseResult,
      backend: 'grep',
      error: grepError,
      warnings: [...commandWarnings],
    };
  }

  let proc: GrepProcess;
  try {
    proc = spawnRipgrep(command, input.cwd, {
      ...process.env,
      LC_ALL: 'C.UTF-8',
    });
  } catch (error) {
    const friendlyMessage = createFriendlySpawnError(error, cli);
    return {
      ...baseResult,
      backend: 'grep',
      error: friendlyMessage || toErrorMessage(error),
      warnings: [...commandWarnings],
    };
  }

  const termination = attachTerminationHandlers(proc, input.timeoutMs, signal);

  try {
    const stdoutStream = proc.proc.stdout ?? undefined;
    const stderrStream = proc.proc.stderr ?? undefined;
    const stderrPromise = readTextStream(stderrStream);
    const stdoutPromise =
      input.outputMode === 'content'
        ? consumeContentOutput(stdoutStream, proc, input)
        : input.outputMode === 'count'
          ? consumeCountOutput(stdoutStream, proc, input)
          : consumeFilesOutput(stdoutStream, proc, input);

    const [stdoutResult, exitResult] = await Promise.allSettled([
      stdoutPromise,
      waitForExitAndStderr(proc, stderrPromise),
    ]);
    const exitCode =
      exitResult.status === 'fulfilled' ? exitResult.value.exitCode : 1;
    const processError =
      exitResult.status === 'fulfilled'
        ? exitResult.value.error
        : toErrorMessage(exitResult.reason);
    const stderr =
      exitResult.status === 'fulfilled' ? exitResult.value.stderr.trim() : '';
    const stdoutError =
      stdoutResult.status === 'rejected'
        ? toErrorMessage(stdoutResult.reason)
        : undefined;
    const parsed =
      stdoutResult.status === 'fulfilled'
        ? stdoutResult.value
        : {
            files: [] as GrepFileMatch[],
            skippedLines: 0,
            limitReached: false,
          };
    const sortedFiles = sortFiles(parsed.files, input);
    const finalized = finalizeFiles(sortedFiles, input);
    // Bounded admission reports its own limit via parsed.limitReached in
    // sorted mode; the final slice cannot detect it (already at capacity).
    const parserLimitReached = parsed.limitReached;
    const warnings = [...commandWarnings];

    if (parsed.skippedLines > 0) {
      warnings.push(
        `GNU grep fallback skipped ${String(parsed.skippedLines)} unparsable output line(s); results may be incomplete.`,
      );
    }

    const result: GrepSearchResult = {
      ...baseResult,
      backend: 'grep',
      files: finalized.files,
      totalMatches: finalized.totalMatches,
      totalFiles: finalized.totalFiles,
      matchKind: getMatchKind(input.outputMode),
      truncated:
        parserLimitReached ||
        finalized.limitReached ||
        termination.state.timedOut ||
        termination.state.cancelled ||
        parsed.skippedLines > 0,
      limitReached: parserLimitReached || finalized.limitReached,
      timedOut: termination.state.timedOut,
      cancelled: termination.state.cancelled,
      exitCode,
      stderr,
      warnings,
    };

    applySuccessfulStderr(result, stderr, exitCode);

    const hasBinaryMatches = /binary file.*matches/i.test(stderr);
    if (hasBinaryMatches) {
      // GNU grep reports binary matches on stderr without parsable records.
      // Preserve text results, but never present the combined result as
      // complete because the binary matches are known to be omitted.
      result.truncated = true;
      if (!hasVisibleResults(result)) {
        result.error =
          'GNU grep fallback cannot display matches inside binary files; rerun with output_mode=files_with_matches or count.';
        return result;
      }
    }

    if (
      (processError || stdoutError) &&
      !result.timedOut &&
      !result.cancelled
    ) {
      result.error = processError ?? stdoutError;
      return result;
    }

    if (
      parsed.skippedLines > 0 &&
      !hasVisibleResults(result) &&
      exitCode === 0 &&
      !result.timedOut &&
      !result.cancelled
    ) {
      result.error = 'GNU grep fallback produced unparsable output.';
      return result;
    }

    if (termination.state.timedOut || termination.state.cancelled) {
      return result;
    }

    if (result.limitReached) {
      return result;
    }

    if (
      exitCode === 0 ||
      (exitCode === 1 && !hasVisibleResults(result) && stderr.length === 0)
    ) {
      return result;
    }

    result.error = result.stderr || `grep exited with code ${String(exitCode)}`;
    return result;
  } finally {
    termination.cleanup();
  }
}
