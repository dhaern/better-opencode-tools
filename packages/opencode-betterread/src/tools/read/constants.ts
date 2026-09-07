export const DEFAULT_READ_LIMIT = 4096;
export const MAX_READ_LIMIT = 32768;
export const DEFAULT_DIRECTORY_LIMIT = 4096;
export const MAX_DIRECTORY_LIMIT = 16384;
export const DEFAULT_OFFSET = 1;
export const MAX_LINE_LENGTH = 4096;
export const SAMPLE_BYTES = 8192;
export const FAST_PATH_MAX_BYTES = 1024 * 1024;
// Upper bound for base64-embedded image/PDF attachments; larger files are
// reported as an error instead of ballooning memory and provider payloads.
export const MAX_EMBEDDED_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 512 * 1024;
export const MAX_OUTPUT_CHARS = 262144;
export const MAX_PARSED_NOTEBOOK_BYTES = MAX_OUTPUT_BYTES * 4;
export const MAX_SIMILAR_PATHS = 5;
export const PDF_COMMAND_TIMEOUT_MS = 15000;
export const READ_TOOL_ID = 'read';
export const ATTACHMENT_UNAVAILABLE_NOTE =
  'File attachments are delivered as base64 data URLs for provider compatibility.';
export const READ_DESCRIPTION = `Read a file or directory from the local filesystem. If the path does not exist, an error is returned.

Usage:
- Args: filePath, offset?, limit?
- filePath accepts absolute, session-relative, and \`~/\` paths
- Returns numbered lines for files and one entry per line for directories
- Supports text, directories, notebooks, images, PDFs, and binary detection
- Images and PDFs are returned as embedded base64 attachments
- Known limitation: unlike the native read tool, this override cannot auto-load nested AGENTS.md instructions for the file's subproject (not exposed by the plugin API)`;
