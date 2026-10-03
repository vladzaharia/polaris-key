#!/usr/bin/env bash
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
Z=${ZSTD_SRC:-$W/zstd-1.5.7}/lib
LLD="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/rust-lld"
OBJ=$W/obj; rm -rf $OBJ; mkdir -p $OBJ
SRC="$W/zenc.c $(ls $Z/common/*.c | grep -v -e threading -e pool) $(ls $Z/compress/*.c | grep -v zstdmt) $Z/decompress/huf_decompress.c $Z/decompress/zstd_ddict.c $Z/decompress/zstd_decompress.c $Z/decompress/zstd_decompress_block.c"
for f in $SRC; do
  clang --target=wasm32 -O3 -nostdlib -ffreestanding -mbulk-memory -DNDEBUG -DZSTD_DISABLE_ASM -DZSTD_NO_TRACE \
    -I"$W/stub" -I"$Z" -I"$Z/common" -c -o "$OBJ/$(basename $f .c).o" "$f"
done
$LLD -flavor wasm --no-entry --strip-all -o $W/zenc.wasm $OBJ/*.o
ls -la $W/zenc.wasm; shasum -a 256 $W/zenc.wasm
