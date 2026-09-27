import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { destroyReader, watchCappedStream } from '../../utils/process-output';
import type { GlobSearchResult, NormalizedGlobInput } from './types';

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sliceLimit(
  input: NormalizedGlobInput,
  files: string[],
): string[] {
  return files.slice(0, input.limit);
}

export function emptyResult(
  input: NormalizedGlobInput,
  command: string[] | undefined,
  extra: Partial<GlobSearchResult> = {},
): GlobSearchResult {
  return {
    files: [],
    count: 0,
    backend: 'rg',
    truncated: false,
    incomplete: false,
    timedOut: false,
    cancelled: false,
    exitCode: 0,
    command,
    cwd: input.searchPath,
    stderr: '',
    ...extra,
  };
}

interface StderrWatch {
  read: () => string;
  stop: () => void;
}

type DestroyableReadable = NodeJS.ReadableStream & {
  destroy?: () => void;
  closed?: boolean;
};

// destroy() may report its error asynchronously. Keep a harmless error
// listener until close, independently of the run's settlement listeners.
function watchReader(
  stream: NodeJS.ReadableStream,
  onData: (chunk: Buffer | string) => void,
): () => void {
  let stopped = false;
  const ignoreError = () => undefined;
  const onClose = () => {
    stream.removeListener('data', onData);
    stream.removeListener('error', ignoreError);
    stream.removeListener('close', onClose);
  };
  stream.on('error', ignoreError);
  stream.once('close', onClose);
  stream.on('data', onData);
  return () => {
    if (stopped) return;
    stopped = true;
    stream.removeListener('data', onData);
    const reader = stream as DestroyableReadable;
    if (reader.closed || !reader.destroy) onClose();
    else destroyReader(reader as ChildProcess['stdout']);
  };
}

export function watchStderr(stream: NodeJS.ReadableStream | null): StderrWatch {
  return watchCappedStream(stream as ChildProcess['stdout'], 'stderr');
}

// rg emits NUL-delimited relative paths (--null). Records are split on the
// raw byte stream and only complete records are decoded, so multibyte UTF-8
// sequences split across stream chunks survive intact.
export function collectMatchedPaths(
  input: NormalizedGlobInput,
  stream: NodeJS.ReadableStream | null,
  options: { onOverflow?: () => void } = {},
): {
  read: () => string[];
  stop: () => void;
} {
  if (!stream) {
    return {
      read: () => [],
      stop: () => undefined,
    };
  }

  const files: string[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let overflowed = false;

  const consume = (record: Buffer) => {
    if (record.length === 0) return;
    const relative = record.toString('utf-8');
    files.push(path.resolve(input.searchPath, relative));
    if (files.length > input.limit) {
      overflowed = true;
      options.onOverflow?.();
    }
  };

  const onData = (chunk: Buffer | string) => {
    if (overflowed) return;

    const data =
      typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    let searchable = Buffer.concat(
      pending.length === 0 ? [data] : [pending, data],
    );
    pending = Buffer.alloc(0);

    let separator = searchable.indexOf(0);
    while (separator !== -1) {
      consume(searchable.subarray(0, separator));
      if (overflowed) return;
      searchable = searchable.subarray(separator + 1);
      separator = searchable.indexOf(0);
    }

    pending = searchable;
  };

  const stop = watchReader(stream, onData);

  return {
    // Only NUL-terminated records are ever published as paths. rg --null
    // terminates every record; a leftover fragment means the process was
    // cut mid-write (abort/timeout/limit), and publishing it would invent
    // paths that may not exist.
    read: () => [...files],
    stop,
  };
}
