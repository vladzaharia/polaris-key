#!/usr/bin/env bash
# `twine upload` into the PyPI feed (F-22), then the published version installed back with pip.
#   1. build an sdist and a wheel of polaris-smoke-published 1.0.0 (`python -m build`);
#   2. twine upload both to /pypi/<owner>/legacy/ with __token__ and the publish token;
#   3. wait for the version to publish (the uploads settle after ten seconds) — polling the simple
#      page, at most 60 s — and check it lists both files;
#   4. pip installs ==1.0.0 from the feed and imports it;
#   5. an upload without a token is refused.
# REGISTRY, OWNER and PKEY_REGISTRY_PUBLISH_TOKEN come from run.mjs; twine and build are
# bootstrapped from PyPI into a throwaway virtual environment.
set -euo pipefail
: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
: "${PKEY_REGISTRY_PUBLISH_TOKEN:?run.mjs mints the publish token}"
PY="${PYTHON:-python3}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
"$PY" -m venv "$work/venv"
V="$work/venv/bin"
"$V/pip" install -q --disable-pip-version-check twine build >/dev/null
echo "$("$V/twine" --version | head -1)"

src="$work/src"
mkdir -p "$src/polaris_smoke_published"
cat > "$src/pyproject.toml" <<'TOML'
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "polaris-smoke-published"
version = "1.0.0"
description = "Published natively by the registry-client harness"
requires-python = ">=3.8"
TOML
printf 'VERSION = "1.0.0"\n' > "$src/polaris_smoke_published/__init__.py"
"$V/python" -m build -q --sdist --wheel --outdir "$work/dist" "$src" >/dev/null

LEGACY="$REGISTRY/pypi/$OWNER/legacy/"
if "$V/twine" upload --non-interactive --disable-progress-bar --repository-url "$LEGACY" \
    -u __token__ -p "$PKEY_REGISTRY_PUBLISH_TOKEN" "$work"/dist/* >"$work/upload.log" 2>&1; then
  ok "twine upload (sdist and wheel)"
else tail -20 "$work/upload.log"; bad "twine upload"; fi

# The simple page, with the token when the feed is authenticated (run.mjs --auth).
CURL_AUTH=()
if [ -n "${PKEY_REGISTRY_TOKEN:-}" ]; then CURL_AUTH=(-u "__token__:$PKEY_REGISTRY_TOKEN"); fi
page="$REGISTRY/pypi/$OWNER/simple/polaris-smoke-published/"
listed=0
for _ in $(seq 1 30); do
  n="$(curl -fsS ${CURL_AUTH[@]+"${CURL_AUTH[@]}"} -H 'Accept: application/vnd.pypi.simple.v1+json' "$page" 2>/dev/null |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).files.length)}catch{console.log(0)}})" || echo 0)"
  if [ "$n" = "2" ]; then listed=1; break; fi
  sleep 2
done
[ "$listed" = 1 ] && ok "the version published with both files" || bad "the version did not publish with both files"

INDEX="$REGISTRY/pypi/$OWNER/simple/"
if [ -n "${PKEY_REGISTRY_TOKEN:-}" ]; then
  INDEX="${REGISTRY/:\/\//://__token__:$PKEY_REGISTRY_TOKEN@}/pypi/$OWNER/simple/"
fi
"$PY" -m venv "$work/consumer"
if "$work/consumer/bin/pip" install -q --disable-pip-version-check --index-url "$INDEX" \
    --trusted-host 127.0.0.1 "polaris-smoke-published==1.0.0" >"$work/install.log" 2>&1 &&
   [ "$("$work/consumer/bin/python" -c 'import polaris_smoke_published as p; print(p.VERSION)')" = "1.0.0" ]; then
  ok "pip installs the published 1.0.0"
else tail -20 "$work/install.log"; bad "pip install of the published version"; fi

if "$V/twine" upload --non-interactive --disable-progress-bar --repository-url "$LEGACY" \
    -u __token__ -p "pkeyr_nope" "$work"/dist/*.tar.gz >"$work/anon.log" 2>&1; then
  bad "an upload with a bad token was accepted"
else ok "an upload with a bad token is refused"; fi
exit "$fail"
