# @pkey-feature core.verify
# @pkey-feature core.cache
# @pkey-feature core.sync
# @pkey-feature core.bundle
"""Wire batch W: pinned-key tombstones with signed evidence, the trust-signer retry, the signed
bundle slice with per-type floors, and the device-id re-binding that keeps the evidence.

Each test fails on the parent commit's source."""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx
import pytest

from helpers import (
    BASE_URL,
    DAY,
    KID,
    NOW,
    PRIVATE_PEM,
    PRODUCT,
    PUBKEY_RAW,
    ROTATED_PEM,
    ROTATED_PUB,
    TOKEN,
    key_entry,
    make_client,
    routes,
    sign_bundle,
    sign_config,
    sign_license,
    sign_manifest,
)
from polaris_key.constants_generated import MAX_TRUST_SIGNER_ATTEMPTS
from polaris_key.core.bundle import INNER_DOC_REJECTED
from polaris_key.core.errors import PolarisError
from polaris_key.core.device_binding import bind_device_id
from polaris_key.core.store import CacheRecord
from polaris_key.devices.deviceid import device_id_from_raw
from polaris_key.devices.store import FileStore, InMemoryStore
from polaris_key.local import create_local_client

ALT = "alt-test-2026"
PINS = {KID: PUBKEY_RAW, ALT: ROTATED_PUB}


def _alt_manifest(*, issued: int = NOW, revoke_pin: bool = True) -> str:
    """Signed by ALT: lists KID as revoked with its exact pinned bytes."""
    keys = [
        key_entry(KID, PUBKEY_RAW, "revoked" if revoke_pin else "active"),
        key_entry(ALT, ROTATED_PUB),
    ]
    return sign_manifest(keys, issued=issued, pem=ROTATED_PEM, kid=ALT)


def _synced(store: Any, manifest: str):
    c = make_client(
        routes(
            trust_jws=manifest,
            license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]),
        ),
        store=store,
        trust=PINS,
    )
    c._tokens.set(TOKEN)
    c.sync()
    return c


# ── tombstones and their evidence (§1, §4.1) ────────────────────────────────────────
def test_a_revoking_manifest_is_filed_as_evidence_in_the_same_write_and_survives_restart() -> None:
    store = InMemoryStore(PRODUCT)
    manifest = _alt_manifest()
    c = _synced(store, manifest)
    assert c._trust.revoked_pins == [KID]
    assert KID not in c._trust.effective
    rec = store.read_cache()
    assert rec is not None
    assert rec.trustJws == manifest and rec.pinRevocations == {KID: manifest}
    c.close()

    # A restart re-derives the tombstone from the evidence, so the pin stays dead and a
    # manifest it signed is refused.
    again = make_client(routes(), store=store, trust=PINS)
    assert again._trust.revoked_pins == [KID]
    assert again._trust.effective.get(KID) is None
    stale = sign_manifest([key_entry(KID, PUBKEY_RAW)], issued=NOW + 10)
    assert again._trust.load_cached(stale) is False
    again.close()


def test_evidence_that_no_longer_verifies_is_dropped_and_restores_nothing() -> None:
    store = InMemoryStore(PRODUCT)
    store.write_cache(CacheRecord(pinRevocations={KID: "not.a.jws"}))
    c = make_client(routes(), store=store, trust=PINS)
    assert c._trust.revoked_pins == [] and c._trust.pin_revocations == {}
    assert c._trust.effective[KID] == PUBKEY_RAW
    c.close()


def test_deactivation_keeps_the_pin_evidence() -> None:
    store = InMemoryStore(PRODUCT)
    c = _synced(store, _alt_manifest())
    c.deactivate()
    rec = store.read_cache()
    assert rec is not None and set(rec.pinRevocations) == {KID}
    assert rec.docs == {} and rec.trustJws is None
    c.close()


def test_device_rebinding_drops_the_grants_but_keeps_the_evidence(tmp_path) -> None:
    store = FileStore(PRODUCT, str(tmp_path))
    store.set_device_id("COPIEDFROMANOTHERMACHINE00000000")
    store.set_token(TOKEN)
    store.write_cache(
        CacheRecord(
            docs={"license": "x.y.z"},
            trustJws="t.r.u",
            bundle="b.u.n",
            etags={"license": "e"},
            pinRevocations={KID: "r.e.v"},
        )
    )
    got = bind_device_id(PRODUCT, store, read_anchor=lambda: "ANCHOR-1")
    assert got == device_id_from_raw(PRODUCT, "ANCHOR-1")
    rec = store.read_cache()
    assert rec is not None
    assert rec.pinRevocations == {KID: "r.e.v"}
    assert rec.docs == {} and rec.trustJws is None and rec.bundle is None and rec.etags == {}


# ── the signer retry (§2.3) ─────────────────────────────────────────────────────────
def _retry_handler(seen: List[str], by_signer: Dict[str, str], default: str):
    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path == f"/{PRODUCT}/.well-known/polaris-trust.jws":
            seen.append(r.url.query.decode())
            signer = r.url.params.get("signer")
            body = default if signer is None else by_signer.get(signer)
            return httpx.Response(200, text=body) if body else httpx.Response(404)
        return httpx.Response(404)

    return handler


def test_a_refused_manifest_signed_by_a_foreign_key_is_retried_per_pin() -> None:
    # The client pins only ALT; the active key (KID) signs the default manifest.
    default = sign_manifest([key_entry(KID, PUBKEY_RAW), key_entry(ALT, ROTATED_PUB)])
    by_alt = sign_manifest(
        [key_entry(KID, PUBKEY_RAW, "retired"), key_entry(ALT, ROTATED_PUB)],
        pem=ROTATED_PEM,
        kid=ALT,
    )
    seen: List[str] = []
    c = make_client(
        _retry_handler(seen, {ALT: by_alt}, default), trust={ALT: ROTATED_PUB}
    )
    assert c._trust.refresh() == by_alt
    assert seen == ["", f"signer={ALT}"]
    c.close()


def test_a_refused_manifest_signed_by_a_usable_pin_is_never_retried() -> None:
    bad = sign_manifest([key_entry(KID, PUBKEY_RAW)], schemaVersion=2)
    seen: List[str] = []
    c = make_client(_retry_handler(seen, {}, bad), trust=PINS)
    assert c._trust.refresh() is None
    assert seen == [""]
    c.close()


def test_the_signer_retry_is_bounded_and_in_ascending_byte_order() -> None:
    pins = {f"k{n}": PUBKEY_RAW for n in range(9, 0, -1)}
    foreign = sign_manifest([key_entry(KID, PUBKEY_RAW)], kid=KID)
    seen: List[str] = []
    c = make_client(_retry_handler(seen, {}, foreign), trust=pins)
    assert c._trust.refresh() is None
    assert seen == [""] + [f"signer=k{n}" for n in range(1, MAX_TRUST_SIGNER_ATTEMPTS + 1)]
    c.close()


# ── the signed bundle slice, floors and the reload profile (§7) ─────────────────────
def _local(store: Any):
    return create_local_client(
        product_slug=PRODUCT,
        version="1.0.0",
        trust={KID: PUBKEY_RAW, ALT: ROTATED_PUB},
        base_url=BASE_URL,
        store=store,
    )


def test_a_bundle_not_newer_than_the_cached_licence_is_refused_and_a_newer_one_replaces() -> None:
    store = InMemoryStore(PRODUCT)
    c = _local(store)
    dev = c.core.device_id
    first = sign_bundle(dev, docs={"license": sign_license(dev, issued=NOW)}, bundle_id="B1")
    c.import_bundle(first, NOW)
    same_age = sign_bundle(dev, docs={"license": sign_license(dev, issued=NOW)}, bundle_id="B2")
    with pytest.raises(PolarisError) as exc:
        c.import_bundle(same_age, NOW)
    assert exc.value.code == INNER_DOC_REJECTED
    newer = sign_bundle(
        dev, docs={"license": sign_license(dev, issued=NOW + 60)}, bundle_id="B3", issued=NOW + 60
    )
    assert c.import_bundle(newer, NOW + 60).imported == ["license"]
    assert store.read_cache().bundle == newer
    c.close()


def test_a_byte_identical_reimport_writes_nothing() -> None:
    store = InMemoryStore(PRODUCT)
    c = _local(store)
    dev = c.core.device_id
    bundle = sign_bundle(dev, docs={"config": sign_config(dev)})
    c.import_bundle(bundle, NOW)
    writes: List[Any] = []
    orig = store.write_cache
    store.write_cache = lambda rec: (writes.append(rec), orig(rec))[1]  # type: ignore[method-assign]
    again = c.import_bundle(bundle, NOW + 5)
    assert again.imported == ["config"] and writes == []
    c.close()


def test_bundle_activation_is_re_derived_on_the_reload_profile_past_the_import_window() -> None:
    store = InMemoryStore(PRODUCT)
    c = _local(store)
    dev = c.core.device_id
    issued = NOW - 100 * DAY
    c.import_bundle(
        sign_bundle(dev, issued=issued, docs={"license": sign_license(dev, issued=issued)}),
        issued + DAY,
    )
    c.close()
    # The cached bundle re-verifies at every start without the 30-day import window: it
    # expired 70 days ago and still activates.
    later = _local(store)
    assert later.get_sync_state().activation == "bundle"
    later.close()


def test_the_old_import_marker_is_never_read() -> None:
    store = InMemoryStore(PRODUCT)
    c = _local(store)
    dev = c.core.device_id
    store.write_cache(CacheRecord(docs={"license": sign_license(dev)}))
    legacy = store.read_cache()
    assert legacy is not None
    c.close()
    raw = legacy.to_dict()
    raw["importedBundle"] = {"bundleId": "B", "importedAt": NOW}
    restored = CacheRecord.from_dict(raw)
    assert restored.bundle is None and "importedBundle" not in restored.to_dict()
    store.write_cache(restored)
    again = _local(store)
    assert again.get_sync_state().activation is None
    again.close()


def test_a_bundle_signed_by_a_tombstoned_pin_does_not_activate() -> None:
    store = InMemoryStore(PRODUCT)
    c = _local(store)
    dev = c.core.device_id
    c.import_bundle(sign_bundle(dev), NOW)
    rec = store.read_cache()
    assert rec is not None
    rec.pinRevocations = {KID: _alt_manifest()}
    store.write_cache(rec)
    c.close()
    again = _local(store)
    assert again._trust.revoked_pins == [KID]
    assert again.get_sync_state().activation is None
    again.close()


def test_the_held_newer_manifest_is_kept_over_the_bundles() -> None:
    store = InMemoryStore(PRODUCT)
    c = _local(store)
    dev = c.core.device_id
    held = sign_manifest([key_entry(KID, PUBKEY_RAW)], issued=NOW + 500)
    store.write_cache(CacheRecord(trustJws=held))
    c.close()
    c = _local(store)
    c.import_bundle(sign_bundle(dev), NOW)
    assert store.read_cache().trustJws == held
    c.close()
