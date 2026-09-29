# 🔍 opencode-betterglob

[![npm](https://img.shields.io/npm/v/opencode-betterglob)](https://www.npmjs.com/package/opencode-betterglob)
[![License: MIT](https://img.shields.io/github/license/dhaern/better-opencode-tools)](https://github.com/dhaern/better-opencode-tools/blob/main/LICENSE)

An OpenCode plugin that replaces the built-in `glob` tool. It registers under the
same tool ID and returns matching file paths, one per line, using `rg --files`
for the walk.

It is part of [Better OpenCode Tools](https://github.com/dhaern/better-opencode-tools),
next to `opencode-bettergrep` and `opencode-betterread`.

## 🚀 Install

```bash
npm install opencode-betterglob
```

```json
{
  "plugin": ["opencode-betterglob"]
}
```

To run it from a local checkout, clone the repository, run `bun install` and
`bun run build`, and point the plugin entry at
`file:///path/to/better-opencode-tools/packages/opencode-betterglob`.

## 🎛️ Options

| Option | Default | Meaning |
| --- | --- | --- |
| `pattern` | required | The glob to match. |
| `path` | working directory | Directory to search. |
| `limit` | 500 | Maximum number of paths returned. |
| `sort_by` | `mtime` | `mtime`, `path` or `none`. |
| `sort_order` | none | `asc` or `desc`. |
| `hidden` | `true` | Include hidden files, still honoring ignore rules. |
| `timeout_ms` | 80,000 | Deadline for the whole call, including binary resolution and any first install. |

The default limit is deliberately low, so a broad pattern does not flood the
conversation with paths. Raise `limit` when you need more.

Output is plain paths with the native tool's empty-result and timeout messages,
so agents can use it as a drop-in replacement.

## 🛡️ How it handles processes

- A search that reaches its limit stops ripgrep immediately; SIGKILL follows
  only if it has not closed after the kill grace. Output drain is bounded.
- Timeout and cancellation stop the process and do not leave it running.
- Paths are read NUL-delimited, so unusual file names stay intact.
- `which` and `proper-lockfile` load only when they are needed. Importing the
  plugin does not patch host globals.

## ⚠️ Known limitations

- `sort_by: "mtime"` relies on ripgrep's modified-time sorting. On a very broad
  search, ripgrep may not stream useful partial paths before a timeout.
- The first run may need network access if the plugin has to download a managed
  ripgrep binary.
- On Bun hosts, a working `node` executable must be on `PATH` to validate or
  install ripgrep, or to resolve a managed ripgrep. An already validated `rg` on
  `PATH` can search without it.
- The first managed ripgrep installation loads `proper-lockfile`, which patches
  some Node process and fs functions and signal listeners.
- Symlink traversal is disabled. `follow_symlinks: true` is rejected, because an
  `rg --follow` process cannot be confined to the destinations authorized before
  it starts.

## 🧪 Development

```bash
bun run typecheck
BETTERGLOB_TEST_RG="$(command -v rg)" bun test
bun run build
bun run check
```
