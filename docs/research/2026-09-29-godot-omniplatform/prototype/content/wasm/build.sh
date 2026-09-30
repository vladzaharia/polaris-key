#!/bin/bash
# Builds the decoder-only libzstd WASM (zdec.c + zstd 1.5.7's lib/common and lib/decompress), no emscripten, no libc.
# usage: wasm/build.sh
#   ZSTD_SRC  an extracted zstd-1.5.7 source tree. Default: wasm/zstd-1.5.7, fetched from the official
#             GitHub release and checked against its SHA-256 when it is missing.
#   CC        clang with the wasm32 target and wasm-ld (default: clang). clang 18.1.3 reproduces the
#             measured binaries byte for byte; other versions build a working but different module.
# Outputs (git-ignored): wasm/zstddec-prefix-O3.wasm, wasm/zstddec-prefix-Oz.wasm, and the -O3 build copied to
# runners/browser/zstddec-prefix.wasm, where the Node, browser and probe scripts load it.
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
CC=${CC:-clang}
ZSTD_URL=https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz
ZSTD_SHA256=eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3
if [ -z "${ZSTD_SRC:-}" ]; then
  ZSTD_SRC=$W/zstd-1.5.7
  if [ ! -d "$ZSTD_SRC" ]; then
    curl -sSfL -o "$W/zstd-1.5.7.tar.gz" "$ZSTD_URL"
    echo "$ZSTD_SHA256  $W/zstd-1.5.7.tar.gz" | sha256sum -c -
    tar -xzf "$W/zstd-1.5.7.tar.gz" -C "$W"
  fi
fi
Z=$ZSTD_SRC/lib
# Source order matters for a byte-identical module: it fixes the function order in the output.
SRC="$W/zdec.c $Z/common/entropy_common.c $Z/common/error_private.c $Z/common/fse_decompress.c $Z/common/zstd_common.c
  $Z/common/xxhash.c $Z/decompress/huf_decompress.c $Z/decompress/zstd_ddict.c $Z/decompress/zstd_decompress.c
  $Z/decompress/zstd_decompress_block.c"
for opt in O3 Oz; do
  # shellcheck disable=SC2086
  "$CC" --target=wasm32 -$opt -nostdlib -ffreestanding -mbulk-memory -I"$W/fakelibc" -I"$Z" -I"$Z/common" \
    -Wl,--no-entry -Wl,--strip-all -o "$W/zstddec-prefix-$opt.wasm" $SRC
done
cp -f "$W/zstddec-prefix-O3.wasm" "$W/../runners/browser/zstddec-prefix.wasm"
# The measured builds (clang 18.1.3): -O3 68,949 B, -Oz 56,506 B.
for pair in O3:5d409a8a397c86c9d68a8b055e996338fc950db140952f3d998d32c610714a93 \
  Oz:127f0bfb276a12489f1a52a154db4065f03ee1801dd36289705526eb1c88acee; do
  f=$W/zstddec-prefix-${pair%%:*}.wasm
  got=$(sha256sum "$f" | cut -d' ' -f1)
  [ "$got" = "${pair#*:}" ] && m="identical to the measured build" || m="differs from the measured build (compiler version?)"
  echo "$(basename "$f"): $(stat -c%s "$f") B, $(gzip -9c "$f" | wc -c) B gzipped, $m"
done
