#!/usr/bin/env bash
# The npm feed with pnpm (F-04). PNPM_VERSION picks a release (the matrix runs 9 and 10).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/npm-feed.bash
. "$here/lib/npm-feed.bash"
pnpm_cli() { npx -y "pnpm@${PNPM_VERSION:-10}" "$@"; }
echo "pnpm $(pnpm_cli --version)"
setup() { printf '%s:registry=%s\n' "$SCOPE" "$FEED" > "$1/.npmrc"; npmrc_auth "$1/.npmrc"; }
add() { (cd "$1" && pnpm_cli add --store-dir "$1/.pnpm-store" --config.node-linker=hoisted "$2"); }
lockfile() { echo "$1/pnpm-lock.yaml"; }
YANK_WARNING="broken build" npm_feed_matrix
