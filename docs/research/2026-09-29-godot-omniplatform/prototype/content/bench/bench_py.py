# Run from content/: bench_py.py stdlib|zstandard. VECTORS_DIR (default vectors) holds the large set;
# PACKS_DIR (default ../patching/out) the 160 MB pair.
import hashlib, json, os, sys, time
sys.path.insert(0, "runners/python")
import pkey_content as pc
z = pc.StdlibZstd() if sys.argv[1] == "stdlib" else pc.ZstandardPkg()
VL = os.environ.get("VECTORS_DIR", "vectors") + "/large/"
L = VL + "blobs/"
doc = json.load(open(VL + "cases.json"))
rd = lambda n: open(L + n, "rb").read()
def best(fn, n=3):
    b, r = 1e9, None
    for _ in range(n):
        t = time.perf_counter(); r = fn(); b = min(b, time.perf_counter() - t)
    return b * 1000, r
mb = lambda nbytes, ms: f"{nbytes / 1e6 / (ms / 1e3):.0f} MB/s"
res = {}
full2 = rd("payload/v2.full.zst"); v1 = z.decompress(rd("payload/v1.full.zst"))
ms, v2 = best(lambda: z.decompress(full2)); res["zstd_decompress"] = f"{ms:.0f} ms, {mb(len(v2), ms)}"
def h():
    x = hashlib.sha256()
    for o in range(0, len(v2), 1 << 20): x.update(v2[o:o + (1 << 20)])
    return x.hexdigest()
ms, _ = best(h); res["sha256_stream"] = mb(len(v2), ms)
cd = next(c for c in doc["applyCases"] if c["id"] == "delta-whole-v1-to-v2")["delta"]; art = rd(cd["artifact"]["blob"])
ms, _ = best(lambda: z.decompress(art, dict_bytes=v1)); res["delta_decode_only"] = f"{ms:.0f} ms, {mb(len(v2), ms)}"
ms, _ = best(lambda: pc.apply_delta(v1, cd, art, z)); res["delta_apply_verified"] = f"{ms:.0f} ms, {mb(len(v2), ms)}"
cc = next(c for c in doc["applyCases"] if c["id"] == "chunk-v1-to-v2"); six, tix = rd("chunks/v1.pkc"), rd("chunks/v2.pkc")
bundles = {h: rd(r["blob"]) for h, r in cc["bundles"].items()}
ms, _ = best(lambda: pc.apply_chunk(tix, [(v1, six)], lambda h, o, l: bundles[h][o:o + l], cc["expectedSha256"], cc["expectedSize"], False, z))
res["chunk_reassembly"] = f"{ms:.0f} ms, {mb(len(v2), ms)}"
fc = next(c for c in doc["applyCases"] if c["id"] == "file-delta-v1-to-v2")
i1, i2, gaps = json.loads(rd("files/v1.files.json")), json.loads(rd("files/v2.files.json")), z.decompress(rd("files/v2.gaps.zst"))
ms, _ = best(lambda: pc.apply_files(v1, i1, i2, gaps, "container", fc["fileDeltas"], lambda d: rd(d["artifact"]["blob"]), fc["fileBlobs"],
                                     lambda s: rd(fc["fileBlobs"][s]["blob"]), fc["expectedSha256"], fc["expectedSize"], z))
res["file_delta_rebuild"] = f"{ms:.0f} ms, {mb(len(v2), ms)}"
ms, _ = best(lambda: pc.parse_chunk_index(tix), 20); res["parse_chunk_index_1531"] = f"{ms:.2f} ms"
B = os.environ.get("PACKS_DIR", "../patching/out") + "/"
bo, bd = open(B + "big_old.bin", "rb").read(), open(B + "big.pf.zst", "rb").read()
try:
    if sys.argv[1] == "stdlib":
        from compression import zstd as Z
        Z.decompress(bd, zstd_dict=Z.ZstdDict(bo, is_raw=True).as_prefix); res["big_default_window"] = "decoded"
    else:
        import zstandard as zs
        zs.ZstdDecompressor(dict_data=zs.ZstdCompressionDict(bo, dict_type=zs.DICT_TYPE_RAWCONTENT)).decompress(bd); res["big_default_window"] = "decoded"
except Exception as e:
    res["big_default_window"] = "FAILS: " + str(e)[:90]
ms, out = best(lambda: z.decompress(bd, dict_bytes=bo), 2); res["big_delta_decode"] = f"{ms:.0f} ms, {mb(len(out), ms)}, sha {hashlib.sha256(out).hexdigest()[:12]}"
print(json.dumps({"python": sys.version.split()[0], "backend": z.name, **res}, indent=1))
