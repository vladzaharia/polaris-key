# @pkey-feature server.license server.signin
"""A gated Flask, Django and DRF route answers each §14.2 verdict (backend-matrix.json rows)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

_M: Dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "backend-matrix.json").read_text("utf-8")
)


# The core refuses an empty pin set (nothing could verify); a row with no keys gets one pin that signed
# nothing, which is the same verdict.
_NO_SIGNER = {"unused-pin": "A" * 43}

def _usable(r: Dict[str, Any]) -> bool:
    o = r["input"]["options"]
    return (
        len(o["products"]) == 1
        and o.get("maxAgeSeconds") is None
        and all(h[0].lower() in ("x-pkey-license", "x-pkey-device") and "," not in h[1] for h in r["input"]["headers"])
        and len(o.get("require", [])) <= 1
    )


ROWS: List[Dict[str, Any]] = [r for r in _M["verdict"] if _usable(r)]
IDS = [r["id"] for r in ROWS]


def _cfg(row: Dict[str, Any]) -> Dict[str, Any]:
    slug = row["input"]["options"]["products"][0]
    return {"product_slug": slug, "base_url": "https://key.plrs.im", "trust": row["input"]["trust"][slug] or _NO_SIGNER}


def _req(row: Dict[str, Any]) -> Any:
    reqs = row["input"]["options"].get("require", [])
    return reqs[0] if reqs else None


def _flask_deco(polaris: Any, r: Any) -> Any:
    if r is None:
        return polaris.require_license()
    return polaris.require_sign_in() if r["kind"] == "signIn" else polaris.require_entitlement(r["name"])


def _dup_names(row: Dict[str, Any]) -> bool:
    names = [h[0].lower() for h in row["input"]["headers"]]
    return len(names) != len(set(names))


def _check(status: int, ctype: str, www: Any, body: Any, row: Dict[str, Any], tier: Any = None) -> None:
    e = row["expect"]
    assert status == e["status"]
    if e["code"] is None:
        assert body == {"tier": e["context"]["license"]["tier"]}
    else:
        assert ctype.split(";")[0] == "application/problem+json"
        assert body["code"] == e["code"]
        assert (www is not None) == (e["status"] == 401)


# -- Flask ------------------------------------------------------------------------------


@pytest.mark.parametrize("row", ROWS, ids=IDS)
def test_flask_route(row: Dict[str, Any]) -> None:
    pytest.importorskip("flask")
    from flask import Flask, g

    from polaris_key.server.flask import PolarisKey

    polaris = PolarisKey(config=_cfg(row), trust_refresh=False, clock=lambda: row["input"]["now"])
    app = Flask(__name__)
    polaris.init_app(app)
    r = _req(row)
    deco = _flask_deco(polaris, r)

    @app.get("/x")
    @deco
    def x() -> Any:
        return {"tier": g.polaris.license.tier}

    res = app.test_client().get("/x", headers=[(k, v) for k, v in row["input"]["headers"]])
    _check(res.status_code, res.headers.get("Content-Type", ""), res.headers.get("WWW-Authenticate"), res.get_json(), row)


def test_flask_on_refusal_and_raise() -> None:
    pytest.importorskip("flask")
    from flask import Flask

    from polaris_key.server import PolarisKeyError
    from polaris_key.server.flask import PolarisKey

    cfg = _cfg(ROWS[0])
    shaped = PolarisKey(config=cfg, trust_refresh=False, on_refusal=lambda p: ({"error": p.code}, p.status))
    app = Flask(__name__)
    shaped.init_app(app)
    app.get("/x")(shaped.require_license()(lambda: "ok"))
    assert app.test_client().get("/x").get_json() == {"error": "license_required"}

    raising = PolarisKey(config=cfg, trust_refresh=False, errors="raise")
    app2 = Flask(__name__)
    raising.init_app(app2)
    app2.errorhandler(PolarisKeyError)(lambda e: ({"e": e.code}, e.status))
    app2.get("/x")(raising.require_license()(lambda: "ok"))
    assert app2.test_client().get("/x").get_json() == {"e": "license_required"}


# -- Django and DRF -----------------------------------------------------------------------


def _django(row: Dict[str, Any], **extra: Any) -> Any:
    pytest.importorskip("django")
    from django.conf import settings

    if not settings.configured:
        settings.configure(
            SECRET_KEY="x",
            DEBUG=True,
            ALLOWED_HOSTS=["*"],
            ROOT_URLCONF=__name__,
            INSTALLED_APPS=["django.contrib.contenttypes", "django.contrib.auth", "rest_framework"],
            USE_TZ=True,
        )
        import django

        django.setup()
    from django.test import override_settings

    return override_settings(
        POLARIS_KEY={"CONFIG": _cfg(row), "TRUST_REFRESH": False, **extra},
    )


def _now(row: Dict[str, Any]) -> Any:
    import time
    from unittest import mock

    return mock.patch.object(time, "time", lambda: row["input"]["now"])


DJ_ROWS = [r for r in ROWS if not _dup_names(r)]
DJ_IDS = [r["id"] for r in DJ_ROWS]


@pytest.mark.parametrize("row", DJ_ROWS, ids=DJ_IDS)
def test_django_view(row: Dict[str, Any]) -> None:
    from django.http import JsonResponse
    from django.test import RequestFactory

    with _django(row), _now(row):
        from polaris_key.server import django as dj
        from polaris_key.server.django import PolarisKeyMiddleware

        r = _req(row)
        deco = dj.require_license() if r is None else dj.require_sign_in() if r["kind"] == "signIn" else dj.require_entitlement(r["name"])

        @deco
        def view(request: Any) -> Any:
            return JsonResponse({"tier": request.polaris.license.tier})

        mw = PolarisKeyMiddleware(view)
        req = RequestFactory().get("/x", **{"headers": {k: v for k, v in row["input"]["headers"]}})
        res = mw(req)
        body = json.loads(res.content)
        _check(res.status_code, res["Content-Type"], res.get("WWW-Authenticate"), body, row)


@pytest.mark.parametrize("row", DJ_ROWS, ids=DJ_IDS)
def test_drf_view(row: Dict[str, Any]) -> None:
    from rest_framework.response import Response
    from rest_framework.test import APIRequestFactory
    from rest_framework.views import APIView

    with _django(row), _now(row):
        from polaris_key.server import drf
        from polaris_key.server.drf import PolarisKeyAuthentication, exception_handler

        r = _req(row)
        perm = drf.has_license() if r is None else drf.has_sign_in() if r["kind"] == "signIn" else drf.has_entitlement(r["name"])

        class V(APIView):
            authentication_classes = [PolarisKeyAuthentication]
            permission_classes = [perm]

            def get_exception_handler(self) -> Any:
                return exception_handler

            def get(self, request: Any) -> Any:
                return Response({"tier": request.auth.license.tier})

        req = APIRequestFactory().get("/x", **{"headers": {k: v for k, v in row["input"]["headers"]}})
        res = V.as_view()(req)
        res.render()
        body = json.loads(res.content)
        _check(res.status_code, res["Content-Type"], res.get("WWW-Authenticate"), body, row)


def test_drf_default_handler_without_ours() -> None:
    """Without our handler DRF still answers 401 (authenticate_header) and 403."""
    from rest_framework.response import Response
    from rest_framework.test import APIRequestFactory
    from rest_framework.views import APIView

    row = ROWS[0]
    with _django(row), _now(row):
        from polaris_key.server.drf import PolarisKeyAuthentication

        class V(APIView):
            authentication_classes = [PolarisKeyAuthentication]

            def get(self, request: Any) -> Any:
                return Response({})

        res = V.as_view()(APIRequestFactory().get("/x"))
        assert res.status_code == 401 and res["WWW-Authenticate"].startswith("PKey-License realm=")


def test_django_on_refusal_setting() -> None:
    from django.http import JsonResponse
    from django.test import RequestFactory

    row = ROWS[0]
    with _django(row, ON_REFUSAL=f"{__name__}.refused"):
        from polaris_key.server.django import require_license

        res = require_license()(lambda r: JsonResponse({}))(RequestFactory().get("/x"))
        assert json.loads(res.content) == {"error": "license_required"}


def refused(problem: Any, request: Any) -> Any:
    from django.http import JsonResponse

    return JsonResponse({"error": problem.code}, status=problem.status)


urlpatterns: List[Any] = []
