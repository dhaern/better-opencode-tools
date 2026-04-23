export const GREP_TOOL_ID = 'grep';
export const RG_BINARY = 'rg';
export const GREP_BINARY = 'grep';

export const GREP_DESCRIPTION = `A powerful local search tool built on ripgrep.

Usage:
- Base args: pattern, path?, include?
- Output modes: content, files_with_matches, count
- Supports regex, fixed_strings, smart_case, PCRE2, multiline, context, file/glob filters, hidden files, symlink following, max_count_per_file, max_filesize, and path or mtime sorting
- Use this tool for content/code search, not file name matching`;

export const DEFAULT_GREP_TIMEOUT_MS = 80_000;
export const MAX_GREP_TIMEOUT_MS = 140_000;

export const DEFAULT_GREP_LIMIT = 500;
export const MAX_GREP_LIMIT = 5_000;
export const MAX_MTIME_DISCOVERY_FILES = 5_000;

export const DEFAULT_GREP_CONTEXT = 0;
export const MAX_GREP_CONTEXT = 20;

export const DEFAULT_GREP_MAX_CONCURRENCY = 2;
export const DEFAULT_GREP_RETRY_COUNT = 1;
export const DEFAULT_GREP_RETRY_DELAY_MS = 150;

export const CONTEXT_BUFFER_MULTIPLIER = 2;
export const MAX_LINE_LENGTH = 2_000;
export const MAX_STDERR_CHARS = 20_000_000;
