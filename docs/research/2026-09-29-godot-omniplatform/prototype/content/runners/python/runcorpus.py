#!/usr/bin/env python3
"""The P4-04 oracle: runs pkey_content_v1 (an implementation of plans/P4-01.md §2.7-§2.9 written
independently of tools/gen-content-corpus.ts) over the committed content corpus and plan matrix,
comparing every verdict by canonical JSON.

usage: runcorpus.py <conformance/corpus/v2>        (Python 3.14+, stdlib compression.zstd)"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pkey_content_v1 as pc  # noqa: E402


def canon(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"))


def mutate(b, muts):
    b = bytearray(b)
    for m in muts or []:
        if m["op"] == "truncate":
            del b[m["length"]:]
        elif m["op"] == "xor":
            b[m["offset"]] ^= m["value"]
        else:
            raise ValueError(f"unknown mutation {m}")
    return bytes(b)


class Store:
    def __init__(self, root, zstd):
        self.root, self.zstd, self._raw, self._dec = root, zstd, {}, {}

    def raw(self, name):
        if name not in self._raw:
            with open(os.path.join(self.root, name), "rb") as f:
                self._raw[name] = f.read()
        return self._raw[name]

    def ref(self, ref):
        """A <ref>: the named blob, decoded when codec is zstd (to size), then mutated; or {text}."""
        if "text" in ref:
            return mutate(ref["text"].encode("utf-8"), ref.get("mutate"))
        b = self.raw(ref["blob"])
        if ref.get("codec") == "zstd":
            key = (ref["blob"], ref["size"])
            if key not in self._dec:
                self._dec[key] = self.zstd.decode(b, ref["size"])
            b = self._dec[key]
        return mutate(b, ref.get("mutate"))

    def stored(self, ref):
        """An `objects` entry: raw stored bytes (mutations apply to them), or {text}."""
        if "text" in ref:
            return mutate(ref["text"].encode("utf-8"), ref.get("mutate"))
        return mutate(self.raw(ref["blob"]), ref.get("mutate"))


def installed_files(store, inst):
    """{claimed sha256: bytes}: each installed index entry sliced from the installed payload."""
    payload = store.ref(inst["payload"])
    index = json.loads(store.ref(inst["files"]))
    out, pos = {}, 0
    for e in index["files"]:
        off = e.get("offset", pos)
        out.setdefault(e["sha256"], payload[off : off + e["size"]])
        pos = off + e["size"]
    return payload, out


def run_apply(store, c):
    objects = c.get("objects", {})

    def fetch(sha):
        ref = objects.get(sha)
        return None if ref is None else store.stored(ref)

    z, v = store.zstd, c["variant"]
    try:
        if c["strategy"] == "full":
            return pc.apply_full(v, fetch, z)
        payload, files = installed_files(store, c["installed"])
        if c["strategy"] == "delta":
            return pc.apply_delta(v, c["delta"], payload, fetch, z, c.get("skipBaseCheck", False))
        if c["strategy"] == "file":
            return pc.apply_file(v, c.get("delta"), files, fetch, z)
        raise ValueError(c["strategy"])
    except pc.ContentError as e:
        return e.verdict()


def run_files_index(store, c):
    try:
        doc = pc.parse_files_index(store.stored(c["stored"]), c["files"], c["payload"], store.zstd)
        return {"ok": True, "files": len(doc["files"])}
    except pc.ContentError as e:
        return e.verdict()


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "conformance/corpus/v2"
    z = pc.Zstd()
    content = json.load(open(os.path.join(root, "content", "cases.json")))
    matrix = json.load(open(os.path.join(root, "plan-matrix.json")))
    blobs_dir = os.path.join(root, "content", "blobs")
    store = Store(blobs_dir, z)
    lines, bad_total = [], 0

    # Blob integrity: every file under blobs/ is in the table with its size and SHA-256, and back.
    on_disk = sorted(os.path.relpath(os.path.join(d, f), blobs_dir).replace(os.sep, "/")
                     for d, _, fs in os.walk(blobs_dir) for f in fs)
    bad = 0 if on_disk == sorted(content["blobs"]) else 1
    for name, meta in content["blobs"].items():
        b = store.raw(name)
        if len(b) != meta["size"] or pc.sha256(b) != meta["sha256"]:
            print("BLOB INTEGRITY FAIL", name)
            bad += 1
    lines.append(f"blobs {len(content['blobs']) - bad}/{len(content['blobs'])} match the table")
    bad_total += bad

    hexb = bytes.fromhex
    sections = [
        (content, "applyCases", lambda c: run_apply(store, c)),
        (content, "pathCases", lambda c: pc.check_paths(c["paths"])),
        (content, "filesIndexCases", lambda c: run_files_index(store, c)),
        (content, "packSetIdCases", lambda c: {"packSetId": pc.pack_set_id(c["entries"])}),
        (content, "stampCases", lambda c: pc.parse_content_stamp(c["stamp"])),
        (content, "frameWindowCases", lambda c: {"window": pc.frame_window(hexb(c["header"]))}),
        (matrix, "rows", lambda c: pc.plan(c["input"])),
        (matrix, "variantCases", lambda c: pc.select_variant(c["variants"], c["prefs"])),
        (matrix, "targetCases", lambda c: pc.plan_target(c["variant"], c["recordSha256"], c["filesIndex"])),
    ]
    t0 = time.perf_counter()
    for doc, name, fn in sections:
        cases, bad = doc[name], 0
        for c in cases:
            got = fn(c)
            if canon(got) != canon(c["expect"]):
                bad += 1
                print(f"FAIL {name}/{c['id']}\n  got      {canon(got)[:600]}\n  expected {canon(c['expect'])[:600]}")
        label = "plan-matrix " + name if doc is matrix else name
        lines.append(f"{label} {len(cases) - bad}/{len(cases)}")
        bad_total += bad
    print(f"python {sys.version.split()[0]} [{z.name}], contentCorpusVersion {content['contentCorpusVersion']}, "
          f"planMatrixVersion {matrix['planMatrixVersion']}, {(time.perf_counter() - t0) * 1000:.0f} ms")
    for l in lines:
        print("  " + l)
    print("all verdicts match" if bad_total == 0 else f"{bad_total} mismatches")
    sys.exit(1 if bad_total else 0)


if __name__ == "__main__":
    main()
