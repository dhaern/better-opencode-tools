import {
  consumeNullCountPairsBytes,
  consumeNullItemsBytes,
} from './json-stream';
import { buildPathFromBytes } from './path-utils';
import {
  countOccurrences,
  countVisibleMatches,
  createFileMatch,
  trimFilesToLineLimit,
} from './result-utils';
import { type GrepProcess, killProcess } from './runtime';
import type { GrepFileMatch, NormalizedGrepInput } from './types';

type FileListInput = Pick<
  NormalizedGrepInput,
  'cwd' | 'maxResults' | 'sortBy' | 'sortOrder' | 'worktree'
>;

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

// Sort keys are precomputed once per file: admission and final sorting share
// them instead of allocating two Buffers per comparison.
const sortKeyCache = new WeakMap<GrepFileMatch, Buffer>();

export function getPathSortKey(file: GrepFileMatch): Buffer {
  const cached = sortKeyCache.get(file);
  if (cached) return cached;
  const key = absolutePathSortBytes(file);
  sortKeyCache.set(file, key);
  return key;
}

export function comparePathBytes(
  left: GrepFileMatch,
  right: GrepFileMatch,
): number {
  return Buffer.compare(getPathSortKey(left), getPathSortKey(right));
}

type Admission = ReturnType<typeof createSortedAdmission>;

/**
 * Bounded admission for sort_by=path: keeps at most `capacity` files that are
 * the best under bytewise path order, evicting the worst as better paths
 * arrive. The retained set stays ranked, so admission costs O(log capacity)
 * comparisons instead of rescanning the set, and eviction needs no rescan.
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
  const ranked: GrepFileMatch[] = [];
  const keyOf = (file: GrepFileMatch): string =>
    file.pathKey ?? file.absolutePath;
  const outranks = (
    candidate: GrepFileMatch,
    current: GrepFileMatch,
  ): boolean =>
    Buffer.compare(getPathSortKey(candidate), getPathSortKey(current)) *
      direction <
    0;
  const rankOf = (file: GrepFileMatch): number => {
    let low = 0;
    let high = ranked.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (outranks(file, ranked[mid] as GrepFileMatch)) high = mid;
      else low = mid + 1;
    }
    return low;
  };

  return {
    admit(file) {
      const key = keyOf(file);
      if (files.has(key)) {
        return true;
      }

      if (ranked.length < capacity) {
        ranked.splice(rankOf(file), 0, file);
        files.set(key, file);
        return true;
      }

      const worst = ranked[ranked.length - 1];
      if (!worst) {
        files.set(key, file);
        return true;
      }

      if (!outranks(file, worst)) {
        dropped = true;
        return false;
      }

      ranked.pop();
      ranked.splice(rankOf(file), 0, file);
      files.delete(keyOf(worst));
      onEvict?.(worst);
      files.set(key, file);
      dropped = true;
      return true;
    },
    dropped: () => dropped,
  };
}

export function admitFileBytes(
  files: Map<string, GrepFileMatch>,
  admission: Admission | null,
  rawPath: Uint8Array,
  input: Pick<NormalizedGrepInput, 'cwd' | 'worktree'>,
  // GNU fallback results omit a false nonUtf8Path while ripgrep results
  // carry it explicitly; each backend keeps its exact observable shape.
  dropFalseNonUtf8 = false,
): GrepFileMatch | null {
  const pathInfo = buildPathFromBytes(rawPath, input.cwd, input.worktree);
  const existing = files.get(pathInfo.pathKey);
  if (existing) return existing;

  const created = createFileMatch({
    file: pathInfo.displayPath,
    absolutePath: pathInfo.absolutePath,
    replayPath: pathInfo.replayPath,
    nonUtf8Path:
      dropFalseNonUtf8 && !pathInfo.nonUtf8Path
        ? undefined
        : pathInfo.nonUtf8Path,
    pathKey: pathInfo.pathKey,
  });
  if (!admission) {
    files.set(pathInfo.pathKey, created);
    return created;
  }
  return admission.admit(created) ? created : null;
}

export async function collectFileEntries(
  proc: GrepProcess,
  input: FileListInput,
  visit: (
    yieldFile: (filePath: Uint8Array, matchCount: number) => boolean,
  ) => Promise<void>,
  dropFalseNonUtf8 = false,
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

  await visit((filePath, matchCount) => {
    const file = admitFileBytes(
      files,
      admission,
      filePath,
      input,
      dropFalseNonUtf8,
    );
    if (!file) {
      return true;
    }
    file.matchCount = matchCount;
    if (!admission && files.size >= input.maxResults) {
      limitReached = true;
      killProcess(proc);
      return false;
    }
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

export async function consumeCountOutput(
  stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
  proc: GrepProcess,
  input: FileListInput,
): Promise<{
  files: GrepFileMatch[];
  skippedLines: number;
  limitReached: boolean;
}> {
  let skippedLines = 0;
  const collected = await collectFileEntries(
    proc,
    input,
    (yieldFile) =>
      consumeNullCountPairsBytes(stdout, (filePath, countText) => {
        if (!/^\d+$/.test(countText)) {
          skippedLines += 1;
          return true;
        }

        const count = Number.parseInt(countText, 10);
        if (count === 0) {
          return true;
        }
        return yieldFile(filePath, count);
      }),
    true,
  );
  return { ...collected, skippedLines };
}

export async function consumeFilesOutput(
  stdout: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
  proc: GrepProcess,
  input: FileListInput,
): Promise<{
  files: GrepFileMatch[];
  skippedLines: number;
  limitReached: boolean;
}> {
  return collectFileEntries(
    proc,
    input,
    (yieldFile) =>
      consumeNullItemsBytes(stdout, (filePath) => {
        if (filePath.length === 0) {
          return true;
        }
        return yieldFile(filePath, 1);
      }),
    true,
  );
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
  const direction = input.sortOrder === 'desc' ? -1 : 1;
  return [...files].sort(
    (left, right) =>
      Buffer.compare(getPathSortKey(left), getPathSortKey(right)) * direction,
  );
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
