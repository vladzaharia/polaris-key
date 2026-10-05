# @pkey-feature core.errors
"""``portal.url()``, the copy catalog and ``crash_tags()`` (SDK parity pass §3.2, §3.5, §3.14;
SP-P14)."""

from __future__ import annotations

import httpx
import pytest

from polaris_key import constants_generated as constants
from polaris_key import copy
from polaris_key.portal import allowed_return
from polaris_key.update.client import UpdateClientOptions

from helpers import BASE_URL, PRODUCT, make_client


def _c(**kw):
    return make_client(lambda r: httpx.Response(404), **kw)


@pytest.mark.parametrize(
    "flow,kw,want",
    [
        ("library", {}, "/#/"),
        ("account", {}, "/#/account"),
        ("activate", {"key": "pkey_ABC"}, f"/#/?activate=pkey_ABC&product={PRODUCT}"),
        ("devices", {}, f"/#/p/{PRODUCT}/devices"),
        ("freeDevice", {"for_": "Ada's laptop"}, f"/#/p/{PRODUCT}/free-device?for=Ada%27s+laptop"),
        ("download", {"platform": "windows"}, f"/#/p/{PRODUCT}/download?platform=windows"),
    ],
)
def test_portal_urls_follow_the_shipped_routes(flow, kw, want) -> None:
    c = _c()
    assert c.portal.url(flow, **kw) == BASE_URL + want
    c.close()


def test_return_to_is_dropped_when_it_cannot_be_a_target() -> None:
    c = _c()
    ok = c.portal.url("freeDevice", return_to="tidewater://done", allowed_returns=["tidewater"])
    assert ok.endswith("return=tidewater%3A%2F%2Fdone")
    for bad in ("javascript:alert(1)", "https://user:pw@x.example/", "https://x.exa mple/", "x" * 3000):
        assert "return=" not in c.portal.url("freeDevice", return_to=bad)
    assert "return=" not in c.portal.url("download", return_to="https://evil.example/", allowed_returns=["https://app.example"])
    assert allowed_return("https://app.example/back", ["https://app.example"]) == "https://app.example/back"
    with pytest.raises(ValueError):
        c.portal.url("nope")
    c.close()


def test_every_registry_code_and_status_has_copy() -> None:
    for code in list(constants.ERROR_CODE_VALUES) + [
        "ok", "grace", "expired", "revoked", "needs-activation", "version-too-old",
        "version-too-new", "channel-not-entitled", "not-applicable", "device-limit",
        "enroll-claimed", "license-disabled", "attestation-required", "rate-limited", "refused",
    ]:
        assert copy.message(code) and copy.title(code)
        assert "{" not in copy.message(code)


def test_curated_copy_and_fallback() -> None:
    assert "sign in" in copy.message("enroll_claimed").lower()
    assert copy.message("brand-new-code") == copy.GENERIC[1].format(code="brand-new-code")
    assert copy.message("bad_request", "missing key") == "The request was not valid: missing key"
    copy.register_locale("fr", {"cancelled": ("Annulé", "Annulé.")})
    assert copy.message("cancelled", locale="fr-CA") == "Annulé."
    assert copy.message("ok", locale="fr") == copy.message("ok")


def test_crash_tags() -> None:
    c = _c(version="1.2.0", update=UpdateClientOptions(outlet="direct", build_number="45", platform="macos", arch="arm64"))
    assert c.crash_tags() == {"release": "app@1.2.0+45", "environment": "stable", "pkey.outlet": "direct"}
    c.close()
    c = _c(version="2.0.0", channel="beta")
    assert c.crash_tags() == {"release": "app@2.0.0", "environment": "beta"}
    c.close()
