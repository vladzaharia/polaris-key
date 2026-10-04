#!/usr/bin/env bash
# The pip client (F-05): pip current and pip 22.2 (the first pip with PEP 691) against the PyPI
# feed. Each installs the stable version, resolves the beta with --pre, refuses the yanked version
# for a range but installs it for an exact pin (PEP 592), and verifies integrity with
# --require-hashes. pip 22.2 also parses the inert HTML page with its own link parser, since every
# pip from 22.2 on asks for JSON first and so never takes the HTML path on its own.
source "$(dirname "$0")/../pypi-lib.sh"
UV="$(find_uv)"

matrix() {
  local name="$1" venv="$2"
  local py="$venv/bin/python" pip=("$venv/bin/python" -m pip)
  local base=(install -q --no-cache-dir --index-url "$INDEX")
  expect_ok "$name: install the stable version" "${pip[@]}" "${base[@]}" "$PROJECT"
  expect_version "$name: stable resolves to 1.0.0, past the yanked 0.9.0" "$py" 1.0.0
  expect_ok "$name: --pre resolves the beta" "${pip[@]}" "${base[@]}" --pre --upgrade "$PROJECT"
  expect_version "$name: the beta" "$py" 1.1.0b1
  "${pip[@]}" uninstall -q -y "$PROJECT" >/dev/null
  expect_fail "$name: a range matching only the yanked version is refused" \
    "${pip[@]}" "${base[@]}" "$PROJECT>0.8.5,<1.0"
  expect_ok "$name: an exact pin of the yanked version installs (PEP 592)" \
    "${pip[@]}" "${base[@]}" "$PROJECT==0.9.0"
  expect_version "$name: the pinned yanked version" "$py" 0.9.0
  "${pip[@]}" uninstall -q -y "$PROJECT" >/dev/null
  echo "$PROJECT==1.0.0 --hash=sha256:$(wheel_sha 1.0.0)" >"$tmp/req-good.txt"
  echo "$PROJECT==1.0.0 --hash=sha256:$(printf '0%.0s' {1..64})" >"$tmp/req-bad.txt"
  expect_ok "$name: --require-hashes with the published hash" \
    "${pip[@]}" "${base[@]}" --only-binary :all: --require-hashes -r "$tmp/req-good.txt"
  "${pip[@]}" uninstall -q -y "$PROJECT" >/dev/null
  expect_fail "$name: --require-hashes refuses a wrong hash" \
    "${pip[@]}" "${base[@]}" --only-binary :all: --require-hashes -r "$tmp/req-bad.txt"
}

# pip current: the newest pip from PyPI in a fresh venv.
"$UV" venv -q --seed --python 3 "$tmp/current" >/dev/null
"$tmp/current/bin/python" -m pip install -q --upgrade pip
echo "pip current: $("$tmp/current/bin/python" -m pip --version)"
matrix "pip current" "$tmp/current"

# PEP 658: the metadata a page advertises is served at <file>.metadata with that hash.
meta_check() {
  curl -sS -H 'Accept: application/vnd.pypi.simple.v1+json' "$INDEX$PROJECT/" |
    python3 -c '
import hashlib, json, sys, urllib.parse, urllib.request
page = sys.argv[1]
d = json.load(sys.stdin)
for f in d["files"]:
    cm = f.get("core-metadata")
    if not cm:
        continue
    url = urllib.parse.urljoin(page, f["url"]) + ".metadata"
    body = urllib.request.urlopen(url).read()
    assert hashlib.sha256(body).hexdigest() == cm["sha256"], url
    assert b"Name: polaris-smoke" in body, url
print("checked")' "$INDEX$PROJECT/"
}
expect_ok "PEP 658: every advertised core-metadata matches its .metadata file" meta_check

# pip 22.2 needs a Python it supports (it predates 3.12).
"$UV" venv -q --seed --python 3.11 "$tmp/old" >/dev/null
"$tmp/old/bin/python" -m pip install -q "pip==22.2"
echo "pip 22.2: $("$tmp/old/bin/python" -m pip --version)"
matrix "pip 22.2" "$tmp/old"

# The HTML page through pip 22.2's own parser: every file, its hash, the yank and Requires-Python.
html_check() {
  curl -sS -D "$tmp/html-h" -H 'Accept: text/html' -o "$tmp/page.html" "$INDEX$PROJECT/"
  grep -qi '^content-type: application/vnd.pypi.simple.v1+html' "$tmp/html-h"
  grep -qi "^content-security-policy: sandbox; default-src 'none'" "$tmp/html-h"
  "$tmp/old/bin/python" - "$tmp/page.html" "$INDEX$PROJECT/" <<'PY'
import sys
from pip._internal.index.collector import IndexContent, parse_links
body = open(sys.argv[1], "rb").read()
page = IndexContent(body, "application/vnd.pypi.simple.v1+html", "utf-8", sys.argv[2])
links = {l.filename: l for l in parse_links(page)}
assert set(links) == {
    "polaris_smoke-0.8.0-py3-none-any.whl",
    "polaris_smoke-0.9.0-py3-none-any.whl",
    "polaris_smoke-1.0.0-py3-none-any.whl",
    "polaris_smoke-1.0.0.tar.gz",
    "polaris_smoke-1.1.0b1-py3-none-any.whl",
}, sorted(links)
for name, l in links.items():
    assert l.hash_name == "sha256" and len(l.hash) == 64, name
    assert l.requires_python == ">=3.8", name
    assert l.url.startswith(sys.argv[2].rsplit("/simple/", 1)[0] + "/files/"), l.url
assert links["polaris_smoke-0.9.0-py3-none-any.whl"].yanked_reason == "broken build"
assert links["polaris_smoke-1.0.0-py3-none-any.whl"].yanked_reason is None
print("parsed", len(links))
PY
}
expect_ok "pip 22.2 parses the inert HTML page (hashes, yank, Requires-Python)" html_check

exit "$fail"
