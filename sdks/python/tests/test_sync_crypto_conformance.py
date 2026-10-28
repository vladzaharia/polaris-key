# @pkey-feature sync.keyring
"""The Cloud Sync E2E crypto against ``conformance/corpus/v2/sync-vectors.json`` (U-38.3;
WIRE-CONTRACT-V5 §13.10, §13.11): hkdfCases, envelopeCases, blindCases, hpkeAnchor, wrapCases,
recoveryCodeCases and adoptCases. cdc, chunk, file-stream, manifest and transfer-plan sections are
other work packages and are not read here (the table is inert to a runner that skips them).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.core import sync_crypto as sc

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
