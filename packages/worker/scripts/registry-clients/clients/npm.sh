#!/usr/bin/env bash
# The npm feed with the npm CLI (F-04). NPM_VERSION picks a release (the matrix runs 10 and 11);
# unset, the npm on PATH. The scope routes to the feed through a project .npmrc.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/npm-feed.bash
. "$here/lib/npm-feed.bash"
npm_cli() { if [ -n "${NPM_VERSION:-}" ]; then npx -y "npm@$NPM_VERSION" "$@"; else npm "$@"; fi; }
echo "npm $(npm_cli --version)"
setup() { printf '%s:registry=%s\n' "$SCOPE" "$FEED" > "$1/.npmrc"; }
add() { (cd "$1" && npm_cli install --no-audit --no-fund --cache "$1/.npm-cache" "$2"); }
lockfile() { echo "$1/package-lock.json"; }
YANK_WARNING="broken build" RANGE_AVOIDS_YANKED=1 npm_feed_matrix
