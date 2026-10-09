# @pkey-feature core.sync
# @pkey-feature core.cache
# @pkey-feature license.gate
# @pkey-feature core.verify
"""The local-trust set: a hard refusal deletes the document it answered for, the licence gate
input, the effective clock, device binding, the required floor and ``typ``, canonical base64url.

Each test fails on the parent commit's source."""

from __future__ import annotations

import json
import os

import httpx
import pytest

from helpers import (
    DAY,
    NOW,
    PRODUCT,
    TRUST,
    TOKEN,
    discovery_doc,
    make_client,
    routes,
    sign_config,
    sign_license,
)
from polaris_key.core.b64url import B64URL_RE, b64url_decode
from polaris_key.core.jws import verify_jws
from polaris_key.core.store import CacheRecord
from polaris_key.core.verify import verify_license_doc
from polaris_key.devices.deviceid import device_id_from_raw
from polaris_key.devices.store import FileStore


def _gate_client(tmp_path, handler, **kw):
    return make_client(handler, store=FileStore(PRODUCT, str(tmp_path)), **kw)


def _lic(r: httpx.Request) -> str:
    return sign_license(r.headers["X-PKey-Device"])


def _cfg(r: httpx.Request) -> str:
    return sign_config(r.headers["X-PKey-Device"])


# ── a hard refusal deletes the document ─────────────────────────────────────────────
def test_hard_401_deletes_the_document_it_answered_for(tmp_path) -> None:
    state = {"revoked": False}
    base = routes(license_jws=_lic, config_jws=_cfg)

    def handler(r: httpx.Request) -> httpx.Response:
        if state["revoked"] and r.url.path.endswith(("/license/document", "/license/token")):
            return httpx.Response(401, json={"error": {"code": "unauthorized"}})
        return base(r)

    c = _gate_client(tmp_path, handler)
    c.license.activate_with_key("k")
    assert c.license.is_licensed()
    state["revoked"] = True
    c.sync(force=True)
    assert c.status().status == "revoked"
    path = tmp_path / PRODUCT / "managed.json"
    rec = json.loads(path.read_text())
    assert "license" not in rec["docs"] and "license" not in rec.get("etags", {})
    assert "config" in rec["docs"]  # only the slice that was answered for
    # Clearing the display hint offline must NOT bring the licence back.
    rec["lastSyncUnauthorized"] = False
    path.write_text(json.dumps(rec))
    c.close()
    c2 = _gate_client(tmp_path, handler)
    assert c2.status().status == "needs-activation"
    assert not c2.license.is_licensed()
    c2.close()


def test_403_build_block_deletes_the_licence_document(tmp_path) -> None:
    state = {"blocked": False}
    base = routes(license_jws=_lic, config_jws=_cfg)

    def handler(r: httpx.Request) -> httpx.Response:
        if state["blocked"] and r.url.path.endswith("/license/document"):
            return httpx.Response(
                403,
                json={"error": {"code": "version_blocked", "reason": "version-too-old"}},
            )
        return base(r)

    c = _gate_client(tmp_path, handler)
    c.license.activate_with_key("k")
    state["blocked"] = True
    c.sync(force=True)
    assert c.status().status == "version-too-old"
    path = tmp_path / PRODUCT / "managed.json"
    rec = json.loads(path.read_text())
    assert "license" not in rec["docs"]
    rec.pop("blocked", None)
    path.write_text(json.dumps(rec))
    c.close()
    c2 = _gate_client(tmp_path, handler)
    assert not c2.license.is_licensed()
    c2.close()


# ── the licence gate input ──────────────────────────────────────────────────────────
def test_unsigned_discovery_cannot_switch_the_licence_gate_off() -> None:
    c = make_client(routes())
    c.core.set_services({"license": {"enabled": False}, "config": {"enabled": True}})
    assert c.status().status == "needs-activation"
    assert not c.license.is_licensed()
    c.close()


def test_discovery_can_switch_the_gate_on_for_a_config_only_build() -> None:
    c = make_client(routes(), expected_services=["config"])
    assert c.status().status == "not-applicable"
    c.core.set_services({"license": {"enabled": True}, "config": {"enabled": True}})
    assert c.status().status == "needs-activation"
    c.close()


def test_a_config_only_build_declares_it_with_expected_services() -> None:
    c = make_client(routes(), expected_services=["config"])
    assert c.license.is_licensed()
    c.close()


# ── the effective clock ─────────────────────────────────────────────────────────────
def test_network_path_verification_runs_on_the_effective_clock() -> None:
    # A document issued 10 days "ahead" of the wall clock is far-future on the raw wall, but the
    # signed floor (here raised by a verified artifact) says real time is at least that late.
    ahead = NOW + 10 * DAY
    c = make_client(routes(license_jws=lambda r: sign_license(r.headers["X-PKey-Device"], issued=ahead)))
    c.core.raise_floor(ahead + 60)
    c.license.activate_with_key("k")
    assert c.license.doc is not None


# ── device binding ──────────────────────────────────────────────────────────────────
def test_stored_device_id_that_disagrees_with_the_anchor_is_discarded(tmp_path) -> None:
    from polaris_key.core.device_binding import bind_device_id

    store = FileStore(PRODUCT, str(tmp_path))
    store.set_device_id("COPIEDFROMANOTHERMACHINE00000000")
    store.set_token(TOKEN)
    store.write_cache(CacheRecord(docs={"license": "x.y.z"}, feeds={"stable": "f.f.f"}))
    got = bind_device_id(PRODUCT, store, read_anchor=lambda: "ANCHOR-1")
    assert got == device_id_from_raw(PRODUCT, "ANCHOR-1")
    assert store.get_device_id() == got
    assert store.get_token() is None
    rec = store.read_cache()
    assert rec is not None and rec.docs == {} and rec.feeds == {"stable": "f.f.f"}


def test_matching_or_anchorless_stores_are_left_alone(tmp_path) -> None:
    from polaris_key.core.device_binding import bind_device_id

    store = FileStore(PRODUCT, str(tmp_path))
    store.set_token(TOKEN)
    store.set_device_id(device_id_from_raw(PRODUCT, "A"))
    assert bind_device_id(PRODUCT, store, read_anchor=lambda: "A") == store.get_device_id()
    assert store.get_token() == TOKEN
    store.set_device_id("STORED-ONLY")
    assert bind_device_id(PRODUCT, store, read_anchor=lambda: None) == "STORED-ONLY"
    assert store.get_token() == TOKEN


def test_core_init_binds_the_device_id(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "polaris_key.core.device_binding.raw_os_device_id", lambda *a, **k: "ANCHOR-2"
    )
    store = FileStore(PRODUCT, str(tmp_path))
    store.set_device_id("COPIED")
    store.set_token(TOKEN)
    c = make_client(routes(), store=store)
    assert c.core.device_id == device_id_from_raw(PRODUCT, "ANCHOR-2")
    assert c.license.activation() is None
    c.close()


# ── required floor, required typ, canonical base64url ───────────────────────────────
def test_the_anti_replay_floor_is_a_required_argument() -> None:
    with pytest.raises(TypeError):
        verify_license_doc("a.b.c", TRUST, expected_aud=PRODUCT, device_id="d")  # type: ignore[call-arg]


def test_typ_is_a_required_argument_of_verify_jws() -> None:
    with pytest.raises(TypeError):
        verify_jws("a.b.c", TRUST)  # type: ignore[call-arg]


def test_b64url_refuses_a_trailing_newline() -> None:
    with pytest.raises(ValueError):
        b64url_decode("YWJj\n")
    assert B64URL_RE.match("YWJj\n") is None
