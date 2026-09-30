#!/usr/bin/env python3
"""CI stand-in: builds a content conformance vector set (pkey-chunks/1, pkey-files/1, zstd deltas,
negative mutations, planner cases) from the Godot study's real v1/v2 PCKs.

usage: gen.py small|large OUTDIR
  small = a ~5 MiB subset of the real packs, shipped as the shared vector set (< 5 MB on disk)
  large = the full 36 MiB packs, same format, used only for throughput runs (not shipped)

Input: PACKS_DIR (env) holds v1.pck and v2.pck. Default: ../../patching/out, the export directory of the
patching experiment next to this one (prototype/patching/out).
"""
import hashlib, json, os, struct, subprocess, sys, shutil
from compression import zstd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pck  # noqa: E402
import planref  # noqa: E402

SRC = os.environ.get("PACKS_DIR") or os.path.join(HERE, "..", "..", "patching", "out")
MODE, OUT = sys.argv[1], sys.argv[2]
AVG = 16384 if MODE == "small" else 65536
BUNDLE_TARGET = 256 * 1024 if MODE == "small" else 4 * 1024 * 1024
LEVEL = 19
MAGIC = b"PKEYCHNK"
FLAG_FILE_AWARE = 1


def sha(b):
    return hashlib.sha256(b).hexdigest()


def zc(b):
    return zstd.compress(b, level=LEVEL)


def blob_put(name, data):
    p = os.path.join(OUT, "blobs", name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)
    BLOBS[name] = {"size": len(data), "sha256": sha(data)}
    return name


BLOBS = {}

# ---------------------------------------------------------------- payloads


def pck_bytes(entries_in_order):
    """Exporter-like PCK v4: header 104 B, 16-byte alignment, files in the given order, directory sorted."""
    out = bytearray()
    out += struct.pack("<6I", pck.MAGIC, 4, 4, 7, 2, 2) + struct.pack("<QQ", 0, 0) + b"\0" * 64
    out += b"\0" * pck.pad(len(out), 16)
    file_base = len(out)
    recs = []
    for path, data in entries_in_order:
        o = len(out)
        out += data
        out += b"\0" * pck.pad(len(out), 16)
        recs.append((path, o - file_base, len(data), hashlib.md5(data).digest()))
    dir_off = len(out)
    out += struct.pack("<I", len(recs))
    for path, o, s, m in sorted(recs):
        b = path.encode()
        b += b"\0" * pck.pad(len(b), 4)
        out += struct.pack("<I", len(b)) + b + struct.pack("<QQ", o, s) + m + struct.pack("<I", 0)
    out[24:40] = struct.pack("<QQ", file_base, dir_off)
    return bytes(out)


def load_versions():
    v1p, v2p = os.path.join(SRC, "v1.pck"), os.path.join(SRC, "v2.pck")
    if MODE == "large":
        return open(v1p, "rb").read(), open(v2p, "rb").read()
    a, b = pck.read_pck(v1p), pck.read_pck(v2p)
    A = {e["path"]: e for e in a["entries"]}
    B = {e["path"]: e for e in b["entries"]}
    data1 = {p: pck.read_entry(v1p, e) for p, e in A.items()}
    data2 = {p: pck.read_entry(v2p, e) for p, e in B.items()}
    changed = [p for p in B if p in A and data1[p] != data2[p]]
    added = [p for p in B if p not in A]
    removed = [p for p in A if p not in B]
    skip = {p for p in changed + added if len(data2[p]) > 600_000 and "t1024_03" not in p}
    keep = set(changed + added + removed) - skip
    total = sum(len(data2[p]) for p in keep if p in B)
    for e in sorted(b["entries"], key=lambda e: e["ofs"]):
        p = e["path"]
        if p in keep or p in changed or p in added or e["size"] > 200_000:
            continue
        if total + e["size"] > 5 * 1024 * 1024:
            continue
        keep.add(p)
        total += e["size"]
    o1 = [(e["path"], data1[e["path"]]) for e in sorted(a["entries"], key=lambda e: e["ofs"]) if e["path"] in keep]
    o2 = [(e["path"], data2[e["path"]]) for e in sorted(b["entries"], key=lambda e: e["ofs"]) if e["path"] in keep]
    return pck_bytes(o1), pck_bytes(o2)


V1, V2 = load_versions()
os.makedirs(OUT, exist_ok=True)
tmp = os.path.join(OUT, "_tmp")
os.makedirs(tmp, exist_ok=True)
open(os.path.join(tmp, "v1.pck"), "wb").write(V1)
open(os.path.join(tmp, "v2.pck"), "wb").write(V2)

# ---------------------------------------------------------------- pkey-files/1


def files_index(payload):
    p = os.path.join(tmp, "x.pck")
    open(p, "wb").write(payload)
    info = pck.read_pck(p)
    files = []
    for e in sorted(info["entries"], key=lambda e: e["ofs"]):
        d = payload[e["ofs"] : e["ofs"] + e["size"]]
        files.append({"path": e["path"], "offset": e["ofs"], "size": e["size"], "sha256": sha(d)})
    return {"format": "pkey-files/1", "layout": "container",
            "payload": {"size": len(payload), "sha256": sha(payload)}, "files": files}


def gaps_of(payload, fidx):
    out, pos = bytearray(), 0
    for f in fidx["files"]:
        out += payload[pos : f["offset"]]
        pos = f["offset"] + f["size"]
    out += payload[pos:]
    return bytes(out)


def segments(fidx, size):
    segs, pos = [], 0
    for f in fidx["files"]:
        if f["offset"] > pos:
            segs.append([pos, f["offset"] - pos])
        if f["size"]:
            segs.append([f["offset"], f["size"]])
        pos = f["offset"] + f["size"]
    if size > pos:
        segs.append([pos, size - pos])
    return segs


def jdump(o):
    return (json.dumps(o, indent=1, sort_keys=False) + "\n").encode()


F1, F2 = files_index(V1), files_index(V2)
blob_put("files/v1.files.json", jdump(F1))
blob_put("files/v2.files.json", jdump(F2))
G2 = gaps_of(V2, F2)
blob_put("files/v2.gaps.zst", zc(G2))

# ---------------------------------------------------------------- chunking + bundles + pkey-chunks/1


def chunk(payload, fidx, tag):
    pth = os.path.join(tmp, f"{tag}.pck")
    segp = os.path.join(tmp, f"{tag}.segs.json")
    json.dump(segments(fidx, len(payload)), open(segp, "w"))
    env = dict(os.environ, FASTCDC_SEGMENTS=segp)
    r = subprocess.run(["node", os.path.join(HERE, "fastcdc.cjs"), pth, str(AVG)], capture_output=True, env=env, check=True)
    return [(c["ofs"], c["size"], c["sha256"]) for c in json.loads(r.stdout)]


def build_index(payload, fidx, tag):
    chunks = chunk(payload, fidx, tag)
    assert sum(s for _, s, _ in chunks) == len(payload)
    uniq, order = {}, []
    for o, s, h in chunks:
        if h not in uniq:
            raw = payload[o : o + s]
            z = zc(raw)
            uniq[h] = z if len(z) < len(raw) else raw
            order.append(h)
    bundles, cur, loc = [], bytearray(), {}
    for h in order:
        blob = uniq[h]
        if cur and len(cur) + len(blob) > BUNDLE_TARGET:
            bundles.append(bytes(cur))
            cur = bytearray()
        loc[h] = (len(bundles), len(cur), len(blob))
        cur += blob
    if cur:
        bundles.append(bytes(cur))
    bshas = [sha(b) for b in bundles]
    hdr = MAGIC + struct.pack("<HHIIIQ", 1, 48, FLAG_FILE_AWARE, len(chunks), len(bundles), len(payload))
    hdr += bytes.fromhex(sha(payload))
    assert len(hdr) == 64
    body = bytearray()
    for o, s, h in chunks:
        bi, bo, bl = loc[h]
        body += bytes.fromhex(h) + struct.pack("<IIII", s, bl, bi, bo)
    for b in bundles:
        body += bytes.fromhex(sha(b)) + struct.pack("<QQ", len(b), 0)
    return hdr + bytes(body), bundles, chunks, loc


I1, B1, C1, L1 = build_index(V1, F1, "v1")
I2, B2, C2, L2 = build_index(V2, F2, "v2")
blob_put("chunks/v1.pkc", I1)
blob_put("chunks/v2.pkc", I2)
bundle_refs = {}
for b in B2:
    h = sha(b)
    bundle_refs[h] = {"blob": blob_put(f"bundles/{h}", b)}
# v1's own bundles are not shipped (a seed index only needs ids and lengths); their sizes live in v1.pkc.

# ---------------------------------------------------------------- full blobs and deltas


def zstd_cli(args):
    subprocess.run(["zstd", "-q", "-f", *args], check=True, stderr=subprocess.DEVNULL)


zstd_cli(["-19", os.path.join(tmp, "v1.pck"), "-o", os.path.join(tmp, "v1.full.zst")])
blob_put("payload/v1.full.zst", open(os.path.join(tmp, "v1.full.zst"), "rb").read())
v2_full_bytes = None
if MODE == "large":
    zstd_cli(["-19", os.path.join(tmp, "v2.pck"), "-o", os.path.join(tmp, "v2.full.zst")])
    blob_put("payload/v2.full.zst", open(os.path.join(tmp, "v2.full.zst"), "rb").read())
    v2_full_bytes = BLOBS["payload/v2.full.zst"]["size"]
else:
    zstd_cli(["-19", os.path.join(tmp, "v2.pck"), "-o", os.path.join(tmp, "v2.full.zst")])
    v2_full_bytes = os.path.getsize(os.path.join(tmp, "v2.full.zst"))  # measured, not shipped

zstd_cli(["-19", "--patch-from=" + os.path.join(tmp, "v1.pck"), os.path.join(tmp, "v2.pck"), "-o", os.path.join(tmp, "whole.pf")])
blob_put("deltas/v1-v2.pf.zst", open(os.path.join(tmp, "whole.pf"), "rb").read())

by1 = {f["path"]: f for f in F1["files"]}
sha1 = {f["sha256"] for f in F1["files"]}
file_deltas, file_blobs, file_blobs_nodelta = [], {}, {}
for f in F2["files"]:
    if f["sha256"] in sha1:
        continue
    new = V2[f["offset"] : f["offset"] + f["size"]]
    z = zc(new)
    ref = {"blob": None, "codec": "zstd" if len(z) < len(new) else "none", "size": len(new)}
    ref["blob"] = blob_put(f"files/{f['sha256']}", z if ref["codec"] == "zstd" else new)
    file_blobs_nodelta[f["sha256"]] = ref
    o = by1.get(f["path"])
    if o is None:
        file_blobs[f["sha256"]] = ref
        continue
    oldp, newp, dp = os.path.join(tmp, "old"), os.path.join(tmp, "new"), os.path.join(tmp, "d")
    open(oldp, "wb").write(V1[o["offset"] : o["offset"] + o["size"]])
    open(newp, "wb").write(new)
    zstd_cli(["-19", "--patch-from=" + oldp, newp, "-o", dp])
    d = open(dp, "rb").read()
    name = blob_put(f"deltas/files/{o['sha256'][:16]}-{f['sha256'][:16]}.pf.zst", d)
    file_deltas.append({"path": f["path"], "from": o["sha256"], "to": f["sha256"], "size": f["size"],
                        "artifact": {"blob": name}, "artifactSha256": sha(d)})

shutil.rmtree(tmp)

# ---------------------------------------------------------------- expected values via the reference applier
import refapply  # noqa: E402

store = refapply.Store(os.path.join(OUT, "blobs"))
SIZES = {"payload/v1.full.zst": len(V1), "files/v2.gaps.zst": len(G2)}
P = lambda name: {"blob": name, "codec": "zstd", "size": SIZES[name]}  # noqa: E731
full1 = P("payload/v1.full.zst")
seed = {"payload": full1, "index": {"blob": "chunks/v1.pkc"}}
tgt_idx = {"blob": "chunks/v2.pkc"}
S2, N2 = sha(V2), len(V2)
S1, N1 = sha(V1), len(V1)
whole = {"method": "zstd-patch-from", "from": S1, "to": S2, "size": N2,
         "artifact": {"blob": "deltas/v1-v2.pf.zst"}, "artifactSha256": BLOBS["deltas/v1-v2.pf.zst"]["sha256"]}

# helpers for choosing mutation targets -------------------------------------------------------
seed_ids = {h for _, _, h in C1}
fetched = []  # (record index, record) for target records fetched from bundles, in order
seen = set()
for i, (o, s, h) in enumerate(C2):
    if h in seed_ids or h in seen:
        continue
    seen.add(h)
    fetched.append((i, h))
bshas = [sha(b) for b in B2]


def first_fetched(pred, start=0):
    for i, h in fetched[start:]:
        bi, bo, bl = L2[h]
        size = next(s for _, s, hh in C2 if hh == h)
        if pred(bl, size):
            return i, h, bi, bo, bl
    raise SystemExit("no candidate chunk")


zi, zh, zbi, zbo, zbl = first_fetched(lambda bl, s: bl < s, len(fetched) // 2)  # a zstd-coded fetched chunk mid-way
ti, th, tbi, tbo, tbl = first_fetched(lambda bl, s: bl < s, len(fetched) - 8)  # a late fetched chunk, for truncation
try:
    ri, rh, rbi, rbo, rbl = first_fetched(lambda bl, s: bl == s)  # a raw-stored fetched chunk
except SystemExit:
    ri = None
# a reused chunk region in v1 (big, so the whole-file delta certainly copies from it)
reuse = max((c for c in C1 if c[2] in {h for _, _, h in C2}), key=lambda c: c[1])
seed_flip = reuse[0] + reuse[1] // 2
# a changed file's base bytes, for the per-file wrong-base case
fd0 = max(file_deltas, key=lambda d: d["size"])
fd0_base = by1[fd0["path"]]
fd_flip = fd0_base["offset"] + fd0_base["size"] // 2

cases = {"applyCases": [], "chunkIndexCases": [], "pathCases": [], "planCases": []}


def add_apply(c):
    c["expected"] = refapply.run_apply(store, c)
    cases["applyCases"].append(c)


def add_index(c):
    c["expected"] = refapply.run_index(store, c)
    cases["chunkIndexCases"].append(c)


# ---- chunk index cases
add_index({"id": "chunks-v1-valid", "description": "The seed release's chunk index parses.", "index": {"blob": "chunks/v1.pkc"}})
add_index({"id": "chunks-v2-valid", "description": "The target release's chunk index parses.", "index": tgt_idx})
nrec = len(C2) + len(B2)
for cid, desc, mut in [
    ("chunks-short-header", "Fewer than 64 bytes.", [{"op": "truncate", "length": 40}]),
    ("chunks-bad-magic", "Magic is not PKEYCHNK.", [{"op": "xor", "offset": 0, "value": 32}]),
    ("chunks-bad-version", "Version 2 is unknown to a v1 reader.", [{"op": "putU16", "offset": 8, "value": 2}]),
    ("chunks-bad-record-size", "Record size must be 48.", [{"op": "putU16", "offset": 10, "value": 40}]),
    ("chunks-bad-flags", "An undefined flag bit is set.", [{"op": "putU32", "offset": 12, "value": 3}]),
    ("chunks-bad-length", "The file is 7 bytes short of 64 + 48 x (chunkCount + bundleCount).", [{"op": "truncate", "length": len(I2) - 7}]),
    ("chunks-bad-length-count", "chunkCount claims one record more than the file holds.", [{"op": "putU32", "offset": 16, "value": len(C2) + 1}]),
    ("chunks-zero-length", "A chunk record with len 0.", [{"op": "putU32", "offset": 64 + 48 * 3 + 32, "value": 0}]),
    ("chunks-bad-clen", "clen greater than len.", [{"op": "putU32", "offset": 64 + 48 * 3 + 36, "value": C2[3][1] + 1}]),
    ("chunks-bad-bundle-ref", "A record names bundle == bundleCount.", [{"op": "putU32", "offset": 64 + 48 * 5 + 40, "value": len(B2)}]),
    ("chunks-bad-bundle-range", "offset + clen runs past the bundle's declared size.",
     [{"op": "putU32", "offset": 64 + 48 * 5 + 44, "value": len(B2[L2[C2[5][2]][0]]) - 1}]),
    ("chunks-reserved-nonzero", "A bundle record's reserved field is not zero.", [{"op": "putU64", "offset": 64 + 48 * len(C2) + 40, "value": 1}]),
    ("chunks-size-mismatch", "payloadSize is not the sum of chunk lengths.", [{"op": "putU64", "offset": 24, "value": N2 + 1}]),
]:
    add_index({"id": cid, "description": desc, "index": {"blob": "chunks/v2.pkc", "mutate": mut}})

# ---- apply cases
add_apply({"id": "full-v1", "strategy": "full", "description": "First install: decode the v1 full blob.",
           "full": full1, "expectedSha256": S1, "expectedSize": N1})
add_apply({"id": "full-v1-tampered", "strategy": "full", "description": "One byte flipped in the middle of the full blob.",
           "full": {**full1, "mutate": [{"op": "xor", "offset": BLOBS["payload/v1.full.zst"]["size"] // 2, "value": 1}]},
           "expectedSha256": S1, "expectedSize": N1})
add_apply({"id": "chunk-v1-to-v2", "strategy": "chunk", "description": "Chunk sync, v1 as the only seed.",
           "target": {"index": tgt_idx}, "seeds": [seed], "bundles": bundle_refs, "repair": False,
           "expectedSha256": S2, "expectedSize": N2})
add_apply({"id": "chunk-no-seed", "strategy": "chunk", "description": "Chunk sync with no seed: every unique chunk is fetched.",
           "target": {"index": tgt_idx}, "seeds": [], "bundles": bundle_refs, "repair": False,
           "expectedSha256": S2, "expectedSize": N2})
add_apply({"id": "chunk-tampered-zstd", "strategy": "chunk",
           "description": "One byte flipped inside a fetched zstd-coded chunk's frame.",
           "target": {"index": tgt_idx}, "seeds": [seed], "repair": False, "expectedSha256": S2, "expectedSize": N2,
           "bundles": {**bundle_refs, bshas[zbi]: {"blob": bundle_refs[bshas[zbi]]["blob"],
                                                  "mutate": [{"op": "xor", "offset": zbo + zbl // 2, "value": 1}]}}})
if ri is not None:
    add_apply({"id": "chunk-tampered-raw", "strategy": "chunk",
               "description": "One byte flipped inside a fetched raw-stored chunk (clen == len).",
               "target": {"index": tgt_idx}, "seeds": [seed], "repair": False, "expectedSha256": S2, "expectedSize": N2,
               "bundles": {**bundle_refs, bshas[rbi]: {"blob": bundle_refs[bshas[rbi]]["blob"],
                                                      "mutate": [{"op": "xor", "offset": rbo + rbl // 2, "value": 1}]}}})
add_apply({"id": "chunk-bundle-truncated", "strategy": "chunk",
           "description": "A bundle object ends in the middle of a fetched chunk.",
           "target": {"index": tgt_idx}, "seeds": [seed], "repair": False, "expectedSha256": S2, "expectedSize": N2,
           "bundles": {**bundle_refs, bshas[tbi]: {"blob": bundle_refs[bshas[tbi]]["blob"],
                                                  "mutate": [{"op": "truncate", "length": tbo + tbl // 2}]}}})
tampered_seed = {"payload": {**full1, "mutate": [{"op": "xor", "offset": seed_flip, "value": 1}]}, "index": {"blob": "chunks/v1.pkc"}}
add_apply({"id": "chunk-seed-tampered", "strategy": "chunk",
           "description": "The installed seed has one flipped byte inside a reused chunk; no repair pass.",
           "target": {"index": tgt_idx}, "seeds": [tampered_seed], "bundles": bundle_refs, "repair": False,
           "expectedSha256": S2, "expectedSize": N2})
add_apply({"id": "chunk-seed-tampered-repair", "strategy": "chunk",
           "description": "As chunk-seed-tampered, with the repair pass: bad seed chunks are refetched.",
           "target": {"index": tgt_idx}, "seeds": [tampered_seed], "bundles": bundle_refs, "repair": True,
           "expectedSha256": S2, "expectedSize": N2})
add_apply({"id": "chunk-index-for-other-payload", "strategy": "chunk",
           "description": "The target index's payloadSha256 is not the release's payload hash.",
           "target": {"index": tgt_idx}, "seeds": [seed], "bundles": bundle_refs, "repair": False,
           "expectedSha256": S1, "expectedSize": N2})
add_apply({"id": "delta-whole-v1-to-v2", "strategy": "delta", "description": "Whole-payload zstd --patch-from, v1 base.",
           "base": full1, "delta": whole})
add_apply({"id": "delta-whole-wrong-base", "strategy": "delta",
           "description": "The base has one flipped byte; the base hash check rejects it before decoding.",
           "base": {**full1, "mutate": [{"op": "xor", "offset": seed_flip, "value": 1}]}, "delta": whole})
add_apply({"id": "delta-whole-wrong-base-unchecked", "strategy": "delta",
           "description": "As delta-whole-wrong-base with the base check skipped: the decoder or the output hash must fail.",
           "base": {**full1, "mutate": [{"op": "xor", "offset": seed_flip, "value": 1}]}, "delta": whole, "skipBaseCheck": True})
add_apply({"id": "delta-whole-artifact-tampered", "strategy": "delta",
           "description": "The delta artifact does not match its pinned SHA-256.",
           "base": full1, "delta": {**whole, "artifact": {"blob": "deltas/v1-v2.pf.zst", "mutate": [{"op": "xor", "offset": 100, "value": 1}]}}})
installed = {"payload": full1, "files": {"blob": "files/v1.files.json"}}
target_files = {"files": {"blob": "files/v2.files.json"}, "gaps": P("files/v2.gaps.zst")}
add_apply({"id": "file-v1-to-v2", "strategy": "file", "description": "Per-file: reuse by hash, fetch changed and added files, fill gaps.",
           "installed": installed, "target": {**target_files, "layout": "container"}, "fileDeltas": [], "fileBlobs": file_blobs_nodelta,
           "expectedSha256": S2, "expectedSize": N2})
add_apply({"id": "file-delta-v1-to-v2", "strategy": "file", "description": "Per-file zstd --patch-from for changed files, blobs for added ones.",
           "installed": installed, "target": {**target_files, "layout": "container"}, "fileDeltas": file_deltas, "fileBlobs": file_blobs,
           "expectedSha256": S2, "expectedSize": N2})
add_apply({"id": "file-delta-tree", "strategy": "file", "description": "As file-delta-v1-to-v2, written as a tree (no container, no gaps).",
           "installed": installed, "target": {"files": {"blob": "files/v2.files.json"}, "layout": "tree"}, "fileDeltas": file_deltas,
           "fileBlobs": file_blobs})
add_apply({"id": "file-delta-wrong-base", "strategy": "file",
           "description": "The installed copy of a changed file has a flipped byte; its per-file base check fails.",
           "installed": {"payload": {**full1, "mutate": [{"op": "xor", "offset": fd_flip, "value": 1}]}, "files": {"blob": "files/v1.files.json"}},
           "target": {**target_files, "layout": "container"}, "fileDeltas": file_deltas, "fileBlobs": file_blobs,
           "expectedSha256": S2, "expectedSize": N2})
add_apply({"id": "file-source-missing", "strategy": "file", "description": "An added file has neither a delta nor a blob.",
           "installed": installed, "target": {**target_files, "layout": "container"}, "fileDeltas": file_deltas,
           "fileBlobs": dict(list(file_blobs.items())[1:]), "expectedSha256": S2, "expectedSize": N2})
add_apply({"id": "file-gaps-short", "strategy": "file", "description": "The gaps blob is one byte short of the layout.",
           "installed": installed,
           "target": {**target_files, "gaps": {**P("files/v2.gaps.zst"), "mutate": [{"op": "truncate", "length": len(G2) - 1}]}, "layout": "container"},
           "fileDeltas": file_deltas, "fileBlobs": file_blobs, "expectedSha256": S2, "expectedSize": N2})

# ---- path cases (files index path rules)
for cid, paths, exp in [
    ("paths-ok", ["assets/a.json", "assets/b.json", ".godot/imported/x.ctex", "a b/c@2x+1.png"], {"ok": True}),
    ("paths-dotdot", ["assets/../../evil"], {"error": "files.unsafe_path", "path": "assets/../../evil"}),
    ("paths-dot-segment", ["assets/./a"], {"error": "files.unsafe_path", "path": "assets/./a"}),
    ("paths-absolute", ["/etc/passwd"], {"error": "files.unsafe_path", "path": "/etc/passwd"}),
    ("paths-backslash", ["assets\\a.json"], {"error": "files.unsafe_path", "path": "assets\\a.json"}),
    ("paths-drive", ["C:/x"], {"error": "files.unsafe_path", "path": "C:/x"}),
    ("paths-empty-segment", ["assets//a"], {"error": "files.unsafe_path", "path": "assets//a"}),
    ("paths-trailing-slash", ["assets/"], {"error": "files.unsafe_path", "path": "assets/"}),
    ("paths-control-char", ["a\u001fb"], {"error": "files.unsafe_path", "path": "a\u001fb"}),
    ("paths-non-ascii", ["assets/caf\u00e9.json"], {"error": "files.unsafe_path", "path": "assets/caf\u00e9.json"}),
    ("paths-reserved-char", ["assets/a:b"], {"error": "files.unsafe_path", "path": "assets/a:b"}),
    ("paths-duplicate", ["a/b", "a/b"], {"error": "files.duplicate_path", "path": "a/b"}),
    ("paths-case-collision", ["Assets/A.json", "assets/a.json"], {"error": "files.case_collision", "path": "assets/a.json"}),
    ("paths-file-dir-conflict", ["a/b", "A/B/c"], {"error": "files.path_conflict", "path": "A/B/c"}),
    ("paths-trailing-dot", ["assets/a./b"], {"error": "files.unsafe_path", "path": "assets/a./b"}),
    ("paths-windows-device", ["assets/aux.json"], {"error": "files.unsafe_path", "path": "assets/aux.json"}),
    ("paths-too-long", ["a" * 1025], {"error": "files.unsafe_path", "path": "a" * 1025}),
]:
    got = refapply.check_paths(paths)
    assert got == exp, (cid, got, exp)
    cases["pathCases"].append({"id": cid, "paths": paths, "expected": exp})

# ---- plan cases
real_plan = planref.real_case(store, V1, V2, F1, F2, BLOBS, file_deltas, file_blobs, file_blobs_nodelta, v2_full_bytes)
for c in planref.synthetic_cases() + real_plan:
    c["expected"] = planref.plan(c["input"], store)
    cases["planCases"].append(c)

doc = {
    "contentCorpusVersion": 1,
    "description": "Cross-SDK content-delivery vectors: pkey-chunks/1 parsing, chunk/delta/file/full apply with negative cases, "
                   "files-index path rules and the install planner. Generated; do not hand-edit.",
    "set": MODE,
    "params": {"chunker": "fastcdc-2016-nc1", "fileAware": True, "avgSize": AVG, "minSize": AVG // 4, "maxSize": AVG * 4,
               "bundleTarget": BUNDLE_TARGET, "zstdLevel": LEVEL, "zstdCli": subprocess.run(["zstd", "-V"], capture_output=True, text=True).stdout.strip()},
    "payloads": {"v1": {"sha256": S1, "size": N1}, "v2": {"sha256": S2, "size": N2, "fullZstdBytes": v2_full_bytes}},
    "blobs": dict(sorted(BLOBS.items())),
    **cases,
}
open(os.path.join(OUT, "cases.json"), "w").write(json.dumps(doc, indent=1) + "\n")
tot = sum(b["size"] for b in BLOBS.values())
print(f"{MODE}: v1 {N1} B, v2 {N2} B, v1 chunks {len(C1)}, v2 chunks {len(C2)}, bundles {len(B2)}, file deltas {len(file_deltas)}, "
      f"blobs {len(BLOBS)} = {tot} B; cases: " + ", ".join(f"{k} {len(v)}" for k, v in cases.items()))
