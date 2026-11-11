"""The export corpus rows (``sync-vectors.json`` ``exportCases``) as a transport: the changes as served, a file
source built from each row's recipes, and the zip read back through the standard library. Shared by
``test_sync_crypto_conformance.py`` (the corpus) and ``test_cloud_sync_export.py`` (the host)."""

from __future__ import annotations

import hashlib
import io
import zipfile
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from polaris_key.cloud_sync.export import ExportFileRef, ExportInput, ExportSummary, export_to_sink
from polaris_key.cloud_sync.transfer_codec import E2eFileCodec, ServerFileCodec
from polaris_key.core import sync_crypto as sc
from polaris_key.core import sync_files as sf


class RootCodec:
    """A host codec over a root, as the ring's ``SyncCodec`` is (``locked``, ``open``, ``open_any``, ``blind``)."""

    locked = False

    def __init__(self, root: bytes) -> None:
        self.root = root

    def open(self, collection: str, name: str, envelope: bytes, aliases: Any = None) -> Any:
        return sc.open_value(self.root, collection, name, envelope, aliases)

    def open_any(self, collection: str, envelope: bytes) -> Any:
        return sc.open_value_any_name(self.root, collection, envelope)

    def blind(self, kind: str, ctx: str, name: str) -> str:
        return sc.blind(self.root, kind, ctx, name)


def stream(label: str, length: int) -> bytes:
    """The corpus plaintext: SHA-256(label || u32be(i)) blocks, cut to ``length``."""
    out = bytearray()
    i = 0
    while len(out) < length:
        out += hashlib.sha256(label.encode() + i.to_bytes(4, "big")).digest()
        i += 1
    return bytes(out[:length])


def _flip(b: bytes, at: int) -> bytes:
    m = bytearray(b)
    m[at] ^= 1
    return bytes(m)


@dataclass
class Transport:
    whole: Dict[Tuple[str, str, Any], bytes] = field(default_factory=dict)
    chunks: Dict[Tuple[str, str], bytes] = field(default_factory=dict)


def transport_of(row: Dict[str, Any], file_codec: Any) -> Transport:
    """What the transport serves for each file and chunk of a row."""
    root = bytes.fromhex(row["rootHex"]) if "rootHex" in row else None
    t = Transport()
    for f in row["files"]:
        key = (f["collection"], f["record"], f["version"])
        if "stored" in f:
            r = f["stored"]

            swap = r.get("swap")
            label, salt = (swap["label"], swap.get("saltHex")) if swap else (r["label"], r.get("saltHex"))
            plain = stream(label, r["length"])
            if salt is None or root is None:
                served = plain
            else:
                ck, kid = sc.derive_coll_key(root, f["collection"]), sc.derive_kid(root)
                served = sf.seal_file(ck, kid, plain, bytes.fromhex(salt))
            if "extra" in r:
                served += stream(r["label"] + " extra", r["extra"])
            if "flipAt" in r:
                served = _flip(served, r["flipAt"])
            if "cut" in r:
                served = served[: r["cut"]]
            t.whole[key] = served
        elif "chunked" in f:
            r = f["chunked"]
            codec = file_codec(f["collection"])
            total = sum(r["chunkLens"])
            plain = stream(r["label"], total)
            records: List[sf.ManifestRecord] = []
            at = 0
            for i, n in enumerate(r["chunkLens"]):
                body = plain[at : at + n]
                at += n
                cid = codec.chunk_id(body)
                records.append(sf.ManifestRecord(id=cid, plain_len=n))
                if r.get("dropChunk") == i:
                    continue
                obj = codec.seal_chunk(cid, body)
                if r.get("flipChunk") == i:
                    obj = obj[:-1] + bytes([obj[-1] ^ 1])
                t.chunks[(f["collection"], cid.hex())] = obj
            digest = bytearray(hashlib.sha256(plain).digest())
            if r.get("plainSha256Flip"):
                digest[0] ^= 1
            manifest = sf.encode_manifest(
                sf.ChunkManifest(
                    plain_size=r.get("manifestPlainSize", total), plain_sha256=bytes(digest), records=records
                )
            )
            stored = manifest
            if root is not None:
                ck, kid = sc.derive_coll_key(root, f["collection"]), sc.derive_kid(root)
                stored = sf.seal_file(ck, kid, manifest, bytes.fromhex(r["saltHex"]))
            if "manifestFlipAt" in r:
                stored = _flip(stored, r["manifestFlipAt"])
            t.whole[key] = stored
    return t


class FakeSource:
    """A file source over a row's transport: bytes arrive in awkward pieces, and the reads are counted."""

    def __init__(self, row: Dict[str, Any], t: Transport, piece: int = 300_007) -> None:
        self.row = row
        self.t = t
        self.piece = piece
        self.stored_bytes = 0

    def pointers(self, collection: str, record: str) -> List[Dict[str, Any]]:
        return [
            {"version": f["version"], "size": f["size"], "sha256": f["sha256"], "format": f["format"]}
            for f in self.row["files"]
            if f["collection"] == collection and f["record"] == record
        ]

    def stored(self, ref: ExportFileRef) -> Iterable[bytes]:
        data = self.t.whole.get((ref.collection, ref.record, ref.version))
        if data is None:
            return
        for at in range(0, len(data), self.piece):
            p = data[at : at + self.piece]
            self.stored_bytes += len(p)
            yield p

    def chunk(self, collection: str, id_hex: str) -> Optional[bytes]:
        return self.t.chunks.get((collection, id_hex))


class CollectSink:
    def __init__(self) -> None:
        self.parts: List[bytes] = []
        self.max_piece = 0

    def write(self, data: bytes) -> None:
        self.parts.append(bytes(data))
        self.max_piece = max(self.max_piece, len(data))

    @property
    def zip(self) -> bytes:
        return b"".join(self.parts)


def codecs_of(row: Dict[str, Any]) -> Tuple[Optional[RootCodec], Any]:
    root = bytes.fromhex(row["rootHex"]) if "rootHex" in row else None
    if root is None:
        return None, lambda collection: ServerFileCodec()
    return RootCodec(root), lambda collection: E2eFileCodec(root, collection)


def make_input(row: Dict[str, Any], source: Any, **extra: Any) -> ExportInput:
    host, file_codec = codecs_of(row)
    return ExportInput(
        product=row["product"],
        exported_at=row["exportedAt"],
        unsynced=row["unsynced"],
        include_revisions=row["includeRevisions"],
        changes=row["changes"],
        files=source,
        codec=host,
        file_codec=file_codec,
        caps=row.get("caps"),
        **extra,
    )


def run_row(
    row: Dict[str, Any], piece: int = 300_007
) -> Tuple[CollectSink, FakeSource, Optional[BaseException], Optional[ExportSummary]]:
    _host, file_codec = codecs_of(row)
    source = FakeSource(row, transport_of(row, file_codec), piece)
    sink = CollectSink()
    try:
        summary = export_to_sink(make_input(row, source), sink)
    except BaseException as e:  # noqa: BLE001 - returned for the test to inspect
        return sink, source, e, None
    return sink, source, None, summary


def read_zip(data: bytes) -> List[Tuple[str, bytes]]:
    """The entries of an archive in central-directory order; ``testzip`` must be clean."""
    z = zipfile.ZipFile(io.BytesIO(data))
    assert z.testzip() is None
    return [(i.filename, z.read(i)) for i in z.infolist()]


def entries_equal(got: Sequence[Tuple[str, bytes]], want: Sequence[Dict[str, Any]]) -> None:
    assert [n for n, _ in got] == [w["name"] for w in want]
    for (name, data), w in zip(got, want):
        assert len(data) == w["size"], name
        assert hashlib.sha256(data).hexdigest() == w["sha256Hex"], name
        if "utf8" in w:
            assert data.decode("utf-8") == w["utf8"], name
        if "hex" in w:
            assert data.hex() == w["hex"], name
