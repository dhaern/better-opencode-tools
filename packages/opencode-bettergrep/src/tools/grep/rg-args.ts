import path from 'node:path';
import { RG_BINARY } from './constants';
import type { NormalizedGrepInput } from './types';

export function appendContextArgs(
  args: string[],
  input: Pick<
    NormalizedGrepInput,
    'afterContext' | 'beforeContext' | 'outputMode'
  >,
): void {
  if (input.outputMode !== 'content') {
    return;
  }

  if (input.beforeContext <= 0 && input.afterContext <= 0) {
    return;
  }

  if (input.beforeContext === input.afterContext) {
    args.push('-C', String(input.beforeContext));
    return;
  }

  if (input.beforeContext > 0) {
    args.push('-B', String(input.beforeContext));
  }

  if (input.afterContext > 0) {
    args.push('-A', String(input.afterContext));
  }
}

function appendFileTypeArgs(
  args: string[],
  input: Pick<NormalizedGrepInput, 'excludeFileTypes' | 'fileTypes'>,
): void {
  for (const fileType of input.fileTypes) {
    args.push('--type', fileType);
  }

  for (const fileType of input.excludeFileTypes) {
    args.push('--type-not', fileType);
  }
}

// rg matches a glob without "/" at any depth, as if it were "**/<glob>", and
// a leading "/" anchors it to the root. Once canonical, "**", "**/*" and
// "**/**" match every path ("/*" stays root-only).
function matchesEveryPath(glob: string): boolean {
  const anchored = glob.includes('/') ? glob.replace(/^\//, '') : `**/${glob}`;
  return anchored === '**' || anchored === '**/*' || anchored === '**/**';
}

// rg matches globs against paths relative to its cwd, so "!**/.git/**" would
// also hide a target inside .git. Like native grep, search what was asked for.
export function excludesGitDirs(
  input: Pick<NormalizedGrepInput, 'searchPath' | 'searchTargets'>,
): boolean {
  return !(input.searchTargets ?? [input.searchPath]).some((target) =>
    target.split(path.sep).includes('.git'),
  );
}

export function buildRgArgs(input: NormalizedGrepInput): string[] {
  const args = ['--no-config', '--no-mmap', '--color', 'never'];

  if (input.outputMode === 'files_with_matches') {
    args.push('--null', '--files-with-matches', '--with-filename');
  }

  if (input.outputMode === 'content') {
    args.push('--json', '--with-filename', '--line-number', '--stats');
  }

  if (input.outputMode === 'count') {
    args.push('--null', '--count-matches', '--with-filename');
  }

  if (input.sortBy === 'path') {
    args.push(input.sortOrder === 'desc' ? '--sortr' : '--sort', 'path');
  }

  if (input.sequentialReplay) {
    args.push('-j1');
  }

  if (input.smartCase) {
    args.push('--smart-case');
  } else if (!input.caseSensitive) {
    args.push('-i');
  }

  if (input.wordRegexp) {
    args.push('-w');
  }

  appendContextArgs(args, input);

  if (input.maxCountPerFile) {
    args.push('--max-count', String(input.maxCountPerFile));
  }

  if (input.fixedStrings) {
    args.push('--fixed-strings');
  }

  if (input.invertMatch) {
    args.push('--invert-match');
  }

  if (input.multiline) {
    args.push('--multiline');
  }

  if (input.multilineDotall) {
    args.push('--multiline-dotall');
  }

  if (input.pcre2) {
    args.push('--pcre2');
  }

  appendFileTypeArgs(args, input);

  if (input.maxFilesize) {
    args.push('--max-filesize', input.maxFilesize);
  }

  // A positive --glob is an rg override: it beats ignore and hidden rules
  // for every path it matches, so a glob matching every path is omitted.
  const globs = input.include ? [input.include, ...input.globs] : input.globs;
  for (const glob of globs) {
    if (!matchesEveryPath(glob)) args.push('--glob', glob);
  }

  for (const glob of input.excludeGlobs) {
    const normalizedGlob = glob.startsWith('!') ? glob : `!${glob}`;
    args.push('--glob', normalizedGlob);
  }

  // Last matching glob wins; exclude .git even if a user glob includes it.
  if (excludesGitDirs(input)) args.push('--glob', '!**/.git/**');

  if (input.hidden) {
    args.push('--hidden');
  }

  if (input.followSymlinks) {
    args.push('--follow');
  }

  args.push(
    '--regexp',
    input.pattern,
    ...(input.searchTargets ?? [input.searchPath]),
  );
  return args;
}

export function buildRgCommand(
  input: NormalizedGrepInput,
  binaryPath = RG_BINARY,
): string[] {
  return [binaryPath, ...buildRgArgs(input)];
}
