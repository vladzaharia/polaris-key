#!/usr/bin/env bash
# fetch_deps.sh <dir> <dep>...   (dep: godot-cpp | sparkle | velopack | winsparkle)
#
# Puts the native plugins' pinned inputs (deps.env) under <dir>, each checked before use:
#
#   godot-cpp   <dir>/godot-cpp, a checkout of GODOT_CPP_TAG verified to be GODOT_CPP_COMMIT
#               (its build products stay in place, so CI caches the directory with its
#               .sconsign.dblite)
#   sparkle     <dir>/sparkle: Sparkle.framework, bin/sign_update, bin/BinaryDelta, … (macOS)
#   velopack    <dir>/velopack: include/Velopack.h and lib/velopack_libc_win_x64_msvc.dll
#   winsparkle  <dir>/winsparkle: include/winsparkle.h, x64/Release/WinSparkle.dll,
#               bin/winsparkle-tool.exe
#
# Every archive is checked against its SHA-256 in deps.env; a mismatch stops the script. An
# input already present (a CI cache hit, a second local run) is not fetched again. Runs on macOS
# (bash 3.2) and in Git Bash on Windows.

set -eu

if [ $# -lt 2 ]; then
  echo "usage: fetch_deps.sh <dir> <godot-cpp|sparkle|velopack|winsparkle>..." >&2
  exit 2
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/deps.env"
DIR="$1"
shift
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pkey-native-deps.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -c1-64
  else
    shasum -a 256 "$1" | cut -c1-64
  fi
}

# fetch <url> <sha256> <file>: download into $WORK/<file> and check it.
fetch() {
  echo "fetch_deps: downloading $1"
  curl -fsSL --retry 3 -o "$WORK/$3" "$1"
  local got
  got="$(sha256_of "$WORK/$3")"
  if [ "$got" != "$2" ]; then
    echo "fetch_deps: $3 has SHA-256 $got, deps.env pins $2" >&2
    exit 1
  fi
}

# unpack_zip <zip> <dest>
unpack_zip() {
  mkdir -p "$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$1" -d "$2"
  elif command -v 7z >/dev/null 2>&1; then
    7z x -y -bd "-o$(cygpath -w "$2")" "$(cygpath -w "$1")" >/dev/null
  else
    powershell.exe -NoProfile -NonInteractive -Command \
      "Expand-Archive -Force -LiteralPath '$(cygpath -w "$1")' -DestinationPath '$(cygpath -w "$2")'"
  fi
}

for dep in "$@"; do
  case "$dep" in
    godot-cpp)
      d="$DIR/godot-cpp"
      if [ ! -f "$d/SConstruct" ]; then
        rm -rf "$d"
        git clone -q --depth 1 -b "$GODOT_CPP_TAG" "$GODOT_CPP_REPO" "$d"
      fi
      got="$(git -C "$d" rev-parse HEAD)"
      if [ "$got" != "$GODOT_CPP_COMMIT" ]; then
        echo "fetch_deps: godot-cpp $GODOT_CPP_TAG is $got, deps.env pins $GODOT_CPP_COMMIT" >&2
        exit 1
      fi
      echo "fetch_deps: godot-cpp $GODOT_CPP_TAG at $got"
      ;;
    sparkle)
      d="$DIR/sparkle"
      if [ ! -d "$d/Sparkle.framework" ]; then
        fetch "$SPARKLE_URL" "$SPARKLE_SHA256" sparkle.tar.xz
        rm -rf "$d"
        mkdir -p "$d"
        tar -xJf "$WORK/sparkle.tar.xz" -C "$d"
      fi
      echo "fetch_deps: Sparkle $SPARKLE_VERSION in $d"
      ;;
    velopack)
      d="$DIR/velopack"
      if [ ! -f "$d/include/Velopack.h" ]; then
        fetch "$VELOPACK_LIBC_URL" "$VELOPACK_LIBC_SHA256" velopack_libc.zip
        rm -rf "$d"
        unpack_zip "$WORK/velopack_libc.zip" "$d"
      fi
      echo "fetch_deps: velopack_libc $VELOPACK_VERSION in $d"
      ;;
    winsparkle)
      d="$DIR/winsparkle"
      if [ ! -f "$d/include/winsparkle.h" ]; then
        fetch "$WINSPARKLE_URL" "$WINSPARKLE_SHA256" winsparkle.zip
        rm -rf "$d" "$WORK/ws"
        unpack_zip "$WORK/winsparkle.zip" "$WORK/ws"
        mv "$WORK/ws/WinSparkle-$WINSPARKLE_VERSION" "$d"
      fi
      echo "fetch_deps: WinSparkle $WINSPARKLE_VERSION in $d"
      ;;
    *)
      echo "fetch_deps: unknown dependency $dep" >&2
      exit 2
      ;;
  esac
done
