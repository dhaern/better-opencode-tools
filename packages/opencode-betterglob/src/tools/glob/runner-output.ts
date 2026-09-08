import path from 'node:path';
import type { GlobSearchResult, NormalizedGlobInput } from './types';

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Diagnostic cap mirroring the native core-ripgrep adapter (8 KiB). The
// stream keeps being drained so a chatty child cannot block on a full pipe.
const STDERR_CAP_BYTES = 8 * 1024;

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
    else reader.destroy();
  };
}

export function watchStderr(stream: NodeJS.ReadableStream | null): StderrWatch {
  if (!stream) {
    return {
      read: () => '',
      stop: () => undefined,
    };
  }

  let buffer = Buffer.alloc(0);
  let truncated = false;
  const chunks: Buffer[] = [];
  let retained = 0;
  const onData = (chunk: Buffer | string) => {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (retained >= STDERR_CAP_BYTES) {
      truncated = true;
      return;
    }
    if (retained + data.length > STDERR_CAP_BYTES) {
      chunks.push(data.subarray(0, STDERR_CAP_BYTES - retained));
      retained = STDERR_CAP_BYTES;
      truncated = true;
      return;
    }
    chunks.push(data);
    retained += data.length;
  };

  const stop = watchReader(stream, onData);

  return {
    read: () => {
      buffer = Buffer.concat(chunks);
      const text = buffer.toString('utf-8');
      return truncated ? `${text}\n[stderr truncated at 8192 bytes]` : text;
    },
    stop,
  };
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
