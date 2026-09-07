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
with suggestions, resolves symlinks only for entries in the visible window to
decorate directory links with a trailing `/` (matching the native tool), and
keeps PDF helper output bounded. File reads open a single verified descriptor
after the permission ask, so a target swapped mid-flight is rejected instead of
silently read.

## 🧠 Supported inputs

- text/code files
- directories
- Jupyter notebooks (`.ipynb`)
- PDFs as metadata/text-only summaries
- images as metadata-only summaries
- binary files as explicit binary placeholders
- missing paths with safe suggestions when possible

## 📎 Media attachments

Images and PDFs are returned as embedded `data:` base64 attachments, the only
attachment form the host actually delivers to models (verified against OpenCode
1.18.x). Embedded attachments are capped at 20 MiB; larger media files are
reported as an error instead of ballooning memory and provider payloads.

## 📦 Recommended installation (npm)

For normal installs, use npm:

```bash
npm install opencode-betterread
```

Then register the installed package in your OpenCode config by package name:

```json
{
  "plugin": [
    "opencode-betterread"
  ]
}
```

## 🛠️ Manual installation from source (alternative)

Use the source/file flow if you want to run the plugin from a local checkout or
test local unpublished changes.

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

- Nested `AGENTS.md` auto-loading: the plugin API does not expose the host's
  instruction resolver, so reading a file inside a subproject does not
  auto-attach that subproject's `AGENTS.md` (the native tool does).
- PDF support is intentionally conservative and metadata-oriented.
- The plugin replaces the agent-facing `read` tool, but it does not patch private
  OpenCode internals.
