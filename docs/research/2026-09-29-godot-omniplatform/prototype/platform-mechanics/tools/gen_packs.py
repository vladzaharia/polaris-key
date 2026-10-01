#!/usr/bin/env python3
"""Data-only PCK generator for S-05 (streaming; no .gd, no .import, no .godot/ caches).

usage: gen_packs.py <out.pck> <total_bytes> <entries> [prefix] [seed]
  Writes <entries> files of equal size (total_bytes / entries, random, incompressible) under
  res://<prefix>/ (default: data/<basename>), plus res://<prefix>/manifest.json listing path -> sha256.
  PCK v4 layout of Godot 4.7 (format 4, PACK_REL_FILEBASE), 16-byte alignment, like the exporter.
"""
import hashlib, json, os, random, struct, sys

MAGIC = 0x43504447


def pad(n, a):
    r = n % a
    return 0 if r == 0 else a - r


def gen(out, total, n, prefix, seed):
    rnd = random.Random(seed)
    size = max(1, total // n)
    recs = []
    man = {}
    with open(out, "wb") as f:
        f.write(struct.pack("<6I", MAGIC, 4, 4, 7, 2, 2))
        fb_pos = f.tell()
        f.write(struct.pack("<QQ", 0, 0))
        f.write(b"\0" * 64)
        f.write(b"\0" * pad(f.tell(), 16))
        file_base = f.tell()
        block = os.urandom(1 << 20) if seed is None else rnd.randbytes(1 << 20)

        def put(path, data):
            o = f.tell()
            f.write(data)
            f.write(b"\0" * pad(f.tell(), 16))
            recs.append((path, o - file_base, len(data), hashlib.md5(data).digest()))

        for i in range(n):
            # distinct content per file: rotate the random block and stamp the index
            k = (i * 7919) % len(block)
            data = bytearray()
            while len(data) < size:
                data += block[k:] + block[:k]
            data = bytes(data[:size])
            data = struct.pack("<I", i) + data[4:] if size >= 4 else data
            p = f"res://{prefix}/f{i:06d}.bin"
            man[p] = hashlib.sha256(data).hexdigest()
            put(p, data)
        put(f"res://{prefix}/manifest.json", json.dumps(man, sort_keys=True).encode())
        f.write(b"\0" * pad(f.tell(), 16))
        dir_off = f.tell()
        f.write(struct.pack("<I", len(recs)))
        for p, o, s, m in recs:
            b = p.encode()
            b += b"\0" * pad(len(b), 4)
            f.write(struct.pack("<I", len(b)) + b + struct.pack("<QQ", o, s) + m + struct.pack("<I", 0))
        f.seek(fb_pos)
        f.write(struct.pack("<QQ", file_base, dir_off))
    return len(recs), os.path.getsize(out)


if __name__ == "__main__":
    out, total, n = sys.argv[1], int(float(sys.argv[2])), int(sys.argv[3])
    prefix = sys.argv[4] if len(sys.argv) > 4 else "data/" + os.path.basename(out).rsplit(".", 1)[0]
    seed = int(sys.argv[5]) if len(sys.argv) > 5 else 1
    cnt, sz = gen(out, total, n, prefix, seed)
    print(f"{out}: {cnt} entries, {sz} bytes")
