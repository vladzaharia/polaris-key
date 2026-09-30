#!/usr/bin/env python3
"""Print the note's Markdown tables from data/out/{inventory,noise-*,matrix-*,packs-*}.json.
Aggregate numbers only: no file names. usage: python3 report.py [family ...] (default desktop)."""
import json, os, statistics, sys
import hist

fams = sys.argv[1:] or ["desktop"]
O = hist.OUT
n = lambda x: f"{round(x):,}"  # noqa: E731


def rng(vals):
    if len(vals) == 1:
        return n(vals[0])
    return f"{n(statistics.mean(vals))} ({n(min(vals))}–{n(max(vals))})"


def mean(vals):
    m = statistics.mean(vals)
    return f"{m:,.1f}".rstrip("0").rstrip(".") if len(vals) > 1 else n(m)


for fam in fams:
    M = json.load(open(os.path.join(O, f"matrix-{fam}.json")))
    P = M["pairs"]
    print(f"\n## {fam}\n")
    print("### Releases\n")
    print("| Release | Payload B | full zstd -19 B | Σ stored unique chunks, fa64 B | fa64 records | fa64 index B (shared 4 MiB) |")
    print("| --- | ---: | ---: | ---: | ---: | ---: |")
    for d, r in M["releases"].items():
        c = r["chunks"]["fa64"]
        print(f"| {r['version']} | {n(r['payload'])} | {n(r['full'])} | {n(c['storedUnique'])} | {n(c['records'])} | {n(c['indexBytes']['shared-4'])} |")
    print("\n### First install: full blob, then record the seed index\n")
    last = list(M["releases"].values())[-1]
    print("| Chunker | records | unique | index B (shared 4 MiB) | index as zstd -19 B | full + index B | Σ stored unique chunks B (a chunk-store 'full') |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for ch, c in last["chunks"].items():
        print(f"| {ch} | {n(c['records'])} | {n(c['unique'])} | {n(c['indexBytes']['shared-4'])} | {n(c.get('indexZstdShared4', 0))} | {n(last['full'] + c['indexBytes']['shared-4'])} | {n(c['storedUnique'])} |")
    classes = ["N-1", "N-2", "N-3", "oldest"]
    for cl in classes:
        ps = [p for p in P if cl in p["classes"]]
        if not ps:
            continue
        label = ", ".join(f"{p['from'].split('-')[-1]}→{p['to'].split('-')[-1]}" for p in ps)
        print(f"\n### {cl} ({len(ps)} pair{'s' if len(ps) > 1 else ''}: {label}); mean (min–max)\n")
        print("| Strategy | bytes to download | index B | requests shared 4/8/16 MiB | requests fresh 4 MiB | bundles touched shared 4/8/16 MiB | bundles touched fresh 4/8/16 MiB | missing chunks | missing stored B | missing raw B |")
        print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
        for ch in M["chunkers"]:
            rows = [p["chunk"][ch] for p in ps]
            L = lambda k, f: [r["layouts"][k][f] for r in rows]  # noqa: E731
            bt = lambda s: " / ".join(mean(L(f"{s}-{t}", "bundlesTouched")) for t in (4, 8, 16))  # noqa: E731
            rq = " / ".join(mean(L(f"shared-{t}", "requests")) for t in (4, 8, 16))
            print(f"| chunk {ch} | {rng(L('shared-4', 'bytes'))} | {mean(L('shared-4', 'indexBytes'))} | "
                  f"{rq} | {mean(L('fresh-4', 'requests'))} | {bt('shared')} | {bt('fresh')} | "
                  f"{mean([r['missingChunks'] for r in rows])} | {rng([r['missingStored'] for r in rows])} | {rng([r['missingRaw'] for r in rows])} |")
        for k, lab in (("whole", "delta, whole-file --patch-from"), ("perEntry", "delta, per-entry --patch-from")):
            rows = [p["delta"][k] for p in ps]
            print(f"| {lab} | {rng([r['bytes'] for r in rows])} | — | {mean([r['requests'] for r in rows])} | — | — | — | — | — | — |")
        zi = lambda p: M["releases"][next(d for d, r in M["releases"].items() if r["version"] == p["to"])]  # noqa: E731
        adj = lambda p, b: b - zi(p)["filesIndexBytes"] + zi(p)["filesIndexZstd"]  # noqa: E731
        print(f"| delta, per-entry, files index as zstd | {rng([adj(p, p['delta']['perEntry']['bytes']) for p in ps])} | — | {mean([p['delta']['perEntry']['requests'] for p in ps])} | — | — | — | — | — | — |")
        rows = [p["file"] for p in ps]
        print(f"| file, files index as zstd | {rng([adj(p, p['file']['bytes']) for p in ps])} | — | {mean([r['requests'] for r in rows])} | — | — | — | — | — | — |")
        print(f"| file (missing entries, zstd -19) | {rng([r['bytes'] for r in rows])} | — | {mean([r['requests'] for r in rows])} | — | — | — | — | — | — |")
        print(f"| full (zstd -19) | {rng([p['full'] for p in ps])} | — | 1 | — | — | — | — | — | — |")
    print("\n### Planner choice (menu: both deltas, chunk with shared 4 MiB bundles, file, full)\n")
    print("| Class | chunker | w = 16 KiB, mem 256 MiB | w = 64 KiB, mem 256 MiB | w = 16 KiB, mem 64 MiB | w = 64 KiB, mem 64 MiB | no-delta SDK, 16 KiB | no-delta SDK, 64 KiB |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for cl in classes:
        ps = [p for p in P if cl in p["classes"]]
        for ch in M["chunkers"]:
            def pick(w, mem, nod=False):
                out = {}
                for p in ps:
                    x = next(q for q in p["plans"] if q["chunker"] == ch and q["requestWeight"] == w and q["memBudget"] == mem)
                    k = x["noDeltaChoice"] if nod else x["choice"]
                    out[k] = out.get(k, 0) + 1
                return ", ".join(f"{k} ×{v}" if len(ps) > 1 else k for k, v in out.items())
            M256, M64 = 256 * hist.MIB, 64 * hist.MIB
            print(f"| {cl} | {ch} | {pick(16384, M256)} | {pick(65536, M256)} | {pick(16384, M64)} | {pick(65536, M64)} | "
                  f"{pick(16384, M256, True)} | {pick(65536, M256, True)} |")
    print("\n### Missing stored bytes by entry class, consecutive pairs (file-aware chunkers)\n")
    cls_all = sorted({k for p in P for ch in M["chunkers"] for k in p["chunk"][ch].get("missingStoredByClass", {})})
    print("| Pair | chunker | " + " | ".join(cls_all) + " | noise share |")
    print("| --- | --- | " + " | ".join("---:" for _ in cls_all) + " | ---: |")
    for p in P:
        if "N-1" not in p["classes"]:
            continue
        for ch in ("fa16", "fa64"):
            a = p["chunk"][ch].get("missingStoredByClass")
            if not a:
                continue
            noise = sum(v for k, v in a.items() if k in ("noise", "global-reorder", "global-grow+reorder"))
            tot = sum(a.values())
            print(f"| {p['from'].split('-')[-1]}→{p['to'].split('-')[-1]} | {ch} | " + " | ".join(n(a.get(k, 0)) for k in cls_all)
                  + f" | {100 * noise / tot:.0f}% |")

npath = os.path.join(O, "noise-desktop.json")
if os.path.exists(npath):
    print("\n## Change classification (desktop)\n")
    print("| Pair | commits | source files changed | asset units changed | entries | offsets moved | content (n, B) | stamp (n, B) | global caches (n, B, kind) | other noise (n, B) |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |")
    for r in json.load(open(npath)):
        c = r["classes"]
        cont = [v for k, v in c.items() if k.startswith("content")]
        g = {k: v for k, v in c.items() if k.startswith("global")}
        gl = "; ".join(f"{v['entries']}, {n(v['bytes'])}, {k.replace('-changed', '')}" for k, v in g.items()) or "—"
        st, no = c.get("stamp-changed", {"entries": 0, "bytes": 0}), c.get("noise-changed", {"entries": 0, "bytes": 0})
        print(f"| {r['from'].split('-')[-1]}→{r['to'].split('-')[-1]} | {r['commits']} | {r['sourceFilesChanged']} | {len(r['assetUnitsChanged'])} | {r['entries']} | {r['offsetMoved']} | "
              f"{sum(v['entries'] for v in cont)}, {n(sum(v['bytes'] for v in cont))} | {st['entries']}, {n(st['bytes'])} | {gl} | {no['entries']}, {n(no['bytes'])} |")

ppath = os.path.join(O, "packs-desktop.json")
if os.path.exists(ppath):
    rows = json.load(open(ppath))
    print("\n## Per-pack estimate (desktop PCK sliced by the proposed packs)\n")
    print("| Pack | slice B (latest) | full B | pairs unchanged (of 5) | N-1 mean: delta B | N-1 mean: chunk fa64m B (req) | N-1 mean: chunk fa32m B (req) | oldest: delta B | oldest: chunk fa64m B (req) | planner fa64m @16K / @64K (N-1; no-delta) | planner fa64m oldest @16K / @64K (no-delta) |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |")
    for pk in dict.fromkeys(r["pack"] for r in rows):
        rs = [r for r in rows if r["pack"] == pk]
        n1 = [r for r in rs if r["class"] == "N-1"]
        old = [r for r in rs if r["class"] != "N-1"][0]
        ch = lambda rr, c, k: statistics.mean(r["chunk"][c][k] for r in rr)  # noqa: E731
        from collections import Counter
        pl = lambda w, key: ", ".join(f"{k}×{v}" for k, v in Counter(r["plan"][f"fa64m@{w}"][key] for r in n1).items())  # noqa: E731
        po = lambda w: f"{old['plan'][f'fa64m@{w}']['choice']} ({old['plan'][f'fa64m@{w}']['noDelta']})"  # noqa: E731
        print(f"| {pk} | {n(n1[-1]['size'])} | {n(n1[-1]['full'])} | {sum(r['unchanged'] for r in rs)} | {n(statistics.mean(r['wholeDelta'] for r in n1))} | "
              f"{n(ch(n1, 'fa64m', 'bytes'))} ({ch(n1, 'fa64m', 'requests'):.1f}) | {n(ch(n1, 'fa32m', 'bytes'))} ({ch(n1, 'fa32m', 'requests'):.1f}) | "
              f"{n(old['wholeDelta'])} | {n(old['chunk']['fa64m']['bytes'])} ({old['chunk']['fa64m']['requests']}) | "
              f"{pl(16384, 'choice')} / {pl(65536, 'choice')}; {pl(16384, 'noDelta')} / {pl(65536, 'noDelta')} | {po(16384)} / {po(65536)} |")
