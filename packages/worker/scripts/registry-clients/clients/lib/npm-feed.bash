# Shared checks for the npm feed's clients (F-04): npm.sh, pnpm.sh, yarn.sh, bun.sh source this.
# Each defines `setup <dir>` (scope routing for its tool), `add <dir> <spec>` (install one spec
# into a fresh project; output on stdout), and `lockfile`, then calls `npm_feed_matrix`.
# REGISTRY and OWNER come from run.mjs; the fixture is fixtures/npm.mjs.
set -euo pipefail

: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
SCOPE="@$OWNER"
FEED="$REGISTRY/npm/$OWNER/"
fail=0
LAST_PROJECT=""
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

# A fresh project directory with the tool's scope routing.
project() {
  local d="$work/$1"
  rm -rf "$d"
  mkdir -p "$d"
  printf '{ "name": "fixture-consumer", "version": "0.0.0", "private": true }\n' > "$d/package.json"
  setup "$d"
  echo "$d"
}

installed_version() {
  node -p "require('$1/node_modules/$SCOPE/$2/package.json').version" 2>/dev/null || echo none
}

# The SRI integrity the feed's full packument gives one version.
feed_integrity() {
  curl -fsS -H 'Accept: application/json' "$FEED$SCOPE%2f$1" |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).versions['$2'].dist.integrity))"
}

# expect_version <label> <spec> <package> <version> [deprecation text the output must show]
expect_version() {
  local label="$1" spec="$2" pkg="$3" want="$4" warn="${5:-}"
  local d out got
  d="$(project "$(echo "$label" | tr -c 'a-z0-9' '-')")"
  if ! out="$(add "$d" "$spec" 2>&1)"; then
    echo "$out" | tail -20
    bad "$label: install failed"
    return
  fi
  got="$(installed_version "$d" "$pkg")"
  if [ "$got" != "$want" ]; then
    echo "$out" | tail -20
    bad "$label: installed $pkg $got, want $want"
    return
  fi
  if [ -n "$warn" ] && ! grep -qiF "$warn" <<<"$out"; then
    echo "$out" | tail -20
    bad "$label: no deprecation warning naming \"$warn\""
    return
  fi
  ok "$label ($pkg $got)"
  LAST_PROJECT="$d"
}

npm_feed_matrix() {
  # 1. The latest tag: 1.0.0 (1.1.0 is yanked and leaves every dist-tag).
  expect_version "latest tag" "$SCOPE/hello" hello 1.0.0
  # 2. Integrity: the lockfile records the feed's SHA-512, and the code runs.
  local want lock
  if [ -z "$LAST_PROJECT" ]; then
    bad "no project to check integrity in"
    return 1
  fi
  want="$(feed_integrity hello 1.0.0)"
  lock="$(lockfile "$LAST_PROJECT")"
  if [ "${CHECK_LOCK_INTEGRITY:-1}" = 1 ]; then
    if grep -qF "$want" "$lock"; then ok "lockfile records the feed's integrity"; else bad "lockfile lacks $want"; fi
  fi
  if [ "$(cd "$LAST_PROJECT" && node -p "require('$SCOPE/hello').version")" = 1.0.0 ]; then
    ok "installed code runs"
  else
    bad "installed code does not run"
  fi
  # 3. A channel tag.
  expect_version "beta tag" "$SCOPE/hello@beta" hello 2.0.0-beta.1
  # 4. The yanked version: installable by exact version (lockfiles keep working), with a warning.
  expect_version "yanked, by exact version" "$SCOPE/hello@1.1.0" hello 1.1.0 "${YANK_WARNING:-}"
  # 5. A dependency resolved through the feed.
  expect_version "dependency through the feed" "$SCOPE/greeter" greeter 1.0.0
  if [ -n "${RANGE_AVOIDS_YANKED:-}" ]; then
    local dep
    dep="$(node -p "require('$LAST_PROJECT/node_modules/$SCOPE/hello/package.json').version" 2>/dev/null ||
      node -p "require('$LAST_PROJECT/node_modules/$SCOPE/greeter/node_modules/$SCOPE/hello/package.json').version" 2>/dev/null || echo none)"
    if [ "$dep" = 1.0.0 ]; then ok "^1.0.0 avoids the yanked 1.1.0"; else bad "^1.0.0 resolved to $dep, want 1.0.0"; fi
  fi
  # 6. A tarball whose bytes do not match the recorded digests is refused (where the client
  #    checks `dist.integrity` on first fetch; Yarn Berry pins its own checksum instead).
  if [ "${INTEGRITY_REFUSAL:-1}" != 1 ]; then
    echo "skip integrity mismatch: $INTEGRITY_REFUSAL"
    return "$fail"
  fi
  local d out
  d="$(project tampered)"
  if out="$(add "$d" "$SCOPE/tampered" 2>&1)" && [ "$(installed_version "$d" tampered)" != none ]; then
    echo "$out" | tail -20
    bad "a tarball with the wrong integrity was installed"
  else
    ok "integrity mismatch refused"
  fi
  return "$fail"
}
