"""PolarisKeyClient against a mock httpx transport that signs a REAL JWS with the test PEM.

The handler activates (key -> token), serves a signed config doc scoped to the product +
the client's derived device id, and exercises the 403 version-too-old block path. No
network is touched — everything routes through ``httpx.MockTransport``.
"""

from __future__ import annotations

import json
from typing import Any, Dict

import httpx
import pytest

from polaris_key.client import DeviceManagementUnsupportedError, PolarisKeyClient
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
            "activatedAt": 1690000000,
        },
        "payload": {
            "config": {
                "run.concurrency": {
                    "state": "enforced",
                    "value": 4,
                    "updatedAt": 1699990000,
                },
                "ui.theme": {
                    "state": "default",
                    "value": "light",
                    "updatedAt": 1699990000,
                },
            },
            "secrets": {
                "proxy.subscriptionUrl": {
                    "state": "hidden",
                    "value": "https://vpn.example.com/sub/abc",
                    "updatedAt": 1699990000,
                }
            },
            "entitlements": {
                "polarisVpn": {
                    "state": "enforced",
                    "value": True,
                    "updatedAt": 1699990000,
                }
            },
        },
    }


def _client(handler, **kw) -> PolarisKeyClient:
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
        **kw,
    )
    c.init()
    return c


def _ok_handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == f"/{PRODUCT}/activate":
        return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 1})
    if path == f"/{PRODUCT}/config":
        device_id = request.headers["X-PKey-Device"]
        jws = sign_jws(_make_doc(device_id), PRIVATE_PEM, KID)
        return httpx.Response(200, text=jws, headers={"etag": "v1"})
    if path == f"/{PRODUCT}/config/report":
        return httpx.Response(200, json={"ok": True})
    return httpx.Response(404)


def test_enforced_remote_value_wins_over_local_and_env() -> None:
    c = _client(
        _ok_handler,
        local_overrides={"run.concurrency": 99},
        env={"PKEY_CONFIG_run__concurrency": "42"},
    )
    c.activate_with_key("my-license-key")
    # enforced -> remote wins regardless of override/env.
    assert c.get_config("run.concurrency") == 4
    assert c.get_config_source("run.concurrency") == "enforced"
    c.close()


def test_default_state_local_override_then_env_then_remote() -> None:
    # local override wins over env + remote-default.
    c = _client(_ok_handler, local_overrides={"ui.theme": "solarized"})
    c.activate_with_key("my-license-key")
    assert c.get_config("ui.theme") == "solarized"
    assert c.get_config_source("ui.theme") == "local"
    c.close()

    # env wins over remote-default; JSON-parsed when it parses.
    c = _client(_ok_handler, env={"PKEY_CONFIG_ui__theme": '"dark"'})
    c.activate_with_key("my-license-key")
    assert c.get_config("ui.theme") == "dark"
    assert c.get_config_source("ui.theme") == "env"
    c.close()

    # no override/env -> remote default value.
    c = _client(_ok_handler, env={})
    c.activate_with_key("my-license-key")
    assert c.get_config("ui.theme") == "light"
    assert c.get_config_source("ui.theme") == "remote-default"
    c.close()


def test_env_raw_string_when_not_json_and_fallback_source() -> None:
    c = _client(_ok_handler, env={"PKEY_CONFIG_ui__theme": "not json {"})
    c.activate_with_key("my-license-key")
    assert c.get_config("ui.theme") == "not json {"
    assert c.get_config_source("ui.theme") == "env"
    # An unknown key falls back.
    assert c.get_config("missing.key", "fb") == "fb"
    assert c.get_config_source("missing.key") == "fallback"
    c.close()


def test_list_user_config_excludes_hidden_and_marks_enforced() -> None:
    c = _client(_ok_handler, local_overrides={"ui.theme": "solarized"})
    c.activate_with_key("my-license-key")
    items = {i["key"]: i for i in c.list_user_config()}
    # No hidden config keys exist here, but enforced + default both appear.
    assert items["run.concurrency"] == {
        "key": "run.concurrency",
        "value": 4,
        "enforced": True,
    }
    assert items["ui.theme"] == {
        "key": "ui.theme",
        "value": "solarized",
        "enforced": False,
    }
    c.close()


def test_activation_then_reads_config_secret_entitlement() -> None:
    state = {"reports": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == f"/{PRODUCT}/activate":
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
        if path == f"/{PRODUCT}/activate":
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
    assert r.kind == "ok"  # activate succeeded; the BLOCK is on /config
    st = c.status(now=1700000100)
    assert st.status == "version-too-old"
    assert st.allowedRange is not None and st.allowedRange.min == "2.0.0"
    assert c.is_licensed(now=1700000100) is False
    c.close()


def test_blocked_with_no_prior_doc_does_not_raise() -> None:
    """D5 regression: a 403/blocked refresh with no prior cached doc patches the cache
    via ``dataclasses.replace`` and must NOT raise (no FrozenInstanceError)."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == f"/{PRODUCT}/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 1})
        if path == f"/{PRODUCT}/config":
            return httpx.Response(
                403, json={"reason": "version-too-old", "allowedRange": {"min": "2.0.0"}}
            )
        if path == f"/{PRODUCT}/config/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = _client(handler)
    # First activate -> 403 creates a doc-less blocked cache.
    r = c.activate_with_key("my-license-key")
    assert r.kind == "ok"
    assert c.status(now=1700000100).status == "version-too-old"
    # A SECOND refresh patches the existing doc-less cache (the previously-crashing path).
    res = c.refresh(force=True)
    assert res.blocked is True
    assert c.status(now=1700000100).status == "version-too-old"
    c.close()


def test_activation_unauthorized() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f"/{PRODUCT}/activate":
            return httpx.Response(401, text="bad key")
        return httpx.Response(404)

    c = _client(handler)
    r = c.activate_with_key("nope")
    assert r.kind == "unauthorized"
    assert c.status(now=1700000100).status == "needs-activation"
    c.close()


def test_activation_device_limit() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f"/{PRODUCT}/activate":
            return httpx.Response(403, json={"limit": 3, "deviceCount": 3})
        return httpx.Response(404)

    c = _client(handler)
    r = c.activate_with_key("k")
    assert r.kind == "device-limit"
    assert getattr(r, "limit", None) == 3
    assert getattr(r, "deviceCount", None) == 3
    c.close()


def test_device_management_surface_current_only() -> None:
    c = _client(_ok_handler)
    current = c.current_device()
    assert current.id
    assert current.current is True
    assert current.status == "needs-activation"
    with pytest.raises(DeviceManagementUnsupportedError):
        c.list_devices()
    with pytest.raises(DeviceManagementUnsupportedError):
        c.deauthorize_device("other-device")
    c.deauthorize_device(current.id)
    c.close()


def test_config_401_reacquires_token_then_succeeds() -> None:
    """A 401 on /config triggers a single /token re-acquire, then re-fetch succeeds."""
    state = {"config_calls": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == f"/{PRODUCT}/activate":
            return httpx.Response(200, json={"token": "stale", "schemaVersion": 1})
        if path == f"/{PRODUCT}/token":
            assert request.headers["X-PKey-Device"]
            assert request.headers["authorization"] == "Bearer stale"
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
        if path == f"/{PRODUCT}/activate":
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
    assert c.status(now=1700000100).status == "needs-activation"
    assert c.get_config("run.concurrency", 0) == 0
    c.close()


def test_wrong_device_doc_rejected() -> None:
    """A doc bound to a different device must NOT be applied (anti-splice)."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == f"/{PRODUCT}/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 1})
        if path == f"/{PRODUCT}/config":
            jws = sign_jws(_make_doc("some-other-device"), PRIVATE_PEM, KID)
            return httpx.Response(200, text=jws)
        if path == f"/{PRODUCT}/config/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = _client(handler)
    c.activate_with_key("k")
    # Doc was rejected -> no doc cached -> needs-activation.
    assert c.status(now=1700000100).status == "needs-activation"
    c.close()
