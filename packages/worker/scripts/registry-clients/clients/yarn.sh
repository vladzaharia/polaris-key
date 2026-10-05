#!/usr/bin/env bash
# The npm feed with Yarn Berry (F-04), routed by `npmScopes`. YARN_VERSION picks a release
# (default 4). The local harness is plain http on 127.0.0.1, so it is whitelisted.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/npm-feed.bash
. "$here/lib/npm-feed.bash"
yarn_cli() { npx -y "@yarnpkg/cli-dist@${YARN_VERSION:-4}" "$@"; }
echo "yarn $(cd "$work" && yarn_cli --version)"
setup() {
  local host
  host="$(node -p "new URL('$REGISTRY').hostname")"
  cat > "$1/.yarnrc.yml" <<YML
nodeLinker: node-modules
enableGlobalCache: false
enableTelemetry: false
unsafeHttpWhitelist: ["$host"]
npmScopes:
  $OWNER:
    npmRegistryServer: "$FEED"
YML
  # F-21: an authenticated feed (run.mjs --auth).
  if [ -n "${PKEY_REGISTRY_TOKEN:-}" ]; then
    printf '    npmAuthToken: "%s"\n    npmAlwaysAuth: true\n' "$PKEY_REGISTRY_TOKEN" >> "$1/.yarnrc.yml"
  fi
  touch "$1/yarn.lock"
}
add() { (cd "$1" && YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn_cli add "$2"); }
lockfile() { echo "$1/yarn.lock"; }
# Yarn Berry does not check `dist.integrity` when it first fetches a tarball (4.18 installs the
# tampered fixture): it records its own archive checksum in yarn.lock and checks THAT on every
# later install. So the lockfile check is on Yarn's checksum, and the mismatch check is skipped.
yarn_checksum() {
  if grep -q '^  checksum: ' "$LAST_PROJECT/yarn.lock"; then
    echo "ok   yarn.lock pins a checksum"
  else
    echo "FAIL yarn.lock pins no checksum"
    fail=1
  fi
}
CHECK_LOCK_INTEGRITY=0 INTEGRITY_REFUSAL="Yarn Berry pins its own checksum in yarn.lock" npm_feed_matrix || true
yarn_checksum
exit "$fail"
