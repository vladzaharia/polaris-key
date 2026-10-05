#!/usr/bin/env bash
# The npm feed with Bun (F-04), routed by a bunfig.toml scope. BUN picks the binary (default
# `bun` on PATH).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/npm-feed.bash
. "$here/lib/npm-feed.bash"
BUN="${BUN:-bun}"
echo "bun $("$BUN" --version)"
setup() {
  # F-21: an authenticated feed (run.mjs --auth) carries the token in the scope.
  local tok=""
  if [ -n "${PKEY_REGISTRY_TOKEN:-}" ]; then tok=", token = \"$PKEY_REGISTRY_TOKEN\""; fi
  cat > "$1/bunfig.toml" <<TOML
[install]
cache = "$1/.bun-cache"
[install.scopes]
"$SCOPE" = { url = "$FEED"$tok }
TOML
}
add() { (cd "$1" && "$BUN" add "$2"); }
lockfile() { if [ -f "$1/bun.lock" ]; then echo "$1/bun.lock"; else echo "$1/bun.lockb"; fi; }
npm_feed_matrix
