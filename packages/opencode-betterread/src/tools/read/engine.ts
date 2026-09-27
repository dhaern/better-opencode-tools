import type { Stats } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import {
  dataAttachment,
  imageDimensions,
  isNotebookPath,
  isProbablyBinary,
  readBoundedBytes,
  sniffMime,
} from './attachments';
import {
  FAST_PATH_MAX_BYTES,
  MAX_EMBEDDED_ATTACHMENT_BYTES,
  SAMPLE_BYTES,
} from './constants';
import { formatDirectoryResult, readDirectory } from './directory-reader';
import {
  buildDirectoryMetadata,
  buildImageMetadata,
  buildPdfMetadata,
  buildStaticMetadata,
  buildTextMetadata,
  escapeStructuredSingleLineValue,
  formatImageInfoResult,
  formatPdfResult,
  renderTextResult,
} from './formatter';
import { normalizeReadArgs } from './limits';
import { readNotebook } from './notebook-reader';
import {
  isMissingPathError,
  listSimilarPaths,
  resolveAccessPath,
  resolveReadPath,
} from './path-utils';
import { readPdf } from './pdf-reader';
import { readTextWindow } from './text-reader';
import type { ReadArgs, ReadExecutionResult, ReadInspection } from './types';

export async function inspectReadTarget(input: {
  args: ReadArgs;
  directory: string;
}): Promise<ReadInspection> {
  const args = normalizeReadArgs(input.args);
  if (args.filePath.length === 0) {
    throw new Error('filePath must be a non-empty string');
  }
  const resolvedPath = resolveReadPath(args.filePath, input.directory);
  const { accessPath, realPath } = await resolveAccessPath(resolvedPath);
  const base = { args, resolvedPath, accessPath, realPath };
  try {
    const fileStat = await stat(accessPath);
    const kind = fileStat.isDirectory()
      ? 'directory'
      : fileStat.isFile()
        ? 'file'
        : 'special';
    return { ...base, exists: true, kind, fileStat };
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return { ...base, exists: false, kind: 'file' };
  }
}

// A target swapped during the permission ask must not be read as the
// authorized one: identity (dev/ino) and type must still match.
function assertSameTarget(
  inspection: ReadInspection,
  current: Stats,
  isExpectedType: (current: Stats) => boolean,
): void {
  const expected = inspection.fileStat;
  if (
    !expected ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    !isExpectedType(current)
  ) {
    throw new Error(
      `Read target changed while awaiting permission: ${escapeStructuredSingleLineValue(inspection.resolvedPath)}`,
    );
  }
}

export async function executeRead(input: {
  args: ReadArgs;
  directory: string;
  inspection?: ReadInspection;
  signal?: AbortSignal;
}): Promise<ReadExecutionResult> {
  const { signal } = input;
  signal?.throwIfAborted();
  const inspection =
    input.inspection ??
    (await inspectReadTarget({ args: input.args, directory: input.directory }));
  const { args, resolvedPath, realPath, accessPath: readPath } = inspection;
  const pathInfo = {
    filePath: resolvedPath,
    ...(realPath ? { realPath } : {}),
  };
  const done = (
    output: string,
    metadata: Record<string, unknown>,
    attachments?: ReadExecutionResult['attachments'],
  ): ReadExecutionResult => ({
    output,
    metadata,
    ...(attachments ? { attachments } : {}),
  });

  if (!inspection.exists) {
    const suggestions = (await listSimilarPaths(readPath))
      .map(escapeStructuredSingleLineValue)
      .join('\n');
    throw new Error(
      `File not found: ${escapeStructuredSingleLineValue(resolvedPath)}${suggestions ? `\nDid you mean:\n${suggestions}` : ''}`,
    );
  }

  if (inspection.kind === 'directory') {
    signal?.throwIfAborted();
    assertSameTarget(inspection, await stat(readPath), (s) => s.isDirectory());
    const directory = await readDirectory(
      readPath,
      args.offset,
      args.limit,
      { displayPath: resolvedPath },
      signal,
    );
    return done(
      formatDirectoryResult(directory),
      buildDirectoryMetadata(pathInfo, directory),
    );
  }

  if (inspection.kind === 'special') {
    throw new Error(
      `Cannot read special file: ${escapeStructuredSingleLineValue(resolvedPath)}`,
    );
  }

  // Bind every byte we return to a single descriptor opened after the
  // permission ask and verified against the inspected identity: reopen-by-
  // path races (TOCTOU) are rejected here instead of silently reading a
  // substituted object. The pre-open re-stat narrows the swap-to-FIFO window
  // (opening a FIFO read end would block); the post-open fstat is the real
  // identity check.
  signal?.throwIfAborted();
  assertSameTarget(inspection, await stat(readPath), (s) => s.isFile());
  const handle = await open(
    readPath,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
  );
  try {
    const handleStat = await handle.stat();
    assertSameTarget(inspection, handleStat, (s) => s.isFile());

    signal?.throwIfAborted();
    const sampleBuffer = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await handle.read(sampleBuffer, 0, SAMPLE_BYTES, 0);
    signal?.throwIfAborted();
    const sample = sampleBuffer.subarray(0, bytesRead);
    const mime = sniffMime(sample);

    if (mime) {
      // Images and PDFs are embedded from the verified descriptor with one
      // bounded read; image dimensions come from the same bytes.
      const bytes = await readBoundedBytes(
        handle,
        MAX_EMBEDDED_ATTACHMENT_BYTES,
        signal,
        handleStat.size,
      );
      const attachments = [dataAttachment(readPath, mime, bytes)];
      if (mime === 'application/pdf') {
        // pdfinfo takes a path argument; metadata-only, so a path-based
        // probe is acceptable.
        const pdf = {
          ...(await readPdf(readPath, signal)),
          path: resolvedPath,
        };
        return done(
          formatPdfResult(pdf),
          buildPdfMetadata(pathInfo, pdf),
          attachments,
        );
      }
      const image = {
        kind: 'image' as const,
        path: resolvedPath,
        mime,
        sizeBytes: handleStat.size,
        ...imageDimensions(mime, bytes),
      };
      return done(
        formatImageInfoResult(image),
        buildImageMetadata(pathInfo, image),
        attachments,
      );
    }

    const notebook = isNotebookPath(resolvedPath);
    if (!notebook && isProbablyBinary(resolvedPath, sample)) {
      const output = `Binary file detected: ${escapeStructuredSingleLineValue(resolvedPath)}`;
      return done(
        output,
        buildStaticMetadata({ ...pathInfo, kind: 'binary' }, output, false),
      );
    }

    const text = notebook
      ? await readNotebook(
          args.offset,
          args.limit,
          handle,
          handleStat.size,
          signal,
        )
      : await readTextWindow(
          handle,
          args.offset,
          args.limit,
          {
            countAll: handleStat.size <= FAST_PATH_MAX_BYTES,
            size: handleStat.size,
          },
          signal,
        );
    const visible = { ...text, path: resolvedPath };
    if (
      visible.totalLines !== undefined &&
      visible.endLine < visible.startLine &&
      !(visible.totalLines === 0 && visible.startLine === 1)
    ) {
      throw new Error(
        `Offset ${visible.startLine} is out of range for this file (${visible.totalLines} lines)`,
      );
    }
    const rendered = renderTextResult(visible);
    return done(
      rendered.output,
      buildTextMetadata(pathInfo, visible, rendered),
    );
  } finally {
    // Readers use positioned operations and never take ownership of this
    // descriptor, so the engine performs the single close here.
    await handle.close().catch(() => undefined);
  }
}
