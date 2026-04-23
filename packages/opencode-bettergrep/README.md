# ⚡ opencode-bettergrep

`opencode-bettergrep` is a standalone OpenCode plugin that replaces the built-in
`grep` tool with a richer local search implementation powered primarily by
`ripgrep`.

It is designed for fast codebase exploration while keeping output structured,
bounded, and useful for AI agents.

## ✨ Why it is better than the native grep tool

### ⚡ Ripgrep-first performance

The primary path uses `ripgrep`, which is usually much faster than generic text
search for real repositories.

### 🔎 More search modes

The plugin supports the common search modes agents need while investigating a
codebase:

- content matches
- `files_with_matches`
- count mode
- fixed-string search
- regular expressions
- multiline search
- PCRE2
- context lines
- include/exclude globs
- file type filters
- size limits
- sorting

### 🧯 Robust timeout behavior

Search processes are terminated with a SIGTERM to SIGKILL escalation path, so a
stubborn child process should not keep running after timeout or cancellation.

### 🧩 Agent-friendly output

Results include file paths, line numbers, context, partial-result notes, and
metadata that helps agents reason about whether a search was exhaustive.

## 🧠 Technical highlights

- Registers as the exact `grep` tool ID.
- Resolves or installs `ripgrep` when needed.
- Includes fallback behavior for environments without ripgrep.
- Tracks timeout, cancellation, partial output, and stderr notes explicitly.
- Keeps output bounded and compatible with OpenCode's tool rendering model.

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
    "file:///path/to/better-opencode-tools/packages/opencode-bettergrep"
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

- Fallback mode is slower and may not support every ripgrep-specific feature.
- Very large outputs can still be expensive for the host UI/model pipeline even
  when the search process itself exits quickly.
