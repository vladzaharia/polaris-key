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
from polaris_key.core.store import CACHE_FORMAT_VERSION, CacheRecord, ImportedBundle
from polaris_key.devices.deviceid import derive_device_id
from polaris_key.devices.store import (
    MAX_STATE_FILE_BYTES,
    SYMLINK_GUARD,
    FileStore,
    InMemoryStore,
    KeyringStore,
)

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
    assert verify_jws("a.b", TRUST, require_typ=True) is None


def test_verify_rejects_garbage() -> None:
    assert verify_jws("not-a-jws", {}, require_typ=True) is None
    assert verify_jws("...", {}, require_typ=True) is None
    assert verify_jws("", {}, require_typ=True) is None


def test_verify_rejects_a_non_string_input() -> None:
    assert verify_jws(None, TRUST, require_typ=True) is None  # type: ignore[arg-type]
    assert verify_jws(b"a.b.c", TRUST, require_typ=True) is None  # type: ignore[arg-type]


def test_verify_rejects_oversized_payload() -> None:
    """A validly-signed JWS whose decoded payload exceeds the size cap is rejected BEFORE
    ``json.loads``, so an oversized doc never reaches the parser."""
    big = "x" * (MAX_DOC_BYTES + 1)
    assert verify_jws(sign_jws({"blob": big}, PRIVATE_PEM, KID, TYP_LICENSE), TRUST, require_typ=True) is None
    ok = sign_jws({"blob": "x" * 16}, PRIVATE_PEM, KID, TYP_LICENSE)
    assert verify_jws(ok, TRUST, require_typ=True) is not None


def test_verify_rejects_an_unknown_kid_and_a_wrong_key() -> None:
    jws = sign_jws({"a": 1}, PRIVATE_PEM, KID, TYP_LICENSE)
    assert verify_jws(jws, {}, require_typ=True) is None
    assert verify_jws(jws, {"other": PUBKEY_RAW}, require_typ=True) is None
    # Right kid, wrong bytes.
    assert verify_jws(jws, {KID: "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U"}, require_typ=True) is None


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
        importedBundle=ImportedBundle(bundleId="B1", importedAt=99),
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


def test_a_malformed_imported_bundle_marker_is_dropped() -> None:
    rec = CacheRecord.from_dict(
        {"v": CACHE_FORMAT_VERSION, "importedBundle": {"bundleId": 7, "importedAt": "x"}}
    )
    assert rec.importedBundle is None


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


# ── hostile filesystem: O_NOFOLLOW + a size cap on the READ (B1-04/B1-07) ───────────
#
# Mode 0600 was applied only AT CREATION and the read was a plain ``open()``, so a symlink
# planted at ``managed.json``/``token``/``device`` redirected the read to a file the attacker
# chose, and a huge file at the path was read whole into the process. Every refusal must land
# as **ABSENT** (``None``) — this store's one spelling of a failed artifact (§4.1) — never as
# a crash and never as the attacker's bytes. Mirrors
# ``packages/sdk-node/test/storeSecurity.test.ts`` and Swift's ``readSecure``.


def _cache_json(padding: str = "") -> str:
    rec: dict = {
        "v": CACHE_FORMAT_VERSION,
        "docs": {"license": "a.b.c"},
        "etags": {"license": "lic-1"},
        "lastSyncUnauthorized": False,
    }
    if padding:
        rec["pad"] = padding
    return json.dumps(rec)


def _cache_json_of_size(size: int) -> str:
    """All-ASCII JSON of EXACTLY ``size`` bytes, so the cap is pinned on both sides."""
    body = _cache_json("x" * (size - len(_cache_json()) - len(', "pad": ""')))
    assert len(body.encode("utf-8")) == size, f"fixture is {len(body)} bytes"
    return body


def test_the_symlink_guard_is_declared_and_covers_the_read() -> None:
    """The strength of the refusal is a value a host can read, not a comment promising
    something the platform may not give (R4-10). It now guards the READ as well."""
    assert SYMLINK_GUARD in ("O_NOFOLLOW", "lstat-precheck")
    if hasattr(os, "O_NOFOLLOW"):
        assert SYMLINK_GUARD == "O_NOFOLLOW"


def test_a_symlinked_cache_path_reads_as_absent(tmp_path) -> None:
    """The target is a perfectly parseable v3 record; the only reason the read is ``None``
    is the refusal to follow the link."""
    store = FileStore("djdl", str(tmp_path))
    outside = tmp_path / "attacker-owned"
    outside.write_text(_cache_json(), encoding="utf-8")
    cache_path = os.path.join(str(tmp_path), "djdl", "managed.json")
    if os.path.exists(cache_path):
        os.remove(cache_path)
    os.symlink(str(outside), cache_path)

    assert CacheRecord.from_dict(json.loads(outside.read_text())).docs["license"] == "a.b.c"
    assert store.read_cache() is None
    assert outside.read_text(encoding="utf-8") == _cache_json()


def test_a_symlinked_token_path_reads_as_absent(tmp_path) -> None:
    store = FileStore("djdl", str(tmp_path))
    outside = tmp_path / "attacker-token"
    outside.write_text("pkeyt_attacker-chose-this\n", encoding="utf-8")
    os.symlink(str(outside), os.path.join(str(tmp_path), "djdl", "token"))
    assert store.get_token() is None


def test_a_symlinked_device_path_refuses_rather_than_adopting_the_id(tmp_path) -> None:
    """The device id is the Device principal's NAME (§6). Reading one through a link would
    let a local attacker rename this install; writing the freshly-minted replacement through
    the same link would let them place it. So the read is absent and the write refuses."""
    store = FileStore("djdl", str(tmp_path))
    outside = tmp_path / "attacker-device"
    outside.write_text("attacker-chosen-device-id", encoding="utf-8")
    os.symlink(str(outside), os.path.join(str(tmp_path), "djdl", "device"))

    with pytest.raises(OSError):
        store.get_device_id()
    assert outside.read_text(encoding="utf-8") == "attacker-chosen-device-id"


def test_the_read_cap_is_named_and_generous() -> None:
    # Three compact JWSs plus hints; a document payload is capped at 64 KiB and base64url
    # encodes to ~87 KiB. Same number Swift's `KeychainStore.maxCacheBytes` uses.
    assert MAX_STATE_FILE_BYTES == 1024 * 1024


def test_a_cache_file_exactly_at_the_cap_still_reads(tmp_path) -> None:
    store = FileStore("djdl", str(tmp_path))
    path = os.path.join(str(tmp_path), "djdl", "managed.json")
    with open(path, "w", encoding="utf-8") as f:
        f.write(_cache_json_of_size(MAX_STATE_FILE_BYTES))
    loaded = store.read_cache()
    assert loaded is not None and loaded.docs["license"] == "a.b.c"


def test_a_cache_file_one_byte_over_the_cap_reads_as_absent(tmp_path) -> None:
    """Byte-for-byte the same shape as the case above; only the size differs."""
    store = FileStore("djdl", str(tmp_path))
    path = os.path.join(str(tmp_path), "djdl", "managed.json")
    with open(path, "w", encoding="utf-8") as f:
        f.write(_cache_json_of_size(MAX_STATE_FILE_BYTES + 1))
    assert store.read_cache() is None


def test_a_directory_planted_at_the_cache_path_reads_as_absent(tmp_path) -> None:
    """Not a regular file => not the file we wrote. ``EISDIR`` must degrade to "re-fetch",
    not to a client that cannot boot."""
    store = FileStore("djdl", str(tmp_path))
    os.mkdir(os.path.join(str(tmp_path), "djdl", "managed.json"))
    assert store.read_cache() is None


def test_the_hardened_read_still_round_trips_and_stays_0600(tmp_path) -> None:
    store = FileStore("djdl", str(tmp_path))
    store.set_token("pkeyt_roundtrip")
    rec = CacheRecord(docs={"license": "a.b.c"}, etags={"license": "lic-1"})
    store.write_cache(rec)
    device_id = store.get_device_id()

    fresh = FileStore("djdl", str(tmp_path))
    assert fresh.get_token() == "pkeyt_roundtrip"
    assert fresh.read_cache() == rec
    assert fresh.get_device_id() == device_id

    for name in ("token", "managed.json", "device"):
        mode = stat.S_IMODE(os.stat(os.path.join(str(tmp_path), "djdl", name)).st_mode)
        assert mode == 0o600, f"{name} must be 0600"


def test_a_pre_existing_loose_mode_is_repaired_on_write(tmp_path) -> None:
    """0600 applies AT CREATION only, so a record left world-readable by an older build (or
    by a first write that died between ``open`` and ``chmod``) is tightened by the next
    write rather than inherited."""
    store = FileStore("djdl", str(tmp_path))
    path = os.path.join(str(tmp_path), "djdl", "managed.json")
    with open(path, "w", encoding="utf-8") as f:
        f.write(_cache_json())
    os.chmod(path, 0o644)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o644

    store.write_cache(CacheRecord(docs={"license": "a.b.c"}))
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


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
