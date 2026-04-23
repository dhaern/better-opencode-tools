import type { Stats } from 'node:fs';

export type ReadArgs = {
  filePath: string;
  offset?: number;
  limit?: number;
};

export type NormalizedReadArgs = {
  filePath: string;
  offset: number;
  limit: number;
};

export type ResolvedReadArgs = NormalizedReadArgs;

export type ReadTargetKind = 'file' | 'directory' | 'special';

export type TextReadResult = {
  kind: 'text';
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines?: number;
  truncatedByBytes: boolean;
  truncatedByLineLength: boolean;
  hasMore: boolean;
  mtimeMs: number;
};

export type DirectoryReadResult = {
  kind: 'directory';
  path: string;
  entries: string[];
  offset: number;
  limit: number;
  totalEntries: number;
  totalEntriesKnown: boolean;
  hasMore: boolean;
  truncatedByBytes: boolean;
};

export type ImageInfoResult = {
  kind: 'image';
  path: string;
  mime: string;
  sizeBytes: number;
  width?: number;
  height?: number;
};

export type NotebookReadResult = {
  kind: 'notebook';
  mode: 'parsed' | 'raw-fallback';
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines?: number;
  truncatedByBytes: boolean;
  truncatedByLineLength: boolean;
  hasMore: boolean;
  mtimeMs: number;
};

export type PdfReadResult = {
  kind: 'pdf';
  path: string;
  pageCount?: number;
  mtimeMs: number;
};

export type ReadInspection = {
  args: ResolvedReadArgs;
  resolvedPath: string;
  accessPath: string;
  realPath?: string;
  exists: boolean;
  kind: ReadTargetKind;
  fileStat?: Stats;
  similarPaths: string[];
};

export type ReadExecutionResult = {
  kind:
    | TextReadResult['kind']
    | DirectoryReadResult['kind']
    | ImageInfoResult['kind']
    | NotebookReadResult['kind']
    | PdfReadResult['kind']
    | 'binary';
  path: string;
  resolvedPath: string;
  realPath?: string;
  output: string;
  metadata: Record<string, unknown>;
};
