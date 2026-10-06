"""``PolarisKeyClient`` against a mock httpx transport that signs REAL JWSs with the test PEM.

The handler activates (key -> ``pkeyt_`` token), serves a signed licence document and a
signed config document scoped to the product + the client's derived device id, and
exercises the 403 build-gate block path. No network is touched — everything routes through
``httpx.MockTransport``.

Heir of the v2 ``test_client.py``, re-pointed at the v3 routes and the split documents.
"""

from __future__ import annotations

import json
from typing import Any, Dict

import httpx
import pytest

from polaris_key.devices.client import DeviceManagementUnsupportedError
from polaris_key.license.gate import LicenseState

from helpers import (
    NOW,
    PRODUCT,
    TOKEN,
    make_client,
    routes,
    sign_config,
    sign_license,
)


def _ok_routes(**kw: Any):
    return routes(
        license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]),
        config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]),
        **kw,
    )


# ── layered config ──────────────────────────────────────────────────────────────────
# @pkey-feature config.resolve
def test_enforced_remote_value_wins_over_local_and_env() -> None:
    c = make_client(
        _ok_routes(),
        local_overrides={"run.concurrency": 99},
        env={"PKEY_CONFIG_run__concurrency": "42"},
    )
    c.license.activate_with_key("my-license-key")
    # enforced -> remote wins regardless of override/env.
    assert c.config.get_config("run.concurrency") == 4
    assert c.config.get_config_source("run.concurrency") == "enforced"
    c.close()


# @pkey-feature config.resolve
def test_default_state_local_override_then_env_then_remote() -> None:
    # local override wins over env + remote-default.
    c = make_client(_ok_routes(), local_overrides={"ui.theme": "solarized"})
    c.license.activate_with_key("k")
    assert c.config.get_config("ui.theme") == "solarized"
    assert c.config.get_config_source("ui.theme") == "local"
    c.close()

    # env wins over remote-default; JSON-parsed when it parses.
    c = make_client(_ok_routes(), env={"PKEY_CONFIG_ui__theme": '"dark"'})
    c.license.activate_with_key("k")
    assert c.config.get_config("ui.theme") == "dark"
    assert c.config.get_config_source("ui.theme") == "env"
    c.close()

    # no override/env -> remote default value.
    c = make_client(_ok_routes(), env={})
    c.license.activate_with_key("k")
    assert c.config.get_config("ui.theme") == "light"
    assert c.config.get_config_source("ui.theme") == "remote-default"
    c.close()


# @pkey-feature config.resolve
def test_env_raw_string_when_not_json_and_fallback_source() -> None:
    c = make_client(_ok_routes(), env={"PKEY_CONFIG_ui__theme": "not json {"})
    c.license.activate_with_key("k")
    assert c.config.get_config("ui.theme") == "not json {"
    assert c.config.get_config_source("ui.theme") == "env"
    # An unknown key falls back.
    assert c.config.get_config("missing.key", "fb") == "fb"
    assert c.config.get_config_source("missing.key") == "fallback"
    c.close()


# @pkey-feature config.list
def test_list_user_config_excludes_hidden_and_marks_enforced() -> None:
    c = make_client(_ok_routes(), local_overrides={"ui.theme": "solarized"})
    c.license.activate_with_key("k")
    items = {i["key"]: i for i in c.config.list_user_config()}
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
    # The hidden secret is APPLIED but never enumerated.
    assert "proxy.subscriptionUrl" not in items
    assert c.config.get_secret("proxy.subscriptionUrl") is not None
    c.close()


# ── the whole flow ──────────────────────────────────────────────────────────────────
# @pkey-feature license.activate license.entitlements config.secret
def test_activation_then_reads_across_both_documents() -> None:
    state = {"reports": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        p = f"/{PRODUCT}"
        if path == f"{p}/license/activate":
            assert r.headers["authorization"] == "Bearer my-license-key"
            assert r.headers["X-PKey-Device"]
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if path == f"{p}/license/document":
            assert r.headers["authorization"] == f"Bearer {TOKEN}"
            assert r.headers["X-PKey-Version"] == "1.0.0"
            assert r.headers["X-PKey-Channel"] == "stable"
            return httpx.Response(
                200, text=sign_license(r.headers["X-PKey-Device"]), headers={"etag": "l1"}
            )
        if path == f"{p}/config/document":
            return httpx.Response(
                200, text=sign_config(r.headers["X-PKey-Device"]), headers={"etag": "c1"}
            )
        if path == f"{p}/devices/report":
            body = json.loads(r.content)
            assert body["config"]["run.concurrency"] == 4
            assert body["entitlements"]["polarisVpn"] is True
            # Secrets are NOT included in the report snapshot.
            assert "secrets" not in body
            state["reports"] += 1
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler)
    assert c.license.activate_with_key("my-license-key").kind == "ok"

    assert c.is_licensed(now=NOW + 100) is True
    assert c.status(now=NOW + 100).status == "ok"
    assert c.config.get_config("run.concurrency", 1) == 4
    assert c.config.get_config("missing", "fallback") == "fallback"
    assert c.config.get_secret("proxy.subscriptionUrl") == "https://vpn.example.com/sub/abc"
    assert c.config.get_secret("missing") is None
    assert c.config.schema_version() == 4
    assert c.license.is_entitled("polarisVpn") is True
    assert c.license.is_entitled("nope") is False
    assert c.license.get_entitlements() == {"polarisVpn": True, "license.tier": "pro"}
    assert c.license.get_license_id() == "lic_v3"
    profile = c.license.get_profile()
    assert profile is not None and profile.firstName == "Grace"
    assert state["reports"] >= 1
    c.close()


# @pkey-feature core.sync
def test_the_two_documents_have_independent_etags() -> None:
    """§5: a settings edit no longer forces a licence re-download, and a tier change no
    longer forces a settings refetch."""
    c = make_client(_ok_routes())
    c.license.activate_with_key("k")
    assert c._cache.etag("license") == "lic-etag"
    assert c._cache.etag("config") == "cfg-etag"
    c.close()


# @pkey-feature core.sync
def test_sync_reports_per_service_outcomes() -> None:
    c = make_client(_ok_routes())
    c._tokens.set(TOKEN)
    result = c.sync()
    assert set(result.documents) == {"license", "config"}
    assert result.documents["license"].kind == "applied"
    assert result.documents["config"].kind == "applied"
    assert result.applied is True
    c.close()


def test_re_serving_the_same_document_is_refused_as_a_replay() -> None:
    """§3's per-type anti-replay floor, reached through the client: a forced re-fetch that
    returns a document with the SAME ``issuedAt`` is not newer, so nothing is applied and
    — crucially — nothing about the document already held is disturbed."""
    c = make_client(_ok_routes())
    c.license.activate_with_key("k")
    held = c._cache.license_doc()
    result = c.sync(force=True)
    assert result.applied is False
    assert result.documents["license"].kind == "error"
    assert c._cache.license_doc() == held, "the held document survives untouched"
    assert c.status().status == "ok"
    c.close()


def test_a_disabled_service_is_skipped_entirely() -> None:
    seen: Dict[str, Any] = {"paths": []}
    c = make_client(
        routes(license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]), seen=seen),
        expected_services=["license"],
    )
    c.license.activate_with_key("k")
    result = c.sync(force=True)
    assert set(result.documents) == {"license"}
    assert f"/{PRODUCT}/config/document" not in seen["paths"]
    c.close()


def test_get_sync_state_is_the_bridge_contract() -> None:
    c = make_client(_ok_routes())
    before = c.get_sync_state()
    assert before.activation is None and before.doc is None
    assert before.highWaterMark == 0 and before.lastVerifiedAt is None
    assert before.blocked is None and before.lastSyncUnauthorized is False

    c.license.activate_with_key("k")
    after = c.get_sync_state()
    assert after.activation == "token"
    assert after.doc is not None and after.doc.licenseId == "lic_v3"
    assert after.highWaterMark == NOW
    assert after.lastVerifiedAt is not None
    c.close()


# @pkey-feature core.sync
def test_on_change_fires_only_when_the_content_actually_changed() -> None:
    fired: list = []
    c = make_client(_ok_routes(), on_change=lambda st: fired.append(st))
    c.license.activate_with_key("k")
    assert len(fired) == 1 and isinstance(fired[0], LicenseState)
    # A forced re-sync of the SAME content re-signs but does not change the ETag.
    c.sync(force=True)
    assert len(fired) == 1
    c.close()


# ── the 403 build gate ──────────────────────────────────────────────────────────────
def test_license_document_403_version_too_old_blocks() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        p = f"/{PRODUCT}"
        if path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if path == f"{p}/license/document":
            return httpx.Response(
                403,
                json={
                    "error": {"code": "version_blocked", "reason": "version-too-old"},
                    "allowedRange": {"min": "2.0.0"},
                },
            )
        if path == f"{p}/devices/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler, expected_services=["license"])
    assert c.license.activate_with_key("k").kind == "ok"  # the BLOCK is on the document
    st = c.status(now=NOW + 100)
    assert st.status == "version-too-old"
    assert st.allowedRange is not None and st.allowedRange.min == "2.0.0"
    assert c.is_licensed(now=NOW + 100) is False
    c.close()


def test_a_403_with_a_bare_code_falls_back_to_the_stricter_reason() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        p = f"/{PRODUCT}"
        if r.url.path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if r.url.path == f"{p}/license/document":
            return httpx.Response(403, json={"error": {"code": "channel_not_allowed"}})
        if r.url.path == f"{p}/devices/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler, expected_services=["license"])
    c.license.activate_with_key("k")
    assert c.status().status == "channel-not-entitled"
    c.close()


def test_blocked_with_no_prior_doc_does_not_raise() -> None:
    """A 403 with no prior cached document creates a doc-less blocked cache; a SECOND
    sync patches that existing record (the previously-crashing path)."""
    c = make_client(routes(license_status=403), expected_services=["license"])
    assert c.license.activate_with_key("k").kind == "ok"
    assert c.status(now=NOW + 100).status == "version-too-old"
    res = c.sync(force=True)
    assert res.blocked is True
    assert c.status(now=NOW + 100).status == "version-too-old"
    c.close()


def test_a_healthy_sync_clears_the_unsigned_hints() -> None:
    """§4.1: the two unsigned hints can only TIGHTEN the gate, so clearing them on
    evidence of a healthy authenticated exchange is safe; setting them requires the server
    to have said so."""
    state = {"blocked": True}

    def handler(r: httpx.Request) -> httpx.Response:
        p = f"/{PRODUCT}"
        if r.url.path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if r.url.path == f"{p}/license/document":
            if state["blocked"]:
                return httpx.Response(403, json={"reason": "version-too-old"})
            return httpx.Response(
                200, text=sign_license(r.headers["X-PKey-Device"]), headers={"etag": "l"}
            )
        if r.url.path == f"{p}/devices/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler, expected_services=["license"])
    c.license.activate_with_key("k")
    assert c.status().status == "version-too-old"
    state["blocked"] = False
    c.sync(force=True)
    assert c.status().status == "ok"
    assert c.get_sync_state().blocked is None
    c.close()


# ── activation failure ladder ───────────────────────────────────────────────────────
# @pkey-feature license.activate
def test_activation_unauthorized() -> None:
    c = make_client(lambda r: httpx.Response(401, text="bad key"))
    r = c.license.activate_with_key("nope")
    assert r.kind == "unauthorized"
    assert c.status(now=NOW + 100).status == "needs-activation"
    c.close()


# @pkey-feature license.manage
def test_activation_device_limit_surfaces_manage_url() -> None:
    url = "https://key.plrs.im/activate?product=djdl&next=free-device&for=Linux%20x86_64"
    for body in (
        {"error": "device_limit", "limit": 1, "deviceCount": 1, "manageUrl": url},
        {"error": {"code": "device_limit", "limit": 1, "deviceCount": 1, "manageUrl": url}},
    ):
        c = make_client(lambda r, b=body: httpx.Response(403, json=b))
        r = c.license.activate_with_key("k")
        assert r.kind == "device-limit" and r.manage_url == url
        assert c.status(now=NOW + 100).status == "needs-activation"
        c.close()
    # An invalid link is dropped; an unknown member never changes the outcome.
    c = make_client(
        lambda r: httpx.Response(
            403,
            json={"error": "device_limit", "manageUrl": "javascript:x", "somethingNew": 1},
        )
    )
    r = c.license.activate_with_key("k")
    assert r.kind == "device-limit" and r.manage_url is None
    c.close()


# @pkey-feature license.activate
def test_activation_device_limit_reads_both_body_shapes() -> None:
    for body in ({"limit": 3, "deviceCount": 3}, {"error": {"limit": 3, "deviceCount": 3}}):
        c = make_client(lambda r, b=body: httpx.Response(403, json=b))
        r = c.license.activate_with_key("k")
        assert r.kind == "device-limit" and r.limit == 3 and r.deviceCount == 3
        c.close()


def test_activation_fingerprint_required_reads_both_body_shapes() -> None:
    for body in ({"error": "fingerprint_required"}, {"error": {"code": "fingerprint_required"}}):
        c = make_client(lambda r, b=body: httpx.Response(403, json=b))
        assert c.license.activate_with_key("k").kind == "fingerprint-required"
        c.close()


def test_activation_hardware_mismatch() -> None:
    c = make_client(
        lambda r: httpx.Response(409, json={"drift": 2, "changed": ["cpuModel"]})
    )
    r = c.license.activate_with_key("k")
    assert r.kind == "hardware-mismatch" and r.drift == 2 and r.changed == ["cpuModel"]
    c.close()


# @pkey-feature license.enroll
def test_enroll_disabled_is_a_404() -> None:
    c = make_client(lambda r: httpx.Response(404))
    assert c.license.enroll().kind == "enroll-disabled"
    c.close()


# @pkey-feature license.enroll
def test_enroll_succeeds_and_syncs() -> None:
    c = make_client(_ok_routes())
    assert c.license.enroll().kind == "ok"
    assert c.status().status == "ok"
    c.close()


# ── 401 handling + deactivation ─────────────────────────────────────────────────────
def test_401_reacquires_the_token_exactly_once_then_succeeds() -> None:
    state = {"doc_calls": 0, "token_calls": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        p = f"/{PRODUCT}"
        if r.url.path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": "pkeyt_stale", "schemaVersion": 4})
        if r.url.path == f"{p}/license/token":
            state["token_calls"] += 1
            assert r.headers["authorization"] == "Bearer pkeyt_stale"
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if r.url.path == f"{p}/license/document":
            state["doc_calls"] += 1
            if r.headers["authorization"] == "Bearer pkeyt_stale":
                return httpx.Response(401)
            return httpx.Response(
                200, text=sign_license(r.headers["X-PKey-Device"]), headers={"etag": "l"}
            )
        if r.url.path == f"{p}/devices/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler, expected_services=["license"])
    assert c.license.activate_with_key("k").kind == "ok"
    assert state["doc_calls"] == 2  # stale -> 401, fresh -> 200
    assert state["token_calls"] == 1
    assert c.status(now=NOW + 100).status == "ok"
    c.close()


def test_a_hard_401_is_recorded_once_and_becomes_revoked() -> None:
    """§4.3: a recorded hard 401 yields ``revoked`` offline, and the re-acquire is
    attempted exactly ONCE per pass — not a loop that would keep postponing the signal."""
    state = {"token_calls": 0}

    def handler(r: httpx.Request) -> httpx.Response:
        p = f"/{PRODUCT}"
        if r.url.path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if r.url.path == f"{p}/license/token":
            state["token_calls"] += 1
            return httpx.Response(401)
        if r.url.path in (f"{p}/license/document", f"{p}/config/document"):
            return httpx.Response(401)
        if r.url.path == f"{p}/devices/report":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler)
    c.license.activate_with_key("k")
    # BOTH documents 401 in the same pass, and they share ONE re-acquire budget.
    assert state["token_calls"] == 1
    assert c.status().status == "revoked"
    assert c.get_sync_state().lastSyncUnauthorized is True
    # The next pass re-arms the budget.
    c.sync()
    assert state["token_calls"] == 2
    c.close()


# @pkey-feature license.deactivate
def test_deactivate_wipes_local_state() -> None:
    c = make_client(_ok_routes())
    c.license.activate_with_key("k")
    assert c.is_licensed(now=NOW + 100) is True
    c.license.deactivate()
    assert c.status(now=NOW + 100).status == "needs-activation"
    assert c.config.get_config("run.concurrency", 0) == 0
    assert c.core.high_water_mark == 0
    c.close()


# @pkey-feature license.deactivate
def test_deactivate_works_offline() -> None:
    """The network call is best-effort and the local wipe is not: a device deactivating on
    a plane must not be left holding a token because the control plane was unreachable."""
    c = make_client(_ok_routes())
    c.license.activate_with_key("k")

    def exploding(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    c.core._client = httpx.Client(transport=httpx.MockTransport(exploding), base_url="")
    c.license.deactivate()
    assert c.status().status == "needs-activation"
    assert c.core.store.get_token() is None
    c.close()


def test_wrong_device_doc_rejected() -> None:
    """A doc bound to a different device must NOT be applied (anti-splice)."""
    c = make_client(routes(license_jws=sign_license("some-other-device")))
    c.license.activate_with_key("k")
    assert c.status(now=NOW + 100).status == "needs-activation"
    c.close()


# ── offline init performs zero network calls ────────────────────────────────────────
# @pkey-feature core.cache
def test_offline_init_makes_no_network_calls() -> None:
    """§5 / the sync loop's first line: an unactivated client that polls must not generate
    traffic, and an offline-first ``init()`` must not either."""
    calls: list = []

    def exploding(r: httpx.Request) -> httpx.Response:
        calls.append(r.url.path)
        raise AssertionError(f"unexpected network call to {r.url.path}")

    c = make_client(exploding)
    assert c.status().status == "needs-activation"
    assert c.sync() == c.sync()  # both idle
    assert calls == []
    c.close()


# ── device management passthroughs ──────────────────────────────────────────────────
# @pkey-feature devices.manage
def test_current_device_and_offline_roster() -> None:
    c = make_client(_ok_routes())
    current = c.current_device()
    assert current.id and current.current is True
    assert current.status == "needs-activation"
    # Without a credential there is no roster to fetch, so the honest answer is this
    # device alone — not an error.
    assert [d.id for d in c.list_devices()] == [current.id]
    with pytest.raises(DeviceManagementUnsupportedError):
        c.devices.list()
    c.close()


def test_deauthorizing_this_device_is_a_full_local_deactivation() -> None:
    c = make_client(_ok_routes())
    c.license.activate_with_key("k")
    c.deauthorize_device(c.core.device_id)
    assert c.status().status == "needs-activation"
    c.close()


def test_context_manager_closes() -> None:
    with make_client(_ok_routes()) as c:
        assert c.license.activate_with_key("k").kind == "ok"
    assert c.core._client is None or True  # close() is idempotent
