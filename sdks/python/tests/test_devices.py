"""The Devices sub-client — registration, the roster, rename, deauthorize, telemetry.

THE PARITY GAP THIS SUITE EXISTS FOR: the pre-suite Python client raised
``DeviceManagementUnsupportedError`` from ``list_devices``/``deauthorize_device``
unconditionally. The endpoints existed on the Worker; this SDK simply did not call them.
They are real calls now, and the error survives only for its honest meaning — no
credential, so no roster to ask for.
"""

from __future__ import annotations

import json
from typing import Any, Dict

import httpx
import pytest

from polaris.core.errors import PolarisError
from polaris.devices.client import DeviceManagementUnsupportedError

from helpers import (
    PRODUCT,
    TOKEN,
    make_client,
    routes,
    sign_config,
    sign_license,
)


ROSTER = [
    {
        "id": "dev-current",
        "status": "ok",
        "current": True,
        "licenseId": "lic_v3",
        "label": "Workstation",
        "platform": "darwin",
        "arch": "arm64",
        "appVersion": "1.0.0",
        "sdkName": "polaris-python",
        "sdkVersion": "0.1.0",
    },
    {"id": "dev-other", "status": "ok", "current": False, "label": None},
]


# ── registration (§6) ───────────────────────────────────────────────────────────────
def test_register_mints_and_stores_a_token() -> None:
    c = make_client(routes())
    r = c.devices.register()
    assert r.kind == "ok"
    assert r.token == TOKEN and r.deviceId == c.core.device_id
    assert c.core.store.get_token() == TOKEN
    c.close()


def test_register_sends_the_fingerprint_when_collection_is_on() -> None:
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path == f"/{PRODUCT}/devices/register":
            seen["body"] = r.content
            seen["ct"] = r.headers.get("content-type")
            return httpx.Response(
                200, json={"token": TOKEN, "deviceId": r.headers["X-Polaris-Device"]}
            )
        return httpx.Response(404)

    c = make_client(handler)
    assert c.devices.register().kind == "ok"
    if seen["body"]:
        assert json.loads(seen["body"])["fingerprint"]
        assert seen["ct"] == "application/json"
    c.close()


def test_register_with_fingerprint_off_sends_no_body_at_all() -> None:
    """A host that opted out sends a byte-identical request to one that has nothing to
    report."""
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path == f"/{PRODUCT}/devices/register":
            seen["body"] = r.content
            return httpx.Response(
                200, json={"token": TOKEN, "deviceId": r.headers["X-Polaris-Device"]}
            )
        return httpx.Response(404)

    c = make_client(handler, fingerprint=False)
    assert c.devices.register().kind == "ok"
    assert seen["body"] == b""
    assert c.devices.fingerprint() is None
    c.close()


@pytest.mark.parametrize(
    "status,kind",
    [(403, "registration-closed"), (429, "rate-limited"), (404, "not-configured"), (500, "error")],
)
def test_register_status_ladder(status: int, kind: str) -> None:
    c = make_client(lambda r: httpx.Response(status, text="nope"))
    r = c.devices.register()
    assert r.kind == kind
    assert c.core.store.get_token() is None
    c.close()


def test_register_reports_a_transport_failure_rather_than_raising() -> None:
    def exploding(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    c = make_client(exploding)
    r = c.devices.register()
    assert r.kind == "error" and "offline" in r.message
    c.close()


def test_a_malformed_200_is_an_error_not_a_credential() -> None:
    c = make_client(lambda r: httpx.Response(200, json={"token": 7}))
    assert c.devices.register().kind == "error"
    assert c.core.store.get_token() is None
    c.close()


def test_registration_does_not_fire_the_activation_event() -> None:
    """A keyless registration is a PROVISIONING step a host may want to take long before
    it wants documents (an installer that registers at setup and syncs on first launch).
    Only licence acquisition triggers a sync; the CLI's ``register`` verb syncs
    explicitly."""
    seen: Dict[str, Any] = {"paths": []}
    c = make_client(routes(seen=seen))
    c.devices.register()
    assert f"/{PRODUCT}/license/document" not in seen["paths"]
    assert f"/{PRODUCT}/config/document" not in seen["paths"]
    c.close()


# ── the roster (the parity gap) ─────────────────────────────────────────────────────
def test_list_calls_the_real_endpoint() -> None:
    c = make_client(routes(devices=ROSTER))
    c._tokens.set(TOKEN)
    roster = c.devices.list()
    assert [d.id for d in roster] == ["dev-current", "dev-other"]
    assert roster[0].label == "Workstation" and roster[0].current is True
    assert roster[0].sdkName == "polaris-python"
    c.close()


def test_list_devices_blends_local_state_into_the_roster() -> None:
    c = make_client(
        routes(
            devices=ROSTER,
            license_jws=lambda r: sign_license(r.headers["X-Polaris-Device"]),
            config_jws=lambda r: sign_config(r.headers["X-Polaris-Device"]),
        )
    )
    c.license.activate_with_key("k")
    blended = {d.id: d for d in c.list_devices()}
    assert blended["dev-current"].status == "ok"
    assert blended["dev-current"].profile is not None
    assert blended["dev-other"].profile is None
    c.close()


def test_rename_and_deauthorize_hit_the_real_endpoints() -> None:
    seen: Dict[str, Any] = {"calls": []}

    def handler(r: httpx.Request) -> httpx.Response:
        seen["calls"].append((r.method, r.url.path, r.content))
        return httpx.Response(200, json={"ok": True})

    c = make_client(handler)
    c._tokens.set(TOKEN)
    c.devices.rename("dev-other", "Laptop")
    c.devices.deauthorize("dev-other")
    methods = [(m, p) for m, p, _ in seen["calls"]]
    assert ("PATCH", f"/{PRODUCT}/devices/dev-other") in methods
    assert ("DELETE", f"/{PRODUCT}/devices/dev-other") in methods
    assert json.loads(seen["calls"][0][2]) == {"label": "Laptop"}
    c.close()


def test_a_device_id_is_url_encoded_into_the_path() -> None:
    """A slash in the id must not open a second path segment."""
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        # `raw_path` is what goes on the wire; `.path` is the decoded view.
        seen["raw"] = r.url.raw_path
        return httpx.Response(200, json={"ok": True})

    c = make_client(handler)
    c._tokens.set(TOKEN)
    c.devices.deauthorize("a/b")
    assert seen["raw"] == f"/{PRODUCT}/devices/a%2Fb".encode()
    c.close()


def test_roster_operations_need_a_credential() -> None:
    """The honest meaning of ``DeviceManagementUnsupportedError`` in v3: there is nothing
    to authenticate the roster read with."""
    c = make_client(routes(devices=ROSTER))
    for call in (
        lambda: c.devices.list(),
        lambda: c.devices.rename("x", None),
        lambda: c.devices.deauthorize("x"),
    ):
        with pytest.raises(DeviceManagementUnsupportedError):
            call()
    c.close()


def test_a_failing_roster_call_raises_a_polaris_error() -> None:
    c = make_client(lambda r: httpx.Response(500, text="boom"))
    c._tokens.set(TOKEN)
    with pytest.raises(PolarisError) as exc:
        c.devices.list()
    assert exc.value.code == "device_list_failed"
    c.close()


def test_a_roster_body_without_devices_is_an_empty_list_not_a_crash() -> None:
    c = make_client(lambda r: httpx.Response(200, json={}))
    c._tokens.set(TOKEN)
    assert c.devices.list() == []
    c.close()


# ── telemetry ───────────────────────────────────────────────────────────────────────
def test_report_posts_to_devices_report_and_is_built_from_verified_docs() -> None:
    """R4-05: v1 echoed the on-disk cache back verbatim, so a forged local file authored
    the one signal that would have revealed the forgery. The snapshot is read from the
    documents the cache re-verified moments ago."""
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        p = f"/{PRODUCT}"
        if r.url.path == f"{p}/devices/report":
            seen["body"] = json.loads(r.content)
            return httpx.Response(200, json={"ok": True})
        if r.url.path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if r.url.path == f"{p}/license/document":
            return httpx.Response(
                200, text=sign_license(r.headers["X-Polaris-Device"]), headers={"etag": "l"}
            )
        if r.url.path == f"{p}/config/document":
            return httpx.Response(
                200, text=sign_config(r.headers["X-Polaris-Device"]), headers={"etag": "c"}
            )
        return httpx.Response(404)

    c = make_client(handler)
    c.license.activate_with_key("k")
    body = seen["body"]
    assert body["config"]["run.concurrency"] == 4
    assert body["entitlements"]["polarisVpn"] is True
    assert "secrets" not in body
    assert body["os"]["name"] and body["runtime"]["name"] == "python"
    c.close()


def test_report_without_a_credential_is_a_no_op() -> None:
    def exploding(r: httpx.Request) -> httpx.Response:
        raise AssertionError("must not dial")

    c = make_client(exploding)
    assert c.devices.report() is False
    c.close()


def test_an_empty_report_is_a_truthful_one() -> None:
    """If nothing verified, the maps are empty — never the file's own claims."""
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path == f"/{PRODUCT}/devices/report":
            seen["body"] = json.loads(r.content)
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = make_client(handler)
    c._tokens.set(TOKEN)
    assert c.devices.report() is True
    assert seen["body"]["config"] == {} and seen["body"]["entitlements"] == {}
    c.close()
