"""PolarisKeyClient against a mock httpx transport that signs a REAL JWS with the test PEM.

The handler enrolls (key -> token), serves a signed config doc scoped to the product +
the client's derived device id, and exercises the 403 version-too-old block path. No
network is touched — everything routes through ``httpx.MockTransport``.
"""

from __future__ import annotations

import json
from typing import Any, Dict

import httpx
import pytest

from polaris_key.client import PolarisKeyClient
from polaris_key.store import InMemoryStore
from polaris_key.verify import sign_jws

PRODUCT = "djdl"
KID = "pkey-test-prod-2026"
PUBKEY_RAW = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"
PRIVATE_PEM = (
    "-----BEGIN PRIVATE KEY-----\n"
    "MC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n"
    "-----END PRIVATE KEY-----"
)
TRUST = {KID: PUBKEY_RAW}
TOKEN = "tok_test_123"


def _make_doc(device_id: str, *, issued: int = 1700000000) -> Dict[str, Any]:
    return {
        "schemaVersion": 1,
        "aud": PRODUCT,
        "iss": "key.plrs.im",
        "licenseId": "lic_3f8a9b",
        "deviceId": device_id,
        "issuedAt": issued,
        "expiresAt": issued + 3600,
        "graceUntil": issued + 2_592_000,
        "profile": {
            "name": "Grace Hopper",
            "firstName": "Grace",
            "email": "grace@example.com",
            "enrolledAt": 1690000000,
        },
        "payload": {
            "config": {"run.concurrency": {"state": "managed", "value": 4}},
            "secrets": {
                "proxy.subscriptionUrl": {
                    "state": "hidden",
                    "value": "https://vpn.example.com/sub/abc",
                }
            },
            "entitlements": {"polarisVpn": {"state": "managed", "value": True}},
        },
    }


def _client(handler) -> PolarisKeyClient:
    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport, base_url="")
    store = InMemoryStore(PRODUCT)
    c = PolarisKeyClient(
        product_slug=PRODUCT,
        version="1.0.0",
        trust=TRUST,
        base_url="https://key.example",
        store=store,
        client=http,
    )
    c.init()
    return c


def test_enroll_then_reads_config_secret_entitlement() -> None:
    state = {"reports": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == f"/{PRODUCT}/enroll":
            assert request.headers["authorization"] == "Bearer my-license-key"
            assert request.headers["X-PKey-Device"]  # device header present
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 1})
        if path == f"/{PRODUCT}/config":
            assert request.headers["authorization"] == f"Bearer {TOKEN}"
            assert request.headers["X-PKey-Version"] == "1.0.0"
            assert request.headers["X-PKey-Channel"] == "stable"
            device_id = request.headers["X-PKey-Device"]
            jws = sign_jws(_make_doc(device_id), PRIVATE_PEM, KID)
            return httpx.Response(200, text=jws, headers={"etag": "v1"})
        if path == f"/{PRODUCT}/config/report":
            body = json.loads(request.content)
            assert body["config"]["run.concurrency"] == 4
            assert body["entitlements"]["polarisVpn"] is True
            # Secrets are NOT included in the report snapshot.
            assert "secrets" not in body
            state["reports"] += 1
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = _client(handler)
    r = c.activate_with_key("my-license-key")
    assert r.kind == "ok"

    assert c.is_licensed(now=1700000100) is True
    assert c.status(now=1700000100).status == "ok"
    assert c.get_config("run.concurrency", 1) == 4
    assert c.get_config("missing", "fallback") == "fallback"
    assert c.get_secret("proxy.subscriptionUrl") == "https://vpn.example.com/sub/abc"
    assert c.get_secret("missing") is None
    assert c.is_entitled("polarisVpn") is True
    assert c.is_entitled("nope") is False
    assert c.get_entitlements() == {"polarisVpn": True}
    profile = c.get_profile()
    assert profile is not None and profile.firstName == "Grace"
    assert state["reports"] >= 1
    c.close()


def test_config_403_version_too_old_blocks() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == f"/{PRODUCT}/enroll":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 1})
        if path == f"/{PRODUCT}/config":
            return httpx.Response(
                403,
                json={
                    "reason": "version-too-old",
                    "allowedRange": {"min": "2.0.0"},
                },
            )
        if path == f"/{PRODUCT}/config/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = _client(handler)
    r = c.activate_with_key("my-license-key")
    assert r.kind == "ok"  # enroll succeeded; the BLOCK is on /config
    st = c.status(now=1700000100)
    assert st.status == "version-too-old"
    assert st.allowedRange is not None and st.allowedRange.min == "2.0.0"
    assert c.is_licensed(now=1700000100) is False
    c.close()


def test_enroll_unauthorized() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f"/{PRODUCT}/enroll":
            return httpx.Response(401, text="bad key")
        return httpx.Response(404)

    c = _client(handler)
    r = c.activate_with_key("nope")
    assert r.kind == "unauthorized"
    assert c.status(now=1700000100).status == "needs-enroll"
    c.close()


def test_enroll_device_limit() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f"/{PRODUCT}/enroll":
            return httpx.Response(403, json={"limit": 3, "machineCount": 3})
        return httpx.Response(404)

    c = _client(handler)
    r = c.activate_with_key("k")
    assert r.kind == "machine-limit"
    assert getattr(r, "limit", None) == 3
    c.close()


def test_config_401_reacquires_token_then_succeeds() -> None:
    """A 401 on /config triggers a single /token re-acquire, then re-fetch succeeds."""
    state = {"config_calls": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == f"/{PRODUCT}/enroll":
            return httpx.Response(200, json={"token": "stale", "schemaVersion": 1})
        if path == f"/{PRODUCT}/token":
            assert request.headers["X-PKey-Device"]
            return httpx.Response(200, json={"token": "fresh", "schemaVersion": 1})
        if path == f"/{PRODUCT}/config":
            state["config_calls"] += 1
            if request.headers["authorization"] == "Bearer stale":
                return httpx.Response(401)
            device_id = request.headers["X-PKey-Device"]
            jws = sign_jws(_make_doc(device_id), PRIVATE_PEM, KID)
            return httpx.Response(200, text=jws, headers={"etag": "v1"})
        if path == f"/{PRODUCT}/config/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = _client(handler)
    r = c.activate_with_key("k")
    assert r.kind == "ok"
    assert state["config_calls"] == 2  # stale -> 401, fresh -> 200
    assert c.status(now=1700000100).status == "ok"
    c.close()


def test_deactivate_wipes_local_state() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == f"/{PRODUCT}/enroll":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 1})
        if path == f"/{PRODUCT}/config":
            device_id = request.headers["X-PKey-Device"]
            jws = sign_jws(_make_doc(device_id), PRIVATE_PEM, KID)
            return httpx.Response(200, text=jws)
        if path in (f"/{PRODUCT}/config/report", f"/{PRODUCT}/deauthorize"):
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = _client(handler)
    c.activate_with_key("k")
    assert c.is_licensed(now=1700000100) is True
    c.deactivate()
    assert c.status(now=1700000100).status == "needs-enroll"
    assert c.get_config("run.concurrency", 0) == 0
    c.close()


def test_wrong_device_doc_rejected() -> None:
    """A doc bound to a different device must NOT be applied (anti-splice)."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == f"/{PRODUCT}/enroll":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 1})
        if path == f"/{PRODUCT}/config":
            jws = sign_jws(_make_doc("some-other-device"), PRIVATE_PEM, KID)
            return httpx.Response(200, text=jws)
        if path == f"/{PRODUCT}/config/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = _client(handler)
    c.activate_with_key("k")
    # Doc was rejected -> no doc cached -> needs-enroll.
    assert c.status(now=1700000100).status == "needs-enroll"
    c.close()
