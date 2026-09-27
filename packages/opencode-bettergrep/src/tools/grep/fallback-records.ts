import { type BinaryReadableStream, consumeBufferedBytes } from './json-stream';
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

export function parseContentLine(
  filePath: Uint8Array,
  lineBytes: Uint8Array,
  withContext: boolean,
): ParsedContentRecord | null {
  const line = stripSingleLineEnding(
    tryDecodeUtf8(lineBytes) ?? formatNonUtf8TextDisplay(lineBytes),
  );
  const match = line.match(/^(\d+)([:-])(.*)$/);
  if (!match || (!withContext && match[2] !== ':')) return null;
  return {
    filePath,
    lineNumber: Number.parseInt(match[1], 10),
    text: normalizeDisplayText(match[3]),
    isMatch: match[2] === ':',
  };
}

export async function consumeNullPrefixedLinesStream(
  stream: BinaryReadableStream,
  onRecord: (record: ContentRecord) => boolean | undefined,
): Promise<void> {
  let currentPath: Uint8Array | undefined;
  const separator = Uint8Array.from([0x2d, 0x2d, 0x0a]);
  return consumeBufferedBytes(stream, (buffer) => {
    while (true) {
      if (currentPath === undefined) {
        // The context group separator must be recognized BEFORE scanning
        // for the next NUL, or it gets glued onto the following path.
        if (buffer.startsWith(separator)) {
          buffer.takePrefix(separator.length);
          if (onRecord('--') === false) return false;
          continue;
        }

        const pathBytes = buffer.takeUntil(0);
        if (pathBytes === undefined) break;
        currentPath = pathBytes;
        continue;
      }

      const lineBytes = buffer.takeUntil(0x0a);
      if (lineBytes === undefined) break;

      const record: RawContentRecord = {
        filePath: currentPath,
        line: lineBytes,
      };
      currentPath = undefined;
      if (onRecord(record) === false) return false;
    }
  });
}
