#!/usr/bin/env python3
"""Summarise out/c/runs.jsonl (Playwright) and the ios_* rows of out/c/reports.jsonl."""
import json, sys, collections
rows = [json.loads(l) for l in open("out/c/runs.jsonl")]
print(f"{'browser':8} {'mode':4} {'n':>1} {'run':20} {'ready_ms':>8} {'fetch_ms':>8} {'mount_ms(sum)':>13} {'atBoot':>6} {'GETs':>4} {'rss_MB':>6} {'v8+ab_MB':>8} verify")
for r in rows:
    rep = r.get("rep") or {}
    ms = sum(m["ms"] for m in rep.get("mounts", []))
    h = r.get("cdp_heap") or {}
    heap = (h.get("usedSize", 0) + h.get("backingStorageSize", 0)) / 1e6 if h and "usedSize" in h else -1
    ver = ",".join(sorted({v.get("sha_ok", "-") for v in rep.get("verify", [])}))
    print(f"{r['browser']:8} {r['mode']:4} {r['n']:>1} {r['run']:20} {rep.get('t_ready_js_ms', -1):>8.0f} {rep.get('fetch_total_ms', -1):>8.0f} {ms:>13.1f} {len(rep.get('installed_at_boot', {})):>6} {r['pack_gets_from_server']:>4} {r['rss_mb']:>6} {heap:>8.0f} {ver}")
try:
    ios = [json.loads(l) for l in open("out/c/reports.jsonl") if '"ios_' in l]
except FileNotFoundError:
    ios = []
if ios:
    print("\niOS Simulator Safari (reports.jsonl)")
    for rep in ios:
        q = rep.get("q", {})
        ms = sum(m["ms"] for m in rep.get("mounts", []))
        ver = ",".join(sorted({v.get("sha_ok", "-") for v in rep.get("verify", [])}))
        print(f"{'ios-sim':8} {q.get('mode',''):4} {q.get('n',''):>1} {q.get('run',''):20} {rep.get('t_ready_js_ms', -1):>8.0f} {rep.get('fetch_total_ms', -1):>8.0f} {ms:>13.1f} {len(rep.get('installed_at_boot', {})):>6}    -      -        - {ver}")

# Per pack count: engine-ready time, fetch time and ready + fetch (time until every pack is in the
# filesystem; the probe starts fetching after _ready), as "1 / 3 / 6 packs". Every cell is one load
# (n = 1). iOS rows are taken from the batch named by IOS_BATCH (the run_ios.sh batch= tag; default:
# the newest batch present), and atBoot lists how many files were already in user:// at boot.
import os
def cell(recs, key):
    out = []
    for n in (1, 3, 6):
        r = recs.get(n)
        if r is None:
            out.append("-")
            continue
        rd, fe = r.get("t_ready_js_ms", -1), r.get("fetch_total_ms", -1)
        v = {"ready": rd, "fetch": fe, "total": rd + fe, "atBoot": len(r.get("installed_at_boot", {}))}[key]
        out.append(f"{v:,.0f}")
    return " / ".join(out)
grid = {}
for r in rows:
    grid.setdefault((r["browser"], r["mode"], r["run"]), {})[r["n"]] = r.get("rep") or {}
batches = [rep.get("q", {}).get("batch") for rep in ios if rep.get("q", {}).get("batch")]
want = os.environ.get("IOS_BATCH") or (batches[-1] if batches else None)
if want:
    for rep in ios:
        q = rep.get("q", {})
        if q.get("batch") == want:
            grid.setdefault(("ios-sim", q["mode"], q["run"].removeprefix("ios_")), {})[int(q["n"])] = rep
print(f"\nPer pack count (1 / 3 / 6), n = 1 per cell; iOS batch: {want}")
print(f"{'browser':8} {'mode':5} {'run':8} {'ready_ms':>22} {'fetch_ms':>24} {'ready+fetch_ms':>24} {'atBoot':>10}")
for (b, m, run), recs in sorted(grid.items(), key=lambda kv: (kv[0][0], ["idb", "mem", "cache"].index(kv[0][1]), kv[0][2])):
    if run not in ("first", "reload", "restart"):
        continue
    print(f"{b:8} {m:5} {run:8} {cell(recs,'ready'):>22} {cell(recs,'fetch'):>24} {cell(recs,'total'):>24} {cell(recs,'atBoot'):>10}")
