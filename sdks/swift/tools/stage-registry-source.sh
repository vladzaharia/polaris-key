#!/usr/bin/env bash
# Copy the Swift registry payload from the working tree, preserving version-stamped files while
# omitting repository-only tests and tooling. SwiftPM treats this nested monorepo directory as a
# non-git package and would otherwise archive every working-tree file.
set -euo pipefail

destination="${1:?usage: stage-registry-source.sh <destination>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -e "$destination" ]; then
  echo "::error::registry staging destination already exists: $destination" >&2
  exit 1
fi
mkdir -p "$destination"

while IFS= read -r -d '' path; do
  case "$path" in
    Tests/*|PlatformHostTests/*|tools/*) continue ;;
  esac
  mkdir -p "$destination/$(dirname "$path")"
  cp -p "$here/$path" "$destination/$path"
done < <(cd "$here" && git ls-files -z)

test ! -e "$destination/Tests"
test ! -e "$destination/tools"
