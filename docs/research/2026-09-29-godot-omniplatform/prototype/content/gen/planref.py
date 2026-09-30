"""Planner cases: hand-designed synthetic rows plus rows derived from the real vector data."""
import copy, json
import refapply

pc = refapply.pc


def plan(inp, store):
    return pc.plan(inp, lambda ref: store.raw_mutated(ref))


H = lambda c: c * 64  # noqa: E731  synthetic 64-hex payload ids
T_SHA, R1, R0, R2 = H("a"), H("1"), H("0"), H("2")


def base():
    recs = [[f"c{i}", 1_000_000, 400_000, 0, 400_000 * i] for i in range(10)]
    return {
        "target": {
            "release": "r3",
            "payload": {"sha256": T_SHA, "size": 10_000_000},
            "full": {"bytes": 4_000_000},
            "platform": None,
            "chunks": {"indexBytes": 64 + 48 * 11, "records": recs},
            "files": {"indexBytes": 2_000, "gapsBytes": 1_000,
                      "files": [{"sha256": f"f{i}", "blobBytes": b} for i, b in enumerate([10, 20, 30, 700_000, 500_000])]},
            "deltas": [{"id": "r1-r3", "method": "zstd-patch-from", "from": R1, "memBytes": 25_000_000,
                        "artifacts": [{"sha256": H("d"), "bytes": 300_000}]}],
        },
        "installed": [{"release": "r1", "payloadSha256": R1,
                       "chunks": {"ids": [f"c{i}" for i in range(7)]},
                       "files": ["f0", "f1", "f2"]}],
        "caps": {"strategies": ["delta", "chunk", "file", "full"], "patchMethods": ["zstd-patch-from"],
                 "transports": ["pkey-cdn"], "memBudget": 64 * 2**20, "freeDisk": 2**30},
    }


def synthetic_cases():
    out = []

    def add(cid, desc, fn):
        i = base()
        fn(i)
        out.append({"id": cid, "description": desc, "input": i})

    add("plan-noop", "The installed payload already is the target.",
        lambda i: i["installed"].append({"release": "r3", "payloadSha256": T_SHA, "chunks": None, "files": None}))
    add("plan-platform", "The pack is bound to a platform transport the SDK supports.",
        lambda i: (i["target"].update(platform={"transport": "apple-ba"}), i["caps"]["transports"].append("apple-ba")))
    add("plan-platform-unsupported", "Bound to a platform transport the SDK lacks: no silent CDN fallback.",
        lambda i: i["target"].update(platform={"transport": "play-pad"}))
    add("plan-delta-wins", "delta 300,000 B beats chunk (3 contiguous missing chunks), file and full.", lambda i: None)
    add("plan-delta-other-base", "The only delta starts from a release that is not installed.",
        lambda i: i["target"]["deltas"][0].update({"from": R0}))
    add("plan-delta-over-memory", "The delta needs more memory than the budget.",
        lambda i: i["caps"].update(memBudget=16 * 2**20))
    add("plan-delta-method-unsupported", "The SDK does not advertise zstd-patch-from.",
        lambda i: i["caps"].update(patchMethods=[]))
    add("plan-no-seed-index", "No installed chunk index and no delta: file beats full.",
        lambda i: (i["installed"][0].update(chunks=None), i["target"].update(deltas=[])))
    add("plan-first-install", "Nothing installed: only full is feasible.", lambda i: i.update(installed=[]))

    def heavy(i):
        recs = [[f"s{k}", 10_000, 5_000, 0, 5_000 * k] for k in range(100)]
        i["target"].update(payload={"sha256": T_SHA, "size": 1_000_000}, full={"bytes": 500_000}, deltas=[], files=None,
                           chunks={"indexBytes": 64 + 48 * 101, "records": recs})
        i["installed"][0]["chunks"] = {"ids": [f"s{k}" for k in range(0, 100, 2)]}
    add("plan-request-heavy", "50 scattered missing chunks: request weight makes full cheaper than chunk.", heavy)

    add("plan-tie-rank", "delta and chunk cost exactly the same: rank prefers delta.",
        lambda i: i["target"]["deltas"][0].update(artifacts=[{"sha256": H("d"), "bytes": 600_000}, {"sha256": H("e"), "bytes": 600_592}]))

    def two(i):
        d0 = i["target"]["deltas"][0]
        i["target"]["deltas"] = [dict(d0, id="big", artifacts=[{"sha256": H("d"), "bytes": 900_000}]),
                                 dict(d0, id="small-a", artifacts=[{"sha256": H("e"), "bytes": 200_000}]),
                                 dict(d0, id="small-b", artifacts=[{"sha256": H("f"), "bytes": 200_000}])]
    add("plan-two-deltas", "Three deltas from the installed base: the cheapest wins, equal cost keeps menu order.", two)
    add("plan-disk-limited", "Free disk admits delta and chunk but not file or full.",
        lambda i: i["caps"].update(freeDisk=11_201_000))
    add("plan-insufficient-disk", "No strategy fits in free disk.", lambda i: i["caps"].update(freeDisk=5_000_000))

    def seeds2(i):
        i["target"]["deltas"] = []
        i["installed"] = [{"release": "r1", "payloadSha256": R1, "chunks": {"ids": [f"c{k}" for k in range(5)]}, "files": None},
                          {"release": "r2", "payloadSha256": R2, "chunks": {"ids": [f"c{k}" for k in range(5, 9)]}, "files": None}]
    add("plan-two-seeds", "Two installed releases seed disjoint chunks; only c9 is fetched.", seeds2)

    def runs(i):
        recs = [["a", 1000, 100, 0, 0], ["b", 1000, 100, 0, 100], ["a", 1000, 100, 0, 0], ["c", 1000, 100, 0, 300],
                ["k", 1000, 100, 2, 0], ["d", 1000, 100, 0, 400], ["e", 1000, 100, 1, 0]]
        i["target"].update(payload={"sha256": T_SHA, "size": 7000}, full={"bytes": 400_000}, deltas=[], files=None,
                           chunks={"indexBytes": 64 + 48 * 10, "records": recs})
        i["installed"][0]["chunks"] = {"ids": ["k", "zz"]}
    add("plan-run-rules", "Duplicate ids are fetched once; a gap or a bundle change starts a new request run; "
        "a seeded record between two missing ones does not break their run.", runs)

    def fl(i):
        i["target"]["files"]["files"][3]["blobBytes"] = 5_000_000
    add("plan-full-always-last", "full is cheaper than file, but fallbacks still list full last.", fl)
    add("plan-caps-full-only", "The SDK advertises no incremental strategy; full is always available.",
        lambda i: i["caps"].update(strategies=[]))
    add("plan-request-weight", "As plan-delta-other-base with requestWeight 4 MiB: chunk's second request outweighs its 2.8 MB saving, so full wins.",
        lambda i: (i["target"]["deltas"][0].update({"from": R0}), i["caps"].update(requestWeight=4 * 2**20)))
    return out


def real_case(store, V1, V2, F1, F2, BLOBS, file_deltas, file_blobs, file_blobs_nodelta, v2_full_bytes):
    import hashlib
    S1 = hashlib.sha256(V1).hexdigest()
    S2 = hashlib.sha256(V2).hexdigest()
    sz = lambda n: BLOBS[n]["size"]  # noqa: E731
    per_file = [{"sha256": BLOBS["files/v2.files.json"]["sha256"], "bytes": sz("files/v2.files.json")},
                {"sha256": BLOBS["files/v2.gaps.zst"]["sha256"], "bytes": sz("files/v2.gaps.zst")}]
    per_file += [{"sha256": d["artifactSha256"], "bytes": sz(d["artifact"]["blob"])} for d in file_deltas]
    per_file += [{"sha256": BLOBS[r["blob"]]["sha256"], "bytes": sz(r["blob"])} for r in file_blobs.values()]
    whole_mem = len(V1) + len(V2)
    per_mem = max(d["size"] for d in file_deltas) * 2
    inp = {
        "target": {
            "release": "v2", "payload": {"sha256": S2, "size": len(V2)}, "full": {"bytes": v2_full_bytes}, "platform": None,
            "chunks": {"indexBytes": sz("chunks/v2.pkc"), "index": {"blob": "chunks/v2.pkc"}},
            "files": {"indexBytes": sz("files/v2.files.json"), "gapsBytes": sz("files/v2.gaps.zst"),
                      "files": [{"sha256": f["sha256"], "blobBytes": sz(file_blobs_nodelta[f["sha256"]]["blob"]) if f["sha256"] in file_blobs_nodelta else 0}
                                for f in F2["files"]]},
            "deltas": [
                {"id": "v1-v2-whole", "method": "zstd-patch-from", "from": S1, "memBytes": whole_mem,
                 "artifacts": [{"sha256": BLOBS["deltas/v1-v2.pf.zst"]["sha256"], "bytes": sz("deltas/v1-v2.pf.zst")}]},
                {"id": "v1-v2-files", "method": "zstd-patch-from", "from": S1, "memBytes": per_mem, "artifacts": per_file},
            ],
        },
        "installed": [{"release": "v1", "payloadSha256": S1, "chunks": {"index": {"blob": "chunks/v1.pkc"}},
                       "files": [f["sha256"] for f in F1["files"]]}],
        "caps": {"strategies": ["delta", "chunk", "file", "full"], "patchMethods": ["zstd-patch-from"],
                 "transports": ["pkey-cdn"], "memBudget": 64 * 2**20, "freeDisk": 2**30},
    }
    out = [{"id": "plan-real-v1-v2", "description": "The vector set's own v1 -> v2 menu (bytes are the shipped blobs).", "input": inp}]
    i2 = copy.deepcopy(inp)
    i2["caps"]["strategies"] = ["chunk", "file", "full"]
    out.append({"id": "plan-real-no-delta", "description": "As plan-real-v1-v2 for an SDK without delta support.", "input": i2})
    i3 = copy.deepcopy(inp)
    i3["caps"]["memBudget"] = per_mem
    out.append({"id": "plan-real-low-memory", "description": "Memory budget too small for the whole-payload delta: per-file deltas remain.", "input": i3})
    i4 = copy.deepcopy(i2)
    i4["caps"]["requestWeight"] = 65536
    out.append({"id": "plan-real-no-delta-64k", "description": "As plan-real-no-delta with requestWeight 65536: request count tips the choice to full.", "input": i4})
    return out
