# @pkey-feature core.verify core.store
"""Store round-trip (cache v3) + b64url + JWS edge cases (none/malformed/wrong-key)."""

from __future__ import annotations

import json
import os
import stat

import pytest

from polaris_key.core.b64url import b64url_decode, b64url_encode, b64url_encode_str
from polaris_key.core.jws import sign_jws, verify_jws
from polaris_key.core.models import (
    MAX_DOC_BYTES,
    TYP_LICENSE,
    AllowedRange,
    BlockedState,
)
from polaris_key.core.store import CACHE_FORMAT_VERSION, CacheRecord
from polaris_key.devices.deviceid import derive_device_id
from polaris_key.devices.store import FileStore, InMemoryStore, KeyringStore

KID = "pkey-test-prod-2026"
PUBKEY_RAW = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"
PRIVATE_PEM = (
    "-----BEGIN PRIVATE KEY-----\n"
    "MC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n"
    "-----END PRIVATE KEY-----"
)
TRUST = {KID: PUBKEY_RAW}


# ── b64url ──────────────────────────────────────────────────────────────────────────
def test_b64url_roundtrip_no_padding() -> None:
    raw = b"\x00\x01\x02\xff\xfe"
    enc = b64url_encode(raw)
    assert "=" not in enc and "+" not in enc and "/" not in enc
    assert b64url_decode(enc) == raw
    assert b64url_decode(b64url_encode_str("héllo")) == "héllo".encode("utf-8")


def test_b64url_decode_tolerates_missing_padding() -> None:
    # 32-byte key from the corpus, unpadded.
    assert len(b64url_decode(PUBKEY_RAW)) == 32


# ── JWS edges ───────────────────────────────────────────────────────────────────────
def test_verify_rejects_two_part_jws() -> None:
    assert verify_jws("a.b", TRUST, typ=TYP_LICENSE) is None


def test_verify_rejects_garbage() -> None:
    assert verify_jws("not-a-jws", {}, typ=TYP_LICENSE) is None
    assert verify_jws("...", {}, typ=TYP_LICENSE) is None
    assert verify_jws("", {}, typ=TYP_LICENSE) is None


def test_verify_rejects_a_non_string_input() -> None:
    assert verify_jws(None, TRUST, typ=TYP_LICENSE) is None  # type: ignore[arg-type]
    assert verify_jws(b"a.b.c", TRUST, typ=TYP_LICENSE) is None  # type: ignore[arg-type]


def test_verify_rejects_oversized_payload() -> None:
    """A validly-signed JWS whose decoded payload exceeds the size cap is rejected BEFORE
    ``json.loads``, so an oversized doc never reaches the parser."""
    big = "x" * (MAX_DOC_BYTES + 1)
    assert verify_jws(sign_jws({"blob": big}, PRIVATE_PEM, KID, TYP_LICENSE), TRUST, typ=TYP_LICENSE) is None
    ok = sign_jws({"blob": "x" * 16}, PRIVATE_PEM, KID, TYP_LICENSE)
    assert verify_jws(ok, TRUST, typ=TYP_LICENSE) is not None


def test_verify_rejects_an_unknown_kid_and_a_wrong_key() -> None:
    jws = sign_jws({"a": 1}, PRIVATE_PEM, KID, TYP_LICENSE)
    assert verify_jws(jws, {}, typ=TYP_LICENSE) is None
    assert verify_jws(jws, {"other": PUBKEY_RAW}, typ=TYP_LICENSE) is None
    # Right kid, wrong bytes.
    assert verify_jws(jws, {KID: "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U"}, typ=TYP_LICENSE) is None


def test_sign_requires_an_ed25519_key() -> None:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    rsa_pem = (
        rsa.generate_private_key(public_exponent=65537, key_size=2048)
        .private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        .decode("ascii")
    )
    with pytest.raises(ValueError):
        sign_jws({"a": 1}, rsa_pem, KID, TYP_LICENSE)


# ── device id ───────────────────────────────────────────────────────────────────────
def test_device_id_is_stable_and_short() -> None:
    a = derive_device_id("djdl", fallback="seed")
    assert a == derive_device_id("djdl", fallback="seed")
    assert len(a) == 32
    # Different product => different id.
    assert derive_device_id("other", fallback="seed") != a


# ── the cache record ────────────────────────────────────────────────────────────────
def test_cache_record_round_trips_every_v3_slice() -> None:
    rec = CacheRecord(
        docs={"license": "l.w.s", "config": "c.w.s"},
        etags={"license": "l1", "config": "c1"},
        trustJws="t.w.s",
        bundle="b.w.s",
        pinRevocations={KID: "r.e.v"},
        lastSyncUnauthorized=True,
        blocked=BlockedState(
            reason="version-too-old", allowedRange=AllowedRange(min="2.0.0")
        ),
    )
    round_tripped = CacheRecord.from_dict(rec.to_dict())
    assert round_tripped == rec


def test_an_unknown_doc_slice_is_dropped_on_read() -> None:
    """The record has exactly two slices. An invented third is not a document this client
    will ever fetch, so it is not carried into memory either."""
    rec = CacheRecord.from_dict(
        {
            "v": CACHE_FORMAT_VERSION,
            "docs": {"license": "l.w.s", "identity": "x.y.z"},
            "etags": {"identity": "e"},
        }
    )
    assert rec.docs == {"license": "l.w.s"}
    assert rec.etags == {}


@pytest.mark.parametrize("version", [None, 1, 2, "3", 4])
def test_a_foreign_cache_version_is_refused(version) -> None:
    """§4.1: ``v != 3`` is DISCARDED, never migrated. Checked BEFORE any field is read, so
    a v1/v2 record's ``trustedKeys`` and unsigned counters are never even looked at."""
    with pytest.raises(ValueError):
        CacheRecord.from_dict({"v": version, "trustedKeys": {KID: "attacker"}})


def test_a_non_string_bundle_slice_is_dropped_and_the_old_marker_is_never_read() -> None:
    rec = CacheRecord.from_dict({"v": CACHE_FORMAT_VERSION, "bundle": {"bundleId": "B1"}})
    assert rec.bundle is None
    old = CacheRecord.from_dict(
        {"v": CACHE_FORMAT_VERSION, "importedBundle": {"bundleId": "B1", "importedAt": 99}}
    )
    assert old.bundle is None and "importedBundle" not in old.to_dict()


# ── FileStore ───────────────────────────────────────────────────────────────────────
def test_filestore_roundtrip_and_permissions(tmp_path) -> None:
    store = FileStore("djdl", str(tmp_path))

    assert store.get_token() is None
    store.set_token("pkeyt_abc")
    assert store.get_token() == "pkeyt_abc"

    device_id = store.get_device_id()
    assert len(device_id) == 32
    assert store.get_device_id() == device_id  # persisted

    # v3 persists the SIGNED ARTIFACTS, never the decoded doc or bare key material.
    license_jws = sign_jws({"hello": "world"}, PRIVATE_PEM, KID, TYP_LICENSE)
    trust_jws = sign_jws({"keys": []}, PRIVATE_PEM, KID)
    rec = CacheRecord(
        docs={"license": license_jws},
        etags={"license": "v1"},
        trustJws=trust_jws,
        blocked=BlockedState(
            reason="version-too-old", allowedRange=AllowedRange(min="2.0.0")
        ),
    )
    store.write_cache(rec)
    loaded = store.read_cache()
    assert loaded is not None
    assert loaded.docs["license"] == license_jws
    assert loaded.trustJws == trust_jws
    assert loaded.etags["license"] == "v1"
    assert loaded.blocked is not None and loaded.blocked.reason == "version-too-old"
    assert loaded.blocked.allowedRange is not None
    assert loaded.blocked.allowedRange.min == "2.0.0"

    # The record on disk carries the format version and NONE of the v1 unsigned fields.
    on_disk = json.loads(
        open(os.path.join(str(tmp_path), "djdl", "managed.json"), encoding="utf-8").read()
    )
    assert on_disk["v"] == CACHE_FORMAT_VERSION
    for removed in (
        "doc",
        "trustedKeys",
        "lastAcceptedIssuedAt",
        "lastTrustIssuedAt",
        "lastVerifiedAt",
        "configJws",  # the v2 single-document field
    ):
        assert removed not in on_disk, f"{removed} must not be persisted (§4.1)"

    token_mode = stat.S_IMODE(
        os.stat(os.path.join(str(tmp_path), "djdl", "token")).st_mode
    )
    assert token_mode == 0o600

    store.clear_token()
    store.clear_cache()
    assert store.get_token() is None
    assert store.read_cache() is None


def test_v1_and_v2_cache_records_are_discarded_not_migrated(tmp_path) -> None:
    store = FileStore("djdl", str(tmp_path))
    path = os.path.join(str(tmp_path), "djdl", "managed.json")
    for record in (
        {
            "doc": {"aud": "djdl"},
            "lastAcceptedIssuedAt": 0,
            "trustedKeys": {KID: "attacker-key"},
            "lastVerifiedAt": 99,
        },
        {"v": 2, "configJws": "a.b.c", "lastSyncUnauthorized": False},
    ):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(record, f)
        assert store.read_cache() is None


def test_filestore_ignores_an_unreadable_cache(tmp_path) -> None:
    store = FileStore("djdl", str(tmp_path))
    with open(
        os.path.join(str(tmp_path), "djdl", "managed.json"), "w", encoding="utf-8"
    ) as f:
        f.write("{not json")
    assert store.read_cache() is None


def test_keyring_store_falls_back_to_files_and_uses_the_pkey_tag(tmp_path) -> None:
    """§8: the OS keyring service tag is ``pkey:<product>`` — stable across wire-contract
    revisions. The ``plrs:`` spelling withdrawn by Amendment A1 is neither written nor read."""
    store = KeyringStore("djdl", str(tmp_path))
    assert store.service == "pkey:djdl"
    # With no `keyring` extra installed the file fallback carries everything.
    store.set_token("pkeyt_x")
    assert store.get_token() == "pkeyt_x"
    assert len(store.get_device_id()) == 32
    rec = CacheRecord(lastSyncUnauthorized=True)
    store.write_cache(rec)
    assert store.read_cache() == rec
    store.clear_cache()
    store.clear_token()
    assert store.read_cache() is None and store.get_token() is None


def test_inmemory_store_roundtrip() -> None:
    s = InMemoryStore("djdl")
    assert s.get_token() is None
    s.set_token("pkeyt_t")
    assert s.get_token() == "pkeyt_t"
    assert len(s.get_device_id()) == 32
    assert s.read_cache() is None
    rec = CacheRecord(lastSyncUnauthorized=True)
    s.write_cache(rec)
    assert s.read_cache() is rec
    s.clear_cache()
    assert s.read_cache() is None
