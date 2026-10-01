#!/usr/bin/env python3
"""S-02: the real byte ranges an update fetches from chunk bundles.

usage: runs.py VECTOR_DIR [GAP]

Reads chunks/v1.pkc (installed) and chunks/v2.pkc (target) from a vector set built by
prototype/content/gen/gen.py large, finds the v2 chunks the v1 install lacks, and coalesces them
into contiguous runs per bundle (runs separated by at most GAP bytes are merged; default 0).
Prints JSON: {bundles: [{sha256, size, runs: [[start, endInclusive], ...]}], ...} for probe.mjs.
"""
import json, os, struct, sys

MAGIC = b"PKEYCHNK"


def read_index(path):
    b = open(path, "rb").read()
    assert b[:8] == MAGIC, "not a pkey-chunks/1 index"
    ver, rec, flags, n_chunks, n_bundles, size = struct.unpack_from("<HHIIIQ", b, 8)
    assert rec == 48
    off = 64
    chunks = []
    for _ in range(n_chunks):
        h = b[off : off + 32].hex()
        s, clen, bi, bo = struct.unpack_from("<IIII", b, off + 32)
        chunks.append((h, s, clen, bi, bo))
        off += 48
    bundles = []
    for _ in range(n_bundles):
        h = b[off : off + 32].hex()
        bsize, _ = struct.unpack_from("<QQ", b, off + 32)
        bundles.append((h, bsize))
        off += 48
    return chunks, bundles


def main():
    vec = sys.argv[1]
    gap = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    c1, _ = read_index(os.path.join(vec, "blobs", "chunks", "v1.pkc"))
    c2, b2 = read_index(os.path.join(vec, "blobs", "chunks", "v2.pkc"))
    have = {c[0] for c in c1}
    need = {}
    for h, _s, clen, bi, bo in c2:
        if h in have:
            continue
        need.setdefault(bi, set()).add((bo, bo + clen - 1))
    out = []
    total_bytes = 0
    total_runs = 0
    for bi, (bh, bsize) in enumerate(b2):
        spans = sorted(need.get(bi, ()))
        runs = []
        for s, e in spans:
            if runs and s <= runs[-1][1] + 1 + gap:
                runs[-1][1] = max(runs[-1][1], e)
            else:
                runs.append([s, e])
        total_runs += len(runs)
        total_bytes += sum(e - s + 1 for s, e in runs)
        out.append({"sha256": bh, "size": bsize, "runs": runs})
    json.dump(
        {
            "from": "v1",
            "to": "v2",
            "gap": gap,
            "missingChunks": sum(len(v) for v in need.values()),
            "runs": total_runs,
            "bytes": total_bytes,
            "bundles": out,
        },
        sys.stdout,
    )
    print()


if __name__ == "__main__":
    main()
