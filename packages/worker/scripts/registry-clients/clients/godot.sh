#!/usr/bin/env bash
# The Godot client matrix (F-09, plans/F-01.md §6.8), against the fixture `godot.seed.ts` published:
#   1. GodotEnv (`addons.json` with "source": "zip") installs the addon from the feed, and the
#      installed plugin.cfg is the `latest` version's;
#   2. HTTP contract checks of both editor API shapes, reading exactly the fields the editors read
#      (≤ 4.6: configure, asset?…, asset/<id> with download_hash; 4.7+: the root, tags, licenses,
#      search/query, assets, releases), and the bytes behind download_url hash to download_hash;
#   3. yank, deprecate and channel tags: the yanked 1.0.1 is in no listing, the deprecated 1.0.0
#      says so, `latest` is 1.1.0 and `beta` is 1.2.0-beta.1.
# The manual editor installs (one per editor shape) are pkey-godot-engineer's and recorded in the
# PR; this script covers what an editor reads, over real HTTP.
#
# Needs curl and python3; GodotEnv (`dotnet tool install --global Chickensoft.GodotEnv`) for step 1,
# which is skipped with a notice when `godotenv` is not installed and REQUIRE_GODOTENV is unset.
set -euo pipefail

: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
PUBLISHER="registry-smoke"
NAME="smoke_addon"
BASE="$REGISTRY/godot/$OWNER"
# F-21: an authenticated feed is reached through a Godot editor URL token in the path; every answer
# is then private and uncached, and every feed URL in a document carries the same segment.
CC='public, max-age=(60|31536000)'
if [ -n "${REGISTRY_AUTH:-}" ]; then
  : "${PKEY_REGISTRY_URL_TOKEN:?the URL token comes from run.mjs --auth}"
  BASE="$REGISTRY/godot/$OWNER/t/$PKEY_REGISTRY_URL_TOKEN"
  CC='private, no-store'
fi
fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

# fetch <path> <out>: GET, require 200, a JSON or byte type on the allowlist and the host headers.
fetch() {
  local path="$1" out="$2" code
  code="$(curl -sS -o "$out" -D "$tmp/h" -w '%{http_code}' "$path")"
  if [ "$code" != 200 ]; then echo "  $path: status $code"; return 1; fi
  grep -qi '^x-content-type-options: nosniff' "$tmp/h" || { echo "  $path: no nosniff"; return 1; }
  grep -qi '^content-security-policy: sandbox' "$tmp/h" || { echo "  $path: no sandbox CSP"; return 1; }
  grep -qiE "^cache-control: $CC" "$tmp/h" || { echo "  $path: cache-control"; return 1; }
  [ -n "${REGISTRY_AUTH:-}" ] || grep -qi '^etag: "' "$tmp/h" || { echo "  $path: no strong etag"; return 1; }
}

# check <label> <python expression over `d` (the parsed JSON)> <path>
check() {
  local label="$1" expr="$2" path="$3"
  if fetch "$path" "$tmp/body" &&
    python3 - "$tmp/body" "$expr" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
# The expression is this script's own fixed check (never response data): `d` is the parsed body.
ok = eval(sys.argv[2], {"d": d, "json": json})
if not ok:
    print("  got:", json.dumps(d)[:600])
sys.exit(0 if ok else 1)
PY
  then ok "$label"; else bad "$label"; fi
}

# ── Godot ≤ 4.6: the Asset Library API (base $BASE/asset-library/api) ───────────────────────────
L="$BASE/asset-library/api"
check "≤4.6 configure: categories with string ids" \
  'all(set(c) >= {"id","name"} and isinstance(c["id"], str) for c in d["categories"]) and any(c["id"]=="6" for c in d["categories"])' \
  "$L/configure"
check "≤4.6 asset?…: the editor's query lists the addon at 1.1.0" \
  'd["total_items"]==1 and d["result"][0]["version_string"]=="1.1.0" and set(d["result"][0]) >= {"title","asset_id","author","author_id","category_id","cost","icon_url"}' \
  "$L/asset?sort=updated&godot_version=4.6&support=official+community+testing&page=0"
check "≤4.6 asset?…: an older editor is refused by godot_version" 'd["total_items"]==0' \
  "$L/asset?godot_version=4.3"
fetch "$L/asset?godot_version=4.6" "$tmp/search" || bad "≤4.6 search fetch"
ASSET_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"][0]["asset_id"])' "$tmp/search")"
check "≤4.6 asset/<id>: download_url, download_hash and provider Custom" \
  'd["version_string"]=="1.1.0" and len(d["download_hash"])==64 and d["download_provider"]=="Custom" and d["download_url"].endswith("/smoke_addon-1.1.0.zip") and set(d) >= {"title","asset_id","author","author_id","version","category_id","cost","description","browse_url"}' \
  "$L/asset/$ASSET_ID"
fetch "$L/asset/$ASSET_ID" "$tmp/asset" || bad "≤4.6 asset fetch"
URL="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["download_url"])' "$tmp/asset")"
HASH="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["download_hash"])' "$tmp/asset")"
if fetch "$URL" "$tmp/zip" && [ "$(shasum -a 256 "$tmp/zip" | cut -d' ' -f1)" = "$HASH" ] &&
  grep -qi '^content-type: application/zip' "$tmp/h"; then
  ok "≤4.6 the zip behind download_url hashes to download_hash (what the editor compares)"
else bad "≤4.6 download_hash"; fi
ICON="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["icon_url"])' "$tmp/asset")"
if fetch "$ICON" "$tmp/icon" && grep -qi '^content-type: image/png' "$tmp/h" &&
  python3 - "$tmp/icon" <<'PY'
# What Godot's PNG loader enforces: the signature and every chunk's CRC-32 (a bad IDAT CRC made the
# 4.6 editor drop the icon, F-09's manual editor check).
import struct, sys, zlib
d = open(sys.argv[1], "rb").read()
assert d[:8] == b"\x89PNG\r\n\x1a\n"
p = 8
while p < len(d):
    n, t = struct.unpack(">I4s", d[p:p + 8])
    body = d[p + 8:p + 8 + n]
    crc = struct.unpack(">I", d[p + 8 + n:p + 12 + n])[0]
    assert crc == zlib.crc32(t + body), t
    p += 12 + n
PY
then
  ok "≤4.6 icon_url serves a valid image/png (chunk CRCs)"
else bad "icon"; fi

# ── Godot 4.7+: the Asset Store API (base $BASE/store/api/v1) ──────────────────────────────────
S="$BASE/store/api/v1"
check "4.7 root: the repository check" 'd["version"]=="1.1.0"' "$S/"
check "4.7 tags/" 'd==[]' "$S/tags/?featured_only=true"
check "4.7 licenses/" 'd==[{"count":1,"type":"MIT"}]' "$S/licenses/"
check "4.7 search/query/: the editor's query" \
  'd["count"]=="1" and set(d["hits"][0]["asset"]) >= {"name","slug","store_url","license_type","reviews_score","publisher"} and d["hits"][0]["asset"]["publisher"]["slug"]=="registry-smoke"' \
  "$S/search/query/?query=&require_release=true&type=0&sort=relevance&compatibility=4.7"
check "4.7 assets/<publisher>/<asset>/" \
  'd["slug"]=="smoke_addon" and set(d) >= {"name","slug","store_url","license_type","reviews_score","body_bbcode","source","publisher"}' \
  "$S/assets/$PUBLISHER/$NAME/"
check "4.7 releases/…: stable first (the editor preselects the first), yanked 1.0.1 absent, deprecation note" \
  '[r["version"] for r in d]==["1.1.0","1.0.0","1.2.0-beta.1"] and [r["stable"] for r in d]==[True,True,False] and d[1]["notes"].startswith("Deprecated") and all(set(r) >= {"download_url","version","stable","min_godot_version","max_godot_version"} for r in d)' \
  "$S/releases/$PUBLISHER/$NAME/"
check "4.7 releases/?stable_only=true" '[r["version"] for r in d]==["1.1.0","1.0.0"]' \
  "$S/releases/$PUBLISHER/$NAME/?stable_only=true"

# ── GodotEnv: index.json and a real install ─────────────────────────────────────────────────────
check "index.json: latest 1.1.0, beta 1.2.0-beta.1, yanked 1.0.1 absent, an addons.json entry" \
  'd["packages"][0]["tags"]=={"beta":"1.2.0-beta.1","latest":"1.1.0"} and [v["version"] for v in d["packages"][0]["versions"]]==["1.2.0-beta.1","1.1.0","1.0.0"] and d["packages"][0]["versions"][2]["deprecated"]=="use 1.1.0" and d["packages"][0]["godotenv"]["smoke_addon"]["source"]=="zip"' \
  "$BASE/index.json"

if command -v godotenv >/dev/null 2>&1 || [ -x "$HOME/.dotnet/tools/godotenv" ]; then
  GODOTENV="$(command -v godotenv || echo "$HOME/.dotnet/tools/godotenv")"
  proj="$tmp/project"
  mkdir -p "$proj"
  printf 'config_version=5\n\n[application]\n\nconfig/name="pkey-godotenv-smoke"\n' >"$proj/project.godot"
  fetch "$BASE/index.json" "$tmp/index" || bad "index fetch"
  python3 - "$tmp/index" "$proj/addons.json" <<'PY'
import json, sys
idx = json.load(open(sys.argv[1]))
entry = idx["packages"][0]["godotenv"]
json.dump({"path": "addons", "cache": ".addons", "addons": entry}, open(sys.argv[2], "w"), indent=2)
PY
  if (cd "$proj" && "$GODOTENV" addons install) >"$tmp/godotenv.log" 2>&1 &&
    grep -q '^version="1.1.0"' "$proj/addons/$NAME/plugin.cfg"; then
    ok "GodotEnv \"source\": \"zip\" installs addons/$NAME at the latest version (1.1.0)"
  else
    cat "$tmp/godotenv.log"
    bad "GodotEnv install"
  fi
elif [ -n "${REQUIRE_GODOTENV:-}" ]; then
  bad "GodotEnv is required (REQUIRE_GODOTENV) but not installed"
else
  echo "skip GodotEnv install: godotenv not installed (dotnet tool install --global Chickensoft.GodotEnv)"
fi

exit "$fail"
