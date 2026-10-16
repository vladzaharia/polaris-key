# @pkey-feature server.license server.signin
"""The server core around the verdict: trust refresh, the cache, redaction, configuration and the
copy tables. The verdict rows replay in test_server_matrix.py."""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any, List

import httpx
import pytest

from polaris_key.core.jws import sign_jws
from polaris_key.core.models import TYP_LICENSE
from polaris_key.server import PolarisKey, PolarisKeyError, backend_verdict
from polaris_key.server._copy import COPY
from polaris_key.server._problem import LOCALES
from tests.helpers import (
    KID,
    NOW,
    PRIVATE_PEM,
    PUBKEY_RAW,
    ROTATED_PEM,
    ROTATED_PUB,
    key_entry,
    license_payload,
    sign_license,
    sign_manifest,
)

CFG = {"product_slug": "djdl", "base_url": "https://key.example", "trust": {KID: PUBKEY_RAW}}
REPO = Path(__file__).resolve().parents[3]


def _headers(jws: str) -> List[Any]:
    return [("X-PKey-License", jws)]


def _quiet(polaris: PolarisKey) -> PolarisKey:
    """Mark the start-up refresh as done, so only the unknown-kid path fetches."""
    for t in polaris._trust.values():
        t.last_attempt = NOW
    return polaris


def _manifest_client(calls: List[str], status: int = 200) -> httpx.Client:
    manifest = sign_manifest([key_entry("rotated-2027", ROTATED_PUB)])

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        assert req.headers["x-pkey-sdk"] == "python-server"
        return httpx.Response(status, text=manifest if status == 200 else "")

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_unknown_kid_fetches_the_manifest_once_a_minute() -> None:
    calls: List[str] = []
    polaris = _quiet(PolarisKey(config=CFG, http_client=_manifest_client(calls), clock=lambda: NOW))
    rotated = sign_license("dev_1", pem=ROTATED_PEM, kid="rotated-2027")
    assert polaris.authenticate(_headers(rotated)).problem is None
    assert calls == ["https://key.example/djdl/.well-known/polaris-trust.jws"]
    # A kid nobody knows: refused, and the next junk header does not fetch again within 60 s.
    junk = sign_license("dev_1", pem=ROTATED_PEM, kid="nobody")
    assert polaris.authenticate(_headers(junk)).problem.code == "license_invalid"  # type: ignore[union-attr]
    n = len(calls)
    assert polaris.authenticate(_headers(junk)).problem.code == "license_invalid"  # type: ignore[union-attr]
    assert len(calls) == n


def test_a_failed_fetch_keeps_the_pins() -> None:
    calls: List[str] = []
    polaris = _quiet(PolarisKey(config=CFG, http_client=_manifest_client(calls, 500), clock=lambda: NOW))
    junk = sign_license("dev_1", pem=ROTATED_PEM, kid="nobody")
    assert polaris.authenticate(_headers(junk)).problem.code == "license_invalid"  # type: ignore[union-attr]
    assert polaris.authenticate(_headers(sign_license("dev_1"))).problem is None


def test_trust_refresh_false_never_fetches() -> None:
    calls: List[str] = []
    polaris = PolarisKey(config=CFG, trust_refresh=False, http_client=_manifest_client(calls), clock=lambda: NOW)
    rotated = sign_license("dev_1", pem=ROTATED_PEM, kid="rotated-2027")
    assert polaris.authenticate(_headers(rotated)).problem.code == "license_invalid"  # type: ignore[union-attr]
    assert calls == []


def test_async_authenticate_fetches_off_the_loop() -> None:
    calls: List[str] = []
    polaris = _quiet(PolarisKey(config=CFG, http_client=_manifest_client(calls), clock=lambda: NOW))
    rotated = sign_license("dev_1", pem=ROTATED_PEM, kid="rotated-2027")
    auth = asyncio.run(polaris.aauthenticate(_headers(rotated)))
    assert auth.problem is None and len(calls) == 1


def test_cached_verdict_still_rechecks_freshness() -> None:
    now = [NOW]
    polaris = PolarisKey(config=CFG, trust_refresh=False, clock=lambda: now[0])
    h = _headers(sign_license("dev_1"))
    assert polaris.authenticate(h).problem is None
    assert polaris.authenticate(h).problem is None  # from the cache
    now[0] = NOW + 3600 + 301
    assert polaris.authenticate(h).problem.code == "license_stale"  # type: ignore[union-attr]


def test_max_age_seconds_tightens_freshness() -> None:
    polaris = PolarisKey(config=CFG, trust_refresh=False, max_age_seconds=600, clock=lambda: NOW + 901)
    assert polaris.authenticate(_headers(sign_license("dev_1"))).problem.code == "license_stale"  # type: ignore[union-attr]


def test_valued_entitlement_test() -> None:
    from polaris_key.server import entitlement

    doc = license_payload("dev_1")
    doc["entitlements"]["seats"] = {"state": "enforced", "value": 7, "updatedAt": 0}
    h = _headers(sign_jws(doc, PRIVATE_PEM, KID, TYP_LICENSE))
    polaris = PolarisKey(config=CFG, trust_refresh=False, clock=lambda: NOW)
    assert polaris.authenticate(h, require=[entitlement("seats", lambda v: v >= 5)]).problem is None
    p = polaris.authenticate(h, require=[entitlement("seats", lambda v: v >= 9)]).problem
    assert p is not None and p.code == "not_entitled"


def test_no_token_or_holder_in_repr_logs_or_errors(caplog: pytest.LogCaptureFixture) -> None:
    jws = sign_license("dev_1")
    polaris = PolarisKey(config=CFG, trust_refresh=False, clock=lambda: NOW)
    with caplog.at_level(logging.DEBUG, logger="polaris_key.server"):
        ok = polaris.authenticate(_headers(jws))
        bad = polaris.authenticate(_headers(jws[:-4] + "AAAA"))
    assert ok.license is not None and ok.license.holder is not None
    texts = [repr(ok), str(ok), repr(ok.license), repr(ok.license.holder), str(ok.license.holder), repr(bad), repr(polaris)]
    assert bad.problem is not None
    texts += [str(PolarisKeyError(bad.problem)), repr(PolarisKeyError(bad.problem)), caplog.text]
    for t in texts:
        for secret in (jws, jws[:20], "grace@example.com", "Grace Hopper", "dev_1"):
            assert secret not in t


def test_a_config_without_the_license_service_fails_at_start() -> None:
    with pytest.raises(ValueError):
        PolarisKey(config={**CFG, "expected_services": ["config"]})
    with pytest.raises(TypeError):
        PolarisKey(config={"product_slug": "x"})
    with pytest.raises(TypeError):
        PolarisKey()


def test_config_module_forms() -> None:
    import types

    mod = types.SimpleNamespace(CONFIG=CFG)
    assert PolarisKey(config=mod, trust_refresh=False).products == ("djdl",)
    mod2 = types.SimpleNamespace(PRODUCT_SLUG="djdl", BASE_URL="https://k.example", PINNED_KEYS={KID: PUBKEY_RAW}, EXPECTED_SERVICES=["license"])
    assert PolarisKey(config=mod2, trust_refresh=False).products == ("djdl",)


def test_on_verdict_reports_code_and_step_only() -> None:
    seen: List[Any] = []
    polaris = PolarisKey(config=CFG, trust_refresh=False, clock=lambda: NOW, on_verdict=lambda c, s: seen.append((c, s)))
    polaris.authenticate([])
    polaris.authenticate(_headers(sign_license("dev_1")))
    assert seen == [("license_required", 1), (None, 0)]


@pytest.mark.parametrize("locale", LOCALES)
def test_copy_tables_equal_the_registry(locale: str) -> None:
    codes = json.loads((REPO / "conformance" / "parity" / f"copy.{locale}.json").read_text("utf-8"))["codes"]
    assert set(COPY[locale]) == {"license_required", "license_invalid", "license_stale", "not_entitled", "sign_in_required"}
    for code, (title, message) in COPY[locale].items():
        assert (title, message) == (codes[code]["title"], codes[code]["message"])


def test_importing_the_core_loads_no_framework() -> None:
    code = textwrap.dedent(
        """
        import sys
        import polaris_key.server
        bad = [m for m in ("fastapi", "starlette", "flask", "django", "rest_framework") if m in sys.modules]
        print(bad)
        """
    )
    out = subprocess.run([sys.executable, "-c", code], check=True, capture_output=True, text=True).stdout.strip()
    assert out == "[]"


def test_the_verdict_function_is_pure() -> None:
    v = backend_verdict(_headers(sign_license("dev_1")), NOW, ["djdl"], {"djdl": {KID: PUBKEY_RAW}})
    assert v.status == 200 and v.step == 0
