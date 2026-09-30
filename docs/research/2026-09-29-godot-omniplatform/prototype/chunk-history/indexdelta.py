#!/usr/bin/env python3
"""How small could the target chunk index be on the wire? For each consecutive pair, the target's
pkey-chunks/1 (shared 4 MiB bundles) raw, as one zstd -19 frame, and as a zstd -19 --patch-from
frame against the seed index the client already holds (raw-content prefix, as decoders use it).
Run after matrix.py (uses its cached recipes and stored sizes). usage: python3 indexdelta.py [family]"""
import json, os, sys
from compression import zstd
import hist

fam = sys.argv[1] if len(sys.argv) > 1 else "desktop"
R = hist.releases()
rows = []
for ch in ("fa64", "fa32m", "fa64m"):
    recs = [hist.recipe(r, fam, ch) for r in R]
    lays = hist.layouts_shared(recs, 4 * hist.MIB)
    size = [os.path.getsize(hist.payload_path(r, fam)) for r in R]
    blobs = [hist.index_blob(recs[k], lays[k][0], hist.CHUNKERS[ch][1], size[k]) for k in range(len(R))]
    for i, j in [(k, k + 1) for k in range(len(R) - 1)] + [(0, len(R) - 1)]:
        a, b = blobs[i], blobs[j]
        opts = {zstd.CompressionParameter.compression_level: 19,
                zstd.CompressionParameter.window_log: max(20, (len(a) + len(b)).bit_length())}
        pf = zstd.compress(b, options=opts, zstd_dict=zstd.ZstdDict(a, is_raw=True).as_prefix)
        assert zstd.decompress(pf, zstd_dict=zstd.ZstdDict(a, is_raw=True).as_prefix) == b
        row = {"chunker": ch, "from": R[i]["version"], "to": R[j]["version"], "raw": len(b),
               "zstd": len(zstd.compress(b, level=19)), "patchFromSeed": len(pf)}
        rows.append(row)
        print(json.dumps(row))
json.dump(rows, open(os.path.join(hist.OUT, f"indexdelta-{fam}.json"), "w"), indent=1)
