import { existsSync } from 'node:fs';
import path from 'node:path';
import { GREP_BINARY } from './constants';
import { translatePatternToEre } from './fallback-ere';
import { appendContextArgs } from './rg-args';
import type { NormalizedGrepInput } from './types';

interface BuiltGrepCommand {
  command: string[];
  warnings: string[];
  patternError?: string;
}

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
