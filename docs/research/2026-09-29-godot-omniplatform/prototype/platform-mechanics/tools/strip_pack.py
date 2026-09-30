#!/usr/bin/env python3
"""Rewrite a PCK without the entries an editor --export-pack always adds to a data pack.
usage: strip_pack.py <in.pck> <out.pck> [path ...]   (default: project.binary, .godot/global_script_class_cache.cfg)"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "patching", "tools"))
import pck  # noqa: E402

src, dst = sys.argv[1], sys.argv[2]
drop = set(sys.argv[3:] or ["project.binary", ".godot/global_script_class_cache.cfg"])
info = pck.read_pck(src)
keep = [(e["path"], pck.read_entry(src, e), e["flags"]) for e in info["entries"] if e["path"].removeprefix("res://") not in drop]
pck.write_pck(dst, keep)
print(f"{dst}: kept {len(keep)} of {len(info['entries'])} entries, dropped {sorted(drop)}")
