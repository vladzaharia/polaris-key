"""FileStore round-trip + b64url + verify edge cases (none/malformed/wrong-key)."""

from __future__ import annotations

import os
import stat

import pytest

from polaris_key.b64url import b64url_decode, b64url_encode, b64url_encode_str
from polaris_key.deviceid import derive_device_id
from polaris_key.license import BlockedState
from polaris_key.models import AllowedRange, DocProfile, ManagedConfigDoc, ManagedPayload
from polaris_key.store import CacheRecord, FileStore, InMemoryStore
from polaris_key.verify import MAX_PAYLOAD_BYTES, sign_jws, verify_jws

KID = "pkey-test-prod-2026"
PUBKEY_RAW = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"
PRIVATE_PEM = (
    "-----BEGIN PRIVATE KEY-----\n"
    "MC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n"
    "-----END PRIVATE KEY-----"
)


def test_b64url_roundtrip_no_padding() -> None:
    raw = b"\x00\x01\x02\xff\xfe"
    enc = b64url_encode(raw)
    assert "=" not in enc and "+" not in enc and "/" not in enc
    assert b64url_decode(enc) == raw
    assert b64url_decode(b64url_encode_str("héllo")) == "héllo".encode("utf-8")


def test_b64url_decode_tolerates_missing_padding() -> None:
    # 32-byte key from the corpus, unpadded.
    raw = b64url_decode("kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI")
    assert len(raw) == 32


def test_verify_rejects_two_part_jws() -> None:
    assert verify_jws("a.b", {"k": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"}) is None


def test_verify_rejects_garbage() -> None:
    assert verify_jws("not-a-jws", {}) is None
    assert verify_jws("...", {}) is None


def test_verify_rejects_oversized_payload() -> None:
    """P1.7: a validly-signed JWS whose decoded payload exceeds the size cap is rejected
    BEFORE json.loads, so an oversized doc never reaches the parser."""
    trust = {KID: PUBKEY_RAW}
    big = "x" * (MAX_PAYLOAD_BYTES + 1)
    oversized = sign_jws({"blob": big}, PRIVATE_PEM, KID)
    assert verify_jws(oversized, trust) is None
    # A small, validly-signed payload under the cap still verifies.
    ok = sign_jws({"blob": "x" * 16}, PRIVATE_PEM, KID)
    assert verify_jws(ok, trust) is not None


def test_device_id_is_stable_and_short() -> None:
    a = derive_device_id("djdl", fallback="seed")
    b = derive_device_id("djdl", fallback="seed")
    assert a == b
    assert len(a) == 32
    # Different product => different id.
    assert derive_device_id("other", fallback="seed") != a


def test_filestore_roundtrip_and_permissions(tmp_path) -> None:
    store = FileStore("djdl", str(tmp_path))

    assert store.get_token() is None
    store.set_token("tok_abc")
    assert store.get_token() == "tok_abc"

    device_id = store.get_device_id()
    assert len(device_id) == 32
    assert store.get_device_id() == device_id  # persisted

    doc = ManagedConfigDoc(
        schemaVersion=1,
        aud="djdl",
        iss="key.plrs.im",
        licenseId="lic_1",
        deviceId=device_id,
        issuedAt=1700000000,
        expiresAt=1700003600,
        graceUntil=1702592000,
        profile=DocProfile(name="A", firstName="A", email="a@b.c", activatedAt=0),
        payload=ManagedPayload(
            config={}, secrets={}, entitlements={}
        ),
    )
    rec = CacheRecord(
        doc=doc,
        etag="v1",
        lastAcceptedIssuedAt=doc.issuedAt,
        lastVerifiedAt=1700000001,
        lastSyncUnauthorized=False,
        blocked=BlockedState(
            reason="version-too-old", allowedRange=AllowedRange(min="2.0.0")
        ),
    )
    store.write_cache(rec)
    loaded = store.read_cache()
    assert loaded is not None
    assert loaded.doc is not None
    assert loaded.doc.licenseId == "lic_1"
    assert loaded.etag == "v1"
    assert loaded.blocked is not None and loaded.blocked.reason == "version-too-old"
    assert loaded.blocked.allowedRange is not None
    assert loaded.blocked.allowedRange.min == "2.0.0"

    # Token + cache files are 0600.
    token_mode = stat.S_IMODE(os.stat(os.path.join(str(tmp_path), "djdl", "token")).st_mode)
    assert token_mode == 0o600

    store.clear_token()
    store.clear_cache()
    assert store.get_token() is None
    assert store.read_cache() is None


def test_inmemory_store_roundtrip() -> None:
    s = InMemoryStore("djdl")
    assert s.get_token() is None
    s.set_token("t")
    assert s.get_token() == "t"
    assert len(s.get_device_id()) == 32
    assert s.read_cache() is None
    rec = CacheRecord(doc=None, lastSyncUnauthorized=True)
    s.write_cache(rec)
    assert s.read_cache() is rec
    s.clear_cache()
    assert s.read_cache() is None
