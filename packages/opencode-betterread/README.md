# 📖 opencode-betterread

[![npm](https://img.shields.io/npm/v/opencode-betterread)](https://www.npmjs.com/package/opencode-betterread)
[![License: MIT](https://img.shields.io/github/license/dhaern/better-opencode-tools)](https://github.com/dhaern/better-opencode-tools/blob/main/LICENSE)

An OpenCode plugin that replaces the built-in `read` tool. It registers under the
same tool ID and keeps the numbered-line output models are used to, but it keeps
each read inside the host's output budget and tells the model where to continue.

It is part of [Better OpenCode Tools](https://github.com/dhaern/better-opencode-tools),
next to `opencode-bettergrep` and `opencode-betterglob`.

## 🚀 Install

```bash
npm install opencode-betterread
```

```json
{
  "plugin": ["opencode-betterread"]
}
```

To run it from a local checkout, clone the repository, run `bun install` and
`bun run build`, and point the plugin entry at
`file:///path/to/better-opencode-tools/packages/opencode-betterread`.

## 📄 Text output and continuation

Text files come back with numbered lines. When a read hits the budget, the output
ends with the line to resume from:

```
(Showing lines 1-1363. Use offset=1364 to continue.)
```

The host would otherwise cut an oversized result without saying where it stopped,
and the model would have to guess or read the file again. A single line that is
larger than the whole budget is reported by number
(`(Line 12 exceeds budget. Use offset=13 to continue.)`) so the read can move
past it. Long lines carry a truncation note.

The budget comes from the `tool_output` block of your OpenCode config:

```json
{
  "tool_output": {
    "max_lines": 4000,
    "max_bytes": 153600
  }
}
```

Missing or invalid values fall back to 2,000 lines and 51,200 bytes. The budget
covers the path and type framing, the continuation footer and any truncation
note. Two fixed safety ceilings still apply: 262,144 characters and 524,288 bytes.
Calling the exported `createReadTool` without per-instance limits uses the same
2,000-line and 51,200-byte defaults.

## 🧠 What it can read

| Input | Result |
| --- | --- |
| Text and code | Numbered lines, with offset and limit. |
| Directories | Sorted, paginated entries. The total is marked as exact or partially scanned. |
| Jupyter notebooks | Small ones are rendered cell by cell. Large or malformed ones fall back to bounded raw text. |
| Images | Dimensions and metadata, plus an embedded attachment. |
| PDFs | A conservative metadata and text summary, plus an embedded attachment. |
| Binary files | An explicit binary placeholder. |
| Missing paths | An error with suggestions when there are close matches. |

Directory entries are sorted by UTF-16 code units, so the listing does not depend
on ICU or on the runtime's locale. Symlinks in the visible window get a trailing
`/` when they point to a directory, as the native tool does.

Images and PDFs are returned as embedded `data:` base64 attachments, which is the
only attachment form the host delivers to models (checked against OpenCode
1.18.x). Attachments are capped at 20 MiB. A larger file is reported as an error
instead of inflating memory and the provider payload.

## 🔐 Permissions and filesystem safety

- The tool runs its own `read` and `external_directory` permission checks,
  including symlink-aware paths and escaped permission patterns.
- File reads open one verified descriptor after the permission prompt, so a target
  that is swapped in the meantime is rejected and not read.
- Special files such as FIFOs are rejected.
- PDF helper output is bounded.

## ⚠️ Known limitations

- Nested `AGENTS.md` auto-loading is not available. The plugin API does not expose
  the host's instruction resolver, so reading a file inside a subproject does not
  attach that subproject's `AGENTS.md`. The native tool does.
- PDF metadata extraction is intentionally conservative.
- The plugin replaces the agent-facing `read` tool only. It does not patch
  OpenCode internals.

## 🧪 Development

```bash
bun run typecheck
bun test
bun run build
bun run check
```
