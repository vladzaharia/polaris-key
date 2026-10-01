#!/usr/bin/env python3
"""Rewrite a PCK without the entries an editor --export-pack always adds to a data pack.
usage: strip_pack.py <in.pck> <out.pck> [path ...]   (default: project.binary, .godot/global_script_class_cache.cfg)

The output keeps the source header: format version, engine version and pack flags. Only PCKs this
rewrite can reproduce faithfully are accepted; anything else exits non-zero without writing:
  - format v3 or v4 (v2 has no directory offset, so pck.read_pck cannot parse it);
  - no PACK_DIR_ENCRYPTED (1) and no PACK_SPARSE_BUNDLE (4) pack flag;
  - no PACK_FILE_ENCRYPTED entry.
After writing, it re-reads the output and checks that the header and every kept entry's path,
size, MD5 and flags match the source. File data is copied byte for byte; only the 16-byte
alignment of pck.write_pck may differ from the source's."""
import os, struct, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "patching", "tools"))
import pck  # noqa: E402

PACK_DIR_ENCRYPTED, PACK_REL_FILEBASE, PACK_SPARSE_BUNDLE = 1, 2, 4


def fail(msg):
    sys.exit(f"strip_pack: {msg}")


src, dst = sys.argv[1], sys.argv[2]
drop = set(sys.argv[3:] or ["project.binary", ".godot/global_script_class_cache.cfg"])
with open(src, "rb") as f:  # check the header first: read_pck would mis-parse a v2 or encrypted directory
    magic, version, _, _, _, flags = struct.unpack("<6I", f.read(24))
if magic != pck.MAGIC:
    fail(f"{src}: not a PCK (magic {magic:#x})")
if version not in (3, 4):
    fail(f"{src}: PCK format v{version} is not supported (v3 or v4 only)")
if flags & PACK_DIR_ENCRYPTED:
    fail(f"{src}: encrypted directory (pack flags {flags})")
if flags & PACK_SPARSE_BUNDLE:
    fail(f"{src}: sparse bundle (pack flags {flags}); its file data is not in this file")
if flags & ~(PACK_DIR_ENCRYPTED | PACK_REL_FILEBASE | PACK_SPARSE_BUNDLE):
    fail(f"{src}: unknown pack flags {flags}")
info = pck.read_pck(src)
enc = [e["path"] for e in info["entries"] if e["flags"] & pck.F_ENC]
if enc:
    fail(f"{src}: {len(enc)} encrypted entries, e.g. {enc[0]}")

kept = [e for e in info["entries"] if e["path"].removeprefix("res://") not in drop]
pck.write_pck(dst, [(e["path"], pck.read_entry(src, e), e["flags"]) for e in kept],
              engine=info["engine"], version=info["version"])
if info["flags"] != PACK_REL_FILEBASE:  # write_pck always writes REL_FILEBASE; v3/v4 read the base as relative either way
    with open(dst, "r+b") as f:
        f.seek(20)
        f.write(struct.pack("<I", info["flags"]))

out = pck.read_pck(dst)
want = [(e["path"], e["size"], e["md5"], e["flags"]) for e in kept]
got = [(e["path"], e["size"], e["md5"], e["flags"]) for e in out["entries"]]
head = lambda i: (i["version"], i["engine"], i["flags"])  # noqa: E731
if head(out) != head(info) or got != want:
    os.remove(dst)
    fail(f"{src}: rewritten directory does not match the source (header {head(out)} vs {head(info)}); output removed")
print(f"{dst}: kept {len(kept)} of {len(info['entries'])} entries, dropped {sorted(drop)}; "
      f"format v{info['version']}, engine {'.'.join(map(str, info['engine']))}, flags {info['flags']}")
