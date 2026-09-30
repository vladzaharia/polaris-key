"""Shared helpers for the S-03 chunk-history spike: releases, payload families, file-aware segments,
FastCDC recipes (the shared fastcdc.cjs, unchanged), per-chunk zstd sizes, pkey-chunks/1 sizes,
chunk-bundle layouts (fresh per release, or shared across one deliverable's history) and the
planner's request-run rule.

Everything derived from Diceroll's release assets is written under data/ (git-ignored).
Reuses ../patching/tools/pck.py and ../patching/tools/fastcdc.cjs, and the reference planner in
../content/runners/python/pkey_content.py.
"""
import hashlib
import json
import multiprocessing
import os
import re
import subprocess
import sys
import zipfile
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
PROTO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(PROTO, "patching", "tools"))
sys.path.insert(0, os.path.join(PROTO, "content", "runners", "python"))
import pck  # noqa: E402
import pkey_content as pc  # noqa: E402

DATA = os.environ.get("CHUNK_HISTORY_DATA") or os.path.join(HERE, "data")
REL = os.path.join(DATA, "rel")  # rel/<tag-dir>/Diceroll-<v>-*.{pck,zip,apk} + build manifest
EX = os.path.join(DATA, "ex")  # extracted payloads (web index.pck, android asset tree container)
OUT = os.path.join(DATA, "out")  # recipes, caches, result JSON
FASTCDC = os.path.join(PROTO, "patching", "tools", "fastcdc.cjs")
LEVEL = 19
HDR, REC = 64, 48  # pkey-chunks/1 header and record size
KIB, MIB = 1024, 1024 * 1024

CHUNKERS = {  # name -> (avg, file_aware); min = avg/4, max = avg*4, normalised level 1 (fastcdc.cjs)
    "fa16": (16 * KIB, True),
    "fa32": (32 * KIB, True),
    "fa64": (64 * KIB, True),
    "fa128": (128 * KIB, True),
    "plain64": (64 * KIB, False),
    "fa32m": (32 * KIB, True),
    "fa64m": (64 * KIB, True),
}
# "m" variants: file-aware, but a gap shorter than PAD_MERGE bytes (the exporter's 16-byte alignment
# padding between entries) is appended to the segment before it instead of becoming its own chunk.
MERGE_PAD = {"fa32m", "fa64m"}
PAD_MERGE = 64
BUNDLE_TARGETS = (4 * MIB, 8 * MIB, 16 * MIB)


def node_bin():
    n = os.environ.get("NODE")
    if n:
        return n
    try:
        return subprocess.run(["mise", "exec", "node@22", "--", "which", "node"], capture_output=True, text=True,
                              check=True).stdout.strip()
    except Exception:
        return "node"


NODE = node_bin()


def sha(b):
    return hashlib.sha256(b).hexdigest()


def zlen(b):
    """Stored size of one chunk: a zstd -19 frame, or raw when that is not smaller (gen.py's rule)."""
    from compression import zstd

    return min(len(zstd.compress(b, level=LEVEL)), len(b))


# ------------------------------------------------------------------ releases and payloads


def releases():
    """Tagged releases in version order: [{tag, dir, version, commit, godot, assetLock, assetUnits}]."""
    out = []
    for d in sorted(os.listdir(REL)):
        mf = [f for f in os.listdir(os.path.join(REL, d)) if f.endswith("-build-manifest.json")]
        if not mf:
            continue
        m = json.load(open(os.path.join(REL, d, mf[0])))
        out.append({"tag": "v" + m["version"], "dir": d, "version": m["version"], "commit": m["commit"],
                    "godot": m["godot"], "assetLock": m.get("asset_lock_hash"), "assetUnits": m.get("asset_units", {}),
                    "artifacts": m.get("artifacts", {})})

    def key(r):
        v = r["version"]
        base, _, pre = v.partition("-")
        nums = [int(x) for x in re.findall(r"\d+", base)]
        prenum = [int(x) for x in re.findall(r"\d+", pre)] or [10**9]
        return nums, prenum

    return sorted(out, key=key)


def asset(r, suffix):
    return os.path.join(REL, r["dir"], f"Diceroll-{r['version']}-{suffix}")


def payload_path(r, family):
    """Path of the payload file for a family: desktop (the release PCK), web (index.pck from the web
    zip), android (every file under assets/ in the APK, concatenated in path order: a tree payload)."""
    if family == "desktop":
        return asset(r, "desktop.pck")
    os.makedirs(os.path.join(EX, r["dir"]), exist_ok=True)
    if family == "web":
        p = os.path.join(EX, r["dir"], "web.pck")
        if not os.path.exists(p):
            with zipfile.ZipFile(asset(r, "web.zip")) as z, open(p, "wb") as f:
                f.write(z.read("index.pck"))
        return p
    if family == "android":
        p = os.path.join(EX, r["dir"], "android-assets.bin")
        j = p + ".files.json"
        if not os.path.exists(j):
            files, pos = [], 0
            with zipfile.ZipFile(asset(r, "android.apk")) as z, open(p, "wb") as f:
                for n in sorted(i.filename for i in z.infolist() if i.filename.startswith("assets/") and not i.is_dir()):
                    d = z.read(n)
                    f.write(d)
                    files.append({"path": n[len("assets/"):], "offset": pos, "size": len(d), "sha256": sha(d)})
                    pos += len(d)
            json.dump(files, open(j, "w"))
        return p
    raise ValueError(family)


def files_of(r, family):
    """pkey-files/1-style entry list in offset order: [{path, offset, size, sha256}]."""
    cache = os.path.join(OUT, "files", f"{family}-{r['dir']}.json")
    if os.path.exists(cache):
        return json.load(open(cache))
    p = payload_path(r, family)
    if family == "android":
        files = json.load(open(p + ".files.json"))
    else:
        info = pck.read_pck(p)
        data = open(p, "rb").read()
        files = [{"path": e["path"], "offset": e["ofs"], "size": e["size"],
                  "sha256": sha(data[e["ofs"]:e["ofs"] + e["size"]])}
                 for e in sorted(info["entries"], key=lambda e: e["ofs"])]
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    json.dump(files, open(cache, "w"))
    return files


def segments(files, size):
    """File-aware segments (gap, file, gap, ...), exactly as gen.py builds them."""
    segs, pos = [], 0
    for f in files:
        if f["offset"] > pos:
            segs.append([pos, f["offset"] - pos])
        if f["size"]:
            segs.append([f["offset"], f["size"]])
        pos = f["offset"] + f["size"]
    if size > pos:
        segs.append([pos, size - pos])
    return segs


def merge_padding(segs):
    out = []
    for o, n in segs:
        if out and n < PAD_MERGE and out[-1][0] + out[-1][1] == o:
            out[-1][1] += n
        else:
            out.append([o, n])
    return out


def gaps_of(data, files):
    out, pos = bytearray(), 0
    for f in files:
        out += data[pos:f["offset"]]
        pos = f["offset"] + f["size"]
    out += data[pos:]
    return bytes(out)


def files_index_bytes(r, family, data):
    """The pkey-files/1 JSON exactly as gen.py writes it (jdump, indent 1)."""
    files = files_of(r, family)
    o = {"format": "pkey-files/1", "layout": "container", "payload": {"size": len(data), "sha256": sha(data)},
         "files": files}
    return (json.dumps(o, indent=1, sort_keys=False) + "\n").encode()


# ------------------------------------------------------------------ recipes and compressed sizes


def recipe(r, family, chunker):
    """[(ofs, len, sha256)] in payload order, from fastcdc.cjs (cached)."""
    cache = os.path.join(OUT, "recipes", f"{family}-{r['dir']}-{chunker}.json")
    if os.path.exists(cache):
        return [tuple(x) for x in json.load(open(cache))]
    avg, fa = CHUNKERS[chunker]
    p = payload_path(r, family)
    env = dict(os.environ)
    if fa:
        sp = cache + ".segs.json"
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        segs = segments(files_of(r, family), os.path.getsize(p))
        json.dump(merge_padding(segs) if chunker in MERGE_PAD else segs, open(sp, "w"))
        env["FASTCDC_SEGMENTS"] = sp
    else:
        env.pop("FASTCDC_SEGMENTS", None)
    res = subprocess.run([NODE, FASTCDC, p, str(avg)], capture_output=True, env=env, check=True)
    rec = [(c["ofs"], c["size"], c["sha256"]) for c in json.loads(res.stdout)]
    assert sum(s for _, s, _ in rec) == os.path.getsize(p)
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    json.dump(rec, open(cache, "w"))
    if fa:
        os.remove(sp)
    return rec


_CLEN = None


def _clen_path():
    return os.path.join(OUT, "clen.json")


def clens():
    global _CLEN
    if _CLEN is None:
        _CLEN = json.load(open(_clen_path())) if os.path.exists(_clen_path()) else {}
    return _CLEN


def save_clens():
    os.makedirs(OUT, exist_ok=True)
    tmp = _clen_path() + ".tmp"
    json.dump(clens(), open(tmp, "w"))
    os.replace(tmp, _clen_path())


def _zlen_task(args):
    h, b = args
    return h, zlen(b)


def ensure_clens(data, rec, workers=None):
    """Fill the sha256 -> stored-length cache for every chunk of a recipe (parallel zstd -19)."""
    C = clens()
    todo, seen = [], set()
    for o, s, h in rec:
        if h not in C and h not in seen:
            seen.add(h)
            todo.append((h, bytes(data[o:o + s])))
    if not todo:
        return
    # fork, not spawn: the scripts are plain top-level modules without a __main__ guard
    with ProcessPoolExecutor(max_workers=workers or os.cpu_count(), mp_context=multiprocessing.get_context("fork")) as ex:
        for h, n in ex.map(_zlen_task, todo, chunksize=16):
            C[h] = n
    save_clens()


# ------------------------------------------------------------------ bundles, index, runs


def pack_bundles(order, target, start_id, C):
    """Pack chunk ids (first-use order) into bundles of at most `target` bytes (gen.py's rule).
    Returns ({id: (bundle, offset, clen)}, [bundle sizes])."""
    loc, sizes, cur = {}, [], 0
    for h in order:
        cl = C[h]
        if cur and cur + cl > target:
            sizes.append(cur)
            cur = 0
        loc[h] = (start_id + len(sizes), cur, cl)
        cur += cl
    if cur:
        sizes.append(cur)
    return loc, sizes


def first_use(rec):
    seen, out = set(), []
    for _, _, h in rec:
        if h not in seen:
            seen.add(h)
            out.append(h)
    return out


def layout_fresh(rec, target):
    """Fresh bundles per release: every unique chunk of this release, first-use order."""
    loc, sizes = pack_bundles(first_use(rec), target, 0, clens())
    return loc, len(sizes)


def layouts_shared(recs_in_order, target):
    """Bundles shared across one deliverable's history: release k's new bundles hold only chunks no
    earlier release stored. Returns per release (loc restricted to its chunks, bundles referenced)."""
    C, glob, nb, out = clens(), {}, 0, []
    for rec in recs_in_order:
        new = [h for h in first_use(rec) if h not in glob]
        loc, sizes = pack_bundles(new, target, nb, C)
        glob.update(loc)
        nb += len(sizes)
        mine = {h: glob[h] for _, _, h in rec}
        out.append((mine, len({v[0] for v in mine.values()})))
    return out


def records(rec, loc):
    """Planner-shaped records [id, len, clen, bundle, offset] in payload order."""
    return [[h, s, loc[h][2], loc[h][0], loc[h][1]] for _, s, h in rec]


def index_bytes(n_records, n_bundles):
    return HDR + REC * (n_records + n_bundles)


def index_blob(rec, loc, file_aware, payload_size):
    """The pkey-chunks/1 bytes (gen.py's writer). Bundle ids stand in as SHA-256 of the bundle's chunk
    ids (the real bundle bytes are not built here); both are 32 incompressible bytes."""
    import struct

    bundles = sorted({v[0] for v in loc.values()})
    remap = {b: k for k, b in enumerate(bundles)}
    ends = {}
    for h, (b, o, cl) in loc.items():
        ends[b] = max(ends.get(b, 0), o + cl)
    hdr = b"PKEYCHNK" + struct.pack("<HHIIIQ", 1, REC, 1 if file_aware else 0, len(rec), len(bundles), payload_size)
    hdr += bytes(32)  # payloadSha256 placeholder
    body = bytearray()
    for _, s, h in rec:
        b, o, cl = loc[h]
        body += bytes.fromhex(h) + struct.pack("<IIII", s, cl, remap[b], o)
    for b in bundles:
        body += hashlib.sha256(f"bundle-{b}".encode()).digest() + struct.pack("<QQ", ends[b], 0)
    return hdr + bytes(body)


def missing_stats(target_recs, seed_ids):
    """The planner's chunk candidate, spelled out: unique missing chunks, raw and stored bytes, request
    runs (A7 §4.3 rule: a run continues while the next fetched chunk sits in the same bundle right
    after the previous fetched one) and bundles touched."""
    seen, prev, runs, raw, stored, bundles, n = set(), None, 0, 0, 0, set(), 0
    for cid, ln, cl, bi, bo in target_recs:
        if cid in seed_ids or cid in seen:
            continue
        seen.add(cid)
        n += 1
        raw += ln
        stored += cl
        bundles.add(bi)
        if prev is None or bi != prev[3] or bo != prev[4] + prev[2]:
            runs += 1
        prev = (cid, ln, cl, bi, bo)
    return {"missingChunks": n, "missingRaw": raw, "missingStored": stored, "runs": runs,
            "bundlesTouched": len(bundles)}


def zstd_cli(args):
    subprocess.run(["zstd", "-q", "-f", *args], check=True, stderr=subprocess.DEVNULL)


def plan(inp):
    return pc.plan(inp)
