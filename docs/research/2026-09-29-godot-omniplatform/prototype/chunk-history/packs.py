#!/usr/bin/env python3
"""Per-pack ESTIMATE: slice each desktop PCK into the packs Diceroll's content-streaming design
proposes (notes/A4 §2.3; base, ui, core3d, audio, foes, nature, extra) and cost each slice as if it
were its own deliverable. A slice is the concatenation of its entries in PCK order (no PCK header or
directory, so every slice is a few KB smaller than a real per-pack PCK). File-aware chunks never
cross entries, so a slice's chunks are exactly the release recipe's chunks inside its entries;
bundles are laid out per slice (one deliverable = one bundle history).

Per slice and pair (all ten ordered pairs, N-1 to oldest->latest): full (zstd -19, CLI), whole-slice --patch-from (CLI),
chunk sync per file-aware chunker (shared 4 MiB bundles), and the planner's choice at 16/64 KiB.
usage: python3 packs.py   (after matrix.py desktop) -> data/out/packs-desktop.json"""
import bisect, json, os, re, sys, time
import hist

fam = "desktop"
R = hist.releases()
W = os.path.join(hist.OUT, "work", "packs")
os.makedirs(W, exist_ok=True)
RES = re.compile(rb'"res://(\.godot/(?:imported|exported)/[^"]+)"')
UNITS = {  # Diceroll docs/design/2026-09-29-content-streaming.md §5.1 (units = asset folders)
    "ui": ["fonts", "sfx/interface-sounds", "sfx/casino-audio", "sfx/digital-audio", "sfx/music-jingles"],
    "core3d": ["boardgame", "animations", "adventurers", "platformer", "potions", "blocks", "halloween", "tools",
               "weapons", "skeletons", "resource", "dungeon"],
    "audio": ["music", "sfx/impact-sounds", "sfx/rpg-audio"],
    "foes": ["foes", "skeleton_props"],
    "nature": ["forest"],
    "extra": ["dungeon_x", "resources", "resources_x", "tools_x", "tools_extra", "weapons_x", "adventurers_x", "mystery"],
}
UNIT2PACK = {u: p for p, us in UNITS.items() for u in us}
PACKS = ["base"] + list(UNITS)


def pack_of_source(src):
    parts = src.split("/")
    if parts[0] != "assets":
        return "base"
    if parts[1] == "kaykit" and len(parts) > 2:
        return UNIT2PACK.get(parts[2], "extra")
    if parts[1] == "audio" and len(parts) > 3:
        return UNIT2PACK.get(parts[2] if parts[2] == "music" else f"sfx/{parts[3]}", "audio")
    if parts[1] == "fonts":
        return "ui"
    if parts[1] == "icon":
        return "base"
    return "ui"  # other rendered assets (the design's "rendered-icons")


def assign(r, data):
    files = hist.files_of(r, fam)
    gen2src = {}
    for f in files:
        p = f["path"]
        if p.endswith(".import") or p.endswith(".remap"):
            src = p.rsplit(".", 1)[0]
            for g in RES.findall(data[f["offset"]:f["offset"] + f["size"]]):
                gen2src[g.decode()] = src
    out = {}
    for f in files:
        p = f["path"]
        src = gen2src.get(p, p.rsplit(".", 1)[0] if p.endswith(".import") else p)
        out[p] = pack_of_source(src)
    return files, out


t0 = time.time()
DATA = {r["dir"]: open(hist.payload_path(r, fam), "rb").read() for r in R}
SL = {}  # (pack, dir) -> {"recipe": {chunker: [(ofs,len,h)]}, "path": slice file}
for r in R:
    files, pk = assign(r, DATA[r["dir"]])
    by = {p: [] for p in PACKS}
    for f in files:
        by[pk[f["path"]]].append(f)
    for p in PACKS:
        path = os.path.join(W, f"{p}-{r['dir']}.bin")
        if not os.path.exists(path):
            with open(path, "wb") as out:
                for f in by[p]:
                    out.write(DATA[r["dir"]][f["offset"]:f["offset"] + f["size"]])
        spans = [(f["offset"], f["offset"] + f["size"]) for f in by[p]]
        starts = [a for a, _ in spans]
        recs = {}
        for ch, (_, fa) in hist.CHUNKERS.items():
            if not fa:
                continue
            sel, full_rec = [], hist.recipe(r, fam, ch)
            hist.ensure_clens(DATA[r["dir"]], full_rec)
            for o, s, h in full_rec:
                k = bisect.bisect_right(starts, o) - 1
                if k >= 0 and o < spans[k][1]:
                    sel.append((o, s, h))
            recs[ch] = sel
        SL[p, r["dir"]] = {"recipe": recs, "path": path, "size": os.path.getsize(path), "entries": len(by[p])}
print(f"sliced in {time.time() - t0:.0f} s", file=sys.stderr)


def zfile(src, out, extra=()):
    if not os.path.exists(out):
        hist.zstd_cli(["-19", *extra, src, "-o", out])
    return os.path.getsize(out)


C = hist.clens()
rows = []
last = len(R) - 1
pairs = [(i, j) for i in range(last) for j in range(i + 1, last + 1)]  # all ten pairs
for p in PACKS:
    lay = {ch: hist.layouts_shared([SL[p, r["dir"]]["recipe"][ch] for r in R], 4 * hist.MIB)
           for ch in SL[p, R[0]["dir"]]["recipe"]}
    for i, j in pairs:
        ra, rb = R[i], R[j]
        a, b = SL[p, ra["dir"]], SL[p, rb["dir"]]
        full = zfile(b["path"], b["path"] + ".zst")
        same = open(a["path"], "rb").read() == open(b["path"], "rb").read()
        delta = 0 if same else zfile(b["path"], os.path.join(W, f"{p}-{ra['dir']}-{rb['dir']}.pf.zst"),
                                     (f"--patch-from={a['path']}",))
        row = {"pack": p, "from": ra["version"], "to": rb["version"], "class": f"N-{j - i}", "size": b["size"],
               "entries": b["entries"], "unchanged": same, "full": full, "wholeDelta": delta, "chunk": {}, "plan": {}}
        for ch, L in lay.items():
            loc, nb = L[j]
            recs = hist.records(b["recipe"][ch], loc)
            seed = {h for _, _, h in a["recipe"][ch]}
            m = hist.missing_stats(recs, seed)
            ib = hist.index_bytes(len(recs), nb)
            row["chunk"][ch] = {"bytes": ib + m["missingStored"], "indexBytes": ib, "requests": 1 + m["runs"],
                                "bundlesTouched": m["bundlesTouched"]}
            for w in (16384, 65536):
                inp = {"target": {"release": rb["version"], "payload": {"sha256": "t", "size": b["size"]},
                                  "full": {"bytes": full}, "platform": None,
                                  "chunks": {"indexBytes": ib, "records": recs}, "files": None,
                                  "deltas": [] if same else [{"id": "whole", "method": "zstd-patch-from", "from": "s",
                                                              "memBytes": a["size"] + b["size"],
                                                              "artifacts": [{"sha256": "d", "bytes": delta}]}]},
                       "installed": [{"release": ra["version"], "payloadSha256": "t" if same else "s",
                                      "chunks": {"ids": sorted(seed)}, "files": None}],
                       "caps": {"strategies": ["delta", "chunk", "full"], "patchMethods": ["zstd-patch-from"],
                                "transports": ["pkey-cdn"], "memBudget": 256 * hist.MIB, "freeDisk": 2**31,
                                "requestWeight": w}}
                pl = hist.plan(inp)
                nd = hist.plan(dict(inp, caps=dict(inp["caps"], strategies=["chunk", "full"])))
                row["plan"][f"{ch}@{w}"] = {"choice": pl["strategy"], "bytes": pl["bytes"],
                                            "noDelta": nd["strategy"], "noDeltaBytes": nd["bytes"]}
        rows.append(row)
    print(f"{p} done at {time.time() - t0:.0f} s", file=sys.stderr)
json.dump(rows, open(os.path.join(hist.OUT, "packs-desktop.json"), "w"), indent=1)
