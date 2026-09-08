import { Readable } from 'node:stream';
import { GrowableByteBuffer } from './json-stream';
import {
  formatNonUtf8TextDisplay,
  normalizeDisplayText,
  stripSingleLineEnding,
  tryDecodeUtf8,
} from './path-utils';

export interface ParsedContentRecord {
  filePath: Uint8Array;
  lineNumber: number;
  text: string;
  isMatch: boolean;
}

interface RawContentRecord {
  filePath: Uint8Array;
  line: Uint8Array;
}

type ContentRecord = RawContentRecord | '--';

function toWebReadableStream(
  stream: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
): ReadableStream<Uint8Array> | undefined {
  if (!stream) {
    return undefined;
  }

  if ('getReader' in stream && typeof stream.getReader === 'function') {
    return stream as ReadableStream<Uint8Array>;
  }

  return Readable.toWeb(
    stream as unknown as Readable,
  ) as unknown as ReadableStream<Uint8Array>;
}

function decodeGrepText(bytes: Uint8Array): string {
  return normalizeDisplayText(
    tryDecodeUtf8(bytes) ?? formatNonUtf8TextDisplay(bytes),
  );
}

export function parseContentLine(
  filePath: Uint8Array,
  lineBytes: Uint8Array,
  withContext: boolean,
): ParsedContentRecord | null {
  const line = stripSingleLineEnding(decodeGrepText(lineBytes));
  const match = withContext
    ? line.match(/^(\d+)([:-])(.*)$/)
    : line.match(/^(\d+):(.*)$/);

  if (!match) {
    return null;
  }

  if (withContext) {
    const [, lineNumberText, separator, text] = match;
    return {
      filePath,
      lineNumber: Number.parseInt(lineNumberText, 10),
      text: normalizeDisplayText(text),
      isMatch: separator === ':',
    };
  }

  const [, lineNumberText, text] = match;
  return {
    filePath,
    lineNumber: Number.parseInt(lineNumberText, 10),
    text: normalizeDisplayText(text),
    isMatch: true,
  };
}

export async function consumeNullPrefixedLinesStream(
  stream: NodeJS.ReadableStream | ReadableStream<Uint8Array> | undefined,
  onRecord: (record: ContentRecord) => boolean | undefined,
): Promise<void> {
  const readable = toWebReadableStream(stream);
  if (!readable) {
    return;
  }

  const reader = readable.getReader();
  const buffer = new GrowableByteBuffer();
  let currentPath: Uint8Array | undefined;
  const separator = Uint8Array.from([0x2d, 0x2d, 0x0a]);

  while (true) {
    const { done, value } = await reader.read();
    buffer.append(value);

    while (true) {
      if (currentPath === undefined) {
        // The context group separator must be recognized BEFORE scanning
        // for the next NUL, or it gets glued onto the following path.
        if (buffer.startsWith(separator)) {
          buffer.takePrefix(separator.length);
          if (onRecord('--') === false) {
            await reader.cancel();
            return;
          }
          continue;
        }

        const pathBytes = buffer.takeUntil(0);
        if (pathBytes !== undefined) {
          currentPath = pathBytes;
          continue;
        }

        break;
      }

      const lineBytes = buffer.takeUntil(0x0a);
      if (lineBytes === undefined) break;

      const record: RawContentRecord = {
        filePath: currentPath,
        line: lineBytes,
      };
      currentPath = undefined;
      if (onRecord(record) === false) {
        await reader.cancel();
        return;
      }
    }

    if (done) {
      break;
    }
  }

  if (currentPath !== undefined) {
    const lineBytes = buffer.takeUntil(0x0a);
    if (lineBytes !== undefined) {
      onRecord({
        filePath: currentPath,
        line: lineBytes,
      });
    }
  }
}
