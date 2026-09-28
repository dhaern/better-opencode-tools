/// <reference types="bun-types" />
import { expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import {
  throwIfAborted as assertNotAborted,
  createAbortError,
  createSearchAbortError,
  throwIfAborted,
} from '../../utils/abort';
import { probeExecutable } from './cli-probe';
import { consumeNullPrefixedLinesStream } from './fallback-content';
import {
  consumeNullCountPairsBytes,
  consumeNullItemsBytes,
  consumeRgJsonStream,
  readTextStream,
} from './json-stream';
import {
  escapeBinaryText,
  escapeControlChars,
  escapeControlCharsPreservingNewlines,
  escapePathBytes,
  tryDecodeUtf8,
} from './path-utils';
import { AbortWaitError } from './runtime';

function chunks(parts: string[], onCancel?: () => void) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      if (!onCancel) controller.close();
    },
    cancel: onCancel,
  });
}

test('framing preserves split frames and final JSON without newline', async () => {
  const items: string[] = [];
  await consumeNullItemsBytes(chunks(['a', 'bc\0de', 'f\0ignored']), (item) => {
    items.push(new TextDecoder().decode(item));
    return true;
  });
  expect(items).toEqual(['abc', 'def']);
  const pairs: string[] = [];
  await consumeNullCountPairsBytes(
    chunks(['a\0', '4\r\nb\0', '9\n']),
    (item, count) => {
      pairs.push(`${new TextDecoder().decode(item)}:${count}`);
      return true;
    },
  );
  expect(pairs).toEqual(['a:4', 'b:9']);
  const records: string[] = [];
  await consumeNullPrefixedLinesStream(
    chunks(['a\0', '12:foo\n--\n', 'b\0', '3:bar\n']),
    (record) => {
      records.push(
        record === '--'
          ? record
          : `${new TextDecoder().decode(record.filePath)}:${new TextDecoder().decode(record.line)}`,
      );
      return true;
    },
  );
  expect(records).toEqual(['a:12:foo', '--', 'b:3:bar']);
  const events: string[] = [];
  await consumeRgJsonStream(
    chunks(['{"type":"match","data":{}}\r\n{"type":', '"end","data":{}}']),
    (event) => {
      events.push(event.type);
      return true;
    },
  );
  expect(events).toEqual(['match', 'end']);
});

test('early stop cancels stream exactly once for all framed consumers', async () => {
  const cases: Array<
    [string, (stream: ReadableStream<Uint8Array>) => Promise<void>]
  > = [
    ['a\0b\0', (stream) => consumeNullItemsBytes(stream, () => false)],
    [
      'a\0' + '1\nb\0' + '2\n',
      (stream) => consumeNullCountPairsBytes(stream, () => false),
    ],
    [
      'a\0' + '1:foo\nb\0' + '2:bar\n',
      (stream) => consumeNullPrefixedLinesStream(stream, () => false),
    ],
    [
      '{"type":"match","data":{}}\n',
      (stream) => consumeRgJsonStream(stream, () => false),
    ],
  ];
  for (const [text, consume] of cases) {
    let cancellations = 0;
    await consume(
      chunks([text], () => {
        cancellations++;
      }),
    );
    expect(cancellations).toBe(1);
  }
});

test('invalid JSON rejects and destroys a Node pipe that never ends', async () => {
  let sent = false;
  const stream = new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push('not JSON\n');
      }
    },
  });
  await expect(consumeRgJsonStream(stream, () => true)).rejects.toThrow(
    'invalid JSON',
  );
  expect(stream.destroyed).toBe(true);
});

test('a throwing event handler cancels a web pipe once without replacing its error', async () => {
  const original = new Error('handler failed');
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('{"type":"match","data":{}}\n'),
      );
    },
    cancel() {
      cancellations += 1;
      throw new Error('cancel failed');
    },
  });
  await expect(
    consumeRgJsonStream(stream, () => {
      throw original;
    }),
  ).rejects.toBe(original);
  expect(cancellations).toBe(1);
});

test('stderr retains collected text on stream read failure and preserves truncation suffix', async () => {
  const encoder = new TextEncoder();
  let produced = false;
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced) controller.error(new Error('pipe closed'));
      else {
        produced = true;
        controller.enqueue(encoder.encode('partial'));
      }
    },
  });
  expect(await readTextStream(broken)).toBe('partial');
  expect(await readTextStream(chunks(['abcdef']), 3)).toBe(
    'abc\n[stderr truncated]',
  );
});

test('byte and text escaping keep tab, CR and newline contracts', () => {
  const bytes = Uint8Array.from([9, 10, 13, 0, 0x61, 0xff]);
  expect(escapePathBytes(bytes)).toBe('\\t\\n\\r\\x00a\\xff');
  expect(escapeBinaryText(bytes)).toBe('\t\n\r\\x00a\\xff');
  expect(escapeControlChars('\t\n\r\u0000')).toBe('\\t\\n\\r\\x00');
  expect(escapeControlCharsPreservingNewlines('\t\n\r\u0000')).toBe(
    '\\t\n\\r\\x00',
  );
});

test('shared UTF-8 decoder resets after malformed input', () => {
  expect(tryDecodeUtf8(Uint8Array.from([0xff]))).toBeUndefined();
  expect(tryDecodeUtf8(new TextEncoder().encode('café'))).toBe('café');
});

test('abort errors preserve exact message and class for each caller', async () => {
  const signal = AbortSignal.abort();
  expect(() => throwIfAborted(signal)).toThrow(
    'ripgrep auto-install was aborted',
  );
  expect(createAbortError().name).toBe('AbortError');
  expect(createSearchAbortError()).toBeInstanceOf(AbortWaitError);
  expect(createSearchAbortError().message).toBe(
    'Search was cancelled before execution started.',
  );
  const custom = new AbortWaitError('custom abort');
  try {
    assertNotAborted(signal, () => custom);
    throw new Error('did not abort');
  } catch (error) {
    expect(error).toBe(custom);
  }
  expect(
    new AbortWaitError('Search was cancelled before execution started.'),
  ).toBeInstanceOf(AbortWaitError);
  expect(
    new AbortWaitError('Search was cancelled before execution started.')
      .message,
  ).toBe('Search was cancelled before execution started.');
  await expect(
    probeExecutable('unused', ['--version'], signal),
  ).rejects.toBeInstanceOf(AbortWaitError);
  await expect(
    probeExecutable(
      'unused',
      ['--version'],
      signal,
      undefined,
      undefined,
      createAbortError,
    ),
  ).rejects.toMatchObject({
    name: 'AbortError',
    message: 'ripgrep auto-install was aborted',
  });
});
