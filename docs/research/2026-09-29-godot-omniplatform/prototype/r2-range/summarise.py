#!/usr/bin/env python3
"""S-02: summarise probe.mjs JSONL output into the note's tables.

usage: summarise.py out/<run>.jsonl [--timing]

Behaviour table: per path x case, the distinct (status, decision, bodyOk, cache) outcomes across all
sizes and repetitions, so a flaky or size-dependent case shows up as more than one outcome.
--timing: per path x size, median TTFB of single-cold / single-warm and median full-GET throughput.
"""
import json, statistics, sys
from collections import defaultdict, OrderedDict

rows = [json.loads(l) for l in open(sys.argv[1])]
timing = "--timing" in sys.argv

paths = list(OrderedDict.fromkeys(r["path"] for r in rows))
cases = list(OrderedDict.fromkeys(r["case"] for r in rows))

if not timing:
    out = defaultdict(set)
    for r in rows:
        dec = r.get("decision") or ""
        cache = r.get("cfCacheStatus") or ""
        et = r.get("etag") or ""
        etk = "sha" if len(et.strip('"').removeprefix("W/").strip('"')) == 64 else ("md5" if et else "")
        if et.startswith("W/"):
            etk = "W/" + etk
        out[(r["path"], r["case"])].add(
            f'{r["status"]} {r["bodyOk"]}' + (f" [{dec}]" if dec else "") + (f" {cache}" if cache else "") + (f" etag={etk}" if etk else "")
        )
    print("| case | " + " | ".join(paths) + " |")
    print("| --- | " + " | ".join("---" for _ in paths) + " |")
    for c in cases:
        cells = ["<br>".join(sorted(out.get((p, c), {"—"}))) for p in paths]
        print(f"| {c} | " + " | ".join(cells) + " |")
else:
    t = defaultdict(list)
    for r in rows:
        t[(r["path"], r["size"], r["case"])].append(r)
    sizes = sorted({r["size"] for r in rows})
    print("| path | size | single-cold TTFB ms (med) | single-warm TTFB ms (med) | full GET MB/s (med) | full GET total ms (med) | n |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for p in paths:
        for s in sizes:
            sc = [float(r["ttfbMs"]) for r in t[(p, s, "single-cold")]]
            sw = [float(r["ttfbMs"]) for r in t[(p, s, "single-warm")]]
            fu = [r for r in t[(p, s, "full")] + t[(p, s, "full-again")] + t[(p, s, "full-cold")] + t[(p, s, "full-warm")]]
            if not (sc or fu):
                continue
            mb = [float(r["mbps"]) / 8 for r in fu if r["mbps"]]
            tot = [float(r["totalMs"]) for r in fu]
            med = lambda v: f"{statistics.median(v):.1f}" if v else "—"
            print(f"| {p} | {s // 1048576} MiB | {med(sc)} | {med(sw)} | {med(mb)} | {med(tot)} | {max(len(sc), len(fu))} |")
