#!/usr/bin/env python3
"""Condenses a probe log (pkba_log.jsonl) to one line per event, dropping mid-download progress."""
import json, sys
KEEP = ("ev", "id", "ok", "error", "status", "mount_ok", "mount_ms", "probe", "url_ms", "t_ms", "t_start",
        "t_pack", "dt_ms", "updating", "removed", "local", "version", "downloadSize", "packs", "plan")
last = {}
for line in open(sys.argv[1]):
    e = json.loads(line)
    if e["ev"] == "progress":
        if e.get("fraction", 0) < 1 or last.get(e["id"]) == "done":
            continue
        last[e["id"]] = "done"
    k = {x: e[x] for x in KEEP if x in e}
    if "error" in k: k["error"] = k["error"][:100]
    if "probe" in k: k["probe"] = k["probe"][:40]
    if "packs" in k: k["packs"] = sorted(f"{p['id']}@{int(p['version'])}" for p in k["packs"])
    for x in ("t_ms", "t_start", "t_pack", "dt_ms", "url_ms", "mount_ms", "version", "downloadSize"):
        if x in k: k[x] = round(k[x], 1)
    print(json.dumps(k))
