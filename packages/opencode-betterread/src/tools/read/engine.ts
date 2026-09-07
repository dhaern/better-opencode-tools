import { open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
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
  readPath: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await open(readPath, 'r');
  try {
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
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

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
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
    const kind = classifyReadTarget(fileStat);
    const capturedIdentity = {
      dev: fileStat.dev,
      ino: fileStat.ino,
      realPath,
    };
    return {
      args,
      resolvedPath,
      accessPath,
      realPath,
      exists: true,
      kind,
      fileStat,
      similarPaths: [],
      revalidate: async () => {
        const currentRealPath = await safeRealpathInline(accessPath);
        if (currentRealPath !== capturedIdentity.realPath) {
          throw new Error(
            `Read target changed while awaiting permission: ${escapeStructuredSingleLineValue(resolvedPath)}`,
          );
        }
        const currentStat = await stat(accessPath);
        if (
          currentStat.dev !== capturedIdentity.dev ||
          currentStat.ino !== capturedIdentity.ino
        ) {
          throw new Error(
            `Read target changed while awaiting permission: ${escapeStructuredSingleLineValue(resolvedPath)}`,
          );
        }
        if (classifyReadTarget(currentStat) !== kind) {
          throw new Error(
            `Read target type changed while awaiting permission: ${escapeStructuredSingleLineValue(resolvedPath)}`,
          );
        }
      },
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

async function safeRealpathInline(
  targetPath: string,
): Promise<string | undefined> {
  try {
    return await realpath(targetPath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return undefined;
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

// The host only delivers attachments whose URL is an embedded `data:` URL
// (message-v2 filters `url.startsWith("data:")`), so embed bytes like the
// native read tool does instead of returning `file://` URLs.
async function dataFileAttachment(input: {
  path: string;
  mime: string;
}): Promise<NonNullable<ReadExecutionResult['attachments']>[number]> {
  const bytes = await readFile(input.path);
  return {
    type: 'file',
    mime: input.mime,
    url: `data:${input.mime};base64,${bytes.toString('base64')}`,
    filename: path.basename(input.path),
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
    const directory = {
      ...(await readDirectory(readPath, args.offset, args.limit)),
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

  const sample = await sampleFile(readPath, input.signal);
  const mime = sniffMime(sample);

  if (isImageMime(mime)) {
    const image = {
      ...(await readImageInfo(readPath)),
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
        }),
      ],
    };
  }

  if (isPdfMime(mime)) {
    const pdf = {
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
        }),
      ],
    };
  }

  if (isNotebookPath(inspection.resolvedPath)) {
    const notebook = {
      ...(await readNotebook(readPath, args.offset, args.limit, input.signal)),
      path: inspection.resolvedPath,
    };
    assertReadableWindow(notebook);
    const rendered = renderTextResult(notebook);
    return {
      kind: notebook.kind,
      path: notebook.path,
      resolvedPath: inspection.resolvedPath,
      realPath: inspection.realPath,
      output: rendered.output,
      metadata: buildTextMetadata(metadataPath(inspection), notebook, rendered),
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

  const text = {
    ...(await readTextFile(readPath, args.offset, args.limit, input.signal)),
    path: inspection.resolvedPath,
  };
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
}
