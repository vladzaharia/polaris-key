#!/usr/bin/env bash
# build_apple.sh [--out DIR] [--install PROJECT]
#
# Builds the macOS desktop binding of PolarisKeyPlatform (SP-27): a universal (arm64 + x86_64)
# libpkey_apple.dylib holding the C-interface glue (sdks/godot/native/ios/pkey_apple.m, shared
# with iOS) and the PolarisKeyPlatform Swift sources and C surface (sdks/swift/Sources/
# PolarisKeyPlatform, PolarisKeyPlatformC), in Swift 6 language mode with warnings as errors.
# The desktop store uses its login-keychain calls only ({"op":"kc_*","keychain":"login"}).
#
# Output in --out (default native/macos/dist): libpkey_apple.dylib and pkey_apple_macos.gdextension.
# --install PROJECT copies both into PROJECT/addons/polaris_key/native/bin/.
#
#   MIN_MACOS           the deployment target (default 15.0, the Swift package floor; never lower)
#   GODOT_BIN           the editor whose `--dump-gdextension-interface` provides
#                       gdextension_interface.h (default: godot on PATH; 4.7+), or
#   GDEXTENSION_HEADER  an existing gdextension_interface.h to use instead
#
# EXTENSION=gamecenter builds the OPT-IN Game Center extension instead (I-48.6a; Q-4): the same glue
# compiled with -DPKEY_GAMECENTER over PolarisKeyGameCenter and PolarisKeyGameCenterC into
# libpkey_gamecenter.dylib (GameKit weak-linked) with pkey_gamecenter_macos.gdextension, class
# PolarisKeyGameCenter. The default build links no GameKit.
#
# Nothing here signs: the export signs the app and the GDExtension (ad hoc "-" locally, a
# Developer ID in a release job). No godot-cpp: the glue uses Godot's C interface only.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
SRC="$REPO/sdks/swift/Sources/PolarisKeyPlatform"
CSRC="$REPO/sdks/swift/Sources/PolarisKeyPlatformC"
GCSRC="$REPO/sdks/swift/Sources/PolarisKeyGameCenter"
GCCSRC="$REPO/sdks/swift/Sources/PolarisKeyGameCenterC"
GLUE="$REPO/sdks/godot/native/ios/pkey_apple.m"
EXTENSION="${EXTENSION:-apple}"
case "$EXTENSION" in
  apple) NAME=pkey_apple; GLUE_DEFS="" ;;
  gamecenter) NAME=pkey_gamecenter; GLUE_DEFS="-DPKEY_GAMECENTER" ;;
  *) echo "build_apple.sh: EXTENSION must be apple or gamecenter" >&2; exit 2 ;;
esac
OUT="$HERE/dist"
INSTALL=""
MIN_MACOS="${MIN_MACOS:-15.0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --install) INSTALL="$2"; shift 2 ;;
    *) echo "build_apple.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != Darwin ]; then
  echo "build_apple.sh: the macOS binding builds on macOS only" >&2
  exit 2
fi
if [ "$(printf '%s\n15.0\n' "$MIN_MACOS" | sort -V | head -n1)" != "15.0" ]; then
  echo "build_apple.sh: MIN_MACOS=$MIN_MACOS is below PolarisKeyPlatform's macOS 15.0 floor" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pkey_apple_macos.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if [ -n "${GDEXTENSION_HEADER:-}" ]; then
  cp "$GDEXTENSION_HEADER" "$WORK/gdextension_interface.h"
else
  GODOT="${GODOT_BIN:-godot}"
  (cd "$WORK" && "$GODOT" --headless --dump-gdextension-interface >/dev/null 2>&1) || true
fi
if ! grep -q "GDExtensionClassCreationInfo6" "$WORK/gdextension_interface.h" 2>/dev/null; then
  echo "build_apple.sh: need a Godot 4.7+ gdextension_interface.h (set GODOT_BIN or GDEXTENSION_HEADER)" >&2
  exit 2
fi

SDK="$(xcrun --sdk macosx --show-sdk-path)"
t0=$(date +%s)

# slice <arch>: one dylib for one architecture.
slice() {
  local arch="$1" dir="$WORK/$1" triple="$1-apple-macos$MIN_MACOS"
  mkdir -p "$dir/mods"
  xcrun --sdk macosx clang -c -fobjc-arc -fmodules -O2 -Wall -Wextra -Werror -Wno-unused-parameter -Wno-cast-function-type \
    $GLUE_DEFS -I"$WORK" -target "$triple" -isysroot "$SDK" "$GLUE" -o "$dir/pkey_apple.o"
  xcrun --sdk macosx swiftc -target "$triple" -sdk "$SDK" -swift-version 6 -warnings-as-errors -O \
    -parse-as-library -package-name polaris_key -module-name PolarisKeyPlatform -emit-library -static \
    -emit-module -emit-module-path "$dir/mods/PolarisKeyPlatform.swiftmodule" \
    "$SRC"/*.swift -o "$dir/libPolarisKeyPlatform.a"
  if [ "$EXTENSION" = gamecenter ]; then
    xcrun --sdk macosx swiftc -target "$triple" -sdk "$SDK" -swift-version 6 -warnings-as-errors -O \
      -parse-as-library -module-name PolarisKeyGameCenter -emit-library -static \
      -emit-module -emit-module-path "$dir/mods/PolarisKeyGameCenter.swiftmodule" \
      "$GCSRC"/*.swift -o "$dir/libPolarisKeyGameCenter.a"
    xcrun --sdk macosx swiftc -target "$triple" -sdk "$SDK" -swift-version 6 -warnings-as-errors -O \
      -parse-as-library -module-name PolarisKeyGameCenterC -I "$dir/mods" -emit-library "$GCCSRC"/*.swift \
      "$dir/pkey_apple.o" "$dir/libPolarisKeyGameCenter.a" "$dir/libPolarisKeyPlatform.a" \
      -Xlinker -install_name -Xlinker "@rpath/lib$NAME.dylib" \
      -framework Foundation -Xlinker -weak_framework -Xlinker GameKit -o "$dir/lib$NAME.dylib"
  else
    xcrun --sdk macosx swiftc -target "$triple" -sdk "$SDK" -swift-version 6 -warnings-as-errors -O \
      -parse-as-library -module-name PolarisKeyPlatformC -I "$dir/mods" -emit-library "$CSRC"/*.swift \
      "$dir/pkey_apple.o" "$dir/libPolarisKeyPlatform.a" \
      -Xlinker -install_name -Xlinker "@rpath/lib$NAME.dylib" \
      -framework Foundation -framework StoreKit -framework Security -o "$dir/lib$NAME.dylib"
  fi
}

slice arm64
slice x86_64
mkdir -p "$OUT"
lipo -create "$WORK/arm64/lib$NAME.dylib" "$WORK/x86_64/lib$NAME.dylib" -output "$OUT/lib$NAME.dylib"
cp "$HERE/${NAME}_macos.gdextension" "$OUT/"
nm -gU "$OUT/lib$NAME.dylib" | grep -q "_${NAME}_library_init" || {
  echo "build_apple.sh: ${NAME}_library_init is not exported" >&2
  exit 1
}
echo "build_apple.sh: built $OUT/lib$NAME.dylib (macOS $MIN_MACOS, universal) in $(($(date +%s) - t0)) s"

if [ -n "$INSTALL" ]; then
  BIN="$INSTALL/addons/polaris_key/native/bin"
  mkdir -p "$BIN"
  cp "$OUT/lib$NAME.dylib" "$OUT/${NAME}_macos.gdextension" "$BIN/"
  echo "build_apple.sh: installed into $BIN"
fi
