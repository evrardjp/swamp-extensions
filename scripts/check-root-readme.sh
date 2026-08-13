#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
readme=${1:-"$repo_root/README.md"}
canonical=${2:-"$repo_root/scripts/root-readme.md"}

if ! cmp -s "$canonical" "$readme"; then
  printf '%s\n' 'README.md differs from the approved root README.' >&2
  diff -u "$canonical" "$readme" >&2 || true
  exit 1
fi
