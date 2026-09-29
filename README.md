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
  `glob` launches `rg` directly in its own process group on POSIX and signals
  the group: SIGTERM at the limit, SIGKILL after 250 ms if it has not closed.
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

## ⏱️ Benchmark against the built-in tools

These are timings of the built-in `read`, `grep` and `glob` from the OpenCode
1.18.32 source and of the three plugins at 1.1.0, measured on one machine over the
same files. Times are in milliseconds and lower is better. Per-release notes are on
the [Releases page](https://github.com/dhaern/better-opencode-tools/releases).

How it was measured:

- Each tool is called in process with the same arguments, with no model or UI in
  between, so the numbers cover the tool itself.
- The files are the OpenCode repository (about 6,600 files) and two generated
  fixtures: a 13 MB log of 200,000 lines and a directory of 5,000 files.
- The machine is a 4-core Arm Neoverse-N1 VM on Ubuntu 24.04 with ripgrep 15.2.0
  on `PATH` and a warm file cache.
- Every case makes 5 to 9 timed calls after a discarded first call, and each run
  of the suite records their median. The tables show the median across runs: 5 runs
  for the built-in tools and 4 for the plugins (Bun 1.4.2 and Bun 1.3.14, two runs
  each). The two Bun versions differ by about 3 ms at most on any row.
- The built-in `grep` and `glob` return at most 100 results, and the built-in
  `glob` does not sort. The `grep` and `glob` tables therefore call the plugins
  with `max_results: 100`, and `glob` also with `limit: 100` and
  `sort_by: "none"`. The `read` table leaves the plugin on its default budget of
  2,000 lines or 50 KiB, the same as the built-in. Output sizes are similar but not
  identical, and differ by up to 2× on the single 300 KB line.

### `read`

| Case | Built-in | Plugin | Ratio |
| --- | ---: | ---: | ---: |
| Small file, 139 lines | 7.7 | 0.9 | 8.2× |
| File of 2,000 lines | 7.6 | 1.9 | 4.1× |
| 13 MB log, first window | 6.4 | 1.8 | 3.7× |
| 13 MB log, 200 lines at offset 150,000 | 330 | 13 | 25.3× |
| Single line of 300 KB | 3.8 | 0.6 | 6.2× |
| Minified bundle, 160 KB | 5.5 | 1.8 | 3.1× |
| Directory of 5,000 entries | 11 | 9.7 | 1.1× |
| Missing file | 0.6 | 0.3 | 2.2× |

The plugin is faster on every case. The gap is smallest on the 5,000-entry
directory (1.1×) and largest when reading 200 lines deep into the 13 MB log.

### `grep`

| Case | Built-in | Plugin | Ratio |
| --- | ---: | ---: | ---: |
| Rare literal, whole repository | 42 | 36 | 1.2× |
| Common word in `*.ts` | 12 | 6.6 | 1.9× |
| Regex in `*.ts` | 15 | 7.4 | 2.1× |
| No match, whole repository | 41 | 34 | 1.2× |
| 13 MB log, many hits | 20 | 7.1 | 2.8× |
| 13 MB log, one hit | 24 | 7.6 | 3.2× |

Both sides run ripgrep. A search that walks the whole repository takes 34 to 42 ms
either way, and the plugin is about 1.2× faster there. On searches limited to
`*.ts` it is 1.9× to 2.1× faster, and on the 13 MB log 2.8× to 3.2×.

### `glob`

| Pattern | Built-in | Plugin, same limit | Plugin, defaults |
| --- | ---: | ---: | ---: |
| `**/*.ts` | 8.2 | 6.0 | 33 |
| `**/*.test.ts` | 9.1 | 9.1 | 28 |
| `**/*` | 9.0 | 7.4 | 49 |
| `*.txt` in a directory of 5,000 files | 11 | 8.8 | 18 |
| `src/tool/*.ts`, few matches | 14 | 13 | 25 |
| No match | 15 | 13 | 25 |

With the same limit and no sorting, the plugin takes the same time as the built-in
tool or slightly less. The plugin defaults to 500 paths sorted by
modification time, and that sort is what costs time. In a separate run on the
repository, the sort added about 25 ms to `**/*.ts` and 40 ms to `**/*`, while
raising the limit from 100 to 500 added about 1 ms. Pass `sort_by: "none"` when
order does not matter.

These figures come from one machine and one repository. They leave out the host
and the model, which add their own latency in a real session.

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
