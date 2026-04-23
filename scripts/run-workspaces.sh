#!/usr/bin/env sh
set -eu

script_name="${1:?usage: sh ./scripts/run-workspaces.sh <script>}"

found=0
for dir in packages/*; do
  if [ ! -d "$dir" ]; then
    continue
  fi

  found=1
  printf '\n==> %s (%s)\n' "$dir" "$script_name"
  (
    cd "$dir"
    bun run "$script_name"
  )
done

if [ "$found" -eq 0 ]; then
  printf 'No workspace packages found in packages/*\n' >&2
  exit 1
fi
