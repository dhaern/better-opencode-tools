# ⚡ opencode-bettergrep

[![npm](https://img.shields.io/npm/v/opencode-bettergrep)](https://www.npmjs.com/package/opencode-bettergrep)
[![License: MIT](https://img.shields.io/github/license/dhaern/better-opencode-tools)](https://github.com/dhaern/better-opencode-tools/blob/main/LICENSE)

An OpenCode plugin that replaces the built-in `grep` tool. It registers under the
same tool ID, searches with ripgrep, and adds the filters, limits and timeout
handling an agent needs when it explores a large repository.

It is part of [Better OpenCode Tools](https://github.com/dhaern/better-opencode-tools),
next to `opencode-betterglob` and `opencode-betterread`.

## 🚀 Install

```bash
npm install opencode-bettergrep
```

```json
{
  "plugin": ["opencode-bettergrep"]
}
```

To run it from a local checkout, clone the repository, run `bun install` and
`bun run build`, and point the plugin entry at
`file:///path/to/better-opencode-tools/packages/opencode-bettergrep`.

## 🔎 What you can ask for

| Area | Options |
| --- | --- |
| Output | `output_mode`: `content`, `files_with_matches` or `count`. |
| Matching | `fixed_strings`, `case_sensitive`, `smart_case`, `word_regexp`, `invert_match`, `multiline`, `multiline_dotall`, `pcre2`. |
| Context | `context`, `before_context`, `after_context` (0 to 20 lines). |
| Scope | `path` or `paths`, `include`, `globs`, `exclude_globs`, `file_type`, `file_types`, `exclude_file_types`, `max_filesize`, `hidden`, `follow_symlinks`. |
| Limits | `max_results` (500 by default, 5,000 at most), `max_count_per_file`, `timeout_ms` (80 s by default, 140 s at most). |
| Order | `sort_by`: `none`, `path` or `mtime`, with `sort_order`. |

Results list file paths, line numbers and context. When a search was cut short by
a limit, a timeout or a cancellation, the output says so, so the agent knows
whether the result was exhaustive.

## 🛡️ How it handles processes

- Every search runs under a deadline. On timeout or cancellation the process gets
  SIGTERM and then SIGKILL, so a stubborn child does not outlive the call.
- The probe that checks the ripgrep binary competes against process termination.
  A probe that times out resolves even if a child process keeps stdio open.
- When results tie on modification time, they are ordered by raw path bytes. The
  output does not depend on which worker finished first or on the system locale.

## 🧭 Finding ripgrep

The plugin uses a ripgrep it finds on `PATH`, and installs a managed copy when it
finds none. If ripgrep cannot be used, it falls back to GNU grep. The fallback
runs with `LC_ALL=C.UTF-8` and an empty `LANGUAGE`, so its version output parses
in English even on a machine with a translated locale.

The fallback choice is remembered for 10 minutes. After that the plugin tries
ripgrep again, so a single failed probe does not keep the session on GNU grep. It
also tries again as soon as the ripgrep binary on `PATH` changes.

## ⚠️ Known limitations

- The GNU grep fallback is slower and does not support every ripgrep feature.
- An `include` or `globs` entry that matches every path (`*`, `**`, `**/*`) is
  not passed to ripgrep, so ignore files such as `.gitignore` still apply. Any
  other positive glob is a ripgrep override: it also searches the ignored or
  hidden files it names. To search an ignored directory, pass it as `path`.
- `.git` directories are skipped even with `hidden` or a glob such as
  `**/.git/**`, unless a search path is inside one (`path: '.git'`), as in
  OpenCode's native grep.
- A very large output can still be expensive for the host UI and the model, even
  when the search process exits quickly. Use `max_results` and the filters to keep
  results small.

## 🧪 Development

```bash
bun run typecheck
bun test
bun run build
bun run check
```
