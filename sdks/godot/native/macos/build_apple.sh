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
#   MIN_MACOS           the deployment target (default 14.0, the Swift package floor; never lower)
#   GODOT_BIN           the editor whose `--dump-gdextension-interface` provides
#                       gdextension_interface.h (default: godot on PATH; 4.7+), or
#   GDEXTENSION_HEADER  an existing gdextension_interface.h to use instead
#
# Nothing here signs: the export signs the app and the GDExtension (ad hoc "-" locally, a
# Developer ID in a release job). No godot-cpp: the glue uses Godot's C interface only.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
SRC="$REPO/sdks/swift/Sources/PolarisKeyPlatform"
CSRC="$REPO/sdks/swift/Sources/PolarisKeyPlatformC"
GLUE="$REPO/sdks/godot/native/ios/pkey_apple.m"
OUT="$HERE/dist"
INSTALL=""
MIN_MACOS="${MIN_MACOS:-14.0}"

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
if [ "$(printf '%s\n14.0\n' "$MIN_MACOS" | sort -V | head -n1)" != "14.0" ]; then
  echo "build_apple.sh: MIN_MACOS=$MIN_MACOS is below PolarisKeyPlatform's macOS 14.0 floor" >&2
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
    -I"$WORK" -target "$triple" -isysroot "$SDK" "$GLUE" -o "$dir/pkey_apple.o"
  xcrun --sdk macosx swiftc -target "$triple" -sdk "$SDK" -swift-version 6 -warnings-as-errors -O \
    -parse-as-library -module-name PolarisKeyPlatform -emit-library -static \
    -emit-module -emit-module-path "$dir/mods/PolarisKeyPlatform.swiftmodule" \
    "$SRC"/*.swift -o "$dir/libPolarisKeyPlatform.a"
  xcrun --sdk macosx swiftc -target "$triple" -sdk "$SDK" -swift-version 6 -warnings-as-errors -O \
    -parse-as-library -module-name PolarisKeyPlatformC -I "$dir/mods" -emit-library "$CSRC"/*.swift \
    "$dir/pkey_apple.o" "$dir/libPolarisKeyPlatform.a" \
    -Xlinker -install_name -Xlinker @rpath/libpkey_apple.dylib \
    -framework Foundation -framework StoreKit -framework Security -o "$dir/libpkey_apple.dylib"
}

slice arm64
slice x86_64
mkdir -p "$OUT"
lipo -create "$WORK/arm64/libpkey_apple.dylib" "$WORK/x86_64/libpkey_apple.dylib" -output "$OUT/libpkey_apple.dylib"
cp "$HERE/pkey_apple_macos.gdextension" "$OUT/"
nm -gU "$OUT/libpkey_apple.dylib" | grep -q "_pkey_apple_library_init" || {
  echo "build_apple.sh: pkey_apple_library_init is not exported" >&2
  exit 1
}
echo "build_apple.sh: built $OUT/libpkey_apple.dylib (macOS $MIN_MACOS, universal) in $(($(date +%s) - t0)) s"

if [ -n "$INSTALL" ]; then
  BIN="$INSTALL/addons/polaris_key/native/bin"
  mkdir -p "$BIN"
  cp "$OUT/libpkey_apple.dylib" "$OUT/pkey_apple_macos.gdextension" "$BIN/"
  echo "build_apple.sh: installed into $BIN"
fi
