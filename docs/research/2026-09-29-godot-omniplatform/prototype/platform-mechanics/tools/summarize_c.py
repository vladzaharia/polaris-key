#!/usr/bin/env python3
"""Summarise out/c/runs.jsonl (Playwright) and the ios_* rows of out/c/reports.jsonl."""
import json, sys
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
