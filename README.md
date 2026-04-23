# 🛠️ Better OpenCode Tools

**Better OpenCode Tools** is a monorepo of standalone OpenCode plugins that
replace the built-in `glob`, `grep`, and `read` tools with faster, stricter, and
more predictable implementations.

The goal is simple: keep the familiar OpenCode tool IDs while improving the
runtime behavior behind them.

## ✨ What is included?

| Plugin | Replaces | Main advantage |
| --- | --- | --- |
| [`opencode-betterglob`](./packages/opencode-betterglob) | `glob` | Fast `ripgrep`-powered file discovery with safer limits and native-style output. |
| [`opencode-bettergrep`](./packages/opencode-bettergrep) | `grep` | Advanced local search with `ripgrep`, fallback handling, rich filters, and hard-kill timeouts. |
| [`opencode-betterread`](./packages/opencode-betterread) | `read` | Real plugin replacement for file/directory/notebook reading with stricter permissions and robust output budgeting. |

## 🚀 Why use these instead of the native tools?

### ⚡ Faster file operations

`glob` and `grep` use `ripgrep` where possible, giving excellent performance on
large repositories while still returning model-friendly output.

### 🧯 Safer execution behavior

The plugins include hardened timeout and process handling, bounded output
budgets, safer path handling, and explicit behavior around partial results.

### 🧭 Better agent ergonomics

Outputs are formatted for AI agents: line numbers, continuation hints,
structured metadata, and clear notes when results are partial, capped, or
metadata-only.

### 🧩 Drop-in OpenCode integration

Each package registers using the same tool ID as the built-in tool it replaces:
`glob`, `grep`, or `read`. No OpenCode core patching is required.

## 📦 Packages at a glance

### 🔍 `opencode-betterglob`

- Uses `rg --files` for fast file discovery.
- Supports sorting, hidden files, symlink behavior, limits, and timeouts.
- Keeps native-compatible plain path output.
- Avoids returning enormous default result sets by using safer defaults.

### ⚡ `opencode-bettergrep`

- Uses `ripgrep` as the primary search backend.
- Supports content search, count mode, files-with-matches, context, multiline,
  PCRE2, file globs, sorting, and result limits.
- Includes robust timeout handling with SIGTERM to SIGKILL escalation.
- Provides fallback behavior for environments where `ripgrep` is unavailable.

### 📖 `opencode-betterread`

- Fully replaces the agent-facing `read` tool as a real plugin tool.
- Handles text files, directories, notebooks, PDFs, images, binary files, and
  missing-file suggestions.
- Preserves numbered-line output and continuation hints.
- Implements plugin-side read and external-directory permission checks.
- Returns metadata/text for images and PDFs because the current OpenCode plugin
  API does not expose built-in-style file attachments.

## 📦 npm-ready package names

The monorepo is prepared for npm publication with these planned package names:

```bash
npm install opencode-betterglob
npm install opencode-bettergrep
npm install opencode-betterread
```

Actual registry availability depends on whether a release has already been
published. Until then, use the source/file installation flow below.

## 🚀 Installation from source

Clone and build the monorepo:

```bash
git clone https://github.com/dhaern/better-opencode-tools.git
cd better-opencode-tools
bun install
bun run build
```

Then add the packages you want to your OpenCode config:

```json
{
  "plugin": [
    "file:///path/to/better-opencode-tools/packages/opencode-betterglob",
    "file:///path/to/better-opencode-tools/packages/opencode-bettergrep",
    "file:///path/to/better-opencode-tools/packages/opencode-betterread"
  ]
}
```

Use only the packages you actually want to enable.

## 🧪 Development

```bash
bun install
bun run typecheck
bun test
bun run build
bun run check
```

The root scripts run across all packages under `packages/*`.

## 📝 Issue reporting

This repository uses GitHub issue forms for bug reports, feature requests, and
questions. A lightweight issue triage workflow adds plugin labels and asks only
for the minimum missing details when a report is incomplete.

## ⚠️ Known limitations

- `opencode-betterread` cannot return built-in-style image/PDF attachments
  because the current public plugin API only supports text output and metadata.
- The plugins are intended to replace the agent-facing tool calls. They do not
  patch private OpenCode internals.
- If multiple plugins replace the same tool ID, OpenCode plugin load order
  determines which one wins.

## 🤝 Contributing

Contributions are welcome. Keep changes local to the plugins unless a core
change is explicitly proposed and reviewed separately.

### 🙏 Special thanks

Special thanks to [`oh-my-opencode-slim`](https://github.com/alvinunreal/oh-my-opencode-slim)
for pushing the OpenCode plugin ecosystem forward and for helping inspire parts
of the standalone plugin direction taken here.

If you want a broader day-to-day OpenCode plugin setup beyond the standalone
tool replacements in this repository, it is also worth checking out and trying.

Before opening a PR, run:

```bash
bun run typecheck
bun test
bun run build
bun run check
```

---

Built for people who want OpenCode tools that stay familiar, but behave better
under real-world repository pressure.
