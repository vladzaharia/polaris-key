#!/usr/bin/env bash
# `npm publish` into the npm feed (F-22), then the published versions installed back from it.
#   1. npm publish 1.0.0 (dist-tag latest) and 1.1.0-beta.1 (--tag beta) with the publish token;
#   2. the consumer installs `@<owner>/published` → 1.0.0, and `@beta` → 1.1.0-beta.1, and runs it;
#   3. publishing 1.0.0 again with other bytes is refused (a version is never republished);
#   4. publishing without a token is refused (npm reports E401).
# NPM_VERSION picks an npm release; unset, the npm on PATH. REGISTRY, OWNER and
# PKEY_REGISTRY_PUBLISH_TOKEN come from run.mjs.
set -euo pipefail
: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
: "${PKEY_REGISTRY_PUBLISH_TOKEN:?run.mjs mints the publish token}"
npm_cli() { if [ -n "${NPM_VERSION:-}" ]; then npx -y "npm@$NPM_VERSION" "$@"; else npm "$@"; fi; }
FEED="$REGISTRY/npm/$OWNER/"
SCOPE="@$OWNER"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

npmrc() { # npmrc <dir> [token]
  printf '%s:registry=%s\n' "$SCOPE" "$FEED" > "$1/.npmrc"
  if [ -n "${2:-}" ]; then printf '%s:_authToken=%s\n' "${FEED#http:}" "$2" >> "$1/.npmrc"; fi
}

package() { # package <version> <marker>
  local d="$work/pkg-$1-$2"
  mkdir -p "$d"
  printf '{ "name": "%s/published", "version": "%s", "main": "index.js", "license": "MIT" }\n' "$SCOPE" "$1" > "$d/package.json"
  printf 'module.exports = { version: "%s", marker: "%s" };\n' "$1" "$2" > "$d/index.js"
  npmrc "$d" "$PKEY_REGISTRY_PUBLISH_TOKEN"
  echo "$d"
}

publish() { (cd "$1" && npm_cli publish --cache "$work/.npm-cache" "${@:2}"); }

if out="$(publish "$(package 1.0.0 a)" 2>&1)"; then ok "npm publish 1.0.0"; else echo "$out" | tail -20; bad "npm publish 1.0.0"; fi
if out="$(publish "$(package 1.1.0-beta.1 a)" --tag beta 2>&1)"; then ok "npm publish 1.1.0-beta.1 --tag beta"; else echo "$out" | tail -20; bad "npm publish --tag beta"; fi

consumer="$work/consumer"
mkdir -p "$consumer"
printf '{ "name": "consumer", "version": "0.0.0", "private": true }\n' > "$consumer/package.json"
npmrc "$consumer" "${PKEY_REGISTRY_TOKEN:-}"
installed() { node -p "require('$consumer/node_modules/$SCOPE/published').version" 2>/dev/null || echo none; }
(cd "$consumer" && npm_cli install --no-audit --no-fund --cache "$work/.npm-cache" "$SCOPE/published" >/dev/null 2>&1) || true
[ "$(installed)" = "1.0.0" ] && ok "installs the published 1.0.0 (latest)" || bad "latest installed $(installed), want 1.0.0"
(cd "$consumer" && npm_cli install --no-audit --no-fund --cache "$work/.npm-cache" "$SCOPE/published@beta" >/dev/null 2>&1) || true
[ "$(installed)" = "1.1.0-beta.1" ] && ok "installs the beta tag (1.1.0-beta.1)" || bad "beta installed $(installed), want 1.1.0-beta.1"

if publish "$(package 1.0.0 other)" >"$work/again.log" 2>&1; then
  bad "republishing 1.0.0 with other bytes was accepted"
else ok "republishing 1.0.0 with other bytes is refused"; fi

anon="$(package 1.2.0 anon)"
npmrc "$anon"
if publish "$anon" >"$work/anon.log" 2>&1; then bad "a publish without a token was accepted"
elif grep -qiE 'E401|401|auth' "$work/anon.log"; then ok "a publish without a token is refused (401)"
else tail -10 "$work/anon.log"; bad "the anonymous publish failed for another reason"; fi
exit "$fail"
