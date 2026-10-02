"""Pack fixtures for the Python pack tests (a port of client-core's ``test/packFixtures.ts``):
``files.tree`` pack records signed with the corpus's own release key
(``djdl-release-test-2026``, never a production key), their objects stored raw (``codec:
none``, so no compressor is needed), a fake byte server with Range/If-Range, and a ``files`` delta
set whose one ``delta`` entry is the probe vector (a real ``zstd --patch-from`` frame over a
432-byte base).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Union

from polaris_key.core.jws import sign_jws
from polaris_key.update.packs import ObjectResponse
from polaris_key.update.packs.zstd import PROBE_BASE, PROBE_FRAME

_CORPUS = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "cases.json").read_text(
        encoding="utf-8"
    )
)


def _key(kid: str) -> Dict[str, str]:
    return next(k for k in _CORPUS["keys"] if k["kid"] == kid)


PRODUCT = "djdl"
RELEASE_KID = "djdl-release-test-2026"
PRODUCT_KID = "pkey-test-prod-2026"
RELEASE_KEYS = {RELEASE_KID: _key(RELEASE_KID)["publicKeyRaw"]}
PRODUCT_TRUST = {PRODUCT_KID: _key(PRODUCT_KID)["publicKeyRaw"]}


def sha(b: Union[bytes, str]) -> str:
    return hashlib.sha256(b.encode("utf-8") if isinstance(b, str) else b).hexdigest()


PROBE_TARGET = (
    "".join(
        f"polaris key probe line {'xyz' if i == 3 else f'{i:03d}'}: the quick brown fox jumps over the sleepy cat\n"
        for i in range(6)
    )
    + "tail added for the probe\n"
).encode("ascii")

__all__ = [
    "PRODUCT",
    "RELEASE_KEYS",
    "PRODUCT_TRUST",
    "PROBE_BASE",
    "PROBE_FRAME",
    "PROBE_TARGET",
    "TreePack",
    "tree_pack",
    "stamp_for",
    "marker_for",
    "ByteServer",
    "sha",
    "revocation_for",
    "sign_feed_doc",
    "sign_release_doc",
]


@dataclass
class TreePack:
    pack_id: str
    version: str
    seq: int
    jws: str
    record_sha256: str
    tree_digest: str
    size: int
    objects: Dict[str, bytes]
    files: Dict[str, bytes]
    index_sha256: str
    full_sha256: str


def _j(v: Any) -> bytes:
    return json.dumps(v, separators=(",", ":")).encode("utf-8")


def tree_pack(
    pack_id: str,
    version: str,
    seq: int,
    files: Dict[str, Union[bytes, str]],
    *,
    from_pack: Optional[TreePack] = None,
    activation: str = "hot",
    entitlement: Optional[str] = None,
    type: str = "files.tree",
    index_bytes: Optional[int] = None,
    record_extra: Optional[Dict[str, Any]] = None,
) -> TreePack:
    """A ``files.tree`` pack release over ``files``, every object raw; optionally a ``files``
    delta set from ``from_pack``, whose entries are ``delta`` (the probe frame, when the base file
    is the probe base) or raw ``blob`` entries. ``record_extra`` adds record-level members (a
    reserved ``provides``, say) after the variants."""
    fs = {p: (b.encode("utf-8") if isinstance(b, str) else b) for p, b in files.items()}
    paths = sorted(fs, key=lambda p: p.encode("utf-8"))
    entries = [
        {
            "path": p,
            "size": len(fs[p]),
            "sha256": sha(fs[p]),
            "blob": {"sha256": sha(fs[p]), "bytes": len(fs[p]), "codec": "none"},
        }
        for p in paths
    ]
    digest = sha("".join(f"{e['sha256']} {e['size']} {e['path']}\n" for e in entries))
    size = sum(e["size"] for e in entries)  # type: ignore[misc]
    index = _j({"format": "pkey-files/1", "layout": "tree", "payload": {"size": size, "sha256": digest}, "files": entries})
    full = b"".join(fs[p] for p in paths)
    objects: Dict[str, bytes] = {sha(index): index, sha(full): full}
    for p in paths:
        objects[sha(fs[p])] = fs[p]

    deltas: List[Any] = []
    if from_pack is not None:
        base_by_path = from_pack.files
        base_hashes = {sha(b) for b in base_by_path.values()}
        parts: List[bytes] = []
        offset = 0
        mem_bytes = 1
        pe: List[Any] = []
        for e in entries:
            if e["sha256"] in base_hashes:
                continue
            base = base_by_path.get(e["path"])  # type: ignore[arg-type]
            b = fs[e["path"]]  # type: ignore[index]
            if base is not None and sha(base) == sha(PROBE_BASE) and sha(b) == sha(PROBE_TARGET):
                pe.append(
                    {
                        "path": e["path"],
                        "op": "delta",
                        "from": sha(base),
                        "to": e["sha256"],
                        "size": e["size"],
                        "offset": offset,
                        "length": len(PROBE_FRAME),
                    }
                )
                parts.append(PROBE_FRAME)
                offset += len(PROBE_FRAME)
                mem_bytes = max(mem_bytes, len(base) + len(b))
            else:
                pe.append(
                    {
                        "path": e["path"],
                        "op": "blob",
                        "to": e["sha256"],
                        "size": e["size"],
                        "codec": "none",
                        "offset": offset,
                        "length": len(b),
                    }
                )
                parts.append(b)
                offset += len(b)
                mem_bytes = max(mem_bytes, len(b))
        data = b"".join(parts)
        patch = _j(
            {
                "format": "pkey-patch/1",
                "scope": "files",
                "method": "zstd-patch-from",
                "from": from_pack.tree_digest,
                "to": digest,
                "data": {"sha256": sha(data), "bytes": len(data)},
                "entries": pe,
            }
        )
        if data:
            objects[sha(patch)] = patch
            objects[sha(data)] = data
            deltas.append(
                {
                    "method": "zstd-patch-from",
                    "scope": "files",
                    "from": from_pack.tree_digest,
                    "memBytes": mem_bytes,
                    "patch": {"sha256": sha(patch), "bytes": len(patch), "size": len(patch), "codec": "none"},
                    "data": {"sha256": sha(data), "bytes": len(data)},
                }
            )

    variant: Dict[str, Any] = {
        "variant": {},
        "payload": {"size": size, "sha256": digest},
        "full": {"sha256": sha(full), "bytes": len(full), "size": len(full), "codec": "none"},
        "files": {
            "format": "pkey-files/1",
            "layout": "tree",
            "sha256": sha(index),
            "bytes": index_bytes if index_bytes is not None else len(index),
            "size": index_bytes if index_bytes is not None else len(index),
            "codec": "none",
        },
    }
    if deltas:
        variant["deltas"] = deltas
    record: Dict[str, Any] = {
        "schemaVersion": 1,
        "aud": PRODUCT,
        "deliverable": pack_id,
        "kind": "pack",
        "version": version,
        "seq": seq,
        "issuedAt": 1759300000 + seq,
        "type": type,
        "formatVersion": 1,
        "handler": {"activation": activation},
    }
    if entitlement is not None:
        record["entitlement"] = entitlement
    record["variants"] = [variant]
    if record_extra:
        record.update(record_extra)
    jws = sign_jws(record, _key(RELEASE_KID)["privateKeyPkcs8Pem"], RELEASE_KID, "pkey-release+jws")
    return TreePack(
        pack_id=pack_id,
        version=version,
        seq=seq,
        jws=jws,
        record_sha256=sha(jws),
        tree_digest=digest,
        size=size,
        objects=objects,
        files=fs,
        index_sha256=sha(index),
        full_sha256=sha(full),
    )


def stamp_for(*packs: TreePack) -> Dict[str, Any]:
    """A content stamp's body pinning these releases (all required, essential)."""
    return {
        "contentApi": 1,
        "pins": [
            {"pack": p.pack_id, "release": {"sha256": p.record_sha256, "seq": p.seq, "version": p.version}}
            for p in packs
        ],
        "expects": [{"pack": p.pack_id, "required": True, "delivery": "essential"} for p in packs],
    }


def marker_for(pack: TreePack) -> str:
    """A marker (``pkey-marker/1``) for an embedded copy of ``pack``."""
    return json.dumps(
        {"format": "pkey-marker/1", "packId": pack.pack_id, "version": pack.version, "release": pack.jws},
        separators=(",", ":"),
    )


@dataclass
class ByteServer:
    """A fake byte server over every pack's records and objects. ``cut`` makes the next GET of
    an object stop after that many bytes (an interrupted download)."""

    records: Dict[str, str] = field(default_factory=dict)
    objects: Dict[str, bytes] = field(default_factory=dict)
    calls: List[Dict[str, Any]] = field(default_factory=list)
    cut: Optional[int] = None

    @classmethod
    def of(cls, *packs: TreePack) -> "ByteServer":
        s = cls()
        for p in packs:
            s.records[p.record_sha256] = p.jws
            s.objects.update(p.objects)
        return s

    def fetch_record(self, h: str) -> Dict[str, Any]:
        body = self.records.get(h)
        return {"ok": False, "code": "not_found"} if body is None else {"ok": True, "body": body}

    def fetch_object(self, sha256: str, offset: int, if_range: Optional[str]) -> ObjectResponse:
        self.calls.append({"sha256": sha256, "offset": offset, "ifRange": if_range})
        b = self.objects.get(sha256)
        if b is None:
            return ObjectResponse(status=404, content_range=None, chunks=iter(()))
        ranged = offset > 0 and if_range == f'"{sha256}"'
        body = b[offset:] if ranged else b
        cut = self.cut
        self.cut = None

        def chunks() -> Iterator[bytes]:
            if cut is not None:
                yield body[:cut]
                raise ConnectionError("connection reset")
            for at in range(0, len(body), 7):
                yield body[at : at + 7]

        return ObjectResponse(
            status=206 if ranged else 200,
            content_range=f"bytes {offset}-{len(b) - 1}/{len(b)}" if ranged else None,
            chunks=chunks(),
        )


def revocation_for(
    target: TreePack,
    *,
    replacement: Optional[TreePack] = None,
    issued_at: int = 1759350000,
    reason: str = "Withdrawn in a test.",
    kid: str = RELEASE_KID,
) -> Dict[str, Any]:
    """A ``kind: revocation`` record (plans/P4-13.md §2.3) revoking ``target``, signed with the
    release key (or ``kid``'s key), and its feed entry: ``{"jws", "record", "entry"}``."""
    doc: Dict[str, Any] = {
        "schemaVersion": 1,
        "aud": PRODUCT,
        "deliverable": target.pack_id,
        "kind": "revocation",
        "version": target.version,
        "seq": target.seq,
        "issuedAt": issued_at,
        "revokes": target.record_sha256,
    }
    if replacement is not None:
        doc["replacement"] = {
            "sha256": replacement.record_sha256,
            "seq": replacement.seq,
            "version": replacement.version,
        }
    doc["reason"] = reason
    jws = sign_jws(doc, _key(kid)["privateKeyPkcs8Pem"], kid, "pkey-release+jws")
    record = sha(jws)
    return {
        "jws": jws,
        "record": record,
        "entry": {
            "record": record,
            "pack": target.pack_id,
            "target": target.record_sha256,
            "version": target.version,
            "seq": target.seq,
        },
    }


def sign_feed_doc(doc: Any) -> str:
    """Sign a channel feed with the corpus's product key (``pkey-test-prod-2026``)."""
    return sign_jws(doc, _key(PRODUCT_KID)["privateKeyPkcs8Pem"], PRODUCT_KID, "pkey-feed+jws")


def sign_release_doc(doc: Any) -> str:
    """Sign a release record with the corpus's release key."""
    return sign_jws(doc, _key(RELEASE_KID)["privateKeyPkcs8Pem"], RELEASE_KID, "pkey-release+jws")
