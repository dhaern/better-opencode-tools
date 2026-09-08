import {
  consumeNullCountPairsBytes,
  consumeNullItemsBytes,
} from './json-stream';
import { buildPathFromBytes } from './path-utils';
import {
  countOccurrences,
  countVisibleMatches,
  trimFilesToLineLimit,
} from './result-utils';
import { type GrepProcess, killProcess } from './runtime';
import type { GrepFileMatch, NormalizedGrepInput } from './types';

export function ensureFileMatchBytes(
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

export function createFileMatchFromInfo(pathInfo: {
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

export function comparePathBytes(
  left: GrepFileMatch,
  right: GrepFileMatch,
): number {
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
export function createSortedAdmission(
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

export async function consumeCountOutput(
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

export async function consumeFilesOutput(
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

export function sortFiles(
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

export function finalizeFiles(
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
