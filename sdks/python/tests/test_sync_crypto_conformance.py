# @pkey-feature sync.keyring
"""The Cloud Sync E2E crypto against ``conformance/corpus/v2/sync-vectors.json`` (U-38.3;
WIRE-CONTRACT-V5 §13.10, §13.11): hkdfCases, envelopeCases, blindCases, hpkeAnchor, wrapCases,
recoveryCodeCases, adoptCases and canonicalJsonCases, and (U-22.8) cdcCases, cdcEditCases,
deltaCases, chunkCases and manifestCases, and (U-22.9) fileStreamCases and transferPlanCases.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.core import sync_crypto as sc
from polaris_key.core import sync_files as sf
from polaris_key.update.packs.zstd import select_python_zstd

_ZSTD = select_python_zstd()[0].decode

_PATH = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "sync-vectors.json"
V: Dict[str, Any] = json.loads(_PATH.read_text(encoding="utf-8"))
H = bytes.fromhex


def ids(rows: List[Dict[str, Any]]) -> List[str]:
    return [r["id"] for r in rows]


def test_version_and_constants() -> None:
    assert V["syncVectorsVersion"] == 1
    assert V["constants"] == {
        "envelopeOverheadBytes": sc.ENVELOPE_OVERHEAD_BYTES,
        "envelopeFixedBytes": sc.ENVELOPE_FIXED_BYTES,
        "paddingBlockBytes": sc.ENVELOPE_PAD_BLOCK,
    }


@pytest.mark.parametrize("c", V["hkdfCases"], ids=ids(V["hkdfCases"]))
def test_hkdf(c: Dict[str, Any]) -> None:
    ikm, salt, info = H(c["ikmHex"]), H(c["saltHex"]), H(c["infoHex"])
    assert sc.hkdf(ikm, salt, info, c["length"]).hex() == c["okmHex"]
    # The named derivation, where the table's ikm is the input the function takes.
    label = c["label"]
    if label == "kid":
        assert sc.derive_kid(ikm).hex() == c["okmHex"]
    elif label == "coll":
        assert sc.derive_coll_key(ikm, info[len(b"pkey-sync/1 coll\0") :].decode()).hex() == c["okmHex"]
    elif label == "names":
        assert sc.derive_names_key(ikm).hex() == c["okmHex"]
    elif label == "chunk-id":
        assert sc.derive_chunk_id_key(ikm, info[len(b"pkey-sync/1 chunk-id\0") :].decode()).hex() == c["okmHex"]
    elif label == "value":
        assert sc.derive_value_key(ikm, salt).hex() == c["okmHex"]
    elif label == "recovery":
        assert sc.derive_recovery_key(ikm, salt.decode()).hex() == c["okmHex"]
    elif label == "adopt":
        assert sc.derive_adopt_key(ikm).hex() == c["okmHex"]


@pytest.mark.parametrize("c", V["envelopeCases"], ids=ids(V["envelopeCases"]))
def test_envelope(c: Dict[str, Any]) -> None:
    root = H(c["rootHex"])
    env = H(c["envelopeHex"])
    if "seal" in c:
        # An alias case was sealed under the source name the reader accepts (expect.name).
        again = sc.seal_value(root, c["collection"], c["expect"]["name"], c["seal"]["value"], H(c["seal"]["saltHex"]))
        assert again == env
    got = sc.open_value(root, c["collection"], c["name"], env, c["aliases"])
    want = c["expect"]
    if want["result"] == "ok":
        assert got.ok and got.name == want["name"] and got.value == want["value"]
    else:
        assert not got.ok and got.reason == want["reason"]


@pytest.mark.parametrize("c", V["blindCases"], ids=ids(V["blindCases"]))
def test_blind(c: Dict[str, Any]) -> None:
    assert sc.blind(H(c["rootHex"]), c["kind"], c["ctx"], c["n"]) == c["blinded"]
    assert sc.is_blinded_name(c["blinded"])


def test_hpke_anchor() -> None:
    a = V["hpkeAnchor"]["vector"]
    info, aad = H(a["info"]), H(a["encryption"]["aad"])
    enc, ct = sc.hpke_seal(H(a["pkRm"]), info, aad, H(a["encryption"]["pt"]), H(a["skEm"]))
    assert enc.hex() == a["enc"]
    assert ct.hex() == a["encryption"]["ct"]
    dh, pub = sc.private_dh(H(a["skRm"]))
    assert pub.hex() == a["pkRm"]
    assert sc.hpke_open(dh, pub, enc, info, aad, ct).hex() == a["encryption"]["pt"]  # type: ignore[union-attr]
    # The key schedule's own outputs.
    dh_out = sc._x25519(sc.X25519PrivateKey.from_private_bytes(H(a["skEm"])), H(a["pkRm"]))
    assert dh_out is not None
    shared = sc._shared_secret(dh_out, H(a["enc"]) + H(a["pkRm"]))
    assert shared.hex() == a["shared_secret"]
    key, nonce = sc._key_schedule(shared, info)
    assert (key.hex(), nonce.hex()) == (a["key"], a["base_nonce"])


@pytest.mark.parametrize("c", V["wrapCases"], ids=ids(V["wrapCases"]))
def test_wrap(c: Dict[str, Any]) -> None:
    ctx = sc.WrapContext(c["product"], c["deviceId"], c["ringId"], c["epoch"])
    kid = H(c["kidHex"])
    dh, pub = sc.private_dh(H(c["recipientPrivateHex"]))
    w = c["wrap"]
    wrap = sc.SyncWrap(kem=w["kem"], enc=H(w["encHex"]), ct=H(w["ctHex"]))
    got = sc.unwrap_root(dh, pub, ctx, kid, wrap)
    want = c["expectRootHex"]
    assert (got.hex() if got is not None else None) == want
    if "seal" in c:
        s = c["seal"]
        assert sc.wrap_info(ctx).hex() == s["infoHex"]
        assert pub.hex() == s["recipientPublicHex"]
        again = sc.wrap_root(H(s["recipientPublicHex"]), ctx, kid, H(s["rootHex"]), H(s["ephemeralPrivateHex"]))
        assert again == wrap


def test_wrap_to_a_zero_key_is_refused() -> None:
    with pytest.raises(ValueError):
        sc.wrap_root(bytes(32), sc.WrapContext("demo", "d", "rg_AAAAAAAAAAAAAAAAAAAAAA", 1), bytes(16), bytes(32))


_CODES = [c for c in V["recoveryCodeCases"]]


@pytest.mark.parametrize("c", _CODES, ids=ids(_CODES))
def test_recovery(c: Dict[str, Any]) -> None:
    if c["kind"] == "code":
        assert sc.encode_recovery_code(H(c["codeHex"])) == c["text"]
        assert sc.parse_recovery_code(c["text"]) == H(c["codeHex"])
    elif c["kind"] == "parse":
        got = sc.parse_recovery_code(c["input"])
        want = c["expectCodeHex"]
        assert (got.hex() if got is not None else None) == want
    else:
        code, kid, blob = H(c["codeHex"]), H(c["kidHex"]), H(c["blobHex"])
        got = sc.unwrap_recovery(code, c["ringId"], c["epoch"], kid, blob)
        assert (got.hex() if got is not None else None) == c["expectRootHex"]
        if "seal" in c:
            s = c["seal"]
            assert sc.wrap_recovery(code, c["ringId"], c["epoch"], kid, H(s["rootHex"]), H(s["nonceHex"])) == blob


@pytest.mark.parametrize("c", V["adoptCases"], ids=ids(V["adoptCases"]))
def test_adopt(c: Dict[str, Any]) -> None:
    cur = H(c["currentRootHex"])
    frm = sc.AdoptFrom(c["fromRingId"], c["epoch"], H(c["kidHex"]))
    blob = H(c["blobHex"])
    got = sc.open_adopt(cur, frm, blob)
    assert (got.hex() if got is not None else None) == c["expectRootHex"]
    if "seal" in c:
        s = c["seal"]
        assert sc.seal_adopt(cur, frm, H(s["oldRootHex"]), H(s["nonceHex"])) == blob


def test_a_repr_never_shows_a_value() -> None:
    o = sc.OpenedValue(ok=True, name="theme", value="secret-value")
    assert "secret-value" not in repr(o)


@pytest.mark.parametrize("c", V["canonicalJsonCases"], ids=ids(V["canonicalJsonCases"]))
def test_canonical_json(c: Dict[str, Any]) -> None:
    if "special" in c:
        value: Any = float(c["special"].lower().replace("infinity", "inf"))
    else:
        # Every number is an IEEE double, as JSON.parse reads it.
        value = json.loads(c["inputJson"], parse_int=float)
    if c["expect"]["result"] == "ok":
        assert sc.canonical_json(value) == c["expect"]["canonical"]
    else:
        with pytest.raises(ValueError):
            sc.canonical_json(value)


def test_canonical_json_refuses_ints_beyond_2_pow_53() -> None:
    assert sc.canonical_json(2**53) == "9007199254740992"
    assert sc.canonical_json(-(2**53)) == "-9007199254740992"
    for v in (2**53 + 1, 2**70, -(2**53) - 1):
        with pytest.raises(ValueError):
            sc.canonical_json(v)


# ── U-22.8: the chunker, chunk objects and manifest ───────────────────────────────────────────


def _counter_bytes(label: str, length: int) -> bytes:
    """SHA-256 counter blocks of a label, cut to ``length`` (the recipe in the file's description)."""
    out = bytearray()
    n = 0
    while len(out) < length:
        out += hashlib.sha256(label.encode() + n.to_bytes(4, "big")).digest()
        n += 1
    return bytes(out[:length])


def cdc_input(i: Dict[str, Any]) -> bytes:
    if i["kind"] == "byte":
        return bytes([i["value"]]) * i["length"]
    return _counter_bytes("pkey-sync vector cdc " + i["label"], i["length"])


def _cut(buf: bytes, avg: int, piece: int) -> List[bytes]:
    chunker = sf.CdcChunker(sf.cdc_params(avg))
    out: List[bytes] = []
    for at in range(0, len(buf), piece):
        out += chunker.push(buf[at : at + piece])
    return out + chunker.finish()


@pytest.mark.parametrize("c", V["cdcCases"], ids=ids(V["cdcCases"]))
def test_cdc(c: Dict[str, Any]) -> None:
    assert sf.cdc_params(c["avg"]) == sf.CdcParams(c["avg"], c["min"], c["max"])
    data = cdc_input(c["input"])
    # Whole, then in awkward pieces: the cuts do not depend on how the input arrives.
    for piece in (len(data) or 1, 1000, 65537):
        assert [len(x) for x in _cut(data, c["avg"], piece)] == c["lens"]
    assert list(map(len, sf.cdc_stream([data[:7], b"", data[7:]], sf.cdc_params(c["avg"])))) == c["lens"]


def test_cdc_parameters() -> None:
    assert sf.SYNC_CDC_PARAMS == sf.CdcParams(256 * 1024, 64 * 1024, 1024 * 1024)
    for bad in (0, 32, 1000):
        with pytest.raises(ValueError):
            sf.cdc_params(bad)


def test_cdc_emits_copies() -> None:
    c = sf.CdcChunker(sf.cdc_params(1024))
    first = c.push(bytes(4096))
    assert len(first) == 1
    c.push(bytes([9]) * 4096)
    assert first[0] == bytes(4096)


@pytest.mark.parametrize("c", V["chunkCases"], ids=ids(V["chunkCases"]))
def test_chunk(c: Dict[str, Any]) -> None:
    root = H(c["rootHex"])
    if c["kind"] == "id":
        plain = H(c["plainHex"])
        assert sf.chunk_id_hex(root, c["collection"], plain) == c["e2eIdHex"]
        assert sf.chunk_id_hex(None, c["collection"], plain) == c["serverIdHex"]
        return
    if c["kind"] == "pair":
        assert c["rawNonceHex"] != c["zstdNonceHex"]
        for obj_hex, nonce_hex, codec in ((c["rawObjectHex"], c["rawNonceHex"], 0), (c["zstdObjectHex"], c["zstdNonceHex"], 1)):
            obj = H(obj_hex)
            assert obj[2:14].hex() == nonce_hex
            o = sf.open_chunk(root, c["collection"], H(c["idHex"]), obj, _ZSTD)
            assert o.ok and o.plain.hex() == c["plainHex"] and o.codec == codec
        return
    got = sf.open_chunk(root, c["collection"], H(c["idHex"]), H(c["objectHex"]), _ZSTD)
    want = c["expect"]
    if want["result"] == "ok":
        assert got.ok and got.plain.hex() == want["plainHex"] and got.codec == want["codec"]
    else:
        assert not got.ok and got.reason == want["reason"]
    if "seal" in c:
        sealed = sf.seal_chunk(root, c["collection"], H(c["idHex"]), c["seal"]["codec"], H(c["seal"]["bodyHex"]))
        assert sealed.hex() == c["objectHex"]


def test_chunk_decode_failure_modes() -> None:
    """A missing decoder, a decoder that raises and one that lies about the length are all ``decode``;
    a declared size over 1 MiB is ``size`` and the decoder is never called."""
    root = bytes(range(32))
    a = b"A"
    frame = bytes([0x28, 0xB5, 0x2F, 0xFD, 0x20, 1, 0x09, 0, 0, 0x41])
    assert sf.zstd_content_size(frame) == 1
    cid = sf.chunk_id(root, "saves", a)
    obj = sf.seal_chunk(root, "saves", cid, sf.CHUNK_CODEC_ZSTD, frame)

    def boom(_f: bytes, _n: int) -> bytes:
        raise ValueError("bad frame")

    assert sf.open_chunk(root, "saves", cid, obj, lambda _f, _n: a).codec == 1
    assert sf.open_chunk(root, "saves", cid, obj).reason == "decode"
    assert sf.open_chunk(root, "saves", cid, obj, boom).reason == "decode"
    assert sf.open_chunk(root, "saves", cid, obj, lambda _f, _n: b"AA").reason == "decode"

    called: List[int] = []
    bomb = bytes([0x28, 0xB5, 0x2F, 0xFD, 0xA0]) + (2 * 1024 * 1024).to_bytes(4, "little") + bytes(8)
    obj2 = sf.seal_chunk(root, "saves", cid, sf.CHUNK_CODEC_ZSTD, bomb)
    assert sf.open_chunk(root, "saves", cid, obj2, lambda f, n: called.append(n) or a).reason == "size"
    assert called == []


def test_zstd_content_size_header_widths() -> None:
    def hdr(fhd: int, *rest: int) -> bytes:
        return bytes([0x28, 0xB5, 0x2F, 0xFD, fhd, *rest])

    assert sf.zstd_content_size(hdr(0x20, 200)) == 200
    assert sf.zstd_content_size(hdr(0x60, 1, 0)) == 257
    assert sf.zstd_content_size(hdr(0xA0, 0, 0, 16, 0)) == 1 << 20
    assert sf.zstd_content_size(hdr(0x00, 0x10, 1)) is None
    assert sf.zstd_content_size(bytes([1, 2, 3, 4, 5, 6])) is None


def test_chunk_object_layout_and_refusals_in_order() -> None:
    root = bytes(range(32))
    plain = bytes(range(200))
    cid = sf.chunk_id(root, "saves", plain)
    obj = sf.seal_chunk(root, "saves", cid, 0, plain)
    assert len(obj) == 2 + 12 + len(plain) + 16 and obj[:2] == bytes([1, 0])
    assert sf.seal_chunk(root, "saves", cid, 0, plain) == obj  # deterministic
    assert sf.open_chunk(root, "saves", cid, obj).plain == plain
    assert sf.open_chunk(root, "saves", cid, obj[:29]).reason == "shape"
    assert sf.open_chunk(root, "saves", cid, bytes([2, 9]) + obj[2:]).reason == "version"
    assert sf.open_chunk(root, "saves", cid, bytes([1, 2]) + obj[2:]).reason == "codec"
    assert sf.open_chunk(root, "saves", cid, obj[:-1] + bytes([obj[-1] ^ 1])).reason == "auth"
    assert sf.open_chunk(bytes(32), "saves", cid, obj).reason == "auth"
    assert sf.open_chunk(root, "saves", cid[:31], obj).reason == "auth"
    with pytest.raises(ValueError):
        sf.seal_chunk(root, "saves", cid, 2, plain)
    with pytest.raises(ValueError):
        sf.seal_chunk(root, "saves", cid[:5], 0, plain)
    assert sf.chunk_id_bytes(cid.hex()) == cid
    assert sf.chunk_id_bytes("AB") is None and sf.chunk_id_bytes("A" * 64) is None


@pytest.mark.parametrize("c", V["manifestCases"], ids=ids(V["manifestCases"]))
def test_manifest(c: Dict[str, Any]) -> None:
    parsed = sf.parse_manifest(H(c["manifestHex"]))
    want = c["expect"]
    if want["result"] == "invalid":
        assert not parsed.ok and parsed.reason == want["reason"]
        return
    assert parsed.ok and parsed.manifest is not None
    m = parsed.manifest
    assert m.plain_size == want["plainSize"]
    assert m.plain_sha256.hex() == want["plainSha256Hex"]
    assert [{"idHex": r.id.hex(), "plainLen": r.plain_len} for r in m.records] == want["records"]
    assert sf.encode_manifest(m).hex() == c["manifestHex"]


def apply_edit(base: bytes, e: Dict[str, Any]) -> bytes:
    piece = _counter_bytes("pkey-sync vector cdc-edit " + e["label"], e["length"])
    tail = base[e["at"] :] if e["op"] == "insert" else base[e["at"] + e["length"] :]
    mid = b"" if e["op"] == "delete" else piece
    return base[: e["at"]] + mid + tail


@pytest.mark.parametrize("c", V["cdcEditCases"], ids=ids(V["cdcEditCases"]))
def test_cdc_edit(c: Dict[str, Any]) -> None:
    root = H(c["rootHex"])
    base = cdc_input(c["base"])
    edited = apply_edit(base, c["edit"])
    for buf, lens, id_list, manifest_hex in (
        (base, c["baseLens"], c["baseIdsHex"], c["baseManifestHex"]),
        (edited, c["editedLens"], c["editedIdsHex"], c["editedManifestHex"]),
    ):
        chunks = _cut(buf, c["avg"], 65537)
        assert [len(x) for x in chunks] == lens
        assert [sf.chunk_id_hex(root, c["collection"], x) for x in chunks] == id_list
        parsed = sf.parse_manifest(H(manifest_hex))
        assert parsed.ok and parsed.manifest is not None
        m = parsed.manifest
        assert m.plain_size == len(buf)
        assert m.plain_sha256 == hashlib.sha256(buf).digest()
        assert [r.id.hex() for r in m.records] == id_list
        assert [r.plain_len for r in m.records] == lens
        assert sf.encode_manifest(m).hex() == manifest_hex
    have = set(c["baseIdsHex"])
    kept = [i for i, x in enumerate(c["editedIdsHex"]) if x in have]
    changed = [i for i, x in enumerate(c["editedIdsHex"]) if x not in have]
    assert kept == c["keptIndexes"] and changed == c["changedIndexes"]


def _manifest_records(w: Dict[str, Any]) -> List[Dict[str, Any]]:
    row = next(e for e in V["cdcEditCases"] if e["id"] == w["row"])
    key = "baseManifestHex" if w["side"] == "base" else "editedManifestHex"
    parsed = sf.parse_manifest(H(row[key]))
    assert parsed.ok and parsed.manifest is not None
    return [{"id": r.id.hex(), "plainLen": r.plain_len} for r in parsed.manifest.records]


@pytest.mark.parametrize("c", V["deltaCases"], ids=ids(V["deltaCases"]))
def test_delta(c: Dict[str, Any]) -> None:
    have = set(c["have"]["idsHex"]) if "idsHex" in c["have"] else {r["id"] for r in _manifest_records(c["have"])}
    move: Dict[str, int] = {}
    for r in _manifest_records(c["want"]):
        if r["id"] not in have and r["id"] not in move:
            move[r["id"]] = r["plainLen"]
    assert list(move.keys()) == c["moveIdsHex"]
    assert sum(move.values()) == c["moveBytes"]


def test_manifest_refuses_the_first_violation() -> None:
    sha = bytes(range(32))

    def rec(n: int, ln: int) -> sf.ManifestRecord:
        return sf.ManifestRecord(id=bytes([n]) * 32, plain_len=ln)

    base = sf.encode_manifest(sf.ChunkManifest(20, sha, [rec(1, 10), rec(2, 10)]))

    def edit(at: int, val: int) -> str:
        b = bytearray(base)
        b[at] = val
        return sf.parse_manifest(bytes(b)).reason or "ok"

    assert sf.parse_manifest(base[:10]).reason == "shape"
    assert edit(0, 0) == "magic" and edit(8, 2) == "version" and edit(10, 40) == "recordSize"
    assert edit(12, 1) == "flags" and edit(20, 1) == "reserved" and edit(16, 3) == "length"
    b = bytearray(base)
    b[16:18] = b"\xff\xff"
    assert sf.parse_manifest(bytes(b)).reason == "count"
    assert edit(64 + 36, 1) == "record" and edit(64 + 32, 0) == "chunkLen" and edit(24, 21) == "size"
    # A plainSize beyond 2^53 is refused, not rounded into range.
    b = bytearray(sf.encode_manifest(sf.ChunkManifest(0, sha, [])))
    b[24:32] = b"\xff" * 8
    assert sf.parse_manifest(bytes(b)).reason == "size"


# ── U-22.9: the file stream and the transfer plan ─────────────────────────────────────────────


@pytest.mark.parametrize("c", V["transferPlanCases"], ids=ids(V["transferPlanCases"]))
def test_transfer_plan(c: Dict[str, Any]) -> None:
    p = sf.plan_transfer(c["size"], c["delta"])
    want = c["expect"]
    assert (p.mode, p.part_bytes, p.parts) == (want["mode"], want["partBytes"], want["parts"])


def test_transfer_plan_refuses_nonsense_and_slices_parts() -> None:
    for bad in (-1, True, 1.5):
        with pytest.raises(ValueError):
            sf.plan_transfer(bad, False)  # type: ignore[arg-type]
    size = 20 * 1024 * 1024 + 5
    plan = sf.plan_transfer(size, False)
    assert plan.mode == "multipart" and plan.parts == 3
    assert sf.part_range(plan, size, 1) == (0, plan.part_bytes)
    assert sf.part_range(plan, size, 3) == (2 * plan.part_bytes, size)  # type: ignore[operator]
    for n in (0, 4, True):
        with pytest.raises(ValueError):
            sf.part_range(plan, size, n)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        sf.part_range(sf.plan_transfer(10, False), 10, 1)


def _file_plain(label: str, length: int) -> bytes:
    """The plaintext of a seal row: SHA-256 counter blocks of the label (the file's recipe)."""
    out = bytearray()
    n = 0
    while len(out) < length:
        out += hashlib.sha256(("pkey-sync vector file " + label).encode() + n.to_bytes(4, "big")).digest()
        n += 1
    return bytes(out[:length])


_FSTRIDE = sf.FILE_SEGMENT_BYTES + sf.FILE_TAG_BYTES


def _segment_span(stream: bytes, i: int) -> "tuple[int, int]":
    a = sf.FILE_HEADER_BYTES + i * _FSTRIDE
    return a, min(len(stream), a + _FSTRIDE)


def apply_ops(stream: bytes, ops: List[Dict[str, Any]]) -> bytes:
    b = bytes(stream)
    for o in ops:
        op = o["op"]
        if op == "truncate":
            b = b[: o["length"]]
        elif op == "dropSegment":
            x, y = _segment_span(b, o["index"])
            b = b[:x] + b[y:]
        elif op == "swapSegments":
            lo, hi = sorted((o["a"], o["b"]))
            x1, y1 = _segment_span(b, lo)
            x2, y2 = _segment_span(b, hi)
            b = b[:x1] + b[x2:y2] + b[y1:x2] + b[x1:y1] + b[y2:]
        elif op == "appendSegment":
            x, y = _segment_span(b, o["from"])
            b = b + b[x:y]
        elif op == "xor":
            m = bytearray(b)
            m[o["offset"]] ^= o["value"]
            b = bytes(m)
        elif op == "setHex":
            m = bytearray(b)
            raw = H(o["hex"])
            m[o["offset"] : o["offset"] + len(raw)] = raw
            b = bytes(m)
        else:
            b = b + H(o["hex"])
    return b


_FILE_ROWS: List[Dict[str, Any]] = V["fileStreamCases"]
_SEAL_ROWS = {r["id"]: r for r in _FILE_ROWS if r["kind"] == "seal"}
_STREAMS: Dict[str, bytes] = {}


def _sealed(row: Dict[str, Any]) -> bytes:
    if row["id"] not in _STREAMS:
        root = H(row["rootHex"])
        _STREAMS[row["id"]] = sf.seal_file(
            sc.derive_coll_key(root, row["collection"]),
            sc.derive_kid(root),
            _file_plain(row["plain"]["label"], row["plain"]["length"]),
            H(row["saltHex"]),
        )
    return _STREAMS[row["id"]]


def _pieces(b: bytes, step: int) -> List[bytes]:
    return [b[at : at + step] for at in range(0, len(b), step)]


@pytest.mark.parametrize("r", list(_SEAL_ROWS.values()), ids=list(_SEAL_ROWS))
def test_file_seal(r: Dict[str, Any]) -> None:
    root = H(r["rootHex"])
    coll_key, kid, salt = sc.derive_coll_key(root, r["collection"]), sc.derive_kid(root), H(r["saltHex"])
    plain = _file_plain(r["plain"]["label"], r["plain"]["length"])
    want = r["expect"]
    assert hashlib.sha256(plain).hexdigest() == want["plainSha256Hex"]
    sealed = sf.seal_file(coll_key, kid, plain, salt)
    assert len(sealed) == want["sealedSize"] == sf.sealed_file_size(len(plain))
    assert sf.plain_file_size(len(sealed)) == len(plain)
    assert sealed[:64].hex() == want["headerHex"]
    assert hashlib.sha256(sealed).hexdigest() == want["sealedSha256Hex"]
    if "sealedHex" in want:
        assert sealed.hex() == want["sealedHex"]
    # The same bytes from a source that arrives in awkward pieces.
    streamed = b"".join(sf.seal_file_stream(coll_key, kid, _pieces(plain, 100_003), salt))
    assert hashlib.sha256(streamed).hexdigest() == want["sealedSha256Hex"]
    _STREAMS[r["id"]] = sealed


def test_file_sizes() -> None:
    row = next(r for r in _FILE_ROWS if r["kind"] == "sizes")
    for p, s in row["plainToSealed"]:
        assert sf.sealed_file_size(p) == s
    for s, p in row["sealedToPlain"]:
        assert sf.plain_file_size(s) == p
    for bad in (-1, True, 1.5):
        with pytest.raises(ValueError):
            sf.sealed_file_size(bad)  # type: ignore[arg-type]
    assert sf.plain_file_size(True) is None  # type: ignore[arg-type]


def _stored(row: Dict[str, Any]) -> "tuple[bytes, bytes, str]":
    base = _SEAL_ROWS[row["base"]]
    return apply_ops(_sealed(base), row["mutate"]), H(base["rootHex"]), base["collection"]


@pytest.mark.parametrize("r", [x for x in _FILE_ROWS if x["kind"] == "open"], ids=[x["id"] for x in _FILE_ROWS if x["kind"] == "open"])
def test_file_open(r: Dict[str, Any]) -> None:
    stream, root, coll = _stored(r)
    coll_key = sc.derive_coll_key(root, r.get("openCollection", coll))
    kid = H(r["expectKidHex"]) if "expectKidHex" in r else sc.derive_kid(root)
    whole = sf.open_file(coll_key, kid, stream)

    # Streamed in awkward pieces: the verdict does not depend on how it arrives.
    def piecewise() -> str:
        out = bytearray()
        try:
            for p in sf.open_file_stream(coll_key, kid, _pieces(stream, 300_007)):
                out += p
        except sf.FileStreamError as e:
            return e.reason
        return hashlib.sha256(bytes(out)).hexdigest()

    want = r["expect"]
    if want["result"] == "ok":
        assert whole.ok and hashlib.sha256(whole.plain).hexdigest() == want["plainSha256Hex"]
        assert piecewise() == want["plainSha256Hex"]
    else:
        assert not whole.ok and whole.reason == want["reason"]
        assert piecewise() == want["reason"]


@pytest.mark.parametrize("r", [x for x in _FILE_ROWS if x["kind"] == "range"], ids=[x["id"] for x in _FILE_ROWS if x["kind"] == "range"])
def test_file_range(r: Dict[str, Any]) -> None:
    stream, root, coll = _stored(r)
    reads: List[List[int]] = []

    def read(offset: int, length: int) -> bytes:
        reads.append([offset, length])
        return stream[offset : offset + length]

    want = r["expect"]
    try:
        got = sf.open_file_range(sc.derive_coll_key(root, coll), sc.derive_kid(root), read, len(stream), r["start"], r["end"])
    except sf.FileStreamError as e:
        assert want == {"result": "invalid", "reason": e.reason}
        return
    assert want["result"] == "ok"
    assert len(got) == want["length"] and hashlib.sha256(got).hexdigest() == want["sha256Hex"]
    assert reads == want["reads"]


def test_file_stream_error_names_no_bytes() -> None:
    e = sf.FileStreamError("auth")
    assert e.reason == "auth" and str(e) == "pkey-sync-file/1: auth"


def test_seal_file_uses_a_fresh_salt_every_time() -> None:
    root = bytes(range(32))
    ck, kid = sc.derive_coll_key(root, "saves"), sc.derive_kid(root)
    a, b = sf.seal_file(ck, kid, b"same"), sf.seal_file(ck, kid, b"same")
    assert a[32:64] != b[32:64] and a != b
    assert sf.open_file(ck, kid, a).plain == b"same"
    with pytest.raises(ValueError):
        sf.encode_file_header(kid[:15], bytes(32))
    with pytest.raises(ValueError):
        sf.encode_file_header(kid, bytes(31))


def test_verify_reassembly_checks_length_and_hash_after_the_last_piece() -> None:
    data = bytes(range(200))
    good = hashlib.sha256(data).digest()
    assert b"".join(sf.verify_reassembly([data[:50], data[50:]], 200, good)) == data

    def reason(pieces: List[bytes], size: int, digest: bytes) -> str:
        try:
            list(sf.verify_reassembly(pieces, size, digest))
        except sf.FileStreamError as e:
            return e.reason
        return "ok"

    assert reason([data[:199]], 200, good) == "plainSize"
    assert reason([data, b"x"], 200, good) == "plainSize"
    assert reason([data[:-1] + b"x"], 200, good) == "plainSha256"
    assert reason([b""], sf.SYNC_FILE_MAX_BYTES + 1, good) == "plainSize"
    # An overrun stops at once: the second piece is never taken from the source.
    taken: List[int] = []

    def source() -> Any:
        for i, p in enumerate([data, b"x", b"y"]):
            taken.append(i)
            yield p

    assert reason(source(), 200, good) == "plainSize" and taken == [0, 1]
