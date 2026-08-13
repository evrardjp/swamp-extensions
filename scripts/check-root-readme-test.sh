#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

printf '%s\n' '# expected' >"$tmpdir/README.md"
cp "$tmpdir/README.md" "$tmpdir/canonical.md"

bash "$repo_root/scripts/check-root-readme.sh" \
  "$tmpdir/README.md" "$tmpdir/canonical.md"

printf '%s\n' '# drifted' >"$tmpdir/README.md"
if output=$(bash "$repo_root/scripts/check-root-readme.sh" \
  "$tmpdir/README.md" "$tmpdir/canonical.md" 2>&1); then
  printf '%s\n' 'Expected changed README content to fail validation.' >&2
  exit 1
fi

if [[ "$output" != *'--- '* || "$output" != *'+++ '* ||
  "$output" != *'-# expected'* || "$output" != *'+# drifted'* ]]; then
  printf '%s\n' 'Expected changed README validation to print a unified diff.' >&2
  exit 1
fi
