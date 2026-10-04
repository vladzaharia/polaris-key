#!/usr/bin/env bash
# Builds src/zdec.wasm: zdec.c plus zstd 1.5.7's lib/common and lib/decompress, decoder only,
# no emscripten and no libc (A7 §9.5; plans/P4-01.md §2.13). With `enc`, builds src/zenc.wasm
# instead (P4-17, notes/S-08 §6): zenc.c plus lib/common (no thread pool), lib/compress (no
# zstdmt) and lib/decompress, the lazy-delta encoder. Never part of the green gate: the built
# modules are committed, and `pnpm --filter @polaris-key/zstd-wasm test` checks each against its
# src/*.wasm.sha256, so a rebuild is a reviewed change to both files.
#
# usage: packages/zstd-wasm/wasm/build.sh [enc]
#   ZSTD_SRC  an extracted zstd-1.5.7 source tree. Default: wasm/zstd-1.5.7 (git-ignored), fetched
#             from the official GitHub release and checked against its SHA-256 when missing.
#   CC        a clang with the WebAssembly target (default: clang). Objects are compiled with -c.
#   WASM_LD   a wasm-ld (default: wasm-ld). `rust-lld -flavor wasm` works too:
#             WASM_LD="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/rust-lld -flavor wasm"
#
# The committed module was built on macOS arm64 with Apple clang 21.0.0 (clang-2100.3.34.2) and
# rust-lld from Rust stable (LLD 20/21), -O3. Another compiler or linker builds a working but
# different module; record its SHA-256 in src/zdec.wasm.sha256 with the module.
set -euo pipefail
W=$(cd "$(dirname "$0")" && pwd)
TARGET=${1:-dec}
case "$TARGET" in
  dec) OUT=$W/../src/zdec.wasm ;;
  enc) OUT=$W/../src/zenc.wasm ;;
  *) echo "usage: build.sh [enc]" >&2; exit 2 ;;
esac
CC=${CC:-clang}
WASM_LD=${WASM_LD:-wasm-ld}
ZSTD_URL=https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz
ZSTD_SHA256=eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
if [ -z "${ZSTD_SRC:-}" ]; then
  ZSTD_SRC=$W/zstd-1.5.7
  if [ ! -d "$ZSTD_SRC" ]; then
    curl -sSfL -o "$W/zstd-1.5.7.tar.gz" "$ZSTD_URL"
    got=$(sha256 "$W/zstd-1.5.7.tar.gz")
    if [ "$got" != "$ZSTD_SHA256" ]; then
      echo "zstd-1.5.7.tar.gz: SHA-256 $got, want $ZSTD_SHA256" >&2
      exit 1
    fi
    tar -xzf "$W/zstd-1.5.7.tar.gz" -C "$W"
    rm -f "$W/zstd-1.5.7.tar.gz"
  fi
fi
Z=$ZSTD_SRC/lib
OBJ=$(mktemp -d)
trap 'rm -rf "$OBJ"' EXIT
# Source order fixes the function order in the output, so keep it for a byte-identical module.
if [ "$TARGET" = dec ]; then
  SRC="$W/zdec.c $Z/common/entropy_common.c $Z/common/error_private.c $Z/common/fse_decompress.c
    $Z/common/zstd_common.c $Z/common/xxhash.c $Z/decompress/huf_decompress.c $Z/decompress/zstd_ddict.c
    $Z/decompress/zstd_decompress.c $Z/decompress/zstd_decompress_block.c"
  DEFS=""
else
  SRC="$W/zenc.c $Z/common/debug.c $Z/common/entropy_common.c $Z/common/error_private.c
    $Z/common/fse_decompress.c $Z/common/xxhash.c $Z/common/zstd_common.c
    $Z/compress/fse_compress.c $Z/compress/hist.c $Z/compress/huf_compress.c
    $Z/compress/zstd_compress.c $Z/compress/zstd_compress_literals.c
    $Z/compress/zstd_compress_sequences.c $Z/compress/zstd_compress_superblock.c
    $Z/compress/zstd_double_fast.c $Z/compress/zstd_fast.c $Z/compress/zstd_lazy.c
    $Z/compress/zstd_ldm.c $Z/compress/zstd_opt.c $Z/compress/zstd_preSplit.c
    $Z/decompress/huf_decompress.c $Z/decompress/zstd_ddict.c $Z/decompress/zstd_decompress.c
    $Z/decompress/zstd_decompress_block.c"
  DEFS="-DZSTD_NO_TRACE"
fi
OBJS=""
i=0
for f in $SRC; do
  o=$OBJ/$(printf '%02d' "$i")-$(basename "$f" .c).o
 # shellcheck disable=SC2086
  "$CC" --target=wasm32 -O3 -nostdlib -ffreestanding -mbulk-memory -DNDEBUG -DZSTD_DISABLE_ASM $DEFS \
    -I"$W/stub" -I"$Z" -I"$Z/common" -c -o "$o" "$f"
  OBJS="$OBJS $o"
  i=$((i + 1))
done
# shellcheck disable=SC2086
$WASM_LD --no-entry --strip-all -o "$OUT" $OBJS
sha256 "$OUT" >"$OUT.sha256"
echo "$(basename "$OUT"): $(wc -c <"$OUT" | tr -d ' ') B, SHA-256 $(command cat "$OUT.sha256")"
