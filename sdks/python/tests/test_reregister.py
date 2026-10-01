"""Re-register on 401 for licence-less devices (wire contract v3 §5, P1b-06).

§5: "exactly one POST /<p>/license/token re-acquire attempt, then one retry of the failed
fetch. (Registered-without-license devices re-register instead; same single-attempt
rule.)" These pins cover the route CHOICE (``choose_reacquire_route``) and the client
behaviour around it, mirroring ``packages/sdk-node/test/reregister.test.ts``.
"""

# @pkey-feature license.reregister

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx
import pytest

from polaris_key.core.token import choose_reacquire_route
from polaris_key.devices.store import InMemoryStore

from helpers import NOW, PRODUCT, make_client, sign_config, sign_license


class Plane:
    """A mock Worker whose documents 401 until a mint route answers 200."""

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.revoked = False
        self.always_unauthorized = False
        self.register_status = 200
        self._bump = 0

    def count(self, suffix: str) -> int:
        return sum(1 for c in self.calls if c["path"].endswith(suffix))

    def first(self, suffix: str) -> Dict[str, Any]:
        return next(c for c in self.calls if c["path"].endswith(suffix))

    def __call__(self, r: httpx.Request) -> httpx.Response:
        path = r.url.path
        self.calls.append(
            {
                "method": r.method,
                "path": path,
                "bearer": r.headers.get("authorization"),
            }
        )
        device = r.headers.get("X-PKey-Device", "d")
        p = f"/{PRODUCT}"
        if path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": "pkeyt_activated", "schemaVersion": 1})
        if path == f"{p}/license/token":
            self.revoked = False
            return httpx.Response(200, json={"token": "pkeyt_rotated", "schemaVersion": 1})
        if path == f"{p}/devices/register":
            if self.register_status != 200:
                return httpx.Response(
                    self.register_status, json={"error": {"code": "registration_closed"}}
                )
            self.revoked = False
            return httpx.Response(200, json={"token": "pkeyt_registered", "deviceId": device})
        if path == f"{p}/devices/report":
            return httpx.Response(200, json={"ok": True})
        if path in (f"{p}/license/document", f"{p}/config/document"):
            if self.always_unauthorized or self.revoked:
                return httpx.Response(401, json={"error": {"code": "unauthorized"}})
            self._bump += 1
            if path.endswith("/license/document"):
                return httpx.Response(
                    200, text=sign_license(device, issued=NOW + self._bump), headers={"etag": "l"}
                )
            return httpx.Response(
                200, text=sign_config(device, issued=NOW + self._bump), headers={"etag": "c"}
            )
        return httpx.Response(404)


def _client(plane: Plane, *, store: Optional[InMemoryStore] = None, **kw: Any):
    return make_client(
        plane,
        store=store if store is not None else InMemoryStore(PRODUCT),
        trust_refresh=False,
        fingerprint=False,
        env={},
        **kw,
    )


# ── The path-selection rule ─────────────────────────────────────────────────────────
@pytest.mark.parametrize("source", ["activate", "enroll", "reacquire", None])
def test_a_licensed_device_uses_license_token(source: Any) -> None:
    assert choose_reacquire_route(license_enabled=True, source=source) == "license-token"


@pytest.mark.parametrize("source", ["activate", "register", None])
def test_license_disabled_always_re_registers(source: Any) -> None:
    assert choose_reacquire_route(license_enabled=False, source=source) == "devices-register"


def test_a_token_minted_by_register_re_registers() -> None:
    assert (
        choose_reacquire_route(license_enabled=True, source="register") == "devices-register"
    )


# ── The client ──────────────────────────────────────────────────────────────────────
def test_licensed_device_still_uses_license_token() -> None:
    plane = Plane()
    c = _client(plane)
    assert c.license.activate_with_key("pkey_k").kind == "ok"
    plane.revoked = True
    r = c.sync()
    assert r.unauthorized is False
    assert plane.count("/license/token") == 1
    assert plane.count("/devices/register") == 0
    assert c.get_sync_state().lastSyncUnauthorized is False
    c.close()


def test_licence_less_device_re_registers_without_authorization() -> None:
    plane = Plane()
    store = InMemoryStore(PRODUCT)
    c = _client(plane, store=store)
    assert c.devices.register().kind == "ok"
    plane.calls.clear()
    plane.revoked = True
    r = c.sync()
    assert plane.count("/license/token") == 0
    assert plane.count("/devices/register") == 1
    reg = plane.first("/devices/register")
    assert reg["method"] == "POST"
    assert reg["bearer"] is None
    assert store.get_token() == "pkeyt_registered"
    assert r.unauthorized is False
    assert r.documents["config"].kind == "applied"
    c.close()


def test_after_a_restart_with_license_enabled_an_unknown_source_keeps_license_token() -> None:
    """A licensed device with an empty cache and a licence-less one look the same after a
    restart; the recorded ``sync-errors`` transcript pins this state to /license/token."""
    plane = Plane()
    store = InMemoryStore(PRODUCT)
    store.set_token("pkeyt_from_a_previous_run")
    c = _client(plane, store=store)
    plane.revoked = True
    c.sync()
    assert plane.count("/license/token") == 1
    assert plane.count("/devices/register") == 0
    c.close()


def test_license_disabled_re_registers_without_authorization() -> None:
    plane = Plane()
    store = InMemoryStore(PRODUCT)
    store.set_token("pkeyt_old")
    c = _client(plane, store=store, expected_services=["config"])
    plane.revoked = True
    r = c.sync()
    assert plane.count("/license/document") == 0
    assert plane.count("/license/token") == 0
    assert plane.count("/devices/register") == 1
    assert plane.first("/devices/register")["bearer"] is None
    assert r.documents["config"].kind == "applied"
    c.close()


def test_two_401s_in_one_pass_cause_exactly_one_register_call() -> None:
    plane = Plane()
    c = _client(plane)
    assert c.devices.register().kind == "ok"
    plane.calls.clear()
    # Both documents 401 for the whole pass: the first spends the one attempt, the second
    # is told no.
    plane.always_unauthorized = True
    r = c.sync()
    assert plane.count("/devices/register") == 1
    assert plane.count("/license/token") == 0
    assert r.unauthorized is True
    c.close()


def test_two_401s_recover_on_one_register_call() -> None:
    plane = Plane()
    c = _client(plane)
    assert c.devices.register().kind == "ok"
    plane.calls.clear()
    plane.revoked = True
    r = c.sync()
    assert plane.count("/devices/register") == 1
    assert r.documents["license"].kind == "applied"
    assert r.documents["config"].kind == "applied"
    c.close()


def test_registration_closed_records_the_hard_401_without_a_second_attempt() -> None:
    plane = Plane()
    store = InMemoryStore(PRODUCT)
    c = _client(plane, store=store)
    assert c.devices.register().kind == "ok"
    plane.calls.clear()
    plane.revoked = True
    plane.register_status = 403
    r = c.sync()
    assert plane.count("/devices/register") == 1
    assert plane.count("/license/token") == 0
    # One fetch per document: no retry after a failed attempt.
    assert plane.count("/license/document") == 1
    assert plane.count("/config/document") == 1
    assert r.unauthorized is True
    assert c.get_sync_state().lastSyncUnauthorized is True
    assert store.get_token() == "pkeyt_registered"
    c.close()


def test_the_next_pass_re_arms_the_attempt() -> None:
    plane = Plane()
    store = InMemoryStore(PRODUCT)
    store.set_token("pkeyt_old")
    c = _client(plane, store=store, expected_services=["config"])
    plane.always_unauthorized = True
    assert c.sync().unauthorized is True
    assert plane.count("/devices/register") == 1
    assert plane.count("/config/document") == 2
    c.sync()
    assert plane.count("/devices/register") == 2
    c.close()
