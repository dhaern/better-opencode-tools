export const DEFAULT_READ_LIMIT = 4096;
export const MAX_READ_LIMIT = 32768;
export const DEFAULT_DIRECTORY_LIMIT = 4096;
export const MAX_DIRECTORY_LIMIT = 16384;
export const DEFAULT_OFFSET = 1;
export const MAX_LINE_LENGTH = 4096;
export const SAMPLE_BYTES = 8192;
export const FAST_PATH_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 512 * 1024;
export const MAX_OUTPUT_CHARS = 262144;
export const MAX_PARSED_NOTEBOOK_BYTES = MAX_OUTPUT_BYTES * 4;
export const MAX_SIMILAR_PATHS = 5;
export const PDF_COMMAND_TIMEOUT_MS = 15000;
export const READ_TOOL_ID = 'read';
export const ATTACHMENT_UNAVAILABLE_NOTE =
  'Builtin-style file attachments are unavailable through the current plugin API; returning metadata/text only.';
export const READ_DESCRIPTION = `Read a file or directory from the local filesystem. If the path does not exist, an error is returned.

Usage:
- Args: filePath, offset?, limit?
- filePath accepts absolute, session-relative, and \`~/\` paths
- Returns numbered lines for files and one entry per line for directories
- Supports text, directories, notebooks, images, PDFs, and binary detection
- Images and PDFs return metadata/text only`;
