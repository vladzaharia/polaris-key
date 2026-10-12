# @pkey-feature core.verify core.store
"""Store round-trip (cache v3) + b64url + JWS edge cases (none/malformed/wrong-key)."""

from __future__ import annotations

import json
import os
import stat
import threading

import pytest

from polaris_key.core.b64url import b64url_decode, b64url_encode, b64url_encode_str
from polaris_key.core.jws import sign_jws, verify_jws
from polaris_key.core.models import (
    BLOCK_REASONS,
    MAX_DOC_BYTES,
    TYP_LICENSE,
    AllowedRange,
    BlockedState,
)
from polaris_key.core.store import CACHE_FORMAT_VERSION, CacheRecord
from polaris_key.devices.deviceid import derive_device_id
from polaris_key.devices.store import (
    MAX_STATE_FILE_BYTES,
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


@pytest.mark.parametrize(
    "poisoned",
    [
        {"reason": "ok"},
        {"reason": "grace"},
        {"reason": "not-applicable"},
        {"reason": "definitely-fine"},
        {"reason": ""},
        {"reason": None},
        {"reason": 5},
        {"reason": ["version-too-old"]},
        {"allowedRange": {"min": "1.0.0"}},
        "version-too-old",
        ["version-too-old"],
    ],
)
def test_a_blocked_hint_outside_the_vocabulary_is_dropped_and_the_rest_of_the_record_survives(
    poisoned,
) -> None:
    """§4.1 keeps ``blocked`` unsigned on the argument that it can only ever make the gate
    STRICTER, and the gate returns its reason AS the status — so a reason outside
    ``BLOCK_REASONS`` (``{"reason": "ok"}`` is the one that matters) must not survive the
    decode. It is DROPPED, not coerced: the record is simply not one this client wrote, and
    the honest reading of a hint that does not parse is that there is none."""
    rec = CacheRecord.from_dict(
        {
            "v": CACHE_FORMAT_VERSION,
            "docs": {"license": "l.w.s"},
            "trustJws": "t.w.s",
            "blocked": poisoned,
        }
    )
    assert rec.blocked is None
    assert rec.docs == {"license": "l.w.s"} and rec.trustJws == "t.w.s"


@pytest.mark.parametrize("reason", BLOCK_REASONS)
def test_a_blocked_hint_inside_the_vocabulary_is_read_back_with_its_range(reason: str) -> None:
    """The drop narrows the hint; it does not delete the feature."""
    rec = CacheRecord.from_dict(
        {
            "v": CACHE_FORMAT_VERSION,
            "blocked": {"reason": reason, "allowedRange": {"min": "1.0.0"}},
        }
    )
    assert rec.blocked == BlockedState(reason=reason, allowedRange=AllowedRange(min="1.0.0"))


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


# ── hostile filesystem: O_NOFOLLOW + a size cap on the READ ─────────────────────────
#
# Mode 0600 applies at creation, so a symlink planted at ``managed.json``/``token``/``device``
# would redirect a plain ``open()`` read to a file the attacker chose, and a huge file at the
# path would be read whole into the process. Every refusal must land as **ABSENT** (``None``) —
# this store's one spelling of a failed artifact (§4.1) — never as a crash and never as the
# attacker's bytes.


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
    body = _cache_json("x" * (size - len(_cache_json("x")) + 1))
    assert len(body.encode("utf-8")) == size, f"fixture is {len(body)} bytes"
    return body


def test_a_symlinked_cache_path_reads_as_absent(tmp_path) -> None:
    """The target is a perfectly parseable v3 record; the only reason the read is ``None``
    is the refusal to follow the link."""
    store = FileStore("djdl", str(tmp_path))
    outside = tmp_path / "attacker-owned"
    outside.write_text(_cache_json(), encoding="utf-8")
    cache_path = os.path.join(str(tmp_path), "djdl", "managed.json")
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


def test_the_lstat_precheck_refuses_a_symlink_on_the_read_too(monkeypatch, tmp_path) -> None:
    """Force the no-``O_NOFOLLOW`` (Windows) path: the read still refuses the link."""
    import polaris_key.devices.store as store_mod

    store = FileStore("djdl", str(tmp_path))
    outside = tmp_path / "attacker-owned"
    outside.write_text(_cache_json(), encoding="utf-8")
    token_outside = tmp_path / "attacker-token"
    token_outside.write_text("pkeyt_attacker-chose-this\n", encoding="utf-8")
    os.symlink(str(outside), os.path.join(str(tmp_path), "djdl", "managed.json"))
    os.symlink(str(token_outside), os.path.join(str(tmp_path), "djdl", "token"))

    monkeypatch.setattr(store_mod, "_O_NOFOLLOW", None)
    assert store.read_cache() is None
    assert store.get_token() is None


def test_the_read_cap_is_named_and_generous() -> None:
    # A signed document's payload is capped at 64 KiB, which base64url-encodes to ~87 KiB, and
    # the record holds only compact JWSs plus a few hints.
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


def test_the_cap_binds_the_token_and_the_device_file_too(tmp_path) -> None:
    store = FileStore("djdl", str(tmp_path))
    token_path = os.path.join(str(tmp_path), "djdl", "token")
    with open(token_path, "w", encoding="utf-8") as f:
        f.write("t" * MAX_STATE_FILE_BYTES)
    assert store.get_token() == "t" * MAX_STATE_FILE_BYTES
    with open(token_path, "w", encoding="utf-8") as f:
        f.write("t" * (MAX_STATE_FILE_BYTES + 1))
    assert store.get_token() is None

    # An oversize device file is ABSENT, so the id is re-derived and the file replaced.
    device_path = os.path.join(str(tmp_path), "djdl", "device")
    with open(device_path, "w", encoding="utf-8") as f:
        f.write("d" * (MAX_STATE_FILE_BYTES + 1))
    device_id = store.get_device_id()
    assert len(device_id) == 32
    assert os.path.getsize(device_path) == 32


def test_a_directory_planted_at_the_cache_path_reads_as_absent(tmp_path) -> None:
    """Not a regular file => not the file we wrote. ``EISDIR`` must degrade to "re-fetch",
    not to a client that cannot boot."""
    store = FileStore("djdl", str(tmp_path))
    os.mkdir(os.path.join(str(tmp_path), "djdl", "managed.json"))
    assert store.read_cache() is None


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs POSIX FIFOs")
def test_a_fifo_planted_at_a_state_path_reads_as_absent_without_blocking(tmp_path) -> None:
    """Opening a FIFO read-only blocks until a writer appears, so without ``O_NONBLOCK`` a
    planted FIFO would hang the process inside ``open(2)`` before the regular-file check could
    refuse it."""
    store = FileStore("djdl", str(tmp_path))
    fifo = os.path.join(str(tmp_path), "djdl", "managed.json")
    os.mkfifo(fifo)
    result: list = []
    reader = threading.Thread(target=lambda: result.append(store.read_cache()), daemon=True)
    reader.start()
    reader.join(timeout=10)
    try:
        assert not reader.is_alive(), "reading a FIFO must not wait for a writer"
        assert result == [None]
    finally:
        if reader.is_alive():
            # Release a reader a regression left blocked in open(2), so the suite can exit.
            fd = os.open(fifo, os.O_WRONLY)
            os.close(fd)
            reader.join(timeout=5)


def test_a_state_file_that_is_not_utf8_reads_as_absent_instead_of_raising(tmp_path) -> None:
    store = FileStore("djdl", str(tmp_path))
    for name in ("token", "managed.json"):
        with open(os.path.join(str(tmp_path), "djdl", name), "wb") as f:
            f.write(b"\xff\xfe\xfa not utf-8")
    assert store.get_token() is None
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


@pytest.mark.skipif(not hasattr(os, "fchmod"), reason="needs POSIX file modes")
@pytest.mark.parametrize(
    "name,write",
    [
        ("managed.json", lambda s: s.write_cache(CacheRecord(docs={"license": "a.b.c"}))),
        ("token", lambda s: s.set_token("pkeyt_repaired")),
        ("device", lambda s: s.set_device_id("d" * 32)),
    ],
    ids=["cache", "token", "device"],
)
def test_a_pre_existing_loose_mode_is_repaired_on_write(name, write, tmp_path) -> None:
    """0600 applies AT CREATION only, so a record left world-readable by an older build (or
    by a first write that died between ``open`` and ``chmod``) is tightened by the next
    write rather than inherited."""
    store = FileStore("djdl", str(tmp_path))
    path = os.path.join(str(tmp_path), "djdl", name)
    with open(path, "w", encoding="utf-8") as f:
        f.write("placeholder")
    os.chmod(path, 0o644)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o644

    write(store)
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
