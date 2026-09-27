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

export type NotebookReadResult = Omit<TextReadResult, 'kind'> & {
  kind: 'notebook';
  mode: 'parsed' | 'raw-fallback';
};

export type PdfReadResult = {
  kind: 'pdf';
  path: string;
  pageCount?: number;
};

export type ReadInspection = {
  args: NormalizedReadArgs;
  resolvedPath: string;
  accessPath: string;
  realPath?: string;
  exists: boolean;
  kind: ReadTargetKind;
  fileStat?: Stats;
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
  attachments?: Array<{
    type: 'file';
    mime: string;
    url: string;
    filename?: string;
  }>;
};
