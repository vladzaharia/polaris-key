"""Reference implementation of packs v1's content operations, in P4-01's formats (plans/P4-01.md
§2.7-§2.9; WIRE-CONTRACT-V4 §2.6, §2.7, §11.4): the files index with per-entry blob refs (container
and tree layouts, treeDigest), the path rules with the `.pkey` addition, the packed `pkey-patch/1`
descriptor plus data object, full / payload-delta / file apply with exact counters, the zstd window
check (frameWindow, windowLogMax) before every prefix decode, packSetId, the content stamp, the
planner with `full: {bytes, requests?}`, selectVariant and planTarget.

This is the oracle for P4-04's content corpus: an implementation written from the plan, independent
of tools/gen-content-corpus.ts. A7's original formats stay in pkey_content.py (the historical
prototype, which gen/gen.py still uses). Pure stdlib except the zstd backend."""
import hashlib
import json
import re

MAX_INDEX_FILES = 100000
MAX_FILES_INDEX_BYTES = 33554432
MAX_PACK_PATH_BYTES = 1024
MAX_CONTENT_PINS = 256
MAX_WIRE_INTEGER = 2**53 - 1
MAX_JSON_DEPTH = 64
PLAN_REQUEST_WEIGHT = 16384
FILES_FORMAT = "pkey-files/1"
PATCH_FORMAT = "pkey-patch/1"
CONTENT_STAMP_FORMAT = "pkey-content/1"
CODECS = ("zstd", "none")
RANK = {"noop": 0, "platform": 1, "delta": 2, "chunk": 3, "file": 4, "full": 5}

HEX64 = re.compile(r"^[0-9a-f]{64}$")
PACK_ID = re.compile(r"^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$")
VOCAB_TOKEN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
VERSION = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$")


class ContentError(Exception):
    def __init__(self, code, **detail):
        super().__init__(code)
        self.code = code
        self.detail = detail

    def verdict(self):
        return {"ok": False, "error": self.code, **self.detail}


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def is_int(v, minimum=0):
    """The integer rule: a JSON integer token (never a float spelling), in [minimum, 2^53 - 1]."""
    return type(v) is int and minimum <= v <= MAX_WIRE_INTEGER


def is_hex64(v):
    return isinstance(v, str) and bool(HEX64.match(v))


def is_pack_id(v):
    return isinstance(v, str) and v != "app" and len(v.encode()) <= 64 and bool(PACK_ID.match(v))


# ------------------------------------------------------------------ strict JSON (V4 §1.2)


class _Strict(Exception):
    pass


def _pairs(pairs):
    out = {}
    for k, v in pairs:
        if k in out or "\x00" in k:
            raise _Strict()
        out[k] = v
    return out


def _const(_):
    raise _Strict()


def _walk(v, depth):
    if depth > MAX_JSON_DEPTH:
        raise _Strict()
    if isinstance(v, str):
        v.encode("utf-8")  # a lone surrogate fails here
    elif isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            raise _Strict()
    elif isinstance(v, list):
        for x in v:
            _walk(x, depth + 1)
    elif isinstance(v, dict):
        for k, x in v.items():
            k.encode("utf-8")
            _walk(x, depth + 1)


def strict_json(data):
    """bytes or str -> value, or raises _Strict. UTF-8 without BOM, no duplicate member, no
    NaN/Infinity, no lone surrogate, no U+0000 in a member name, depth <= 64."""
    try:
        text = data.decode("utf-8") if isinstance(data, (bytes, bytearray)) else data
        if text.startswith("\ufeff"):
            raise _Strict()
        v = json.loads(text, object_pairs_hook=_pairs, parse_constant=_const)
        _walk(v, 1)
        return v
    except (_Strict, ValueError, UnicodeError, RecursionError):
        raise _Strict()


# ------------------------------------------------------------------ zstd


class Zstd:
    """Python 3.14+ compression.zstd. The decoder parameter is set to its maximum on purpose: the
    window rule is the applier's own header check (§2.7 rule 3), never the decoder's limit."""

    def __init__(self):
        from compression import zstd

        self.z = zstd
        self.name = f"compression.zstd (libzstd {zstd.zstd_version})"

    def decode(self, frame, size, prefix=None):
        z = self.z
        opts = {z.DecompressionParameter.window_log_max: 31}
        if prefix is None:
            out = z.decompress(frame, options=opts)
        else:
            out = z.decompress(frame, zstd_dict=z.ZstdDict(prefix, is_raw=True).as_prefix, options=opts)
        if len(out) != size:
            raise ValueError("decoded length")
        return out


def frame_window(b):
    """RFC 8878 §3.1.1 from the header bytes alone; None for a bad magic, a set reserved bit or a
    short header; saturated at 2^32."""
    if len(b) < 5 or b[:4] != b"\x28\xb5\x2f\xfd":
        return None
    d = b[4]
    if d & 0x08:
        return None
    single = bool(d & 0x20)
    did = (0, 1, 2, 4)[d & 3]
    fcs_flag = d >> 6
    fcs = (1 if single else 0) if fcs_flag == 0 else (0, 2, 4, 8)[fcs_flag]
    need = 5 + (0 if single else 1) + did + fcs
    if len(b) < need:
        return None
    if not single:
        w = b[5]
        base = 1 << (10 + (w >> 3))
        return min(base + (base >> 3) * (w & 7), 2**32)
    at = 5 + did
    v = int.from_bytes(b[at : at + fcs], "little")
    if fcs == 2:
        v += 256
    return min(v, 2**32)


def window_log_max(mem_bytes, p=31):
    n = (mem_bytes - 1).bit_length() if mem_bytes > 0 else 0
    return max(10, min(p, n))


def check_window(frame, mem_bytes, **detail):
    w = frame_window(frame)
    if w is None or w > 2 ** window_log_max(mem_bytes):
        raise ContentError("delta-apply-failed", **detail)


# ------------------------------------------------------------------ path rules (§2.7)

_BAD = set('\\:*?"<>|')
_DEVICES = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}


def _lower(s):
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def _path_ok(p):
    if not 1 <= len(p.encode("utf-8", "surrogatepass")) <= MAX_PACK_PATH_BYTES:
        return False
    if any(not (0x20 <= ord(c) <= 0x7E) or c in _BAD for c in p):
        return False
    segs = p.split("/")
    if _lower(segs[0]) == ".pkey":
        return False
    for s in segs:
        if s in ("", ".", "..") or s.endswith(" ") or s.endswith("."):
            return False
        if _lower(s.split(".", 1)[0]) in _DEVICES:
            return False
    return True


def check_paths(paths):
    seen, lower, dirs = set(), set(), set()
    for p in paths:
        if not _path_ok(p):
            return {"ok": False, "error": "files-unsafe-path", "path": p}
        if p in seen:
            return {"ok": False, "error": "files-duplicate-path", "path": p}
        lp = _lower(p)
        if lp in lower:
            return {"ok": False, "error": "files-case-collision", "path": p}
        parts = lp.split("/")
        prefixes = {"/".join(parts[:k]) for k in range(1, len(parts))}
        if lp in dirs or prefixes & lower:
            return {"ok": False, "error": "files-path-conflict", "path": p}
        seen.add(p)
        lower.add(lp)
        dirs |= prefixes
    return {"ok": True}


def tree_digest(files):
    lines = sorted((f["path"].encode(), f"{f['sha256']} {f['size']} {f['path']}\n") for f in files)
    return sha256("".join(l for _, l in lines).encode())


# ------------------------------------------------------------------ object refs


def stored_matches(stored, ref):
    return stored is not None and len(stored) == ref.get("bytes") and sha256(stored) == ref.get("sha256")


def decode_object(stored, codec, size, zstd):
    if codec == "none":
        if len(stored) != size:
            raise ValueError("none size")
        return stored
    if codec == "zstd":
        return zstd.decode(stored, size)
    raise ValueError("codec")


def _decode_side(stored, ref, zstd):
    """parseFilesIndex step 1 (and parsePatch's): size bound first, stored bytes, decode, length."""
    if not is_int(ref.get("size")) or ref["size"] > MAX_FILES_INDEX_BYTES:
        return None
    if not stored_matches(stored, ref) or ref.get("codec") not in CODECS:
        return None
    try:
        return decode_object(stored, ref["codec"], ref["size"], zstd)
    except Exception:
        return None


# ------------------------------------------------------------------ pkey-files/1 (§2.7)


def _entry_ok(e, container):
    if not isinstance(e, dict) or not isinstance(e.get("path"), str):
        return False
    if not is_int(e.get("size")) or not is_hex64(e.get("sha256")):
        return False
    b = e.get("blob")
    if not isinstance(b, dict) or not is_hex64(b.get("sha256")) or not is_int(b.get("bytes")):
        return False
    if b.get("codec") == "none":
        if b["bytes"] != e["size"] or b["sha256"] != e["sha256"]:
            return False
    elif b.get("codec") != "zstd":
        return False
    if container and not is_int(e.get("offset")):
        return False
    return True


def parse_files_index(stored, ref, payload, zstd):
    """Returns the index doc or raises ContentError (the first failure, §2.7 steps 1-5)."""
    inv = ContentError("files-index-invalid")
    decoded = _decode_side(stored, ref, zstd)
    if decoded is None:
        raise inv
    try:
        doc = strict_json(decoded)
    except _Strict:
        raise inv
    if not isinstance(doc, dict) or doc.get("format") != FILES_FORMAT or doc.get("layout") != ref.get("layout"):
        raise inv
    p = doc.get("payload")
    if not isinstance(p, dict) or not is_int(p.get("size")) or not is_hex64(p.get("sha256")):
        raise inv
    if p["size"] != payload["size"] or p["sha256"] != payload["sha256"]:
        raise inv
    files = doc.get("files")
    if not isinstance(files, list) or len(files) > MAX_INDEX_FILES:
        raise inv
    container = doc["layout"] == "container"
    if not all(_entry_ok(e, container) for e in files):
        raise inv
    pc = check_paths([e["path"] for e in files])
    if not pc["ok"]:
        raise ContentError(pc["error"], path=pc["path"])
    total = sum(e["size"] for e in files)
    if container:
        end = 0
        for e in files:
            if e["offset"] < end:
                raise ContentError("files-layout-mismatch")
            end = e["offset"] + e["size"]
        gaps = ref.get("gaps")
        if end > p["size"] or not isinstance(gaps, dict) or p["size"] - total != gaps.get("size"):
            raise ContentError("files-layout-mismatch")
    elif doc["layout"] == "tree":
        paths = [e["path"].encode() for e in files]
        if any(paths[i - 1] >= paths[i] for i in range(1, len(paths))):
            raise inv
        if total != p["size"] or tree_digest(files) != p["sha256"]:
            raise inv
    return doc


# ------------------------------------------------------------------ pkey-patch/1 (§2.7)


def parse_patch(stored_patch, delta, payload, index, zstd):
    bad = ContentError("delta-artifact-mismatch")
    patch_ref = delta.get("patch") or {}
    decoded = _decode_side(stored_patch, patch_ref, zstd)
    if decoded is None:
        raise bad
    try:
        doc = strict_json(decoded)
    except _Strict:
        raise bad
    if not isinstance(doc, dict) or doc.get("format") != PATCH_FORMAT or doc.get("scope") != "files":
        raise bad
    if doc.get("method") != delta.get("method") or doc.get("from") != delta.get("from"):
        raise bad
    if doc.get("to") != payload["sha256"]:
        raise bad
    data = doc.get("data")
    dref = delta.get("data") or {}
    if not isinstance(data, dict) or data.get("sha256") != dref.get("sha256") or data.get("bytes") != dref.get("bytes"):
        raise bad
    entries = doc.get("entries")
    if not isinstance(entries, list) or len(entries) > MAX_INDEX_FILES:
        raise bad
    pos_of = {e["path"]: i for i, e in enumerate(index["files"])}
    seen, last_pos, end = set(), -1, 0
    for e in entries:
        if not isinstance(e, dict) or e.get("path") not in pos_of or e["path"] in seen:
            raise bad
        seen.add(e["path"])
        t = index["files"][pos_of[e["path"]]]
        if pos_of[e["path"]] <= last_pos:
            raise bad
        last_pos = pos_of[e["path"]]
        if e.get("to") != t["sha256"] or e.get("size") != t["size"]:
            raise bad
        if not is_int(e.get("offset")) or not is_int(e.get("length")):
            raise bad
        if e.get("op") == "delta":
            if not is_hex64(e.get("from")):
                raise bad
        elif e.get("op") == "blob":
            if e.get("codec") == "none":
                if e["length"] != e["size"]:
                    raise bad
            elif e.get("codec") != "zstd":
                raise bad
        else:
            raise bad
        if e["offset"] < end:
            raise bad
        end = e["offset"] + e["length"]
    if end > dref.get("bytes", -1):
        raise bad
    return doc


# ------------------------------------------------------------------ appliers (§2.9)


def apply_full(variant, fetch, zstd):
    payload, full = variant["payload"], variant.get("full") or {}
    files_ref = variant.get("files") or {}
    tree = files_ref.get("layout") == "tree"
    index = None
    if tree:
        index = parse_files_index(fetch(files_ref.get("sha256")), files_ref, payload, zstd)
    corrupt = ContentError("full-corrupt")
    if full.get("codec") not in CODECS or full.get("size") != payload["size"]:
        raise corrupt
    stored = fetch(full.get("sha256"))
    if not stored_matches(stored, full):
        raise corrupt
    try:
        out = decode_object(stored, full["codec"], full["size"], zstd)
    except Exception:
        raise corrupt
    if not tree:
        if sha256(out) != payload["sha256"]:
            raise corrupt
        return {"ok": True, "sha256": payload["sha256"], "size": len(out)}
    pos = 0
    for e in index["files"]:
        if sha256(out[pos : pos + e["size"]]) != e["sha256"]:
            raise corrupt
        pos += e["size"]
    return {"ok": True, "files": len(index["files"]), "bytes": pos, "treeDigest": tree_digest(index["files"])}


def apply_delta(variant, k, base, fetch, zstd, skip_base_check=False):
    payload, d = variant["payload"], variant["deltas"][k]
    art = d.get("artifact") or {}
    frame = fetch(art.get("sha256"))
    if not stored_matches(frame, art):
        raise ContentError("delta-artifact-mismatch")
    if not skip_base_check and sha256(base) != d.get("from"):
        raise ContentError("delta-base-mismatch")
    check_window(frame, d["memBytes"])
    try:
        out = zstd.decode(frame, payload["size"], prefix=base)
    except Exception:
        raise ContentError("delta-apply-failed")
    if sha256(out) != payload["sha256"]:
        raise ContentError("delta-apply-failed")
    return {"ok": True, "sha256": payload["sha256"], "size": len(out)}


def apply_file(variant, k, installed, fetch, zstd):
    """installed: {claimed sha256: bytes}. k: index of a `files`-scope delta set, or None for the
    `file` strategy."""
    payload, files_ref = variant["payload"], variant["files"]
    index = parse_files_index(fetch(files_ref.get("sha256")), files_ref, payload, zstd)
    container = index["layout"] == "container"
    gaps = None
    if container:
        g = files_ref.get("gaps") or {}
        stored = fetch(g.get("sha256"))
        try:
            if not stored_matches(stored, g) or not is_int(g.get("size")):
                raise ValueError()
            gaps = decode_object(stored, g.get("codec"), g["size"], zstd)
        except Exception:
            raise ContentError("files-layout-mismatch")
    entries, data, mem = {}, None, None
    st = {"reusedFiles": 0, "deltaFiles": 0, "blobFiles": 0, "downloadedBytes": 0}
    if k is not None:
        d = variant["deltas"][k]
        patch = parse_patch(fetch((d.get("patch") or {}).get("sha256")), d, payload, index, zstd)
        dref = d.get("data") or {}
        data = fetch(dref.get("sha256"))
        if not stored_matches(data, dref):
            raise ContentError("delta-artifact-mismatch")
        entries = {e["path"]: e for e in patch["entries"]}
        mem = d["memBytes"]
        st["downloadedBytes"] = d["patch"]["bytes"] + dref["bytes"]
    outs = []
    for f in index["files"]:
        h, path = f["sha256"], f["path"]
        e = entries.get(path)
        if h in installed:
            out = installed[h]
            st["reusedFiles"] += 1
        elif e is not None and e["op"] == "delta":
            base = installed.get(e["from"])
            if base is None or sha256(base) != e["from"]:
                raise ContentError("delta-base-mismatch", path=path)
            frame = data[e["offset"] : e["offset"] + e["length"]]
            check_window(frame, mem, path=path)
            try:
                out = zstd.decode(frame, f["size"], prefix=base)
            except Exception:
                raise ContentError("delta-apply-failed", path=path)
            if sha256(out) != h:
                raise ContentError("delta-apply-failed", path=path)
            st["deltaFiles"] += 1
        elif e is not None:
            try:
                out = decode_object(data[e["offset"] : e["offset"] + e["length"]], e["codec"], f["size"], zstd)
            except Exception:
                raise ContentError("file-corrupt", path=path)
            if sha256(out) != h:
                raise ContentError("file-corrupt", path=path)
            st["blobFiles"] += 1
        elif k is None:
            b = f["blob"]
            stored = fetch(b["sha256"])
            try:
                if not stored_matches(stored, b):
                    raise ValueError()
                out = decode_object(stored, b["codec"], f["size"], zstd)
            except Exception:
                raise ContentError("file-corrupt", path=path)
            if sha256(out) != h:
                raise ContentError("file-corrupt", path=path)
            st["blobFiles"] += 1
            st["downloadedBytes"] += b["bytes"]
        else:
            raise ContentError("file-source-missing", path=path)
        outs.append(out)
    if not container:
        for f, out in zip(index["files"], outs):
            if len(out) != f["size"] or sha256(out) != f["sha256"]:
                raise ContentError("file-corrupt", path=f["path"])
        return {"ok": True, "files": len(outs), "bytes": sum(len(o) for o in outs),
                "treeDigest": tree_digest(index["files"]), **st}
    buf, pos, gp = bytearray(), 0, 0
    for f, out in zip(index["files"], outs):
        g = f["offset"] - pos
        buf += gaps[gp : gp + g]
        gp += g
        buf += out
        pos = f["offset"] + f["size"]
    buf += gaps[gp:]
    if len(buf) != payload["size"] or sha256(buf) != payload["sha256"]:
        raise ContentError("payload-hash-mismatch")
    return {"ok": True, "sha256": payload["sha256"], "size": len(buf), **st}


# ------------------------------------------------------------------ packSetId, stamp (§2.8, §2.9)


def pack_set_id(entries):
    seen = set()
    for e in entries:
        if not is_pack_id(e.get("packId")) or not is_hex64(e.get("releaseSha256")) or e["packId"] in seen:
            return None
        seen.add(e["packId"])
    lines = sorted((e["packId"].encode(), f"{e['packId']} {e['releaseSha256']}\n") for e in entries)
    return sha256("".join(l for _, l in lines).encode())


def _content_ok(c):
    if not is_int(c.get("contentApi"), 1):
        return False
    pins, exp = c.get("pins"), c.get("expects")
    if not isinstance(pins, list) or not isinstance(exp, list):
        return False
    if len(pins) > MAX_CONTENT_PINS or len(exp) > MAX_CONTENT_PINS:
        return False
    seen = set()
    for p in pins:
        if not isinstance(p, dict) or not is_pack_id(p.get("pack")) or p["pack"] in seen:
            return False
        seen.add(p["pack"])
        r = p.get("release")
        if not isinstance(r, dict) or not is_hex64(r.get("sha256")) or not is_int(r.get("seq"), 1):
            return False
        if not isinstance(r.get("version"), str) or not VERSION.match(r["version"]):
            return False
    seen = set()
    for x in exp:
        if not isinstance(x, dict) or not is_pack_id(x.get("pack")) or x["pack"] in seen:
            return False
        seen.add(x["pack"])
        if type(x.get("required")) is not bool:
            return False
        if not isinstance(x.get("delivery"), str) or not VOCAB_TOKEN.match(x["delivery"]):
            return False
    return True


def parse_content_stamp(data):
    bad = {"ok": False, "error": "content-stamp-invalid"}
    try:
        doc = strict_json(data)
    except _Strict:
        return bad
    if not isinstance(doc, dict) or doc.get("format") != CONTENT_STAMP_FORMAT or not _content_ok(doc):
        return bad
    return {"ok": True, "content": {"contentApi": doc["contentApi"], "pins": doc["pins"], "expects": doc["expects"]}}


# ------------------------------------------------------------------ selection and mapping (§2.9)


def _usable(ref):
    return isinstance(ref, dict) and ref.get("codec") in CODECS


def _readable(files):
    return (_usable(files) and files.get("format") == FILES_FORMAT
            and isinstance(files.get("size"), int) and files["size"] <= MAX_FILES_INDEX_BYTES)


def _variant_usable(v):
    f = v.get("files") or {}
    return f.get("layout") == "container" or (f.get("layout") == "tree" and _readable(f))


def select_variant(variants, prefs):
    axes = prefs.get("axes") or {}
    best = None
    for i, v in enumerate(variants):
        if not _variant_usable(v):
            continue
        eng = (v.get("requires") or {}).get("engine")
        if eng is not None and eng != prefs.get("engine"):
            continue
        key, ok = [], True
        for axis in sorted(v.get("variant", {}), key=lambda a: a.encode()):
            lst = axes.get(axis)
            if lst is None or v["variant"][axis] not in lst:
                ok = False
                break
            key.append(lst.index(v["variant"][axis]))
        if ok and (best is None or key < best[0]):
            best = (key, i)
    return {"index": best[1]} if best else {"error": "pack-no-variant"}


def _sb(ref):
    return {"sha256": ref["sha256"], "bytes": ref["bytes"]}


def plan_target(variant, record_sha256, files_index):
    t = {"release": record_sha256, "payload": variant["payload"], "full": None, "platform": None,
         "chunks": None, "files": None, "deltas": []}
    if not _variant_usable(variant):
        return t
    files = variant.get("files") or {}
    container = files.get("layout") == "container"
    full = variant.get("full")
    if _usable(full) and full.get("size") == variant["payload"]["size"]:
        t["full"] = ({"bytes": full["bytes"], "requests": 1} if container
                     else {"bytes": full["bytes"] + files["bytes"], "requests": 2})
    gaps = files.get("gaps")
    if files_index is not None and _readable(files) and (not container or _usable(gaps)):
        t["files"] = {"indexBytes": files["bytes"], "gapsBytes": gaps["bytes"] if container else 0,
                      "files": [{"sha256": e["sha256"], "blobBytes": e["blob"]["bytes"]} for e in files_index["files"]]}
    for d in variant.get("deltas") or []:
        common = {"method": d["method"], "from": d["from"], "memBytes": d["memBytes"]}
        if d.get("scope") == "payload" and container and isinstance(d.get("artifact"), dict):
            t["deltas"].append({"id": d["artifact"]["sha256"], **common, "artifacts": [_sb(d["artifact"])]})
        elif d.get("scope") == "files" and t["files"] is not None and _usable(d.get("patch")):
            arts = [_sb(files)] + ([_sb(gaps)] if container else []) + [_sb(d["patch"]), _sb(d["data"])]
            t["deltas"].append({"id": d["patch"]["sha256"], **common, "artifacts": arts})
    return t


# ------------------------------------------------------------------ the planner (A7 §4.2, §2.9)


def plan(inp):
    t, inst, caps = inp["target"], inp["installed"], inp["caps"]
    if any(i["payloadSha256"] == t["payload"]["sha256"] for i in inst):
        return {"strategy": "noop", "bytes": 0, "requests": 0, "cost": 0, "peakDisk": 0, "fallbacks": []}
    if t.get("platform"):
        if t["platform"]["transport"] in caps.get("transports", []):
            return {"strategy": "platform", "transport": t["platform"]["transport"], "fallbacks": []}
        return {"error": "plan-transport-unsupported"}
    strategies = set(caps.get("strategies", []))
    have = {i["payloadSha256"] for i in inst}
    cands = []
    if "delta" in strategies:
        for k, d in enumerate(t.get("deltas") or []):
            if d["method"] in caps.get("patchMethods", []) and d["from"] in have and d["memBytes"] <= caps["memBudget"]:
                cands.append({"strategy": "delta", "delta": d["id"], "bytes": sum(a["bytes"] for a in d["artifacts"]),
                              "requests": len(d["artifacts"]), "_ord": k})
    seeds = [i["chunks"] for i in inst if i.get("chunks")]
    if "chunk" in strategies and t.get("chunks") and seeds:
        S = set()
        for s in seeds:
            S |= set(s["ids"])
        seen, prev, runs, nbytes = set(), None, 0, t["chunks"]["indexBytes"]
        for r in t["chunks"]["records"]:
            cid, ln, cl, bi, bo = r
            if cid in S or cid in seen:
                continue
            seen.add(cid)
            nbytes += cl
            if prev is None or bi != prev[3] or bo != prev[4] + prev[2]:
                runs += 1
            prev = r
        cands.append({"strategy": "chunk", "bytes": nbytes, "requests": 1 + runs, "_ord": 0})
    inst_files = [i["files"] for i in inst if i.get("files") is not None]
    if "file" in strategies and t.get("files") and inst_files:
        H = set().union(*map(set, inst_files))
        tf, missing = t["files"], {}
        for f in tf["files"]:
            if f["sha256"] not in H and f["sha256"] not in missing:
                missing[f["sha256"]] = f["blobBytes"]
        cands.append({"strategy": "file", "bytes": tf["indexBytes"] + tf["gapsBytes"] + sum(missing.values()),
                      "requests": 1 + (1 if tf["gapsBytes"] > 0 else 0) + len(missing), "_ord": 0})
    if t.get("full"):
        cands.append({"strategy": "full", "bytes": t["full"]["bytes"], "requests": t["full"].get("requests", 1), "_ord": 0})
    if not cands:
        return {"error": "plan-no-strategy"}
    w = caps.get("requestWeight", PLAN_REQUEST_WEIGHT)
    for c in cands:
        c["cost"] = c["bytes"] + w * c["requests"]
        c["peakDisk"] = t["payload"]["size"] + c["bytes"]
    feas = [c for c in cands if c["peakDisk"] <= caps["freeDisk"]]
    if not feas:
        return {"error": "plan-insufficient-disk"}
    feas.sort(key=lambda c: (c["cost"], RANK[c["strategy"]], c["_ord"]))
    chosen, rest = feas[0], feas[1:]
    rest = [c for c in rest if c["strategy"] != "full"] + [c for c in rest if c["strategy"] == "full"]

    def pub(c, with_disk):
        o = {"strategy": c["strategy"]}
        if "delta" in c:
            o["delta"] = c["delta"]
        o.update(bytes=c["bytes"], requests=c["requests"], cost=c["cost"])
        if with_disk:
            o["peakDisk"] = c["peakDisk"]
        return o

    res = pub(chosen, True)
    res["fallbacks"] = [pub(c, False) for c in rest]
    return res
