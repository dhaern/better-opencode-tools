export interface GlobToolInput {
  pattern: string;
  path?: string;
  limit?: number;
  sort_by?: GlobSortMode;
  sort_order?: GlobSortOrder;
  hidden?: boolean;
  follow_symlinks?: boolean;
  timeout_ms?: number;
}

export type GlobSortMode = 'mtime' | 'path' | 'none';
export type GlobSortOrder = 'desc' | 'asc';
export type GlobBackend = 'rg';

export interface NormalizedGlobInput {
  pattern: string;
  relativePattern: string;
  requestedPath: string;
  resolvedPath: string;
  searchPath: string;
  ignoreFiles: string[];
  limit: number;
  sortBy: GlobSortMode;
  sortOrder: GlobSortOrder;
  hidden: boolean;
  followSymlinks: boolean;
  timeoutMs: number;
  cwd: string;
  worktree: string;
}

export interface GlobSearchResult {
  files: string[];
  count: number;
  backend: GlobBackend;
  truncated: boolean;
  incomplete: boolean;
  timedOut: boolean;
  cancelled: boolean;
  exitCode: number;
  command?: string[];
  cwd: string;
  stderr: string;
  error?: string;
}

export type GlobRunner = (
  input: NormalizedGlobInput,
  signal: AbortSignal,
) => Promise<GlobSearchResult>;
