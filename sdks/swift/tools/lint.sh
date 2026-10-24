#!/usr/bin/env bash
# Swift lint (P0-46.6): `swift format lint` against the ledger sdks/swift/lint-debt.json.
#   tools/lint.sh check    fail on a new finding, and on debt the tool no longer reports
#   tools/lint.sh record   rewrite the ledger from today's findings
# swift-format ships with the Swift toolchain, so there is nothing to download: the version is the
# toolchain's. CI's apple job selects Xcode 26.6 (tools/select-xcode-26.sh), Swift 6.3. A rule set
# or default can change between toolchains, so any other toolchain stops with a clear message (a
# local run on the wrong Xcode would record or fail on findings CI does not see). Set
# PKEY_SWIFT_LINT_ANY_TOOLCHAIN=1 to run anyway, for example to look at findings.
# Generated files (GENERATED banner or *.generated.swift), Resources/ and .build/ are not linted.
# Set PKEY_SWIFT_LINT_RAW=<file> to keep the raw lint output (CI uploads it as an artifact).
set -uo pipefail
cd "$(dirname "$0")/.."
mode="${1:-check}"
case "$mode" in check | record) ;; *) echo "usage: tools/lint.sh check|record" >&2; exit 2 ;; esac

EXPECTED_SWIFT="6.3"
have="$(swift --version 2>&1 | sed -n 's/.*Swift version \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)"
if [ "$have" != "$EXPECTED_SWIFT" ] && [ "${PKEY_SWIFT_LINT_ANY_TOOLCHAIN:-}" != 1 ]; then
  echo "swift lint needs the Swift $EXPECTED_SWIFT toolchain (Xcode 26.6, CI's apple job); this is Swift ${have:-unknown}." >&2
  echo "Run sdks/swift/tools/select-xcode-26.sh, or set PKEY_SWIFT_LINT_ANY_TOOLCHAIN=1 to run anyway." >&2
  exit 2
fi

debt="../../tools/lint/lint-debt.mjs"
tmp="$(mktemp -d)"
trap '/bin/rm -rf "$tmp"' EXIT

# The files to lint: tracked-or-not .swift under Sources and Tests, minus generated ones.
find Sources Tests -name '*.swift' -not -path '*/.build/*' -not -path '*/Resources/*' \
  -not -name '*.generated.swift' | LC_ALL=C sort | while IFS= read -r f; do
  head -n 8 "$f" | grep -q 'GENERATED' || printf '%s\n' "$f"
done >"$tmp/files"

# swift-format exits 0 on warnings; non-zero only if it cannot run. Findings go to stderr.
xargs swift format lint --configuration .swift-format <"$tmp/files" 2>"$tmp/lint.txt" >/dev/null
rc=$?
[ -z "${PKEY_SWIFT_LINT_RAW:-}" ] || cp "$tmp/lint.txt" "$PKEY_SWIFT_LINT_RAW"
if [ "$rc" -ne 0 ] && ! grep -q ': warning: ' "$tmp/lint.txt"; then
  cat "$tmp/lint.txt" >&2
  echo "swift format lint failed to run (exit $rc)" >&2
  exit 2
fi

node "$debt" "$mode" --tool swift-format --ledger lint-debt.json --input "$tmp/lint.txt"
