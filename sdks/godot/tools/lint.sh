#!/usr/bin/env bash
# GDScript lint (P0-46.7): gdlint (gdtoolkit, pinned in tools/lint-requirements.txt) against the
# shared ledger sdks/godot/lint-debt.json.
#   tools/lint.sh check    fail on a new finding, and on debt gdlint no longer reports
#   tools/lint.sh record   rewrite the gdlint entries from today's findings
#   tools/lint.sh check --files <list>   only the repo-relative files listed (the pre-commit hook)
# Installs into sdks/godot/.lint-venv (gitignored). gdlint runs with its defaults over
# addons/polaris_key and tests; the generated files (tools/lint/generated.json, among them
# tests/corpus/v2, tests/transcripts and the *_generated.gd files) are dropped by the ledger tool.
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
  while IFS= read -r f; do [ -n "$f" ] && targets+=("${f#sdks/godot/}"); done <"$only"
  [ "${#targets[@]}" -gt 0 ] || exit 0
fi
only_args=(); [ -n "$only" ] && only_args=(--only "$only")
venv=".lint-venv"
req="tools/lint-requirements.txt"
stamp="$venv/.requirements.sha"
want="$(shasum -a 256 "$req" | cut -d' ' -f1)"
if [ ! -x "$venv/bin/gdlint" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$want" ]; then
  python3 -m venv "$venv" || exit 2
  "$venv/bin/python" -m pip install --quiet --disable-pip-version-check -r "$req" || exit 2
  echo "$want" >"$stamp"
fi
tmp="$(mktemp -d)"
trap '/bin/rm -rf "$tmp"' EXIT

# gdlint exits 1 on findings and on a file it cannot parse; both are in the output.
paths=(addons/polaris_key tests); [ "${#targets[@]}" -gt 0 ] && paths=("${targets[@]}")
"$venv/bin/gdlint" "${paths[@]}" >"$tmp/gdlint.txt" 2>&1
[ $? -le 1 ] || { echo "gdlint crashed" >&2; exit 2; }
node ../../tools/lint/lint-debt.mjs "$mode" --tool gdlint --ledger lint-debt.json --input "$tmp/gdlint.txt" ${only_args[@]+"${only_args[@]}"}
