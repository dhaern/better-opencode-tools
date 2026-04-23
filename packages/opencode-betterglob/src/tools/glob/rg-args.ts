import { RG_BINARY } from './constants';
import type { NormalizedGlobInput } from './types';

export function buildRgArgs(input: NormalizedGlobInput): string[] {
  const args = ['--files', '--null', '--no-config'];

  for (const file of input.ignoreFiles) {
    args.push('--ignore-file', file);
  }

  if (input.sortBy === 'path') {
    args.push(input.sortOrder === 'desc' ? '--sortr' : '--sort', 'path');
  }

  if (input.sortBy === 'mtime') {
    args.push(input.sortOrder === 'desc' ? '--sortr' : '--sort', 'modified');
  }

  if (input.hidden) {
    args.push('--hidden');
  }

  if (input.followSymlinks) {
    args.push('--follow');
  }

  return args;
}

export function buildRgCommand(
  input: NormalizedGlobInput,
  binaryPath = RG_BINARY,
): string[] {
  return [binaryPath, ...buildRgArgs(input)];
}
