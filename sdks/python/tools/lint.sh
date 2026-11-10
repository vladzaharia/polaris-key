#!/usr/bin/env bash
# Python lint (P0-46.4): ruff and mypy against the shared ledger sdks/python/lint-debt.json.
#   tools/lint.sh check    fail on a new finding, and on debt a tool no longer reports
#   tools/lint.sh record   rewrite both tools' entries from today's findings
#   tools/lint.sh check --files <list>   only the repo-relative files listed (the pre-commit hook)
# Uses sdks/python/.venv (pip install -e ".[dev]"); both tools are pinned in pyproject.toml.
set -uo pipefail
cd "$(dirname "$0")/.."
mode="${1:-check}"
case "$mode" in check | record) ;; *) echo "usage: tools/lint.sh check|record" >&2; exit 2 ;; esac
# `check --files <list>`: lint only those repo-relative paths (the pre-commit hook's staged files,
# tools/lint-staged.mjs) and hold them to the same ledger; the whole-tree run is unchanged.
only=""; targets=()
if [ "${2:-}" = --files ]; then
  [ "$mode" = check ] && [ -n "${3:-}" ] || { echo "usage: tools/lint.sh check --files <list>" >&2; exit 2; }
  only="$3"
  while IFS= read -r f; do [ -n "$f" ] && targets+=("${f#sdks/python/}"); done <"$only"
  [ "${#targets[@]}" -gt 0 ] || exit 0
fi
only_args=(); [ -n "$only" ] && only_args=(--only "$only")
bin="${PKEY_PYTHON_VENV:-.venv}/bin"   # the hook points a worktree at the main checkout's venv
debt="../../tools/lint/lint-debt.mjs"
tmp="$(mktemp -d)"
trap '/bin/rm -rf "$tmp"' EXIT

# ruff exits 1 on findings and 2 on a crash; mypy 1 on findings and 2 on a crash. Only a crash stops us.
"$bin/ruff" check --output-format json --no-cache --force-exclude "${targets[@]:-.}" >"$tmp/ruff.json"
[ $? -le 1 ] || { echo "ruff crashed" >&2; exit 2; }
"$bin/mypy" --output json --no-error-summary ${targets[@]+"${targets[@]}"} >"$tmp/mypy.jsonl"
[ $? -le 1 ] || { echo "mypy crashed" >&2; exit 2; }

rc=0
for tool in ruff mypy; do
  f="$tmp/$tool.json"; [ "$tool" = mypy ] && f="$tmp/mypy.jsonl"
  node "$debt" "$mode" --tool "$tool" --ledger lint-debt.json --input "$f" ${only_args[@]+"${only_args[@]}"} || rc=$?
done
exit "$rc"
