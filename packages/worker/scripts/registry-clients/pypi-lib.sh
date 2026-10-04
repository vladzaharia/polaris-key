# Shared by the PyPI clients (F-05): pip.sh, uv.sh and poetry.sh. Sourced, never run.
# REGISTRY and OWNER come from run.mjs; the fixture is pypi-fixture.mjs's `polaris-smoke`:
# 0.8.0 (deprecated: live on PyPI), 0.9.0 (yanked, "broken build"), 1.0.0 (wheel, PEP 658
# metadata, sdist) and 1.1.0b1 (beta, a PEP 440 pre-release).
set -euo pipefail

: "${REGISTRY:?REGISTRY is the registry host origin}"
: "${OWNER:?OWNER is the fixture owner}"
INDEX="$REGISTRY/pypi/$OWNER/simple/"
PROJECT="polaris-smoke"
fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Keep every client off the user's own configuration and caches.
export PIP_CONFIG_FILE=/dev/null PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1
export PIP_CACHE_DIR="$tmp/pip-cache" UV_CACHE_DIR="$tmp/uv-cache" UV_NO_CONFIG=1
export POETRY_CACHE_DIR="$tmp/poetry-cache" POETRY_CONFIG_DIR="$tmp/poetry-config"
export POETRY_VIRTUALENVS_IN_PROJECT=true

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

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

# expect_version <label> <python> <version>: the installed polaris_smoke reports <version>.
expect_version() {
  local label="$1" py="$2" want="$3" got
  got="$("$py" -c 'import polaris_smoke; print(polaris_smoke.__version__)' 2>&1 || true)"
  if [ "$got" = "$want" ]; then ok "$label ($got)"; else bad "$label: got '$got', want $want"; fi
}

# uv on PATH, or one bootstrapped into a throwaway venv (from PyPI: the CLIENT, never a package
# of ours). Prints its path.
find_uv() {
  if command -v uv >/dev/null 2>&1; then
    command -v uv
    return
  fi
  python3 -m venv "$tmp/uv-tool" >/dev/null
  "$tmp/uv-tool/bin/python" -m pip install -q uv >/dev/null
  echo "$tmp/uv-tool/bin/uv"
}

# The JSON page, the sha256 of 1.0.0's wheel and its PEP 658 metadata, read with python3.
wheel_sha() {
  curl -sS -H 'Accept: application/vnd.pypi.simple.v1+json' "$INDEX$PROJECT/" |
    python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(f["hashes"]["sha256"] for f in d["files"] if f["filename"]==sys.argv[1]))' \
      "polaris_smoke-$1-py3-none-any.whl"
}
