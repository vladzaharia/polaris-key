#!/usr/bin/env bash
# The uv client (F-05): a project that routes `polaris-smoke` to the feed with the strict router,
# `[[tool.uv.index]] explicit = true` plus `[tool.uv.sources]` (plans/F-01.md §6.7), so no other
# index is ever asked for it. Locks and syncs the stable version (recording the feed's sha256),
# resolves the beta, refuses a range only the yanked version matches, and refuses a wrong hash.
source "$(dirname "$0")/../pypi-lib.sh"
UV="$(find_uv)"
echo "uv: $("$UV" --version)"

project() {
  local dir="$1" spec="$2"
  mkdir -p "$dir"
  cat >"$dir/pyproject.toml" <<TOML
[project]
name = "smoke-consumer"
version = "0.0.0"
requires-python = ">=3.9"
dependencies = ["$spec"]

[[tool.uv.index]]
name = "polaris"
url = "$INDEX"
explicit = true
$([ -z "${PKEY_REGISTRY_TOKEN:-}" ] || echo 'authenticate = "always"')

[tool.uv.sources]
$PROJECT = { index = "polaris" }
TOML
}

project "$tmp/stable" "$PROJECT"
expect_ok "uv lock (explicit index)" "$UV" lock -q --directory "$tmp/stable"
if grep -q "sha256:$(wheel_sha 1.0.0)" "$tmp/stable/uv.lock" &&
  grep -q "version = \"1.0.0\"" "$tmp/stable/uv.lock"; then
  ok "uv.lock pins 1.0.0 with the feed's sha256"
else
  cat "$tmp/stable/uv.lock"
  bad "uv.lock pins 1.0.0 with the feed's sha256"
fi
expect_ok "uv sync installs it" "$UV" sync -q --directory "$tmp/stable"
expect_version "uv: stable resolves to 1.0.0, past the yanked 0.9.0" "$tmp/stable/.venv/bin/python" 1.0.0

project "$tmp/beta" "$PROJECT>=1.1.0b1"
expect_ok "uv: a pre-release specifier resolves the beta" "$UV" sync -q --directory "$tmp/beta"
expect_version "uv: the beta" "$tmp/beta/.venv/bin/python" 1.1.0b1

project "$tmp/yanked" "$PROJECT>0.8.5,<1.0"
expect_fail "uv: a range matching only the yanked version is refused" \
  "$UV" lock -q --directory "$tmp/yanked"

# Integrity: a lock whose hash does not match the bytes is refused at install.
project "$tmp/tampered" "$PROJECT"
"$UV" lock -q --directory "$tmp/tampered"
sed -i.bak "s/sha256:$(wheel_sha 1.0.0)/sha256:$(printf '0%.0s' {1..64})/" "$tmp/tampered/uv.lock"
expect_fail "uv: a wrong hash in the lock is refused" "$UV" sync -q --frozen --directory "$tmp/tampered"

exit "$fail"
