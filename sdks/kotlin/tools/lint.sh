#!/usr/bin/env bash
# Kotlin lint (P0-46.5): ktlint and detekt against the shared ledger sdks/kotlin/lint-debt.json.
#   tools/lint.sh check    fail on a new finding, and on debt a tool no longer reports
#   tools/lint.sh record   rewrite both tools' entries from today's findings
#   tools/lint.sh check --files <list>   only the repo-relative files listed (the pre-commit hook)
# Runs the CLI jars (not Gradle plugins: detekt's plugin targets Kotlin 2.0, the build is on 2.1),
# downloaded from Maven Central into build/lint-tools/ (gitignored) and verified against
# tools/lint-tools.sha256 before every run. Default configs. Needs `java` (JDK 17), curl, node.
# LINT_TOOLS_DIR overrides the jar cache (the checksum test uses it).
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
  while IFS= read -r f; do [ -n "$f" ] && targets+=("${f#sdks/kotlin/}"); done <"$only"
  [ "${#targets[@]}" -gt 0 ] || exit 0
fi
only_args=(); [ -n "$only" ] && only_args=(--only "$only")
debt="../../tools/lint/lint-debt.mjs"
dir="${LINT_TOOLS_DIR:-build/lint-tools}"
sums="tools/lint-tools.sha256"
ktlint_jar="ktlint-cli-1.8.0-all.jar"
detekt_jar="detekt-cli-1.23.8-all.jar"
base="https://repo1.maven.org/maven2"
url_of() {
  case "$1" in
    ktlint-cli-*) v="${1#ktlint-cli-}"; v="${v%-all.jar}"; echo "$base/com/pinterest/ktlint/ktlint-cli/$v/$1" ;;
    detekt-cli-*) v="${1#detekt-cli-}"; v="${v%-all.jar}"; echo "$base/io/gitlab/arturbosch/detekt/detekt-cli/$v/$1" ;;
  esac
}
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
want() { grep -v '^#' "$sums" | awk -v f="$1" '$2 == f { print $1 }'; }
tmp="$(mktemp -d)"
trap '/bin/rm -rf "$tmp"' EXIT

fetch() { # name: download when absent, then always verify
  local name="$1" exp; exp="$(want "$name")"
  [ -n "$exp" ] || { echo "no checksum for $name in $sums" >&2; exit 2; }
  mkdir -p "$dir"
  if [ ! -f "$dir/$name" ]; then
    curl -fsSL --retry 3 -o "$tmp/$name" "$(url_of "$name")" || { echo "download of $name failed" >&2; exit 2; }
    /bin/mv "$tmp/$name" "$dir/$name"
  fi
  [ "$(sha "$dir/$name")" = "$exp" ] || { echo "$name does not match $sums; refusing to run it (delete $dir/$name to fetch it again)" >&2; exit 2; }
}
fetch "$ktlint_jar"; fetch "$detekt_jar"

# Every src/<set>/kotlin tree, without build output; generated files are dropped by the ledger tool.
dirs=()
while IFS= read -r d; do dirs+=("$d"); done < <(find . -type d -path '*/src/*/kotlin' -not -path '*/build/*' | sed 's#^\./##' | sort)
[ "${#dirs[@]}" -gt 0 ] || { echo "no Kotlin source trees found" >&2; exit 2; }
# A partial run lints the listed files only (detekt takes files as well as directories).
[ "${#targets[@]}" -gt 0 ] && dirs=("${targets[@]}")

# ktlint exits 1 on findings; the adapter rejects anything that is not its JSON, so a crash cannot pass.
globs=(); for d in "${dirs[@]}"; do if [ -d "$d" ]; then globs+=("$d/**/*.kt"); else globs+=("$d"); fi; done
java -jar "$dir/$ktlint_jar" --log-level=error --reporter=json --relative "${globs[@]}" >"$tmp/ktlint.json" 2>"$tmp/ktlint.err"
[ -s "$tmp/ktlint.json" ] || { cat "$tmp/ktlint.err" >&2; echo "ktlint produced no report" >&2; exit 2; }

# detekt exits 2 when it finds issues; any other failure is a crash.
input="$(IFS=,; echo "${dirs[*]}")"
java -jar "$dir/$detekt_jar" --config tools/detekt.yml --build-upon-default-config --input "$input" --report "sarif:$tmp/detekt.sarif" >"$tmp/detekt.out" 2>&1
[ $? -le 2 ] && [ -s "$tmp/detekt.sarif" ] || { tail -20 "$tmp/detekt.out" >&2; echo "detekt crashed" >&2; exit 2; }

rc=0
for tool in ktlint detekt; do
  f="$tmp/$tool.json"; [ "$tool" = detekt ] && f="$tmp/detekt.sarif"
  node "$debt" "$mode" --tool "$tool" --ledger lint-debt.json --input "$f" ${only_args[@]+"${only_args[@]}"} || rc=$?
done
exit "$rc"
