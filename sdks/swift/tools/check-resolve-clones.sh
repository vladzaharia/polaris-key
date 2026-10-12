#!/usr/bin/env bash
# SP-52: resolving the registry payload may clone the macOS-only Sparkle package, but never zstd.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/pkey-swift-resolve.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
"$here/tools/stage-registry-source.sh" "$tmp/source"
(
  cd "$tmp/source"
  swift package resolve --scratch-path "$tmp/build"
)

checkouts="$tmp/build/checkouts"
if [ ! -d "$checkouts/Sparkle" ] || [ -e "$checkouts/zstd" ]; then
  echo "::error::Swift resolve must clone only Sparkle; checkouts were: $(find "$checkouts" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort | tr '\n' ' ')" >&2
  exit 1
fi
if [ "$(find "$checkouts" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" != 1 ]; then
  echo "::error::Swift resolve cloned an unexpected dependency." >&2
  exit 1
fi
echo "Swift resolve clones only Sparkle; zstd is vendored."
