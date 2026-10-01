#!/usr/bin/env python3
"""Per release: version, engine, commit, asset lock, payload size and entry count for each family.
Checks every downloaded asset against the release's SHA256SUMS.txt first.
usage: python3 inventory.py [family ...]   (default: desktop web android) -> data/out/inventory.json"""
import hashlib, json, os, sys
import hist
import pck

fams = sys.argv[1:] or ["desktop", "web", "android"]
rows = []
for r in hist.releases():
    d = os.path.join(hist.REL, r["dir"])
    sums = dict(reversed(line.split()) for line in open(os.path.join(d, "SHA256SUMS.txt")) if line.strip())
    for f in os.listdir(d):
        if f in sums:
            h = hashlib.sha256(open(os.path.join(d, f), "rb").read()).hexdigest()
            assert h == sums[f], f"checksum mismatch: {f}"
    row = {"version": r["version"], "commit": r["commit"][:10], "godot": r["godot"], "assetLock": r["assetLock"]}
    for fam in fams:
        p = hist.payload_path(r, fam)
        files = hist.files_of(r, fam)
        row[fam] = {"bytes": os.path.getsize(p), "entries": len(files)}
        if fam != "android":
            i = pck.read_pck(p)
            row[fam].update(pckVersion=i["version"], engine=".".join(map(str, i["engine"])))
    rows.append(row)
    print(json.dumps(row))
os.makedirs(hist.OUT, exist_ok=True)
json.dump(rows, open(os.path.join(hist.OUT, "inventory.json"), "w"), indent=1)
