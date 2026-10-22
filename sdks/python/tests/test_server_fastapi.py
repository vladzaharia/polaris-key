# @pkey-feature server.license server.signin
"""A gated FastAPI route answers each §14.2 verdict; rows come from backend-matrix.json."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

pytest.importorskip("fastapi")
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from polaris_key.server import PolarisAuth  # noqa: E402
from polaris_key.server.fastapi import PolarisKey  # noqa: E402
from polaris_key.server import PolarisKeyError  # noqa: E402

_M: Dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "backend-matrix.json").read_text("utf-8")
)
_ROWS: List[Dict[str, Any]] = [
    r
    for r in _M["verdict"]
    if len(r["input"]["options"]["products"]) == 1
    and r["input"]["options"].get("maxAgeSeconds") is None
    and all(
        h[0].lower() in ("x-pkey-license", "x-pkey-device") and "," not in h[1] for h in r["input"]["headers"]
    )
    and len(r["input"]["options"].get("require", [])) <= 1
]


# The core refuses an empty pin set (nothing could verify); a row with no keys gets one pin that signed
# nothing, which is the same verdict.
_NO_SIGNER = {"unused-pin": "A" * 43}

def _app(row: Dict[str, Any], **kw: Any) -> TestClient:
    o = row["input"]["options"]
    slug = o["products"][0]
    cfg = {"product_slug": slug, "base_url": "https://key.plrs.im", "trust": row["input"]["trust"][slug] or _NO_SIGNER}
    polaris = PolarisKey(config=cfg, trust_refresh=False, clock=lambda: row["input"]["now"], **kw)
    app = FastAPI()
    polaris.install(app)
    req = o.get("require", [])
    dep = (
        polaris.require_license()
        if not req
        else polaris.require_sign_in()
        if req[0]["kind"] == "signIn"
        else polaris.require_entitlement(req[0]["name"])
    )

    @app.get("/x")
    def x(auth: PolarisAuth = Depends(dep)) -> Dict[str, Any]:
        return {"tier": auth.license.tier}  # type: ignore[union-attr]

    return TestClient(app)


@pytest.mark.parametrize("row", _ROWS, ids=[r["id"] for r in _ROWS])
def test_route_answers_the_verdict(row: Dict[str, Any]) -> None:
    client = _app(row)
    res = client.get("/x", headers=[(k, v) for k, v in row["input"]["headers"]])
    assert res.status_code == row["expect"]["status"]
    if row["expect"]["code"] is None:
        assert res.json() == {"tier": row["expect"]["context"]["license"]["tier"]}
    else:
        assert res.headers["content-type"] == "application/problem+json"
        assert res.headers["cache-control"] == "no-store"
        assert res.json()["code"] == row["expect"]["code"]
        assert ("www-authenticate" in res.headers) == (row["expect"]["status"] == 401)


def test_openapi_declares_the_header_scheme() -> None:
    row = _ROWS[0]
    schema = _app(row).app.openapi()  # type: ignore[attr-defined]
    schemes = schema["components"]["securitySchemes"]
    assert any(s.get("name") == "X-PKey-License" for s in schemes.values())


def test_errors_raise_goes_to_the_apps_handler() -> None:
    row = next(r for r in _ROWS if r["expect"]["code"] == "license_stale")
    client = _app(row, errors="raise")
    seen: List[str] = []

    async def handler(request: Any, exc: Exception) -> Any:
        from fastapi.responses import JSONResponse

        assert isinstance(exc, PolarisKeyError)
        seen.append(exc.code)
        return JSONResponse({"error": exc.code}, status_code=exc.status)

    client.app.add_exception_handler(PolarisKeyError, handler)  # type: ignore[attr-defined]
    res = client.get("/x", headers=[(k, v) for k, v in row["input"]["headers"]])
    assert res.json() == {"error": "license_stale"} and seen == ["license_stale"]


def test_on_refusal_shapes_the_response() -> None:
    from fastapi.responses import JSONResponse

    row = next(r for r in _ROWS if r["expect"]["code"] == "license_required")
    client = _app(row, on_refusal=lambda p, req: JSONResponse({"e": p.code}, status_code=p.status))
    assert client.get("/x").json() == {"e": "license_required"}
