#!/usr/bin/env bash
# The Poetry 2 client (F-05): a project with the feed as an `explicit` source, `polaris-smoke`
# pinned to it. Locks and installs the stable version, resolves the beta, refuses a range only
# the yanked version matches. Poetry itself comes from PyPI into a throwaway tool environment.
source "$(dirname "$0")/../pypi-lib.sh"
UV="$(find_uv)"
"$UV" venv -q --python 3 "$tmp/poetry-tool" >/dev/null
VIRTUAL_ENV="$tmp/poetry-tool" "$UV" pip install -q "poetry>=2,<3" >/dev/null
POETRY_BIN="$tmp/poetry-tool/bin/poetry"
# One fresh HTTP cache per command. Under `wrangler dev`, Miniflare's emulation of Cloudflare's
# compression marks any answer WITHOUT a Content-Type `Content-Encoding: gzip` when the client
# accepts gzip (`ensureAcceptableEncoding`), a body-less 304 included, so Poetry's cache, which
# revalidates what an earlier command stored and merges the 304's headers in, then fails to gunzip
# a plain body. pip and uv do not revalidate across these commands. The production edge is to be
# confirmed on staging (F-05 report: follow-up for the 304 headers in registry/cache.ts).
n=0
POETRY() {
  n=$((n + 1))
  POETRY_CACHE_DIR="$tmp/poetry-cache-$n" "$POETRY_BIN" "$@"
}
POETRY="POETRY"
echo "poetry: $("$POETRY" --version)"

project() {
  local dir="$1" spec="$2"
  mkdir -p "$dir"
  cat >"$dir/pyproject.toml" <<TOML
[project]
name = "smoke-poetry"
version = "0.0.0"
requires-python = ">=3.9"
dependencies = ["$spec"]

[tool.poetry]
package-mode = false

[tool.poetry.dependencies]
$PROJECT = { source = "polaris" }

[[tool.poetry.source]]
name = "polaris"
url = "$INDEX"
priority = "explicit"
TOML
}

project "$tmp/stable" "$PROJECT"
expect_ok "poetry lock (explicit source)" "$POETRY" -C "$tmp/stable" lock -q
if grep -q "$(wheel_sha 1.0.0)" "$tmp/stable/poetry.lock"; then
  ok "poetry.lock records the feed's sha256 for 1.0.0"
else
  cat "$tmp/stable/poetry.lock"
  bad "poetry.lock records the feed's sha256 for 1.0.0"
fi
expect_ok "poetry install" "$POETRY" -C "$tmp/stable" install -q --no-root
expect_version "poetry: stable resolves to 1.0.0, past the yanked 0.9.0" "$tmp/stable/.venv/bin/python" 1.0.0

project "$tmp/beta" "$PROJECT>=1.1.0b1"
expect_ok "poetry: a pre-release specifier resolves the beta" "$POETRY" -C "$tmp/beta" install -q --no-root
expect_version "poetry: the beta" "$tmp/beta/.venv/bin/python" 1.1.0b1

project "$tmp/yanked" "$PROJECT>0.8.5,<1.0"
expect_fail "poetry: a range matching only the yanked version is refused" \
  "$POETRY" -C "$tmp/yanked" lock -q

exit "$fail"
