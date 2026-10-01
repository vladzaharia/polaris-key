#!/usr/bin/env python3
"""Classify what changed between consecutive releases of one payload family (pckdiff.py generalised
to a version list), and how much of it is re-import noise: an entry whose bytes changed although
its source did not change in the release's commit range.

Source mapping: x.gdc -> x.gd; .godot/imported/* and .godot/exported/* -> the source named by the
.import / .remap entry that points at it; anything else -> its own path. The commit range comes
from `git diff --name-only <tagA> <tagB>` in a read-only Diceroll checkout (DICEROLL_REPO, default
~/Repos/diceroll); the asset-unit hashes come from each release's build manifest.

Classes of a changed or added entry:
  content   its source file changed in the commit range (or is new)
  stamp     the per-build version stamp (project.binary's config/version, build_info.json)
  global    the project-wide caches (uid_cache.bin, global_script_class_cache.cfg), split into
            global-reorder (same entries, new order: pure noise), global-grow+reorder (entries
            added and the order of the old ones changed) and global-grow (added, order kept)
  noise     same source, different bytes (source unchanged in the range, asset unit unchanged)
usage: python3 noise.py [family]   (default desktop) -> data/out/noise-<family>.json
Prints aggregates by class and by directory prefix only (no file names)."""
import collections, json, os, re, struct, subprocess, sys
import hist

fam = sys.argv[1] if len(sys.argv) > 1 else "desktop"
REPO = os.environ.get("DICEROLL_REPO") or os.path.expanduser("~/Repos/diceroll")
GLOBAL = re.compile(r"^\.godot/(uid_cache\.bin|global_script_class_cache\.cfg)$")  # order-insensitive caches
STAMP = re.compile(r"^(project\.binary|build_info\.json)$")  # written by Diceroll's tools/ci/stamp_version.py
RES = re.compile(rb'"res://(\.godot/(?:imported|exported)/[^"]+)"')


def git_changed(a, b):
    out = subprocess.run(["git", "-C", REPO, "diff", "--name-only", a, b], capture_output=True, text=True, check=True)
    return set(out.stdout.split())


def commits(a, b):
    out = subprocess.run(["git", "-C", REPO, "rev-list", "--count", f"{a}..{b}"], capture_output=True, text=True, check=True)
    return int(out.stdout)


def source_map(r):
    """generated path -> source path, from the .import/.remap entries of a release."""
    p = hist.payload_path(r, fam)
    data = open(p, "rb").read()
    m = {}
    for f in hist.files_of(r, fam):
        path = f["path"]
        if path.endswith(".import") or path.endswith(".remap"):
            src = path[: -len(".import")] if path.endswith(".import") else path[: -len(".remap")]
            for g in RES.findall(data[f["offset"]:f["offset"] + f["size"]]):
                m[g.decode()] = src
    return m, data


def source_of(path, smap):
    if path.endswith(".gdc"):
        return path[:-1]
    if path.endswith(".remap"):
        return path[: -len(".remap")]
    if path.endswith(".import"):
        return path[: -len(".import")]
    return smap.get(path, path)


def prefix(path):
    parts = path.split("/")
    return "/".join(parts[:2]) if len(parts) > 2 else (parts[0] if len(parts) > 1 else "(root)")


def unit_of(src):
    parts = src.split("/")
    return parts[2] if len(parts) > 3 and parts[0] == "assets" else None


def cache_items(path, b):
    """The entries of an order-insensitive cache, in file order."""
    if path.endswith(".bin"):  # uid_cache.bin: u32 count, then (i64 uid, u32 len, path bytes)*
        (n,), o, out = struct.unpack_from("<I", b, 0), 4, []
        for _ in range(n):
            uid, ln = struct.unpack_from("<qI", b, o)
            out.append((uid, b[o + 12:o + 12 + ln]))
            o += 12 + ln
        assert o == len(b)
        return out
    return re.findall(rb"\{[^{}]*\}", b)  # global_script_class_cache.cfg: one dict per class


def global_class(path, a, b):
    x, y = cache_items(path, a), cache_items(path, b)
    sx, sy = set(x), set(y)
    kept = [e for e in x if e in sy] == [e for e in y if e in sx]
    if sx == sy:
        return "global-reorder"
    return "global-grow" if kept else "global-grow+reorder"


R = hist.releases()
rows = []
for ra, rb in zip(R, R[1:]):
    fa, fb = hist.files_of(ra, fam), hist.files_of(rb, fam)
    ea, eb = {f["path"]: f for f in fa}, {f["path"]: f for f in fb}
    smap_b, data_b = source_map(rb)
    smap_a, data_a = source_map(ra)
    smap = {**smap_a, **smap_b}
    changed_src = git_changed(ra["tag"], rb["tag"])
    units_changed = {u for u in set(ra["assetUnits"]) | set(rb["assetUnits"])
                     if ra["assetUnits"].get(u) != rb["assetUnits"].get(u)}
    cls = collections.defaultdict(lambda: {"entries": 0, "bytes": 0})
    by_prefix = collections.defaultdict(lambda: collections.Counter())
    noise_kinds = collections.Counter()
    per_path = {}
    for path, f in eb.items():
        old = ea.get(path)
        if old and old["sha256"] == f["sha256"]:
            continue
        kind = "changed" if old else "added"
        src = source_of(path, smap)
        if STAMP.match(path):
            c = "stamp"
        elif GLOBAL.match(path) and old:
            c = global_class(path, data_a[old["offset"]:old["offset"] + old["size"]],
                             data_b[f["offset"]:f["offset"] + f["size"]])
        elif kind == "added" or src in changed_src or (src.endswith(".gd") and src + ".uid" in changed_src):
            c = "content"
        elif unit_of(src) and unit_of(src) in units_changed:
            c = "content"  # an encrypted asset unit changed (its files are not in git)
        else:
            c = "noise"
            noise_kinds[path.rsplit(".", 1)[-1]] += 1
        k = f"{c}-{kind}"
        cls[k]["entries"] += 1
        cls[k]["bytes"] += f["size"]
        by_prefix[c][prefix(path)] += 1
        per_path[path] = c
    removed = [p for p in ea if p not in eb]
    offset_moved = sum(1 for p in eb if p in ea and ea[p]["offset"] != eb[p]["offset"])
    row = {"from": ra["version"], "to": rb["version"], "commits": commits(ra["tag"], rb["tag"]),
           "sourceFilesChanged": len(changed_src), "assetUnitsChanged": sorted(units_changed),
           "engine": [ra["godot"], rb["godot"]], "entries": len(fb), "removed": len(removed),
           "offsetMoved": offset_moved, "classes": dict(cls), "noiseByExt": dict(noise_kinds),
           "byPrefix": {c: dict(v.most_common(8)) for c, v in by_prefix.items()}}
    print(json.dumps(row))
    row["perPath"] = per_path  # stays in data/out (git-ignored): file names are private
    rows.append(row)
os.makedirs(hist.OUT, exist_ok=True)
json.dump(rows, open(os.path.join(hist.OUT, f"noise-{fam}.json"), "w"), indent=1)
