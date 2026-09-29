# 🛠️ Better OpenCode Tools

[![betterglob](https://img.shields.io/npm/v/opencode-betterglob?label=betterglob)](https://www.npmjs.com/package/opencode-betterglob)
[![bettergrep](https://img.shields.io/npm/v/opencode-bettergrep?label=bettergrep)](https://www.npmjs.com/package/opencode-bettergrep)
[![betterread](https://img.shields.io/npm/v/opencode-betterread?label=betterread)](https://www.npmjs.com/package/opencode-betterread)
[![License: MIT](https://img.shields.io/github/license/dhaern/better-opencode-tools)](./LICENSE)

Three OpenCode plugins that replace the built-in `glob`, `grep` and `read` tools.
They register under the same tool IDs and accept the arguments models already
use, so prompts and agents keep working unchanged. Behind the call, output stays
inside the host budget and says where to continue, search processes cannot hang,
and results come back in the same order on every run.

Each plugin is published on its own. Install only the ones you want.

| Plugin | Replaces | What it does |
| --- | --- | --- |
| [`opencode-betterglob`](./packages/opencode-betterglob) | `glob` | File discovery on top of `rg --files`, with a default limit of 500 paths, mtime or path sorting and a hard deadline. |
| [`opencode-bettergrep`](./packages/opencode-bettergrep) | `grep` | Content search on top of ripgrep, with a GNU grep fallback, the full ripgrep filter set and SIGTERM-then-SIGKILL timeouts. |
| [`opencode-betterread`](./packages/opencode-betterread) | `read` | Text, directories, notebooks, images, PDFs and binaries, with its own permission checks and an output budget that follows your OpenCode config. |

## 🎯 What you notice in use

- `read` cuts its output at the host's `tool_output` budget and ends with the
  offset to continue from, so the model resumes where it stopped and does not
  re-read what it already has. A single line larger than the budget is reported
  by number instead of being dropped.
- Every search process has a deadline and is killed on timeout or cancellation.
  `glob` launches `rg` directly and sends SIGTERM immediately when it reaches
  its limit. If `rg` ignores SIGTERM, SIGKILL follows after 250 ms.
- Ordering does not depend on timing or locale. `grep` breaks mtime ties by raw
  path bytes, and `read` sorts directory entries by UTF-16 code units. The same
  tree gives the same listing on every runtime.
- The GNU grep fallback runs with `LC_ALL=C.UTF-8` and an empty `LANGUAGE`, so
  its output parses the same on a machine with a translated locale. If ripgrep
  fails once, the plugin tries it again after 10 minutes instead of staying on
  GNU grep for the rest of the session.
- Startup is lighter. `effect` (in `read`) and `which` and `proper-lockfile` (in
  `glob`) load on first use. Cold start of `read` dropped from about 260 ms to
  about 70 ms.

## 📉 Smaller code, same features

Version 1.0.0 was a refactor, and no feature was removed. Production code
compared with 0.3.1:

| Plugin | Lines | Files | Tests |
| --- | --- | --- | --- |
| `opencode-betterglob` | 4,746 → 3,892 (−18.0 %) | 28 → 26 | 187 |
| `opencode-bettergrep` | 8,270 → 7,323 (−11.5 %) | 39 → 32 | 302 |
| `opencode-betterread` | 2,902 → 2,121 (−26.9 %) | 24 → 15 | 174 |

Per-release notes are on the [Releases page](https://github.com/dhaern/better-opencode-tools/releases).

## 🚀 Install

```bash
npm install opencode-betterglob opencode-bettergrep opencode-betterread
```

Then list the plugins in your OpenCode config by package name:

```json
{
  "plugin": [
    "opencode-betterglob",
    "opencode-bettergrep",
    "opencode-betterread"
  ]
}
```

<details>
<summary>Run from a local checkout instead</summary>

```bash
git clone https://github.com/dhaern/better-opencode-tools.git
cd better-opencode-tools
bun install
bun run build
```

```json
{
  "plugin": [
    "file:///path/to/better-opencode-tools/packages/opencode-betterglob",
    "file:///path/to/better-opencode-tools/packages/opencode-bettergrep",
    "file:///path/to/better-opencode-tools/packages/opencode-betterread"
  ]
}
```

</details>

## ⚙️ Output budget

`read` takes its limits from the `tool_output` block of your OpenCode config.
Raise them if you want larger windows per call:

```json
{
  "tool_output": {
    "max_lines": 4000,
    "max_bytes": 153600
  }
}
```

Missing or invalid values fall back to 2,000 lines and 51,200 bytes. `grep` and
`glob` do not read this block. They are limited per call with `max_results` and
`limit`.

## ✅ Compatibility

The plugins target the OpenCode 1.x plugin API and are built against
`@opencode-ai/plugin` 1.18.32. Their entry points use the v1 module shape
(`{ id, server }`). Loading them in an OpenCode v2 host has not been tested,
because no v2 host was available.

## ⚠️ Known limitations

- Reading a file inside a subproject does not attach that subproject's nested
  `AGENTS.md`. The native tool does, but the plugin API does not expose the host's
  instruction resolver.
- If several plugins register the same tool ID, OpenCode's plugin load order
  decides which one wins.
- The first search may download a managed ripgrep binary when none is on `PATH`,
  so it needs network access once.
- The plugins replace the agent-facing tool calls only. They do not patch OpenCode
  internals.

## 🧪 Development

```bash
bun install
bun run check
bun run typecheck
bun test
bun run build
```

The root scripts run across every package under `packages/*`. Please run all of
them before opening a PR, and keep changes inside the plugins unless a core
change has been discussed first.

Bugs, feature requests and questions go through the issue forms. A small workflow
adds the plugin label and asks for whatever is missing from an incomplete report.

Thanks to [`oh-my-opencode-slim`](https://github.com/alvinunreal/oh-my-opencode-slim)
for pushing the OpenCode plugin ecosystem forward and inspiring part of the
standalone direction taken here. It is worth trying if you want a broader plugin
setup.
