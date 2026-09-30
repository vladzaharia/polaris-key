"""Reference implementation of the content-delivery operations (pkey-chunks/1, pkey-files/1,
chunk/delta/file/full apply, path rules, install planner). Pure stdlib except the zstd backend."""
import hashlib
import json
import struct

MAGIC = b"PKEYCHNK"
HDR, REC = 64, 48
FLAG_FILE_AWARE = 1
REQUEST_WEIGHT = 16384  # default; caps.requestWeight overrides
RANK = {"noop": 0, "platform": 1, "delta": 2, "chunk": 3, "file": 4, "full": 5}


class ContentError(Exception):
    def __init__(self, code, **detail):
        super().__init__(code)
        self.code = code
        self.detail = detail

    def verdict(self):
        return {"ok": False, "error": self.code, **self.detail}


def sha256(b):
    return hashlib.sha256(b).hexdigest()


# ------------------------------------------------------------------ zstd backends


class StdlibZstd:
    """Python 3.14+ compression.zstd. A raw-content ZstdDict used as a prefix is exactly --patch-from."""

    def __init__(self):
        from compression import zstd

        self.z = zstd
        self.name = f"compression.zstd (libzstd {zstd.zstd_version})"

    def decompress(self, data, dict_bytes=None, size=None):
        z = self.z
        opts = {z.DecompressionParameter.window_log_max: 31}
        if dict_bytes is None:
            return z.decompress(data, options=opts)
        return z.decompress(data, zstd_dict=z.ZstdDict(dict_bytes, is_raw=True).as_prefix, options=opts)


class ZstandardPkg:
    """The `zstandard` PyPI package (Python 3.9+)."""

    def __init__(self):
        import zstandard as zs

        self.zs = zs
        self.name = f"zstandard {zs.__version__} (libzstd {zs.ZSTD_VERSION})"

    def decompress(self, data, dict_bytes=None, size=None):
        zs = self.zs
        kw = {"max_window_size": 2**31}
        if dict_bytes is not None:
            kw["dict_data"] = zs.ZstdCompressionDict(dict_bytes, dict_type=zs.DICT_TYPE_RAWCONTENT)
        return zs.ZstdDecompressor(**kw).decompress(data, max_output_size=size or 0)


# ------------------------------------------------------------------ vector plumbing


def mutate(b, muts):
    if not muts:
        return b
    b = bytearray(b)
    for m in muts:
        op = m["op"]
        if op == "truncate":
            del b[m["length"]:]
        elif op == "xor":
            b[m["offset"]] ^= m["value"]
        elif op == "putU16":
            struct.pack_into("<H", b, m["offset"], m["value"])
        elif op == "putU32":
            struct.pack_into("<I", b, m["offset"], m["value"])
        elif op == "putU64":
            struct.pack_into("<Q", b, m["offset"], m["value"])
        else:
            raise ValueError(op)
    return bytes(b)


# ------------------------------------------------------------------ pkey-chunks/1


def parse_chunk_index(b):
    if len(b) < HDR:
        raise ContentError("chunks.bad_length")
    if b[:8] != MAGIC:
        raise ContentError("chunks.bad_magic")
    ver, rs, flags, n, nb, psize = struct.unpack_from("<HHIIIQ", b, 8)
    if ver != 1:
        raise ContentError("chunks.unsupported_version")
    if rs != REC:
        raise ContentError("chunks.bad_record_size")
    if flags & ~FLAG_FILE_AWARE:
        raise ContentError("chunks.bad_flags")
    if len(b) != HDR + REC * (n + nb):
        raise ContentError("chunks.bad_length")
    bundles = []
    for j in range(nb):
        o = HDR + REC * (n + j)
        size, res = struct.unpack_from("<QQ", b, o + 32)
        if res != 0:
            raise ContentError("chunks.reserved_nonzero", bundle=j)
        bundles.append((b[o : o + 32].hex(), size))
    recs, total = [], 0
    for i in range(n):
        o = HDR + REC * i
        ln, cl, bi, bo = struct.unpack_from("<IIII", b, o + 32)
        if ln == 0:
            raise ContentError("chunks.zero_length", chunk=i)
        if cl == 0 or cl > ln:
            raise ContentError("chunks.bad_clen", chunk=i)
        if bi >= nb:
            raise ContentError("chunks.bad_bundle_ref", chunk=i)
        if bo + cl > bundles[bi][1]:
            raise ContentError("chunks.bad_bundle_range", chunk=i)
        total += ln
        recs.append((b[o : o + 32].hex(), ln, cl, bi, bo))
    if total != psize:
        raise ContentError("chunks.size_mismatch")
    return {"flags": flags, "payloadSize": psize, "payloadSha256": b[32:64].hex(), "records": recs, "bundles": bundles}


def index_summary(ix):
    r = ix["records"]
    return {
        "ok": True,
        "chunkCount": len(r),
        "bundleCount": len(ix["bundles"]),
        "payloadSize": ix["payloadSize"],
        "payloadSha256": ix["payloadSha256"],
        "fileAware": bool(ix["flags"] & FLAG_FILE_AWARE),
        "uniqueChunks": len({x[0] for x in r}),
        "rawStored": sum(1 for x in r if x[1] == x[2]),
        "sumClen": sum(x[2] for x in r),
        "first": list(r[0]) if r else None,
        "last": list(r[-1]) if r else None,
    }


# ------------------------------------------------------------------ paths (pkey-files/1)

_BAD = set('\\:*?"<>|')
_DEVICES = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}


def _path_ok(p):
    if not 1 <= len(p.encode("utf-8")) <= 1024:
        return False
    if any(not (0x20 <= ord(c) <= 0x7E) or c in _BAD for c in p):
        return False
    segs = p.split("/")
    for s in segs:
        if s in ("", ".", ".."):
            return False
        if s.endswith(" ") or s.endswith("."):
            return False
        if s.split(".", 1)[0].lower() in _DEVICES:
            return False
    return True


def check_paths(paths):
    seen, lower, dirs = set(), set(), set()
    for p in paths:
        if not _path_ok(p):
            return {"error": "files.unsafe_path", "path": p}
        if p in seen:
            return {"error": "files.duplicate_path", "path": p}
        lp = p.lower()
        if lp in lower:
            return {"error": "files.case_collision", "path": p}
        parts = lp.split("/")
        prefixes = {"/".join(parts[:k]) for k in range(1, len(parts))}
        if lp in dirs or prefixes & lower:
            return {"error": "files.path_conflict", "path": p}
        seen.add(p)
        lower.add(lp)
        dirs |= prefixes
    return {"ok": True}


# ------------------------------------------------------------------ apply: full / delta


def apply_full(blob_bytes, expected_sha, expected_size, zstd):
    try:
        out = zstd.decompress(blob_bytes, size=expected_size)
    except Exception:
        raise ContentError("full.corrupt")
    if len(out) != expected_size or sha256(out) != expected_sha:
        raise ContentError("full.corrupt")
    return out


def apply_delta(base, d, artifact, zstd, skip_base_check=False, **detail):
    if sha256(artifact) != d["artifactSha256"]:
        raise ContentError("delta.artifact_mismatch", **detail)
    if not skip_base_check and sha256(base) != d["from"]:
        raise ContentError("delta.base_mismatch", **detail)
    try:
        out = zstd.decompress(artifact, dict_bytes=base, size=d["size"])
    except Exception:
        raise ContentError("delta.apply_failed", **detail)
    if len(out) != d["size"] or sha256(out) != d["to"]:
        raise ContentError("delta.apply_failed", **detail)
    return out


# ------------------------------------------------------------------ apply: chunk


def apply_chunk(target_ix_bytes, seeds, fetch, expected_sha, expected_size, repair, zstd):
    """seeds: [(payload_bytes, index_bytes)]; fetch(bundle_sha, offset, length) -> bytes (may be short)."""
    T = parse_chunk_index(target_ix_bytes)
    if T["payloadSha256"] != expected_sha or T["payloadSize"] != expected_size:
        raise ContentError("chunks.payload_mismatch")
    S = {}
    for si, (payload, ib) in enumerate(seeds):
        I = parse_chunk_index(ib)
        off = 0
        for cid, ln, *_ in I["records"]:
            S.setdefault(cid, (si, off))
            off += ln

    def fetch_rec(i, r):
        cid, ln, cl, bi, bo = r
        raw = fetch(T["bundles"][bi][0], bo, cl)
        if len(raw) < cl:
            raise ContentError("bundle.truncated", chunk=i)
        if cl == ln:
            data = raw
        else:
            try:
                data = zstd.decompress(raw, size=ln)
            except Exception:
                raise ContentError("chunk.corrupt", chunk=i)
        if len(data) != ln or sha256(data) != cid:
            raise ContentError("chunk.corrupt", chunk=i)
        return data

    out, first, kinds = bytearray(), {}, []
    st = {"fetchedChunks": 0, "fetchedBytes": 0, "requests": 0, "seedChunks": 0, "selfChunks": 0}
    prev = None
    for i, r in enumerate(T["records"]):
        cid, ln, cl, bi, bo = r
        if cid in S:
            si, so = S[cid]
            data = seeds[si][0][so : so + ln]
            kinds.append("seed")
            st["seedChunks"] += 1
        elif cid in first:
            data = bytes(out[first[cid] : first[cid] + ln])
            kinds.append("self")
            st["selfChunks"] += 1
        else:
            if prev is None or bi != prev[3] or bo != prev[4] + prev[2]:
                st["requests"] += 1
            prev = r
            data = fetch_rec(i, r)
            kinds.append("fetch")
            st["fetchedChunks"] += 1
            st["fetchedBytes"] += cl
        first.setdefault(cid, len(out))
        out += data
    repaired = []
    if sha256(out) != expected_sha:
        if not repair:
            raise ContentError("payload.hash_mismatch")
        pos = 0
        for i, r in enumerate(T["records"]):
            ln = r[1]
            if kinds[i] == "seed" and sha256(out[pos : pos + ln]) != r[0]:
                out[pos : pos + ln] = fetch_rec(i, r)
                repaired.append(i)
            pos += ln
        if sha256(out) != expected_sha:
            raise ContentError("payload.hash_mismatch")
    return bytes(out), {"ok": True, "sha256": expected_sha, "size": len(out), **st, "repairedChunks": repaired}


# ------------------------------------------------------------------ apply: file


def apply_files(inst_payload, inst_ix, tgt_ix, gaps, layout, file_deltas, load_delta, file_blobs, load_blob,
                expected_sha, expected_size, zstd):
    """file_blobs: {sha: {"codec"}}; load_blob(sha) -> raw bytes; load_delta(d) -> artifact bytes.
    Returns (payload_or_tree, verdict). For layout 'tree' the first element is {path: bytes}."""
    files = tgt_ix["files"]
    pc = check_paths([f["path"] for f in files])
    if not pc.get("ok"):
        raise ContentError(pc["error"], path=pc["path"])
    if layout == "container":
        pos, gap_total = 0, 0
        for f in files:
            if f["offset"] < pos:
                raise ContentError("files.layout_mismatch")
            gap_total += f["offset"] - pos
            pos = f["offset"] + f["size"]
        size = tgt_ix["payload"]["size"]
        if size < pos or size != expected_size:
            raise ContentError("files.layout_mismatch")
        gap_total += size - pos
        if gaps is None or len(gaps) != gap_total:
            raise ContentError("files.layout_mismatch")
    H = {}
    for f in inst_ix["files"]:
        H.setdefault(f["sha256"], (f["offset"], f["size"]))
    dmap = {d["path"]: d for d in file_deltas}
    st = {"reusedFiles": 0, "deltaFiles": 0, "blobFiles": 0, "downloadedBytes": 0}
    datas = []
    for f in files:
        h, path = f["sha256"], f["path"]
        d = dmap.get(path)
        if h in H:
            o, s = H[h]
            data = inst_payload[o : o + s]
            st["reusedFiles"] += 1
        elif d is not None and d["to"] == h:
            if d["from"] not in H:
                raise ContentError("delta.base_mismatch", path=path)
            o, s = H[d["from"]]
            art = load_delta(d)
            data = apply_delta(inst_payload[o : o + s], d, art, zstd, path=path)
            st["deltaFiles"] += 1
            st["downloadedBytes"] += len(art)
        elif h in file_blobs:
            raw = load_blob(h)
            try:
                data = zstd.decompress(raw, size=f["size"]) if file_blobs[h]["codec"] == "zstd" else raw
            except Exception:
                raise ContentError("file.corrupt", path=path)
            if len(data) != f["size"] or sha256(data) != h:
                raise ContentError("file.corrupt", path=path)
            st["blobFiles"] += 1
            st["downloadedBytes"] += len(raw)
        else:
            raise ContentError("file.source_missing", path=path)
        datas.append(data)
    if layout == "tree":
        lines = []
        for f, data in zip(files, datas):
            if len(data) != f["size"] or sha256(data) != f["sha256"]:
                raise ContentError("file.corrupt", path=f["path"])
            lines.append((f["path"].encode(), f"{f['sha256']} {f['size']} {f['path']}\n"))
        digest = sha256("".join(l for _, l in sorted(lines)).encode())
        return {f["path"]: d for f, d in zip(files, datas)}, {
            "ok": True, "files": len(files), "bytes": sum(f["size"] for f in files), "treeDigest": digest, **st}
    out, pos, gp = bytearray(), 0, 0
    for f, data in zip(files, datas):
        g = f["offset"] - pos
        out += gaps[gp : gp + g]
        gp += g
        out += data
        pos = f["offset"] + f["size"]
    out += gaps[gp:]
    if sha256(out) != expected_sha:
        raise ContentError("payload.hash_mismatch")
    return bytes(out), {"ok": True, "sha256": expected_sha, "size": len(out), **st}


# ------------------------------------------------------------------ planner


def _chunk_records(spec, load_index):
    if "records" in spec:
        return [tuple(r) for r in spec["records"]]
    return parse_chunk_index(load_index(spec["index"]))["records"]


def _seed_ids(spec, load_index):
    if "ids" in spec:
        return set(spec["ids"])
    return {r[0] for r in parse_chunk_index(load_index(spec["index"]))["records"]}


def plan(inp, load_index=None):
    t, inst, caps = inp["target"], inp["installed"], inp["caps"]
    if any(i["payloadSha256"] == t["payload"]["sha256"] for i in inst):
        return {"strategy": "noop", "bytes": 0, "requests": 0, "cost": 0, "peakDisk": 0, "fallbacks": []}
    if t.get("platform"):
        if t["platform"]["transport"] in caps.get("transports", []):
            return {"strategy": "platform", "transport": t["platform"]["transport"], "fallbacks": []}
        return {"error": "plan.transport_unsupported"}
    strategies = set(caps.get("strategies", []))
    have = {i["payloadSha256"] for i in inst}
    cands = []
    if "delta" in strategies:
        for k, d in enumerate(t.get("deltas", [])):
            if d["method"] in caps.get("patchMethods", []) and d["from"] in have and d["memBytes"] <= caps["memBudget"]:
                cands.append({"strategy": "delta", "delta": d["id"], "bytes": sum(a["bytes"] for a in d["artifacts"]),
                              "requests": len(d["artifacts"]), "_ord": k})
    seeds = [i["chunks"] for i in inst if i.get("chunks")]
    if "chunk" in strategies and t.get("chunks") and seeds:
        S = set()
        for s in seeds:
            S |= _seed_ids(s, load_index)
        seen, prev, runs = set(), None, 0
        nbytes = t["chunks"]["indexBytes"]
        for r in _chunk_records(t["chunks"], load_index):
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
        H = set()
        for fl in inst_files:
            H |= set(fl)
        tf = t["files"]
        missing = {}
        for f in tf["files"]:
            if f["sha256"] not in H and f["sha256"] not in missing:
                missing[f["sha256"]] = f["blobBytes"]
        cands.append({"strategy": "file", "bytes": tf["indexBytes"] + tf["gapsBytes"] + sum(missing.values()),
                      "requests": 1 + (1 if tf["gapsBytes"] > 0 else 0) + len(missing), "_ord": 0})
    if t.get("full"):
        cands.append({"strategy": "full", "bytes": t["full"]["bytes"], "requests": 1, "_ord": 0})
    if not cands:
        return {"error": "plan.no_strategy"}
    w = caps.get("requestWeight", REQUEST_WEIGHT)
    for c in cands:
        c["cost"] = c["bytes"] + w * c["requests"]
        c["peakDisk"] = t["payload"]["size"] + c["bytes"]
    feas = [c for c in cands if c["peakDisk"] <= caps["freeDisk"]]
    if not feas:
        return {"error": "plan.insufficient_disk"}
    feas.sort(key=lambda c: (c["cost"], RANK[c["strategy"]], c["_ord"]))
    chosen, rest = feas[0], feas[1:]
    rest = [c for c in rest if c["strategy"] != "full"] + [c for c in rest if c["strategy"] == "full"]

    def pub(c, full=True):
        o = {"strategy": c["strategy"]}
        if "delta" in c:
            o["delta"] = c["delta"]
        o.update(bytes=c["bytes"], requests=c["requests"], cost=c["cost"])
        if full:
            o["peakDisk"] = c["peakDisk"]
        return o

    res = pub(chosen)
    res["fallbacks"] = [pub(c, False) for c in rest]
    return res
