#!/usr/bin/env bash
# The Cargo client (F-30, plans/F-01.md §6.8), against the fixture `cargo.seed.ts` published:
#   1. a fresh project depending on smoke-crate "1" through `registry = "<owner>"` resolves 1.1.0
#      (past the yanked 0.9.0, never the 1.2.0-beta.1 pre-release), pulls smoke-dep 1.0.0 from the
#      same feed (an index line's `registry: null`), downloads both through `dl` (Cargo checks
#      each crate against the index's `cksum`), builds and runs;
#   2. a fresh resolution of the yanked 0.9.0 is refused, and a Cargo.lock that pins it builds;
#   3. "=1.2.0-beta.1" resolves the pre-release;
#   4. config.json has no publish `api`, and says `auth-required` exactly when the feed is not
#      public (run.mjs --auth), where Cargo sends PKEY_REGISTRY_TOKEN as its registry token.
# CARGO_TOOLCHAIN=<version> runs the same checks with that toolchain (rustup installs it); the
# default is the runner's `cargo`. Sparse indexes need Cargo 1.68; authenticated ones 1.74.
set -euo pipefail

: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

if ! command -v cargo >/dev/null 2>&1; then
  if [ -n "${REGISTRY_CLIENTS_REQUIRE:-}" ]; then echo "FAIL cargo is not installed"; exit 1; fi
  echo "skip cargo is not installed"
  exit 0
fi
CARGO=(cargo)
if [ -n "${CARGO_TOOLCHAIN:-}" ]; then
  rustup toolchain install --profile minimal "$CARGO_TOOLCHAIN" >/dev/null
  CARGO=(cargo "+$CARGO_TOOLCHAIN")
fi
echo "cargo: $("${CARGO[@]}" --version)"

INDEX="sparse+$REGISTRY/cargo/$OWNER/"
# A Cargo home of its own: no user configuration, credentials or registry cache leak in. The
# toolchain stays where rustup keeps it (RUSTUP_HOME).
export CARGO_HOME="$tmp/cargo-home" CARGO_TARGET_DIR="$tmp/target"
export CARGO_TERM_COLOR=never CARGO_NET_RETRY=0 CARGO_HTTP_TIMEOUT=30
mkdir -p "$CARGO_HOME"
cat >"$CARGO_HOME/config.toml" <<TOML
[registries.$OWNER]
index = "$INDEX"
TOML
if [ -n "${REGISTRY_AUTH:-}" ]; then
  : "${PKEY_REGISTRY_TOKEN:?the token comes from run.mjs --auth}"
  # An authenticated registry needs a credential provider named; cargo:token reads the variable.
  echo 'credential-provider = "cargo:token"' >>"$CARGO_HOME/config.toml"
  var="CARGO_REGISTRIES_$(echo "$OWNER" | tr 'a-z-' 'A-Z_')_TOKEN"
  export "$var=$PKEY_REGISTRY_TOKEN"
fi

# expect_ok <label> <command...>: the command must succeed (its output is shown on failure).
expect_ok() {
  local label="$1"
  shift
  if "$@" >"$tmp/out" 2>&1; then ok "$label"; else cat "$tmp/out"; bad "$label"; fi
}

# expect_fail <label> <command...>: the command must fail.
expect_fail() {
  local label="$1"
  shift
  if "$@" >"$tmp/out" 2>&1; then cat "$tmp/out"; bad "$label (it succeeded)"; else ok "$label"; fi
}

# project <dir> <requirement>: a binary crate depending on smoke-crate from the feed.
project() {
  local dir="$1" req="$2"
  mkdir -p "$dir/src"
  cat >"$dir/Cargo.toml" <<TOML
[package]
name = "app"
version = "0.1.0"
edition = "2021"
publish = false

[dependencies]
smoke-crate = { version = "$req", registry = "$OWNER" }
TOML
  cat >"$dir/src/main.rs" <<'RS'
fn main() {
    println!("{} {}", smoke_crate::version(), smoke_crate::dep());
}
RS
}

# expect_run <label> <dir> <want> [cargo flags]: `cargo run` prints exactly <want>.
expect_run() {
  local label="$1" dir="$2" want="$3" got
  shift 3
  if got="$(cd "$dir" && "${CARGO[@]}" run -q "$@" 2>"$tmp/err")" && [ "$got" = "$want" ]; then
    ok "$label ($got)"
  else
    cat "$tmp/err"
    bad "$label: got '$got', want '$want'"
  fi
}

# 1. Resolution, the sibling crate, the downloads and the build.
project "$tmp/app" "1"
expect_ok "resolves smoke-crate from the sparse index" \
  bash -c "cd '$tmp/app' && ${CARGO[*]} generate-lockfile"
expect_ok "the lockfile pins 1.1.0 (not the yanked 0.9.0, not the beta) and smoke-dep 1.0.0 from the same feed" \
  python3 - "$tmp/app/Cargo.lock" "$INDEX" <<'PY'
import re, sys
lock = open(sys.argv[1]).read()
pkgs = {(m.group(1), m.group(2)): m.group(3) for m in re.finditer(
    r'\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\n(?:source = "([^"]+)")?', lock)}
assert pkgs.get(("smoke-crate", "1.1.0")) == sys.argv[2], pkgs
assert pkgs.get(("smoke-dep", "1.0.0")) == sys.argv[2], pkgs
assert not any(n == "smoke-crate" and v != "1.1.0" for n, v in pkgs), pkgs
PY
expect_run "downloads (cksum-checked), builds and runs 1.1.0 with its dependency" \
  "$tmp/app" "1.1.0 smoke-dep 1.0.0"

# 2. Yank: a fresh resolution refuses 0.9.0; a lockfile that already pins it still builds.
project "$tmp/yanked" "=0.9.0"
expect_fail "a fresh resolution of the yanked 0.9.0 is refused" \
  bash -c "cd '$tmp/yanked' && ${CARGO[*]} generate-lockfile"
cksum="$(curl -sS "$REGISTRY/cargo/$OWNER/sm/ok/smoke-crate" |
  python3 -c 'import json,sys; print(next(json.loads(l)["cksum"] for l in sys.stdin if json.loads(l)["vers"]=="0.9.0"))')"
cat >"$tmp/yanked/Cargo.lock" <<LOCK
# This file is automatically @generated by Cargo.
# It is not intended for manual editing.
version = 3

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "smoke-crate",
]

[[package]]
name = "smoke-crate"
version = "0.9.0"
source = "$INDEX"
checksum = "$cksum"
LOCK
expect_run "a Cargo.lock pinning the yanked 0.9.0 still builds (--locked)" \
  "$tmp/yanked" "0.9.0 none" --locked

# 3. The pre-release, asked for exactly.
project "$tmp/beta" "=1.2.0-beta.1"
expect_run "=1.2.0-beta.1 resolves the pre-release" "$tmp/beta" "1.2.0-beta.1 none"

# 4. config.json: no publish API; auth-required exactly on an authenticated feed.
config_check() {
  curl -sS "$REGISTRY/cargo/$OWNER/config.json" |
    python3 -c '
import json, os, sys
d = json.load(sys.stdin)
assert "api" not in d, d
assert d["dl"].endswith("/files/{sha256-checksum}/{crate}-{version}.crate"), d
assert d.get("auth-required", False) == bool(os.environ.get("REGISTRY_AUTH")), d
print("checked")'
}
if [ -n "${REGISTRY_AUTH:-}" ]; then
  # curl sends the header token through CURL_HOME's .curlrc as `Bearer`; Cargo sends it bare.
  expect_ok "config.json says auth-required, and has no publish api" config_check
else
  expect_ok "config.json has no publish api and no auth-required" config_check
fi

exit "$fail"
