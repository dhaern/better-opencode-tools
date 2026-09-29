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
| `hidden` | `true` | Include hidden files. Ignore rules apply as described below. |
| `timeout_ms` | 80,000 | Deadline for the whole call, including binary resolution and any first install. |

The default limit is deliberately low, so a broad pattern does not flood the
conversation with paths. Raise `limit` when you need more.

Output is plain paths with the native tool's empty-result and timeout messages,
so agents can use it as a drop-in replacement.

## 🛡️ How it handles processes

- A search that reaches its limit stops ripgrep immediately; SIGKILL follows
  only if it has not closed after the kill grace. Output drain is bounded.
- Timeout and cancellation stop the process, including a wrapper's child because
  ripgrep runs in its own process group on POSIX.
- Paths are read NUL-delimited, so unusual file names stay intact.
- `which` and `proper-lockfile` load only when they are needed. Importing the
  plugin does not patch host globals.

## ⏱️ Benchmark against the built-in `glob`

Times in milliseconds, lower is better, for the built-in tool from the OpenCode
1.18.32 source and this plugin at 1.1.0. Both were called in process with the same
arguments, on a 4-core Arm Neoverse-N1 VM with ripgrep 15.2.0, over the OpenCode
repository (about 6,600 files) and a generated directory of 5,000 files. The
built-in tool returns at most 100 paths and does not sort, so the "same limit"
column ran the plugin with `limit: 100` and `sort_by: "none"`. Each figure is a
median across separate runs of the suite: 5 for the built-in tool and 4 for the
plugin (Bun 1.4.2 and Bun 1.3.14, two runs each). The two Bun versions differ by
less than 2 ms on every row.

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
order does not matter. The full method, and the `read` and `grep` results, are in
the [repository README](https://github.com/dhaern/better-opencode-tools#readme).

## ⚠️ Known limitations

- On Windows, only the launched process is stopped with `child.kill()`, as in 1.0.1.
- `sort_by: "mtime"` relies on ripgrep's modified-time sorting. On a very broad
  search, ripgrep may not stream useful partial paths before a timeout.
- The first run may need network access if the plugin has to download a managed
  ripgrep binary.
- On Bun hosts, a working `node` executable must be on `PATH` to validate or
  install ripgrep, or to resolve a managed ripgrep. An already validated `rg` on
  `PATH` can search without it.
- The first managed ripgrep installation loads `proper-lockfile`, which patches
  some Node process and fs functions and signal listeners.
- Ignore files such as `.gitignore` always apply to a pattern that matches
  every path (`*`, `**`, `**/*`). Any other pattern is a ripgrep override, as in
  OpenCode's native glob: it also returns the ignored or hidden files it names
  (`*.log`, `.env*`), and `packages/**` also descends into ignored directories
  below `packages/`, such as nested `node_modules`. To list an ignored
  directory, pass it as `path`.
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
