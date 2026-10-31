#!/usr/bin/env bash
# check_gamekit_weak.sh <game-center-binary-or-xcframework> <apple-binary-or-xcframework>
# The opt-in Game Center extension is the only place GameKit is linked, and it is linked weakly (I-48.6a,
# Q-4). Asserts, for every Mach-O slice found under the arguments (a dylib, a framework binary, or an
# xcframework directory):
#   - in the Game Center extension: GameKit is LC_LOAD_WEAK_DYLIB, and never a strong LC_LOAD_DYLIB;
#   - in the default pkey_apple build: GameKit is not linked at all.
set -euo pipefail
gc="${1:?game center binary or xcframework}" apple="${2:?pkey_apple binary or xcframework}"

machos() { # machos <path> -> one Mach-O file per line
  if [ -d "$1" ]; then
    find "$1" -type f \( -name '*.dylib' -o -perm -u+x \) -exec sh -c 'file "$1" | grep -q "Mach-O" && echo "$1"' _ {} \;
  else
    echo "$1"
  fi
}

n=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  n=$((n + 1))
  # otool prints one block per architecture; `-l` shows the load-command kind.
  if ! otool -l "$f" | grep -B2 -A3 "GameKit" | grep -q "LC_LOAD_WEAK_DYLIB"; then
    echo "check_gamekit_weak: GameKit is not a weak load in $f" >&2
    exit 1
  fi
  if otool -l "$f" | grep -B2 -A3 "GameKit" | grep -q "cmd LC_LOAD_DYLIB"; then
    echo "check_gamekit_weak: GameKit is also a strong load in $f" >&2
    exit 1
  fi
  echo "ok: GameKit is weak in $f"
done < <(machos "$gc")
[ "$n" -gt 0 ] || { echo "check_gamekit_weak: no Mach-O under $gc" >&2; exit 1; }

m=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  m=$((m + 1))
  if otool -L "$f" | grep -q "GameKit"; then
    echo "check_gamekit_weak: the default build links GameKit: $f" >&2
    exit 1
  fi
  echo "ok: no GameKit in $f"
done < <(machos "$apple")
[ "$m" -gt 0 ] || { echo "check_gamekit_weak: no Mach-O under $apple" >&2; exit 1; }
