import { RG_BINARY } from './constants';
import type { NormalizedGlobInput } from './types';

// rg matches a glob without "/" at any depth, as if it were "**/<glob>", and
// a leading "/" anchors it to the root. Once canonical, "**", "**/*" and
// "**/**" match every path ("/*" stays root-only).
function matchesEveryPath(glob: string): boolean {
  const anchored = glob.includes('/') ? glob.replace(/^\//, '') : `**/${glob}`;
  return anchored === '**' || anchored === '**/*' || anchored === '**/**';
}

export function buildRgArgs(input: NormalizedGlobInput): string[] {
  // Matching is delegated entirely to ripgrep's glob engine; there is no
  // JavaScript post-filter. rg anchors globs containing "/" to the search
  // root, while bare basenames match at any depth — normalize.ts
  // root-anchors absolute patterns accordingly.
  const args = [
    '--files',
    '--null',
    '--no-config',
    '--no-mmap',
    '--no-require-git',
  ];

  if (input.sortBy === 'path') {
    args.push(input.sortOrder === 'desc' ? '--sortr' : '--sort', 'path');
  }

  if (input.sortBy === 'mtime') {
    args.push(input.sortOrder === 'desc' ? '--sortr' : '--sort', 'modified');
  }

  if (input.hidden) {
    args.push('--hidden');
  }

  // A positive --glob is an rg override: it beats ignore and hidden rules
  // for every path it matches. A glob matching every path filters nothing,
  // so it is omitted and "list everything" still honors .gitignore.
  if (!matchesEveryPath(input.relativePattern)) {
    args.push(`--glob=${input.relativePattern}`);
  }

  // Must come after the user pattern: the last matching glob wins, so .git
  // stays excluded even when the user pattern matches it explicitly.
  args.push('--glob=!**/.git/**');

  return args;
}

export function buildRgCommand(
  input: NormalizedGlobInput,
  binaryPath = RG_BINARY,
): string[] {
  return [binaryPath, ...buildRgArgs(input)];
}
