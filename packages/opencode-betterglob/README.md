# 🔍 opencode-betterglob

`opencode-betterglob` is a standalone OpenCode plugin that replaces the built-in
`glob` tool with a fast `ripgrep`-backed file discovery engine.

It keeps the agent-facing behavior simple: return matching file paths, one per
line, while adding stronger controls around limits, sorting, hidden files,
timeouts, and large workspaces.

## ✨ Why it is better than the native glob tool

### ⚡ Faster discovery on large repositories

The plugin uses `rg --files` as its backend, which is highly optimized for large
trees, ignored files, and modern repository layouts.

### 🎛️ More explicit controls

It supports advanced options that make tool calls more predictable:

- `limit`
- `sort_by`
- `sort_order`
- `hidden`
- `follow_symlinks`
- `timeout_ms`

### 🧯 Safer defaults

The default result limit is intentionally conservative to avoid flooding the
conversation with huge path lists. Heavy searches still work, but they are more
controlled.

### 🧩 Native-compatible output

The output remains plain paths with native-style empty states and timeout notes,
so agents can use it as a drop-in replacement for the built-in `glob` tool.

## 🧠 Technical highlights

- Registers as the exact `glob` tool ID.
- Uses NUL-delimited parsing where appropriate for safe path handling.
- Supports ripgrep auto-resolution and managed install behavior.
- Handles timeout and cancellation without leaving long-running processes behind.
- Adds render metadata through a lightweight post-execution hook.

## 📦 npm installation

Planned npm package name:

```bash
npm install opencode-betterglob
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
    "file:///path/to/better-opencode-tools/packages/opencode-betterglob"
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

- `sort_by: "mtime"` depends on ripgrep's modified-time sorting behavior. On
  very broad searches, ripgrep may not stream useful partial paths before a
  timeout.
- First run may need network access if the plugin has to download a managed
  `ripgrep` binary.
