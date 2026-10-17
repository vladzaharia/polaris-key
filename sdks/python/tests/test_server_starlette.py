# @pkey-feature server.license
"""Plain Starlette: the middleware attaches the licence; the decorators gate an endpoint."""

from __future__ import annotations

from typing import Any

import pytest

pytest.importorskip("starlette")
from starlette.applications import Starlette  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402
from starlette.routing import Route  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

from polaris_key.server import PolarisKeyError  # noqa: E402
from polaris_key.server.starlette import PolarisKey, PolarisKeyMiddleware  # noqa: E402
from helpers import KID, NOW, PUBKEY_RAW, license_payload, sign_license  # noqa: E402

CFG = {"product_slug": "djdl", "base_url": "https://key.example", "trust": {KID: PUBKEY_RAW}}


def _client(**kw: Any) -> TestClient:
    polaris = PolarisKey(config=CFG, trust_refresh=False, clock=lambda: NOW, **kw)

    @polaris.require_entitlement("polarisVpn")
    async def vpn(request: Any) -> Any:
        return JSONResponse({"tier": request.state.polaris.license.tier})

    @polaris.require_sign_in()
    def signed(request: Any) -> Any:
        return JSONResponse({})

    app = Starlette(routes=[Route("/vpn", vpn), Route("/signed", signed)])
    app.add_middleware(PolarisKeyMiddleware, polaris=polaris)
    polaris.install(app)
    return TestClient(app)


def test_gated_endpoint() -> None:
    c = _client()
    assert c.get("/vpn", headers={"X-PKey-License": sign_license("dev_1")}).json() == {"tier": "pro"}
    r = c.get("/vpn")
    assert r.status_code == 401 and r.json()["code"] == "license_required"
    assert r.headers["www-authenticate"] == 'PKey-License realm="djdl", error="license_required"'
    r = c.get("/signed", headers={"X-PKey-License": sign_license("dev_1")})
    assert r.status_code == 403 and r.json()["code"] == "sign_in_required"


def test_localised_refusal() -> None:
    r = _client().get("/vpn", headers={"Accept-Language": "de"})
    assert r.json()["title"] == "Lizenz erforderlich"


def test_errors_raise_reaches_the_apps_handler_and_defaults_to_an_http_error() -> None:
    polaris = PolarisKey(config=CFG, trust_refresh=False, clock=lambda: NOW, errors="raise")

    @polaris.require_license()
    def home(request: Any) -> Any:
        return JSONResponse({})

    app = Starlette(routes=[Route("/", home)])
    app.add_middleware(PolarisKeyMiddleware, polaris=polaris)
    # No handler of ours: Starlette still answers the status and the challenge.
    r = TestClient(app).get("/")
    assert r.status_code == 401 and r.headers["www-authenticate"].startswith("PKey-License")

    app2 = Starlette(routes=[Route("/", home)])
    app2.add_middleware(PolarisKeyMiddleware, polaris=polaris)
    app2.add_exception_handler(PolarisKeyError, lambda req, exc: JSONResponse({"e": exc.code}, status_code=exc.status))
    assert TestClient(app2).get("/").json() == {"e": "license_required"}
