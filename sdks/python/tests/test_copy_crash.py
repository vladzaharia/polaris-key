# @pkey-feature core.errors
"""The copy catalog and ``crash_tags()`` (SDK parity pass §3.2, §3.14; SP-P14). There is no
portal URL builder: owner decision Q6 (2026-10-05) drops §3.5's client-side builder."""

from __future__ import annotations

import httpx

from polaris_key import constants_generated as constants
from polaris_key import copy
from polaris_key.update.client import UpdateClientOptions

from helpers import make_client


def _c(**kw):
    return make_client(lambda r: httpx.Response(404), **kw)


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
