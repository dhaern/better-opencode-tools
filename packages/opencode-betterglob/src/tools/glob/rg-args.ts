import { RG_BINARY } from './constants';
import type { NormalizedGlobInput } from './types';

export function buildRgArgs(input: NormalizedGlobInput): string[] {
  // Matching is delegated entirely to ripgrep's glob engine for native
  // parity; there is no JavaScript post-filter. rg anchors globs containing
  // "/" to the search root, while bare basenames match at any depth —
  // normalize.ts root-anchors absolute patterns accordingly.
  const args = ['--files', '--null', '--no-config', '--no-require-git'];

  if (input.sortBy === 'path') {
    args.push(input.sortOrder === 'desc' ? '--sortr' : '--sort', 'path');
  }

  if (input.sortBy === 'mtime') {
    args.push(input.sortOrder === 'desc' ? '--sortr' : '--sort', 'modified');
  }

  if (input.hidden) {
    args.push('--hidden');
  }

  args.push(`--glob=${input.relativePattern}`);

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
