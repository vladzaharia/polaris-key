#!/usr/bin/env bash
# build.sh [--deps DIR] [--out DIR] [--install PROJECT] [--jobs N]
#
# Builds the macOS Sparkle bridge (P5-07): godot-cpp (deps.env's commit, GODOT_CPP_API,
# template_release, universal) once per deps directory, then pkey_sparkle.mm into a universal
# libpkey_sparkle.dylib (macOS 12+, Sparkle 2.10's own floor) that WEAK-links Sparkle.framework
# (notes/S-11 §8 step 1). The result is
# staged in --out (default native/macos/dist):
#
#   libpkey_sparkle.dylib  pkey_sparkle.gdextension  Sparkle.framework/
#
# --install PROJECT copies the three into PROJECT/addons/polaris_key/native/bin/, where the
# .gdextension expects them. Nothing here signs: the export signs the app, the GDExtension and
# Sparkle's helpers (codesign/codesign=1; ad-hoc identity "-" for local runs), and
# sign_and_notarize.sh re-signs with a Developer ID and notarises in a release job.
#
#   --deps DIR   where fetch_deps.sh keeps godot-cpp and Sparkle (default native/.deps; CI caches
#                godot-cpp/ there with its .sconsign.dblite)
#   --jobs N     SCons jobs (default: the CPU count)

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/.." && pwd)"
# shellcheck disable=SC1091
. "$NATIVE/deps.env"
DEPS="$NATIVE/.deps"
OUT="$HERE/dist"
INSTALL=""
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

while [ $# -gt 0 ]; do
  case "$1" in
    --deps) DEPS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --install) INSTALL="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    *) echo "build.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != Darwin ]; then
  echo "build.sh: the Sparkle bridge builds on macOS only" >&2
  exit 2
fi

"$NATIVE/fetch_deps.sh" "$DEPS" godot-cpp sparkle
GC="$DEPS/godot-cpp"
SP="$DEPS/sparkle"
LIB="$GC/bin/libgodot-cpp.macos.template_release.universal.a"

t0=$(date +%s)
# SCons decides whether anything is stale (.sconsign.dblite lives in the godot-cpp directory).
(cd "$GC" && scons -Q platform=macos target=template_release arch=universal "api_version=$GODOT_CPP_API" \
  macos_deployment_target=11.0 "-j$JOBS")
echo "build.sh: godot-cpp ready in $(($(date +%s) - t0)) s"

mkdir -p "$OUT"
t0=$(date +%s)
clang++ -std=c++17 -fobjc-arc -O2 -fPIC -shared -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 \
  -fvisibility=hidden \
  -I"$GC/include" -I"$GC/gen/include" -I"$GC/gdextension" \
  -F"$SP" -weak_framework Sparkle -framework Cocoa \
  -Wl,-rpath,@loader_path -Wl,-rpath,@executable_path/../Frameworks \
  -install_name @rpath/libpkey_sparkle.dylib \
  "$HERE/src/pkey_sparkle.mm" "$LIB" \
  -o "$OUT/libpkey_sparkle.dylib"
echo "build.sh: libpkey_sparkle.dylib built in $(($(date +%s) - t0)) s"

cp "$HERE/pkey_sparkle.gdextension" "$OUT/"
rm -rf "$OUT/Sparkle.framework"
ditto "$SP/Sparkle.framework" "$OUT/Sparkle.framework"

lipo -info "$OUT/libpkey_sparkle.dylib"
# Sparkle must be a weak (LC_LOAD_WEAK_DYLIB) dependency, or a build without it fails to load
# the extension instead of answering `dependency`.
if ! otool -l "$OUT/libpkey_sparkle.dylib" | grep -A2 LC_LOAD_WEAK_DYLIB | grep -q Sparkle.framework; then
  echo "build.sh: Sparkle.framework is not weak-linked" >&2
  exit 1
fi
nm -gU "$OUT/libpkey_sparkle.dylib" | grep -q pkey_sparkle_init || { echo "build.sh: entry symbol missing" >&2; exit 1; }

if [ -n "$INSTALL" ]; then
  BIN="$INSTALL/addons/polaris_key/native/bin"
  mkdir -p "$BIN"
  rm -rf "$BIN/Sparkle.framework" "$BIN/libpkey_sparkle.dylib"
  ditto "$OUT/Sparkle.framework" "$BIN/Sparkle.framework"
  cp "$OUT/libpkey_sparkle.dylib" "$OUT/pkey_sparkle.gdextension" "$BIN/"
  echo "build.sh: installed into $BIN"
fi
