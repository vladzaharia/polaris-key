#!/usr/bin/env bash
# The smoke client (F-02): the registry host's isolation contract over real HTTP, with curl.
# REGISTRY is the host's origin, OWNER the seeded fixture owner (run.mjs sets both). Every
# ecosystem client after it (F-04 to F-09) relies on what this one proves.
set -euo pipefail

: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# check <label> <expected status> <method> <path> [header-regex-that-must-match...]
# Every answer must also be hardened: nosniff, a sandbox CSP, same-origin CORP, no cookie, no CORS.
check() {
  local label="$1" want="$2" method="$3" path="$4"
  shift 4
  local hdr="$tmp/h" body="$tmp/b" got
  if [ "$method" = "HEAD" ]; then
    got="$(curl -sS -o "$body" -D "$hdr" -I -w '%{http_code}' "$REGISTRY$path")"
  else
    got="$(curl -sS -o "$body" -D "$hdr" -X "$method" -H 'Cookie: __Host-pkey_admin=forged' \
      -H 'Origin: https://evil.example' -w '%{http_code}' "$REGISTRY$path")"
  fi
  local ok=1
  [ "$got" = "$want" ] || { echo "  status $got, want $want"; ok=0; }
  grep -qi '^x-content-type-options: nosniff' "$hdr" || { echo "  no nosniff"; ok=0; }
  grep -qi '^content-security-policy: sandbox' "$hdr" || { echo "  no sandbox CSP"; ok=0; }
  grep -qi '^cross-origin-resource-policy: same-origin' "$hdr" || { echo "  no CORP"; ok=0; }
  ! grep -qi '^set-cookie:' "$hdr" || { echo "  Set-Cookie present"; ok=0; }
  ! grep -qi '^access-control-' "$hdr" || { echo "  Access-Control-* present"; ok=0; }
  for re in "$@"; do
    grep -qiE "$re" "$hdr" "$body" || { echo "  missing: $re"; ok=0; }
  done
  if [ "$ok" = 1 ]; then echo "ok   $label"; else echo "FAIL $label"; fail=1; fi
}

check "landing page"                200 GET  "/"  '^content-type: text/html; charset=utf-8' 'Polaris Key Delivery'
# F-21 (Q1): with REGISTRY_TOKEN_KEY set, `/v2/` challenges a request without a pull token.
check "OCI base challenges"         401 GET  "/v2/" '^docker-distribution-api-version: registry/2.0' '^www-authenticate: Bearer realm="[^"]+/v2/token",service='
check "OCI base, HEAD"              401 HEAD "/v2/" '^docker-distribution-api-version: registry/2.0'
check "console is absent"           404 GET  "/manage" '"error":"not_found"'
check "docs are absent"             404 GET  "/docs/" '"error":"not_found"'
check "discovery is absent"         404 GET  "/$OWNER/.well-known/polaris.json" '"error":"not_found"'
check "byte routes are absent"      404 GET  "/$OWNER/distribution/blobs/sha256/$(printf 'a%.0s' {1..64})"
check "unknown package is absent"   404 GET  "/npm/$OWNER/@$OWNER%2fsdk" '"error":"not_found"'
check "unknown owner"               404 GET  "/npm/nobody-here/@x%2fy" '"error":"not_found"'
check "reserved ecosystem"          404 GET  "/cargo/$OWNER/index/config.json"
check "no preflight"                405 OPTIONS "/npm/$OWNER/x"
check "GET and HEAD only"           405 POST "/npm/$OWNER/x" '^allow: GET, HEAD'
check "OCI push refused"            405 POST "/v2/$OWNER/app/blobs/uploads/" '"UNSUPPORTED"'

# An anonymous pull token from the token service opens `/v2/` (public pulls keep working).
host="${REGISTRY#http://}"
host="${host#https://}"
host="${host%%:*}"
tok="$(curl -q -fsS "$REGISTRY/v2/token?service=$host" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).token')"
code="$(curl -q -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" "$REGISTRY/v2/")"
if [ "$code" = 200 ]; then echo "ok   an anonymous pull token opens /v2/"; else echo "FAIL /v2/ with an anonymous pull token: $code"; fail=1; fi

exit "$fail"
