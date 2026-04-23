export const GLOB_TOOL_ID = 'glob';
export const RG_BINARY = 'rg';

export const GLOB_DESCRIPTION = `Fast file pattern matching tool backed by ripgrep.

Usage:
- Base args: pattern, path?
- Optional args: limit, sort_by, sort_order, hidden, follow_symlinks, timeout_ms
- Returns absolute file paths, one per line
- Use this tool for file name/path matching, not content search`;

export const DEFAULT_GLOB_LIMIT = 500;
export const DEFAULT_GLOB_TIMEOUT_MS = 80_000;

export const TRUNCATED_NOTE =
  '(Results are truncated: reached the {limit}-result limit. Consider using a more specific path or pattern.)';
