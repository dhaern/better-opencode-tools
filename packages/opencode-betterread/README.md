# 📖 opencode-betterread

`opencode-betterread` is a standalone OpenCode plugin that replaces the
agent-facing built-in `read` tool with a real plugin implementation.

It focuses on predictable file ingestion: numbered text output, robust directory
pagination, notebook handling, binary detection, explicit permission checks, and
honest metadata for non-text formats.

## ✨ Why it is better than the native read tool

### 📄 Better text windows

The plugin preserves numbered line output while adding stronger output budgeting,
long-line truncation notes, continuation hints, and metadata that reflects the
final emitted output.

### 📁 Safer directory reads

Directory listings are paginated, sorted, bounded, and explicit about whether the
total entry count is exact or only partially scanned. Special files and symlink
edge cases are handled defensively.

### 📓 Notebook support

Small Jupyter notebooks are rendered as readable cell-oriented text. Large or
malformed notebooks fall back to bounded raw text instead of loading huge files
into memory blindly.

### 🔐 Plugin-side permission hardening

The tool performs its own `read` and `external_directory` permission checks,
including symlink-aware access paths and escaped permission patterns.

### 🧯 Defensive filesystem behavior

The implementation rejects special files such as FIFOs, handles missing paths
with suggestions, avoids following symlinks just to decorate directory entries,
and keeps PDF helper output bounded.

## 🧠 Supported inputs

- text/code files
- directories
- Jupyter notebooks (`.ipynb`)
- PDFs as metadata/text-only summaries
- images as metadata-only summaries
- binary files as explicit binary placeholders
- missing paths with safe suggestions when possible

## ⚠️ Important limitation: media attachments

The current public OpenCode plugin API does not expose the same rich attachment
channel used by the built-in `read` tool.

Because of that, this plugin **does not return built-in-style image/PDF
attachments**. For images and PDFs it returns metadata/text only, with an explicit
note in the output.

## 📦 npm installation

Planned npm package name:

```bash
npm install opencode-betterread
```

This package metadata is ready for npm publication, but actual registry
availability depends on whether it has already been published. Until then, use
the source/file installation flow below.

## 🚀 Installation from source

```bash
git clone https://github.com/dhaern/better-opencode-tools.git
cd better-opencode-tools
bun install
bun run build
```

Add the plugin to your OpenCode config:

```json
{
  "plugin": [
    "file:///path/to/better-opencode-tools/packages/opencode-betterread"
  ]
}
```

## 🧪 Development

```bash
bun run typecheck
bun test
bun run build
bun run check
```

## ⚠️ Known limitations

- No built-in-style image/PDF attachments through the current plugin API.
- PDF support is intentionally conservative and metadata-oriented.
- The plugin replaces the agent-facing `read` tool, but it does not patch private
  OpenCode internals.
