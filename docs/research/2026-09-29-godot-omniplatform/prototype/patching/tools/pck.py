#!/usr/bin/env python3
"""Minimal Godot PCK (v2/v3/v4) reader/writer used by the research experiments."""
import hashlib, struct, sys

MAGIC = 0x43504447
F_ENC, F_REMOVAL, F_DELTA = 1, 2, 4


def read_pck(path, offset=0):
    with open(path, "rb") as f:
        f.seek(offset)
        magic, version, vmaj, vmin, vpat, flags = struct.unpack("<6I", f.read(24))
        assert magic == MAGIC, hex(magic)
        file_base, dir_off = struct.unpack("<QQ", f.read(16))
        file_base += offset
        dir_off += offset
        f.seek(dir_off)
        (count,) = struct.unpack("<I", f.read(4))
        entries = []
        for _ in range(count):
            (sl,) = struct.unpack("<I", f.read(4))
            p = f.read(sl).rstrip(b"\0").decode()
            ofs, size = struct.unpack("<QQ", f.read(16))
            md5 = f.read(16)
            (fl,) = struct.unpack("<I", f.read(4))
            entries.append({"path": p, "ofs": file_base + ofs, "rel": ofs, "size": size, "md5": md5.hex(), "flags": fl})
        return {"version": version, "engine": (vmaj, vmin, vpat), "flags": flags, "file_base": file_base,
                "dir_off": dir_off, "entries": entries}


def read_entry(path, e):
    with open(path, "rb") as f:
        f.seek(e["ofs"])
        return f.read(e["size"])


def pad(n, a):
    r = n % a
    return 0 if r == 0 else a - r


def write_pck(path, files, align=16, engine=(4, 7, 2), version=4):
    """files: list of (path, bytes, flags). Writes files in the given order, directory in the given order."""
    with open(path, "wb") as f:
        f.write(struct.pack("<6I", MAGIC, version, *engine, 2))  # PACK_REL_FILEBASE
        fb_pos = f.tell(); f.write(struct.pack("<QQ", 0, 0)); f.write(b"\0" * 64)
        f.write(b"\0" * pad(f.tell(), align))
        file_base = f.tell()
        recs = []
        for p, data, fl in files:
            o = f.tell(); f.write(data); f.write(b"\0" * pad(f.tell(), align))
            recs.append((p, o - file_base, len(data), hashlib.md5(data).digest() if not fl & F_REMOVAL else b"\0" * 16, fl))
        f.write(b"\0" * pad(f.tell(), align))
        dir_off = f.tell()
        f.write(struct.pack("<I", len(recs)))
        for p, o, s, m, fl in recs:
            b = p.encode(); b += b"\0" * pad(len(b), 4)
            f.write(struct.pack("<I", len(b)) + b + struct.pack("<QQ", o, s) + m + struct.pack("<I", fl))
        f.seek(fb_pos); f.write(struct.pack("<QQ", file_base, dir_off))


if __name__ == "__main__":
    info = read_pck(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 0)
    print("version", info["version"], "engine", info["engine"], "flags", info["flags"], "files", len(info["entries"]))
    for e in sorted(info["entries"], key=lambda e: -e["size"])[: int(sys.argv[3]) if len(sys.argv) > 3 else 20]:
        print(f'{e["size"]:>10} {e["flags"]} {e["path"]}')
