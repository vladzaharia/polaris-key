#!/usr/bin/env bash
# Verify the exact source archive SwiftPM prepares for the registry: no repository-only payload
# and no more than the six-megabyte published-size budget (SP-52).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
limit=6000000

check() {
  local archive="$1"
  local bytes
  bytes="$(stat -f %z "$archive")"
  if [ "$bytes" -ge "$limit" ]; then
    echo "::error::Swift registry archive is $bytes bytes; budget is under $limit." >&2
    exit 1
  fi
  if unzip -Z1 "$archive" | grep -Eq '(^|/)(Tests|PlatformHostTests|tools)(/|$)'; then
    echo "::error::Swift registry archive contains repository-only tests or tools." >&2
    exit 1
  fi
  echo "Swift registry archive: $bytes bytes, no Tests or tools."
}

if [ "$#" -eq 1 ]; then
  check "$1"
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo "usage: check-registry-archive.sh [archive.zip]" >&2
  exit 2
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/pkey-swift-registry.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
"$here/tools/stage-registry-source.sh" "$tmp/source"
mkdir "$tmp/out"
(
  cd "$tmp/source"
  swift package-registry publish polaris-key.PolarisKey 0.0.0 \
    --url https://pkg.plrs.im/swift/polaris-key --dry-run --scratch-directory "$tmp/out"
)
check "$tmp/out/polaris-key.PolarisKey-0.0.0.zip"
