#!/bin/bash
# Build libpkey_sparkle.dylib (universal) against godot-cpp 10.0.0 and Sparkle 2.10.0 (weak-linked).
set -e
cd "$(dirname "$0")"
GC=${GODOT_CPP:-../../godot-cpp}; SP=${SPARKLE_DIR:-../../dl/sparkle}
mkdir -p bin
t0=$(date +%s)
clang++ -std=c++17 -fobjc-arc -O2 -fPIC -shared -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 \
  -I$GC/include -I$GC/gen/include -I$GC/gdextension \
  -F$SP -weak_framework Sparkle -framework Cocoa \
  -Wl,-rpath,@loader_path/../Frameworks -Wl,-rpath,@executable_path/../Frameworks \
  src/pkey_sparkle.mm $GC/bin/libgodot-cpp.macos.template_release.universal.a \
  -o bin/libpkey_sparkle.dylib
echo "built in $(( $(date +%s) - t0 )) s"; ls -la bin; lipo -info bin/libpkey_sparkle.dylib; otool -L bin/libpkey_sparkle.dylib
