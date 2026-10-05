"""LX-17 (S-19 §7.5, §10.1 risk 1, decision 10): does the Python SDK tolerate a ``licenseId``
that changes on a PLAIN REFRESH — no activation call, the same device token — the way
``licensing.reanchor: onRefresh`` would deliver it?

"Tolerate" is pinned on the three surfaces the audit names:

* cache: the new document is applied, the accessors read it, and it is what a fresh client
  restores from the same store while offline;
* telemetry: the ``/devices/report`` after the refresh carries the NEW licence's grants, and
  the current device reports the new ``licenseId``;
* activation: the device stays activated on the SAME token, with no re-activation and no wipe.

Audit result for Python: PASS.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx

from polaris_key.devices.store import InMemoryStore

from helpers import NOW, PRODUCT, TOKEN, make_client, sign_license


def _entitlements(tier: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "license.tier": {"state": "enforced", "value": tier, "updatedAt": 0},
    }
    if tier == "pro":
        out["pro"] = {"state": "enforced", "value": True, "updatedAt": 0}
    return out


# @pkey-feature core.sync license.entitlements
def test_a_license_id_change_on_a_plain_refresh_is_tolerated() -> None:
    server: Dict[str, Any] = {
        "license_id": "lic_trial",
        "tier": "free",
        "etag": "lic-1",
        "issued": NOW,
    }
    paths: List[str] = []
    reports: List[Dict[str, Any]] = []
    bearers: set = set()

    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        paths.append(path)
        p = f"/{PRODUCT}"
        if path == f"{p}/license/activate":
            return httpx.Response(200, json={"token": TOKEN, "schemaVersion": 4})
        if path == f"{p}/devices/report":
            reports.append(json.loads(r.content))
            return httpx.Response(200, json={"ok": True})
        if path == f"{p}/license/document":
            bearers.add(r.headers.get("authorization"))
            if r.headers.get("if-none-match") == server["etag"]:
                return httpx.Response(304, headers={"etag": server["etag"]})
            return httpx.Response(
                200,
                text=sign_license(
                    r.headers["X-PKey-Device"],
                    issued=server["issued"],
                    licenseId=server["license_id"],
                    entitlements=_entitlements(server["tier"]),
                ),
                headers={"etag": server["etag"]},
            )
        return httpx.Response(404)

    store = InMemoryStore(PRODUCT)
    c = make_client(handler, store=store, expected_services=["license"])
    assert c.license.activate_with_key("pkey_djdl_test").kind == "ok"
    assert c.license.get_license_id() == "lic_trial"
    assert c.license.is_entitled("pro") is False

    # The server re-anchors this device on another licence; the next plain sync receives it.
    server.update(license_id="lic_pro", tier="pro", etag="lic-2", issued=NOW + 60)
    paths.clear()
    reports.clear()
    result = c.sync()

    # cache
    assert result.documents["license"].kind == "applied"
    assert c.license.get_license_id() == "lic_pro"
    assert c.license.is_entitled("pro") is True
    assert c.license.get_entitlements()["license.tier"] == "pro"
    # activation state
    assert f"/{PRODUCT}/license/activate" not in paths
    assert bearers == {f"Bearer {TOKEN}"}
    assert c.license.activation() == "token"
    assert c.status(now=NOW + 100).status == "ok"
    # telemetry
    assert len(reports) == 1
    assert reports[0]["entitlements"]["license.tier"] == "pro"
    assert c.current_device().licenseId == "lic_pro"

    # The following refresh revalidates the new licence's document normally.
    again = c.sync()
    assert again.documents["license"].kind == "unchanged"
    assert c.license.get_license_id() == "lic_pro"
    c.close()

    # A fresh client on the same store, fully offline, restores the re-anchored document.
    def offline(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=r)

    o = make_client(offline, store=store, expected_services=["license"])
    assert o.license.get_license_id() == "lic_pro"
    assert o.license.is_entitled("pro") is True
    assert o.status(now=NOW + 100).status == "ok"
    o.close()
