import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { MAX_EMBEDDED_ATTACHMENT_BYTES } from './constants';
import type { ReadExecutionResult } from './types';

// Reads up to cap+1 bytes from a handle with explicitly positioned reads,
// tolerating short reads and stopping with an error past the cap. The shared
// handle's cursor is never moved.
export async function readBoundedBytes(
  handle: FileHandle,
  cap: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const chunkBuffer = Buffer.alloc(Math.min(1024 * 1024, cap + 1));
  let position = 0;

  for (;;) {
    signal?.throwIfAborted();
    const remaining = cap + 1 - total;
    if (remaining <= 0) break;
    const { bytesRead } = await handle.read(
      chunkBuffer,
      0,
      Math.min(chunkBuffer.length, remaining),
      position,
    );
    if (bytesRead === 0) break;
    position += bytesRead;
    total += bytesRead;
    chunks.push(Buffer.from(chunkBuffer.subarray(0, bytesRead)));
    if (total > cap) break;
  }

  if (total > cap) {
    throw new Error(`Embedded attachment exceeds the ${cap} byte limit`);
  }
  signal?.throwIfAborted();
  return Buffer.concat(chunks, total);
}

// The host only delivers attachments whose URL is an embedded `data:` URL
// (message-v2 filters `url.startsWith("data:")`), so embed bytes like the
// native read tool does instead of returning `file://` URLs. Reading is
// capped so a huge file cannot balloon memory or the provider payload.
export async function dataFileAttachment(input: {
  path: string;
  mime: string;
  handle: FileHandle;
  signal?: AbortSignal;
}): Promise<NonNullable<ReadExecutionResult['attachments']>[number]> {
  const bytes = await readBoundedBytes(
    input.handle,
    MAX_EMBEDDED_ATTACHMENT_BYTES,
    input.signal,
  );
  return {
    type: 'file',
    mime: input.mime,
    url: `data:${input.mime};base64,${bytes.toString('base64')}`,
    filename: path.basename(input.path),
  };
}
