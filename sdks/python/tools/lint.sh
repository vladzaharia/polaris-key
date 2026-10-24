#!/usr/bin/env bash
# Python lint (P0-46.4): ruff and mypy against the shared ledger sdks/python/lint-debt.json.
#   tools/lint.sh check    fail on a new finding, and on debt a tool no longer reports
#   tools/lint.sh record   rewrite both tools' entries from today's findings
# Uses sdks/python/.venv (pip install -e ".[dev]"); both tools are pinned in pyproject.toml.
set -uo pipefail
cd "$(dirname "$0")/.."
mode="${1:-check}"
case "$mode" in check | record) ;; *) echo "usage: tools/lint.sh check|record" >&2; exit 2 ;; esac
bin=".venv/bin"
debt="../../tools/lint/lint-debt.mjs"
tmp="$(mktemp -d)"
trap '/bin/rm -rf "$tmp"' EXIT

# ruff exits 1 on findings and 2 on a crash; mypy 1 on findings and 2 on a crash. Only a crash stops us.
"$bin/ruff" check --output-format json --no-cache . >"$tmp/ruff.json"
[ $? -le 1 ] || { echo "ruff crashed" >&2; exit 2; }
"$bin/mypy" --output json --no-error-summary >"$tmp/mypy.jsonl"
[ $? -le 1 ] || { echo "mypy crashed" >&2; exit 2; }

rc=0
for tool in ruff mypy; do
  f="$tmp/$tool.json"; [ "$tool" = mypy ] && f="$tmp/mypy.jsonl"
  node "$debt" "$mode" --tool "$tool" --ledger lint-debt.json --input "$f" || rc=$?
done
exit "$rc"
