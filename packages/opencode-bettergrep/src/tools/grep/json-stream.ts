import { MAX_STDERR_CHARS, RG_BINARY } from './constants';
import { formatNonUtf8TextDisplay, tryDecodeUtf8 } from './path-utils';
import type { RgJsonEvent, RgPathPayload, RgTextPayload } from './types';

export function decodeRgPayload(
  payload: RgTextPayload | RgPathPayload | undefined,
): string {
  if (typeof payload?.text === 'string') return payload.text;
  if (typeof payload?.bytes !== 'string') return '';
  const bytes = Buffer.from(payload.bytes, 'base64');
  return tryDecodeUtf8(bytes) ?? formatNonUtf8TextDisplay(bytes);
}

export type BinaryReadableStream =
  | NodeJS.ReadableStream
  | ReadableStream<Uint8Array>
  | null
  | undefined;

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<unknown>;
}

// Web streams keep their own reader. Node pipes use their native async
// iterator, not Readable.toWeb(): after cancel() that adapter can still
// enqueue a chunk flushed by a pending resume tick and throw outside any
// caller (nodejs/node#64529), terminating a host without a global handler.
function getChunkReader(stream: BinaryReadableStream): ChunkReader | null {
  if (!stream) return null;
  if ('getReader' in stream && typeof stream.getReader === 'function')
    return (stream as ReadableStream<Uint8Array>).getReader();
  const chunks = (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  return {
    read: () => chunks.next() as ReturnType<ChunkReader['read']>,
    cancel: async () => chunks.return?.(),
  };
}

export class GrowableByteBuffer {
  private buffer = new Uint8Array(0);
  private start = 0;
  private end = 0;
  private searchStart = 0;

  append(chunk?: Uint8Array): void {
    if (!chunk?.length) return;
    if (this.end + chunk.length > this.buffer.length) {
      const length = this.end - this.start;
      if (length + chunk.length <= this.buffer.length) {
        this.buffer.copyWithin(0, this.start, this.end);
      } else {
        const next = new Uint8Array(
          Math.max(64, this.buffer.length * 2, length + chunk.length),
        );
        next.set(this.buffer.subarray(this.start, this.end));
        this.buffer = next;
      }
      this.searchStart = Math.max(0, this.searchStart - this.start);
      this.start = 0;
      this.end = length;
    }
    this.buffer.set(chunk, this.end);
    this.end += chunk.length;
  }

  takeUntil(delimiter: number): Uint8Array | undefined {
    const relativeIndex = this.buffer
      .subarray(this.searchStart, this.end)
      .indexOf(delimiter);
    if (relativeIndex < 0) {
      this.searchStart = this.end;
      return undefined;
    }

    const absoluteIndex = this.searchStart + relativeIndex;
    const item = this.buffer.slice(this.start, absoluteIndex);
    this.advance(absoluteIndex + 1);
    return item;
  }

  startsWith(prefix: Uint8Array): boolean {
    if (prefix.length > this.end - this.start) return false;
    for (let index = 0; index < prefix.length; index += 1) {
      if (this.buffer[this.start + index] !== prefix[index]) return false;
    }
    return true;
  }

  takePrefix(length: number): Uint8Array | undefined {
    if (length < 0 || this.end - this.start < length) return undefined;
    const item = this.buffer.slice(this.start, this.start + length);
    this.advance(this.start + length);
    return item;
  }

  drain(): Uint8Array {
    return this.takePrefix(this.end - this.start) ?? new Uint8Array();
  }

  private advance(position: number): void {
    this.start = position;
    this.searchStart = position;
    if (position === this.end) {
      this.start = 0;
      this.end = 0;
      this.searchStart = 0;
    }
  }
}

export async function consumeBufferedBytes(
  stream: BinaryReadableStream,
  onBuffer: (buffer: GrowableByteBuffer, done: boolean) => boolean | undefined,
): Promise<void> {
  const reader = getChunkReader(stream);
  if (!reader) return;
  const buffer = new GrowableByteBuffer();
  while (true) {
    const { done, value } = await reader.read();
    buffer.append(value);
    let keepReading: boolean | undefined;
    try {
      keepReading = onBuffer(buffer, done);
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        // Cancellation is best-effort; preserve the consumer's original error.
      }
      throw error;
    }
    if (keepReading === false) {
      await reader.cancel();
      return;
    }
    if (done) return;
  }
}

export async function consumeNullItemsBytes(
  stream: BinaryReadableStream,
  onItem: (item: Uint8Array) => boolean | undefined,
): Promise<void> {
  return consumeBufferedBytes(stream, (buffer) => {
    while (true) {
      const item = buffer.takeUntil(0);
      if (item === undefined) break;
      if (onItem(item) === false) return false;
    }
  });
}

export async function consumeNullCountPairsBytes(
  stream: BinaryReadableStream,
  onPair: (filePath: Uint8Array, countText: string) => boolean | undefined,
): Promise<void> {
  const decoder = new TextDecoder();
  let currentPath: Uint8Array | undefined;
  return consumeBufferedBytes(stream, (buffer) => {
    while (true) {
      if (currentPath === undefined) {
        const pathBytes = buffer.takeUntil(0);
        if (pathBytes === undefined) break;
        currentPath = pathBytes;
        continue;
      }
      const countBytes = buffer.takeUntil(0x0a);
      if (countBytes === undefined) break;
      const pathBytes = currentPath;
      currentPath = undefined;
      const countText = decoder.decode(countBytes).replace(/\r$/, '');
      if (onPair(pathBytes, countText) === false) return false;
    }
  });
}

export async function consumeRgJsonStream(
  stream: BinaryReadableStream,
  onEvent: (event: RgJsonEvent) => boolean | undefined,
): Promise<void> {
  const decoder = new TextDecoder();
  return consumeBufferedBytes(stream, (buffer, done) => {
    const parse = (
      bytes: Uint8Array,
      trailing: boolean,
    ): boolean | undefined => {
      const line = decoder.decode(bytes).replace(/\r$/, '');
      if (!line) return;
      let event: RgJsonEvent;
      try {
        event = JSON.parse(line) as RgJsonEvent;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${RG_BINARY} returned invalid ${trailing ? 'trailing JSON' : 'JSON'}: ${message}. Line: ${line.slice(0, 200)}`,
        );
      }
      return onEvent(event);
    };
    while (true) {
      const line = buffer.takeUntil(0x0a);
      if (line === undefined) break;
      if (parse(line, false) === false) return false;
    }
    if (done && parse(buffer.drain(), true) === false) return false;
  });
}

export async function readTextStream(
  stream: BinaryReadableStream,
  maxChars = MAX_STDERR_CHARS,
  suffix = '[stderr truncated]',
  preserveOnError = true,
  cancelOnLimit = true,
): Promise<string> {
  const reader = getChunkReader(stream);
  if (!reader) return '';

  const decoder = new TextDecoder();
  let text = '';

  while (true) {
    let result: Awaited<ReturnType<typeof reader.read>>;
    try {
      result = await reader.read();
    } catch (error) {
      // Preserve partial output after a forced pipe close.
      if (!preserveOnError) throw error;
      break;
    }
    const { done, value } = result;
    text += value ? decoder.decode(value, { stream: true }) : decoder.decode();

    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n${suffix}`;
      if (cancelOnLimit) {
        await reader.cancel();
      } else {
        // Keep the child's pipe drained without retaining output or waiting
        // for its exit; cancelling a Node pipe would cause a child EPIPE.
        void (async () => {
          try {
            while (!(await reader.read()).done) {
              /* drain */
            }
          } catch {
            /* stream closed */
          }
        })();
      }
      break;
    }

    if (done) break;
  }

  return text;
}
