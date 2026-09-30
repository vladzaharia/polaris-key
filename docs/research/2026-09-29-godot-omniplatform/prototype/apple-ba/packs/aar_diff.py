#!/usr/bin/env python3
"""What could an asset-pack update cost on the wire? Offline analysis of a v1/v2 .aar pair.

usage: aar_diff.py <v1.aar> <v2.aar> [out_dir]

A `ba-package` archive is an Apple Archive stream in a `pbze` container: an 8-byte magic
(`pbze` = LZFSE), a big-endian u64 block size, then blocks of (u64 raw size, u64 stored size,
payload). Each block is compressed independently. This script reports, for the pair:

  - whole-archive sizes (what a whole-pack transport sends);
  - block-level reuse: v2 compressed blocks whose bytes also occur as a v1 block
    (what a naive block-dedupe transport could skip);
  - zstd -19 --patch-from over the compressed archives and over the decompressed
    Apple Archive streams (an upper bound on what a server-side binary delta could achieve).

It measures what is possible, not what Apple's CDN does; that needs a device (see the note).
"""
import ctypes, hashlib, os, struct, subprocess, sys, tempfile

_lib = ctypes.CDLL("/usr/lib/libcompression.dylib")
_lib.compression_decode_buffer.restype = ctypes.c_size_t
_lib.compression_decode_buffer.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
                                           ctypes.c_size_t, ctypes.c_void_p, ctypes.c_int]
ALGO = {b"pbze": 0x801, b"pbz4": 0x100, b"pbzz": 0x205, b"pbzx": 0x305}  # lzfse, lz4, zlib, lzma


def blocks(path):
    with open(path, "rb") as f:
        data = f.read()
    magic = data[:4]
    assert magic in ALGO, magic
    (bs,) = struct.unpack(">Q", data[4:12])
    i, out = 12, []
    while i < len(data):
        raw, stored = struct.unpack(">QQ", data[i:i + 16])
        out.append((raw, stored, data[i + 16:i + 16 + stored]))
        i += 16 + stored
    return magic, bs, out


def decode(magic, blks):
    parts = []
    for raw, stored, payload in blks:
        if raw == stored:
            parts.append(payload)
            continue
        dst = ctypes.create_string_buffer(raw)
        n = _lib.compression_decode_buffer(dst, raw, payload, stored, None, ALGO[magic])
        assert n == raw, (n, raw)
        parts.append(dst.raw[:n])
    return b"".join(parts)


def zstd_patch(old, new):
    with tempfile.TemporaryDirectory() as t:
        o, n, p = (os.path.join(t, x) for x in ("o", "n", "p"))
        open(o, "wb").write(old)
        open(n, "wb").write(new)
        subprocess.run(["zstd", "-q", "-19", "--long=27", f"--patch-from={o}", n, "-o", p], check=True)
        return os.path.getsize(p)


def zstd_full(data):
    return len(subprocess.run(["zstd", "-q", "-19", "-c"], input=data, capture_output=True, check=True).stdout)


def main():
    a, b = sys.argv[1:3]
    ma, bsa, ba = blocks(a)
    mb, bsb, bb = blocks(b)
    seen = {hashlib.sha256(p).digest() for _, _, p in ba}
    reused = [p for _, _, p in bb if hashlib.sha256(p).digest() in seen]
    same_pos = sum(1 for x, y in zip(ba, bb) if x[2] == y[2])
    ra, rb = decode(ma, ba), decode(mb, bb)
    size_a, size_b = os.path.getsize(a), os.path.getsize(b)
    res = {
        "container": mb.decode(), "block_size": bsb,
        "v1_aar": size_a, "v2_aar": size_b,
        "v1_raw_stream": len(ra), "v2_raw_stream": len(rb),
        "v2_blocks": len(bb), "v2_blocks_reused_anywhere": len(reused),
        "v2_blocks_same_position": same_pos,
        "block_dedupe_bytes": size_b - sum(len(p) + 16 for p in reused),
        "zstd19_full_v2_raw": zstd_full(rb),
        "zstd19_patch_from_aar": zstd_patch(open(a, "rb").read(), open(b, "rb").read()),
        "zstd19_patch_from_raw_stream": zstd_patch(ra, rb),
    }
    w = max(len(k) for k in res)
    for k, v in res.items():
        print(f"{k:<{w}}  {v:>12,}" if isinstance(v, int) else f"{k:<{w}}  {v:>12}")


if __name__ == "__main__":
    main()
