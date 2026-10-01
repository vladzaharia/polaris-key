#!/usr/bin/env python3
"""Builds the S-01 asset packs (v1 and v2) with `xcrun ba-package`.

usage: make_packs.py <out_dir> <a6_v1.pck> <a6_v2.pck>

Asset-pack ids use hyphens, not dots: App Store Connect accepts only alphanumerics and hyphens
(Apple Frameworks Engineer, developer forums thread 818337, April 2026); `ba-package` itself
accepts any string.

Four packs, each a directory with a unique prefix `pkba/<role>/` (the system merges all packs into
one namespace) holding `content.pck` and a `.pkey/pack.json` marker:

  pkba-essential-c1  essential (firstInstallation, subsequentUpdate)  small data-only PCK, ~1 MiB
  pkba-prefetch-c1   prefetch  (firstInstallation, subsequentUpdate)  small data-only PCK, ~8 MiB
  pkba-ondemand-c1   onDemand                                          small data-only PCK, ~4 MiB
  pkba-big-c1        onDemand                                          the A6 36 MiB v1/v2 pair

The big pack is A6's unmodified full-project PCK, NOT data-only: it holds project.binary, the class
and uid caches and two .gdc scripts, at res:// root paths. It is here only as the byte baseline for
the differential question; it would fail CONTENT §4.2's pre-mount directory check and must never be
uploaded to App Store Connect as is.

v2 of the three small packs changes one 40-byte JSON file (the minimal change); v2 of the big pack
is A6's v2 (24 changed, 10 added, 5 removed PCK entries: the larger, realistic change).

The small PCKs are written with prototype/patching/tools/pck.py (byte-identical to the exporter).
Padding comes from a seeded PRNG so v1 and v2 share it byte for byte.
"""
import hashlib, json, os, random, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "patching", "tools"))
from pck import write_pck  # noqa: E402

SMALL = {  # role -> (policy, padding bytes)
    "essential": ({"essential": {"installationEventTypes": ["firstInstallation", "subsequentUpdate"]}}, 1 << 20),
    "prefetch": ({"prefetch": {"installationEventTypes": ["firstInstallation", "subsequentUpdate"]}}, 8 << 20),
    "ondemand": ({"onDemand": {}}, 4 << 20),
}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def marker(pack_id, version, pck_path):
    # Stand-in for CONTENT §7's .pkey/pack.json (the real one carries a detached JWS).
    return {"packId": pack_id, "version": version, "contentApi": 1,
            "pckSha256": sha256(pck_path), "note": "S-01 research marker, unsigned"}


def build(out, version, a6_pck):
    src = os.path.join(out, f"src_v{version}")
    shutil.rmtree(src, ignore_errors=True)
    aars = {}
    for role, (policy, pad) in list(SMALL.items()) + [("big", ({"onDemand": {}}, 0))]:
        pack_id = f"pkba-{role}-c1"
        d = os.path.join(src, pack_id, "pkba", role)
        os.makedirs(os.path.join(d, ".pkey"))
        pck = os.path.join(d, "content.pck")
        if role == "big":
            shutil.copyfile(a6_pck, pck)
        else:
            rnd = random.Random(f"pkba-{role}")
            hello = json.dumps({"role": role, "version": version}).encode()
            files = [(f"pkba/{role}/hello.json", hello, 0),
                     (f"pkba/{role}/padding.bin", rnd.randbytes(pad), 0)]
            write_pck(pck, files)
        with open(os.path.join(d, ".pkey", "pack.json"), "w") as f:
            json.dump(marker(pack_id, version, pck), f, indent=1)
        manifest = {"assetPackID": pack_id, "downloadPolicy": policy,
                    "fileSelectors": [{"directory": "pkba"}], "platforms": ["iOS"]}
        mpath = os.path.join(src, pack_id, "Manifest.json")
        with open(mpath, "w") as f:
            json.dump(manifest, f, indent=1)
        aar = os.path.join(out, f"v{version}", f"{pack_id}.aar")
        os.makedirs(os.path.dirname(aar), exist_ok=True)
        subprocess.run(["xcrun", "ba-package", "package", mpath, "-o", aar, "-q"],
                       cwd=os.path.join(src, pack_id), check=True)
        aars[pack_id] = {"aar": aar, "aar_bytes": os.path.getsize(aar), "pck_bytes": os.path.getsize(pck)}
    return aars


def main():
    out, v1, v2 = (os.path.abspath(a) for a in sys.argv[1:4])
    res = {"v1": build(out, 1, v1), "v2": build(out, 2, v2)}
    with open(os.path.join(out, "packs.json"), "w") as f:
        json.dump(res, f, indent=1)
    for v, packs in res.items():
        for pid, r in packs.items():
            print(f"{v} {pid:22} pck={r['pck_bytes']:>10} aar={r['aar_bytes']:>10}")


if __name__ == "__main__":
    main()
