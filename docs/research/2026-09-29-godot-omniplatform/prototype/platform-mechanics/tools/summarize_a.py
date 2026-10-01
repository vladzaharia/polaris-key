#!/usr/bin/env python3
"""Summarise out/a/results.jsonl: per case and cold/warm, median/min of the mount call and frame hitch."""
import json, statistics, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else "out/a/results.jsonl")]
g = collections.defaultdict(list)
for r in rows:
    if "mounts" not in r:
        continue
    g[(r["case"], r["temp"])].append(r)
print(f"{'case':34} {'temp':5} {'n':>2} {'call_ms med/min/max':>22} {'hitch med/min':>14} {'>33ms':>6} {'ready_ms med':>12} {'verify'}")
for (c, t), rs in sorted(g.items()):
    calls = []
    for r in rs:
        ms = [m.get("call_ms", m.get("thread_ms", 0)) for m in r["mounts"]]
        calls.append(ms if len(ms) > 1 else ms[0])
    if isinstance(calls[0], list):
        per = list(zip(*calls))
        cs = " | ".join(f"{statistics.median(p):.1f}" for p in per)
    else:
        cs = f"{statistics.median(calls):.1f}/{min(calls):.1f}/{max(calls):.1f}"
    def hitch(r):
        # frames[s0-1] is the frame that calls the first mount, so deltas[0] (= frames[s0] -
        # frames[s0-1]) holds it and deltas[0..k-1] hold k main-thread mounts, one per frame; for a
        # thread, deltas[0..last-s0] are the frames drawn until it finished. Verify comes after.
        d = r["frame_deltas_after_start_ms"]
        s0 = r["mount_started_frame"]
        if any(m.get("thread") for m in r["mounts"]):
            k = max(m["frame"] for m in r["mounts"]) - s0
        else:
            k = len(r["mounts"])
        return max(d[0:max(1, k)]) if d else -1
    mf = statistics.median(hitch(r) for r in rs)
    mfmin = min(hitch(r) for r in rs)
    o33 = statistics.median(r["frames_over_33ms"] for r in rs)
    rd = statistics.median(r["ticks_at_ready_ms"] for r in rs)
    ver = ",".join(sorted({v.get("sha_ok", "-") for r in rs for v in r.get("verify", [])}))
    print(f"{c:34} {t:5} {len(rs):>2} {cs:>22} {f"{mf:.1f}/{mfmin:.1f}":>14} {o33:>6} {rd:>12.0f} {ver}")
