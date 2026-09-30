#!/usr/bin/env python3
"""The S-03 matrix: for every ordered pair of releases (from < to) of one payload family, what each
strategy costs.

  chunk   file-aware FastCDC at 16/32/64/128 KiB and plain FastCDC at 64 KiB: missing chunks, missing
          raw bytes, missing stored bytes (zstd -19 per chunk, raw when not smaller), the real
          pkey-chunks/1 size (64 + 48 x (records + bundles)), request runs under the planner's rule
          and chunk bundles touched, for 4/8/16 MiB bundles laid out fresh per release or shared
          across the deliverable's history (new bundles hold only new chunks)
  delta   whole-payload `zstd -19 --patch-from` (CLI) and per-entry --patch-from (CLI, one frame per
          changed entry, new entries as zstd -19 blobs, plus the files index and gaps blob)
  file    files index + gaps blob + missing entries as zstd -19 blobs
  full    zstd -19 of the target payload (CLI)
  plan    the reference planner (pkey_content.plan) over each pair's menu, per chunker, at request
          weights 16 KiB and 64 KiB and memory budgets 256 MiB and 64 MiB

usage: python3 matrix.py [family]   (default desktop) -> data/out/matrix-<family>.json
Needs zstd >= 1.5 on PATH and Python >= 3.14 (compression.zstd)."""
import bisect, json, os, subprocess, sys, time
from compression import zstd
import hist

fam = sys.argv[1] if len(sys.argv) > 1 else "desktop"
R = hist.releases()
W = os.path.join(hist.OUT, "work", fam)
os.makedirs(W, exist_ok=True)
DATA = {r["dir"]: open(hist.payload_path(r, fam), "rb").read() for r in R}
FILES = {r["dir"]: hist.files_of(r, fam) for r in R}
C = hist.clens()
t0 = time.time()

# ---------------------------------------------------------------- recipes, stored sizes, layouts
REC = {}
for ch in hist.CHUNKERS:
    for r in R:
        REC[ch, r["dir"]] = hist.recipe(r, fam, ch)
        hist.ensure_clens(DATA[r["dir"]], REC[ch, r["dir"]])
print(f"recipes + per-chunk zstd: {time.time() - t0:.0f} s", file=sys.stderr)

LAYOUT = {}  # (chunker, strategy, target, dir) -> (loc, bundlesReferenced)
for ch in hist.CHUNKERS:
    for tgt in hist.BUNDLE_TARGETS:
        for r in R:
            LAYOUT[ch, "fresh", tgt, r["dir"]] = hist.layout_fresh(REC[ch, r["dir"]], tgt)
        for r, lay in zip(R, hist.layouts_shared([REC[ch, r["dir"]] for r in R], tgt)):
            LAYOUT[ch, "shared", tgt, r["dir"]] = lay

# ---------------------------------------------------------------- per-release sizes (full, first install)
def full_size(r):
    out = os.path.join(W, f"{r['dir']}.full.zst")
    if not os.path.exists(out):
        t = time.time()
        hist.zstd_cli(["-19", hist.payload_path(r, fam), "-o", out])
        json.dump({"seconds": round(time.time() - t, 1)}, open(out + ".time.json", "w"))
    return os.path.getsize(out), json.load(open(out + ".time.json"))["seconds"]


def files_blob(sha256, data, f):
    """Stored size of one whole entry as a file blob (zstd -19 or raw)."""
    if sha256 not in C:
        C[sha256] = hist.zlen(data[f["offset"]:f["offset"] + f["size"]])
    return C[sha256]


REL = {}
for r in R:
    fb, secs = full_size(r)
    idx = {ch: {"records": len(REC[ch, r["dir"]]),
                "unique": len({h for _, _, h in REC[ch, r["dir"]]}),
                "storedUnique": sum(C[h] for h in {h for _, _, h in REC[ch, r["dir"]]}),
                "indexBytes": {f"{s}-{t // hist.MIB}": hist.index_bytes(len(REC[ch, r["dir"]]),
                                                                         LAYOUT[ch, s, t, r["dir"]][1])
                               for s in ("fresh", "shared") for t in hist.BUNDLE_TARGETS},
                "indexZstdShared4": len(zstd.compress(hist.index_blob(REC[ch, r["dir"]], LAYOUT[ch, "shared", 4 * hist.MIB, r["dir"]][0],
                                                                      hist.CHUNKERS[ch][1], len(DATA[r["dir"]])), level=19))}
           for ch in hist.CHUNKERS}
    data = DATA[r["dir"]]
    fidx = hist.files_index_bytes(r, fam, data)
    gaps = hist.gaps_of(data, FILES[r["dir"]])
    REL[r["dir"]] = {"version": r["version"], "payload": len(data), "full": fb, "fullSeconds": secs, "chunks": idx,
                     "filesIndexBytes": len(fidx), "filesIndexZstd": len(zstd.compress(fidx, level=19)),
                     "gapsRaw": len(gaps), "gapsZstd": len(zstd.compress(gaps, level=19))}
hist.save_clens()

# ---------------------------------------------------------------- deltas
def patch_from(a_path, b_path, out):
    if not os.path.exists(out):
        t = time.time()
        hist.zstd_cli(["-19", f"--patch-from={a_path}", b_path, "-o", out])
        json.dump({"seconds": round(time.time() - t, 1)}, open(out + ".time.json", "w"))
    return os.path.getsize(out), json.load(open(out + ".time.json"))["seconds"]


def entry_patch(a_bytes, b_bytes, key):
    out = os.path.join(W, "entries", key + ".pf.zst")
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        pa, pb = out + ".a", out + ".b"
        open(pa, "wb").write(a_bytes)
        open(pb, "wb").write(b_bytes)
        hist.zstd_cli(["-19", f"--patch-from={pa}", pb, "-o", out])
        os.remove(pa)
        os.remove(pb)
    return os.path.getsize(out)


def window_log(path):
    """Window size the CLI wrote into a frame header (zstd -lv)."""
    o = subprocess.run(["zstd", "-lv", path], capture_output=True, text=True).stdout
    for line in o.splitlines():
        if "Window Size" in line:
            return line.split(":", 1)[1].strip()
    return None


# ---------------------------------------------------------------- pairs
def pair_class(i, j):
    d = j - i
    labels = [f"N-{d}"]
    if i == 0 and j == len(R) - 1:
        labels.append("oldest")
    return labels


def entry_owner(files):
    starts = [f["offset"] for f in files]

    def owner(ofs):
        k = bisect.bisect_right(starts, ofs) - 1
        if k >= 0 and ofs < files[k]["offset"] + max(files[k]["size"], 1):
            return files[k]["path"]
        return None  # a gap segment

    return owner


NOISE = {}
npath = os.path.join(hist.OUT, f"noise-{fam}.json")
if os.path.exists(npath):
    for row in json.load(open(npath)):
        NOISE[row["from"], row["to"]] = row["perPath"]

# PAIRS=all (default) or PAIRS=adjacent (N-1 pairs and oldest->latest only, for slow families)
ALL = [(i, j) for i in range(len(R)) for j in range(i + 1, len(R))]
SEL = ALL if os.environ.get("PAIRS", "all") == "all" else [(i, j) for i, j in ALL if j == i + 1 or (i, j) == (0, len(R) - 1)]
pairs = []
for i, j in SEL:
    if True:
        ra, rb = R[i], R[j]
        da, db = DATA[ra["dir"]], DATA[rb["dir"]]
        row = {"from": ra["version"], "to": rb["version"], "classes": pair_class(i, j), "payload": len(db),
               "full": REL[rb["dir"]]["full"], "chunk": {}, "delta": {}, "file": {}, "plans": []}
        # chunk rows
        for ch in hist.CHUNKERS:
            seed = {h for _, _, h in REC[ch, ra["dir"]]}
            cr = {"layouts": {}}
            for s in ("fresh", "shared"):
                for t in hist.BUNDLE_TARGETS:
                    loc, nb = LAYOUT[ch, s, t, rb["dir"]]
                    recs = hist.records(REC[ch, rb["dir"]], loc)
                    m = hist.missing_stats(recs, seed)
                    ib = hist.index_bytes(len(recs), nb)
                    cr["layouts"][f"{s}-{t // hist.MIB}"] = {"indexBytes": ib, "runs": m["runs"],
                                                             "requests": 1 + m["runs"],
                                                             "bundlesTouched": m["bundlesTouched"],
                                                             "bytes": ib + m["missingStored"]}
            cr.update({k: m[k] for k in ("missingChunks", "missingRaw", "missingStored")})
            # attribute missing stored bytes to entry classes (consecutive pairs, file-aware only)
            per = NOISE.get((ra["version"], rb["version"]))
            if per is not None and hist.CHUNKERS[ch][1]:
                owner, att, seen = entry_owner(FILES[rb["dir"]]), {}, set()
                for o, sz, h in REC[ch, rb["dir"]]:
                    if h in seed or h in seen:
                        continue
                    seen.add(h)
                    p = owner(o)
                    c = "gap" if p is None else per.get(p, "unchanged-entry")
                    att[c] = att.get(c, 0) + C[h]
                cr["missingStoredByClass"] = att
            row["chunk"][ch] = cr
        # deltas
        whole_out = os.path.join(W, f"{ra['dir']}-{rb['dir']}.pf.zst")
        wb, wsecs = patch_from(hist.payload_path(ra, fam), hist.payload_path(rb, fam), whole_out)
        row["delta"]["whole"] = {"bytes": wb, "requests": 1, "memBytes": len(da) + len(db), "seconds": wsecs,
                                 "window": window_log(whole_out)}
        fa = {f["path"]: f for f in FILES[ra["dir"]]}
        have = {f["sha256"] for f in FILES[ra["dir"]]}
        arts, blobs, max_entry, n_changed, n_added = [], {}, 0, 0, 0
        for f in FILES[rb["dir"]]:
            if f["sha256"] in have or f["sha256"] in blobs:
                continue
            nb = files_blob(f["sha256"], db, f)
            blobs[f["sha256"]] = nb
            o = fa.get(f["path"])
            if o is None:
                arts.append(nb)
                n_added += 1
            else:
                d = entry_patch(da[o["offset"]:o["offset"] + o["size"]], db[f["offset"]:f["offset"] + f["size"]],
                                f"{o['sha256'][:24]}-{f['sha256'][:24]}")
                arts.append(min(d, nb))
                n_changed += 1
                max_entry = max(max_entry, f["size"], o["size"])
        fi, gz = REL[rb["dir"]]["filesIndexBytes"], REL[rb["dir"]]["gapsZstd"]
        row["delta"]["perEntry"] = {"bytes": fi + gz + sum(arts), "requests": 2 + len(arts), "memBytes": 2 * max_entry,
                                    "changedEntries": n_changed, "addedEntries": n_added}
        row["file"] = {"bytes": fi + gz + sum(blobs.values()), "requests": 2 + len(blobs),
                       "missingEntries": len(blobs)}
        # planner, per chunker menu (shared 4 MiB bundles: the recommended layout)
        sa, sb = hist.sha(da), hist.sha(db)
        for ch in hist.CHUNKERS:
            loc, nb = LAYOUT[ch, "shared", 4 * hist.MIB, rb["dir"]]
            recs = hist.records(REC[ch, rb["dir"]], loc)
            for w in (16384, 65536):
                for mem in (256 * hist.MIB, 64 * hist.MIB):
                    inp = {"target": {"release": rb["version"], "payload": {"sha256": sb, "size": len(db)},
                                      "full": {"bytes": row["full"]}, "platform": None,
                                      "chunks": {"indexBytes": hist.index_bytes(len(recs), nb), "records": recs},
                                      "files": {"indexBytes": fi, "gapsBytes": gz,
                                                "files": [{"sha256": f["sha256"], "blobBytes": C.get(f["sha256"], 0)}
                                                          for f in FILES[rb["dir"]]]},
                                      "deltas": [{"id": "whole", "method": "zstd-patch-from", "from": sa,
                                                  "memBytes": row["delta"]["whole"]["memBytes"],
                                                  "artifacts": [{"sha256": "w", "bytes": wb}]},
                                                 {"id": "per-entry", "method": "zstd-patch-from", "from": sa,
                                                  "memBytes": row["delta"]["perEntry"]["memBytes"],
                                                  "artifacts": [{"sha256": "i", "bytes": fi}, {"sha256": "g", "bytes": gz}]
                                                  + [{"sha256": f"a{k}", "bytes": n} for k, n in enumerate(arts)]}]},
                           "installed": [{"release": ra["version"], "payloadSha256": sa,
                                          "chunks": {"ids": sorted({h for _, _, h in REC[ch, ra["dir"]]})},
                                          "files": sorted(have)}],
                           "caps": {"strategies": ["delta", "chunk", "file", "full"], "patchMethods": ["zstd-patch-from"],
                                    "transports": ["pkey-cdn"], "memBudget": mem, "freeDisk": 2**31, "requestWeight": w}}
                    p = hist.plan(inp)
                    nod = dict(inp, caps=dict(inp["caps"], strategies=["chunk", "file", "full"]))
                    q = hist.plan(nod)
                    row["plans"].append({"chunker": ch, "requestWeight": w, "memBudget": mem,
                                         "choice": p["strategy"] + (":" + p["delta"] if "delta" in p else ""),
                                         "bytes": p["bytes"], "requests": p["requests"],
                                         "fallbacks": [(c["strategy"] + (":" + c["delta"] if "delta" in c else ""),
                                                        c["bytes"], c["requests"]) for c in p["fallbacks"]],
                                         "noDeltaChoice": q["strategy"], "noDeltaBytes": q["bytes"],
                                         "noDeltaRequests": q["requests"]})
        pairs.append(row)
        hist.save_clens()
        print(f"{ra['version']} -> {rb['version']} done at {time.time() - t0:.0f} s", file=sys.stderr)

res = {"family": fam, "chunkers": {k: {"avg": a, "min": a // 4, "max": a * 4, "fileAware": fa}
                                   for k, (a, fa) in hist.CHUNKERS.items()},
       "bundleTargets": hist.BUNDLE_TARGETS, "zstd": subprocess.run(["zstd", "-V"], capture_output=True, text=True).stdout.strip(),
       "releases": REL, "pairs": pairs}
json.dump(res, open(os.path.join(hist.OUT, f"matrix-{fam}.json"), "w"), indent=1)
print(f"total {time.time() - t0:.0f} s", file=sys.stderr)
