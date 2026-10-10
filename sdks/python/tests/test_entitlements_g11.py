# @pkey-feature license.entitlements
"""S-19 G11 and the licence conveniences (SDK parity pass §3.3, SP-P02).

``is_entitled`` and ``entitlement_value`` answer as if nothing were granted whenever the gate is
not usable, so a revoked or expired install loses its unlocks at once instead of keeping them
until the cache is cleared. ``license_info()`` summarises the verified document either way.
"""

from __future__ import annotations

import httpx

from helpers import DAY, NOW, PRODUCT, make_client, routes, sign_license


def _client(**kw):
    return make_client(routes(license_jws=lambda r: sign_license(r.headers["X-PKey-Device"], **kw)))


def test_entitled_while_usable() -> None:
    c = _client()
    c.license.activate_with_key("k")
    assert c.license.is_entitled("polarisVpn", now=NOW + 10) is True
    assert c.license.entitlement_value("license.tier", now=NOW + 10) == "pro"
    c.close()


def test_revoked_gate_denies_every_flag() -> None:
    state = {"revoked": False}
    base = routes(license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]))

    def handler(r: httpx.Request) -> httpx.Response:
        if state["revoked"] and r.url.path in (
            f"/{PRODUCT}/license/document",
            f"/{PRODUCT}/config/document",
            f"/{PRODUCT}/license/token",
        ):
            return httpx.Response(401, json={"error": {"code": "unauthorized"}})
        return base(r)

    c = make_client(handler)
    c.license.activate_with_key("k")
    assert c.license.is_entitled("polarisVpn") is True
    state["revoked"] = True
    c.sync(force=True)
    assert c.status().status == "revoked"
    # The hard 401 removed the document it answered for, so nothing is left to grant.
    assert c.license.doc is None
    assert c.license.is_entitled("polarisVpn") is False
    assert c.license.entitlement_value("license.tier") is None
    assert c.license.license_info() is None
    c.close()


def test_not_entitled_once_expired_past_grace() -> None:
    c = _client()
    c.license.activate_with_key("k")
    assert c.license.is_entitled("polarisVpn", now=NOW + 40 * DAY) is False
    assert c.license.is_entitled("polarisVpn", now=NOW + 2 * DAY) is True  # grace still usable
    c.close()


def test_license_info_reads_the_enforced_entitlements() -> None:
    ents = {
        "license.tier": {"state": "enforced", "value": "pro", "updatedAt": 0},
        "license.tierLabel": {"state": "enforced", "value": "Pro", "updatedAt": 0},
        "deviceLimit": {"state": "enforced", "value": 3, "updatedAt": 0},
        "channels": {"state": "enforced", "value": ["stable", "beta"], "updatedAt": 0},
    }
    c = _client(entitlements=ents)
    assert c.license.license_info() is None
    c.license.activate_with_key("k")
    info = c.license.license_info()
    assert info.tier == "pro" and info.tierLabel == "Pro" and info.deviceLimit == 3
    assert info.entitledChannels == ("stable", "beta")
    assert info.profile is not None and info.profile.firstName == "Grace"
    assert info.deviceCount is None and info.expiresAt is None
    c.close()
