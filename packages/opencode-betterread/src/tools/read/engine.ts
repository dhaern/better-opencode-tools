import { constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, stat } from 'node:fs/promises';
import { dataFileAttachment } from './attachments';
import {
  isImageMime,
  isNotebookPath,
  isPdfMime,
  isProbablyBinary,
  sniffMime,
} from './binary';
import { SAMPLE_BYTES } from './constants';
import { readDirectory } from './directory-reader';
import {
  buildDirectoryMetadata,
  buildImageMetadata,
  buildPdfMetadata,
  buildStaticMetadata,
  buildTextMetadata,
} from './enhanced-metadata';
import {
  formatDirectoryResult,
  formatImageInfoResult,
  formatPdfResult,
  renderTextResult,
} from './formatter';
import { readImageInfo } from './image-info';
import { normalizeReadArgs } from './limits';
import { readNotebook } from './notebook-reader';
import {
  isMissingPathError,
  listSimilarPaths,
  resolveAccessPath,
  resolveReadPath,
} from './path-utils';
import { readPdf } from './pdf-reader';
import { escapeStructuredSingleLineValue } from './structured-escape';
import { readTextFile } from './text-reader';
import type {
  NormalizedReadArgs,
  NotebookReadResult,
  ReadArgs,
  ReadExecutionResult,
  ReadInspection,
  TextReadResult,
} from './types';

async function sampleFile(
  signal: AbortSignal | undefined,
  handle: FileHandle,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const buffer = Buffer.alloc(SAMPLE_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  signal?.throwIfAborted();
  return buffer.subarray(0, bytesRead);
}

function assertFilePath(args: NormalizedReadArgs): void {
  if (args.filePath.length === 0) {
    throw new Error('filePath must be a non-empty string');
  }
}

function notFoundMessage(resolvedPath: string, similarPaths: string[]): string {
  const displayPath = escapeStructuredSingleLineValue(resolvedPath);
  if (similarPaths.length === 0) return `File not found: ${displayPath}`;
  return `File not found: ${displayPath}\nDid you mean:\n${similarPaths
    .map(escapeStructuredSingleLineValue)
    .join('\n')}`;
}

function classifyReadTarget(
  fileStat: NonNullable<ReadInspection['fileStat']>,
): ReadInspection['kind'] {
  if (fileStat.isDirectory()) return 'directory';
  if (fileStat.isFile()) return 'file';
  return 'special';
}

function specialFileMessage(resolvedPath: string): string {
  return `Cannot read special file: ${escapeStructuredSingleLineValue(resolvedPath)}`;
}

export async function inspectReadTarget(input: {
  args: ReadArgs;
  directory: string;
}): Promise<ReadInspection> {
  const args = normalizeReadArgs(input.args);
  assertFilePath(args);

  const resolvedPath = resolveReadPath(args.filePath, input.directory);
  const { accessPath, realPath } = await resolveAccessPath(resolvedPath);

  try {
    const fileStat = await stat(accessPath);
    return {
      args,
      resolvedPath,
      accessPath,
      realPath,
      exists: true,
      kind: classifyReadTarget(fileStat),
      fileStat,
      similarPaths: [],
    };
  } catch (error) {
    if (!isMissingPathError(error)) throw error;

    return {
      args,
      resolvedPath,
      accessPath,
      realPath,
      exists: false,
      kind: 'file',
      similarPaths: [],
    };
  }
}

function metadataPath(input: ReadInspection): {
  filePath: string;
  realPath?: string;
} {
  return {
    filePath: input.resolvedPath,
    ...(input.realPath ? { realPath: input.realPath } : {}),
  };
}

function assertReadableWindow(
  result: TextReadResult | NotebookReadResult,
): void {
  if (result.totalLines === undefined) return;
  if (result.endLine >= result.startLine) return;
  if (result.totalLines === 0 && result.startLine === 1) return;

  throw new Error(
    `Offset ${result.startLine} is out of range for this file (${result.totalLines} lines)`,
  );
}

export async function executeRead(input: {
  args: ReadArgs;
  directory: string;
  inspection?: ReadInspection;
  signal?: AbortSignal;
}): Promise<ReadExecutionResult> {
  input.signal?.throwIfAborted();
  const inspection =
    input.inspection ??
    (await inspectReadTarget({ args: input.args, directory: input.directory }));
  const args = inspection.args;
  const readPath = inspection.accessPath;

  if (!inspection.exists) {
    const similarPaths =
      inspection.similarPaths.length > 0
        ? inspection.similarPaths
        : await listSimilarPaths(inspection.accessPath);
    throw new Error(notFoundMessage(inspection.resolvedPath, similarPaths));
  }

  if (inspection.kind === 'directory') {
    // Re-check identity before listing: a target swapped during the
    // permission ask must not be listed as the authorized directory.
    input.signal?.throwIfAborted();
    const currentStat = await stat(readPath);
    if (
      !inspection.fileStat ||
      currentStat.dev !== inspection.fileStat.dev ||
      currentStat.ino !== inspection.fileStat.ino ||
      !currentStat.isDirectory()
    ) {
      throw new Error(
        `Read target changed while awaiting permission: ${escapeStructuredSingleLineValue(inspection.resolvedPath)}`,
      );
    }
    const directory = {
      ...(await readDirectory(
        readPath,
        args.offset,
        args.limit,
        {},
        input.signal,
      )),
      path: inspection.resolvedPath,
    };
    return {
      kind: directory.kind,
      path: directory.path,
      resolvedPath: inspection.resolvedPath,
      realPath: inspection.realPath,
      output: formatDirectoryResult(directory),
      metadata: buildDirectoryMetadata(metadataPath(inspection), directory),
    };
  }

  if (inspection.kind === 'special') {
    throw new Error(specialFileMessage(inspection.resolvedPath));
  }

  // Bind every byte we return to a single descriptor opened after the
  // permission ask and verified against the inspected identity: reopen-by-
  // path races (TOCTOU) are rejected here instead of silently reading a
  // substituted object. The pre-open re-stat narrows the swap-to-FIFO window
  // (opening a FIFO read end would block); the post-open fstat is the real
  // identity check.
  input.signal?.throwIfAborted();
  const preOpenStat = await stat(readPath);
  if (
    !inspection.fileStat ||
    preOpenStat.dev !== inspection.fileStat.dev ||
    preOpenStat.ino !== inspection.fileStat.ino ||
    !preOpenStat.isFile()
  ) {
    throw new Error(
      `Read target changed while awaiting permission: ${escapeStructuredSingleLineValue(inspection.resolvedPath)}`,
    );
  }
  const handle = await open(
    readPath,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
  );
  try {
    const handleStat = await handle.stat();
    if (
      !handleStat.isFile() ||
      (inspection.fileStat &&
        (handleStat.dev !== inspection.fileStat.dev ||
          handleStat.ino !== inspection.fileStat.ino))
    ) {
      throw new Error(
        `Read target changed while awaiting permission: ${escapeStructuredSingleLineValue(inspection.resolvedPath)}`,
      );
    }

    const sample = await sampleFile(input.signal, handle);
    const mime = sniffMime(sample);

    if (isImageMime(mime)) {
      const image = {
        ...(await readImageInfo(readPath, handle, input.signal)),
        path: inspection.resolvedPath,
      };
      return {
        kind: image.kind,
        path: image.path,
        resolvedPath: inspection.resolvedPath,
        realPath: inspection.realPath,
        output: formatImageInfoResult(image),
        metadata: buildImageMetadata(metadataPath(inspection), image),
        attachments: [
          await dataFileAttachment({
            path: inspection.accessPath,
            mime: image.mime,
            handle,
            signal: input.signal,
          }),
        ],
      };
    }

    if (isPdfMime(mime)) {
      const pdf = {
        // pdfinfo takes a path argument; metadata-only, so a path-based
        // probe is acceptable. Attachment bytes come from the verified
        // descriptor.
        ...(await readPdf(readPath, input.signal)),
        path: inspection.resolvedPath,
      };
      return {
        kind: pdf.kind,
        path: pdf.path,
        resolvedPath: inspection.resolvedPath,
        realPath: inspection.realPath,
        output: formatPdfResult(pdf),
        metadata: buildPdfMetadata(metadataPath(inspection), pdf),
        attachments: [
          await dataFileAttachment({
            path: inspection.accessPath,
            mime: 'application/pdf',
            handle,
            signal: input.signal,
          }),
        ],
      };
    }

    if (isNotebookPath(inspection.resolvedPath)) {
      const notebook = await readNotebook(
        readPath,
        args.offset,
        args.limit,
        input.signal,
        handle,
      );
      notebook.path = inspection.resolvedPath;
      assertReadableWindow(notebook);
      const rendered = renderTextResult(notebook);
      return {
        kind: notebook.kind,
        path: notebook.path,
        resolvedPath: inspection.resolvedPath,
        realPath: inspection.realPath,
        output: rendered.output,
        metadata: buildTextMetadata(
          metadataPath(inspection),
          notebook,
          rendered,
        ),
      };
    }

    if (isProbablyBinary(inspection.resolvedPath, sample)) {
      const output = `Binary file detected: ${escapeStructuredSingleLineValue(
        inspection.resolvedPath,
      )}`;
      return {
        kind: 'binary',
        path: inspection.resolvedPath,
        resolvedPath: inspection.resolvedPath,
        realPath: inspection.realPath,
        output,
        metadata: buildStaticMetadata(
          { ...metadataPath(inspection), kind: 'binary' },
          output,
          false,
        ),
      };
    }

    const text = await readTextFile(
      readPath,
      args.offset,
      args.limit,
      input.signal,
      handle,
    );
    text.path = inspection.resolvedPath;
    assertReadableWindow(text);
    const rendered = renderTextResult(text);
    return {
      kind: text.kind,
      path: text.path,
      resolvedPath: inspection.resolvedPath,
      realPath: inspection.realPath,
      output: rendered.output,
      metadata: buildTextMetadata(metadataPath(inspection), text, rendered),
    };
  } finally {
    // All readers use positioned operations and never take ownership of this
    // descriptor, so the engine performs the single close here.
    await handle.close().catch(() => undefined);
  }
}
