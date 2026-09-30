#!/usr/bin/env python3
"""Python runner for the content vectors. usage: runcases.py <vector-dir> [stdlib|zstandard]"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pkey_content as pc  # noqa: E402


class Store:
    def __init__(self, root, zstd=None):
        self.root = root
        self.zstd = zstd or pc.StdlibZstd()
        self._cache = {}

    def raw(self, name):
        if name not in self._cache:
            with open(os.path.join(self.root, name), "rb") as f:
                self._cache[name] = f.read()
        return self._cache[name]

    def materialize(self, ref):
        """blob -> (zstd decode if codec == zstd) -> mutations."""
        b = self.raw(ref["blob"])
        if ref.get("codec") == "zstd":
            key = ("dec", ref["blob"])
            if key not in self._cache:
                self._cache[key] = self.zstd.decompress(b)
            b = self._cache[key]
        return pc.mutate(b, ref.get("mutate"))

    def raw_mutated(self, ref):
        return pc.mutate(self.raw(ref["blob"]), ref.get("mutate"))


def run_index(store, case):
    try:
        return pc.index_summary(pc.parse_chunk_index(store.raw_mutated(case["index"])))
    except pc.ContentError as e:
        return e.verdict()


def run_apply(store, case, keep=None):
    z = store.zstd
    try:
        s = case["strategy"]
        if s == "full":
            out = pc.apply_full(store.raw_mutated(case["full"]), case["expectedSha256"], case["expectedSize"], z)
            if keep is not None:
                keep["out"] = out
            return {"ok": True, "sha256": case["expectedSha256"], "size": len(out)}
        if s == "delta":
            d = case["delta"]
            out = pc.apply_delta(store.materialize(case["base"]), d, store.raw_mutated(d["artifact"]), z,
                                 skip_base_check=case.get("skipBaseCheck", False))
            if keep is not None:
                keep["out"] = out
            return {"ok": True, "sha256": d["to"], "size": len(out), "artifactBytes": len(store.raw(d["artifact"]["blob"]))}
        if s == "chunk":
            bundles = {h: store.raw_mutated(ref) for h, ref in case["bundles"].items()}

            def fetch(h, off, ln):
                return bundles[h][off : off + ln]

            seeds = [(store.materialize(sd["payload"]), store.raw_mutated(sd["index"])) for sd in case["seeds"]]
            out, v = pc.apply_chunk(store.raw_mutated(case["target"]["index"]), seeds, fetch, case["expectedSha256"],
                                    case["expectedSize"], case["repair"], z)
            if keep is not None:
                keep["out"] = out
            return v
        if s == "file":
            inst = case["installed"]
            t = case["target"]
            gaps = store.materialize(t["gaps"]) if t.get("gaps") else None
            fb = case["fileBlobs"]
            out, v = pc.apply_files(
                store.materialize(inst["payload"]), json.loads(store.raw(inst["files"]["blob"])),
                json.loads(store.raw(t["files"]["blob"])), gaps, t["layout"], case["fileDeltas"],
                lambda d: store.raw_mutated(d["artifact"]), fb, lambda h: store.raw(fb[h]["blob"]),
                case.get("expectedSha256"), case.get("expectedSize"), z)
            if keep is not None:
                keep["out"] = out
            return v
        raise ValueError(s)
    except pc.ContentError as e:
        return e.verdict()


def run_plan(store, case):
    return pc.plan(case["input"], lambda ref: store.raw_mutated(ref))


def main():
    root = sys.argv[1]
    backend = sys.argv[2] if len(sys.argv) > 2 else "stdlib"
    z = pc.StdlibZstd() if backend == "stdlib" else pc.ZstandardPkg()
    doc = json.load(open(os.path.join(root, "cases.json")))
    store = Store(os.path.join(root, "blobs"), z)
    bad = 0
    for name, meta in doc["blobs"].items():
        if pc.sha256(store.raw(name)) != meta["sha256"]:
            print("VECTOR INTEGRITY FAIL", name)
            bad += 1
    results, n = {}, 0
    t0 = time.perf_counter()
    for group, fn in [("chunkIndexCases", run_index), ("applyCases", run_apply), ("planCases", run_plan),
                      ("pathCases", lambda s, c: pc.check_paths(c["paths"]))]:
        for c in doc.get(group, []):
            t = time.perf_counter()
            got = fn(store, c)
            ms = (time.perf_counter() - t) * 1000
            n += 1
            ok = got == c["expected"]
            results[c["id"]] = got
            if not ok:
                bad += 1
                print(f"FAIL {group}/{c['id']}\n  got      {json.dumps(got)[:400]}\n  expected {json.dumps(c['expected'])[:400]}")
            elif os.environ.get("VERBOSE"):
                print(f"ok   {group}/{c['id']} {ms:.1f} ms {json.dumps(got)[:120]}")
    print(f"python {sys.version.split()[0]} [{z.name}]: {n - bad}/{n} cases match, {(time.perf_counter() - t0) * 1000:.0f} ms total")
    if os.environ.get("DUMP"):
        json.dump(results, open(os.environ["DUMP"], "w"), indent=1, sort_keys=True)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
