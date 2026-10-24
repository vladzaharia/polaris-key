# @pkey-feature server.license server.signin
"""The developer's side of ``polaris_key.server``: start-up errors, tier and ``require_all``
gates, the typed license accessor, CORS preflight, ``Cache-Control: private``, refusals in the
app's own shape, trust-fetch diagnostics and the testing kit. Verdict rows replay in
test_server_matrix.py."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

import httpx
import pytest

from polaris_key.server import (
    PolarisAuth,
    PolarisKey,
    PolarisKeySetupError,
    backend_problem,
    entitlement,
    get_polaris_license,
    is_cors_preflight,
    sign_in,
    signin,
    tier,
)
from polaris_key.server.testing import create_test_kit

PIN = "A" * 43
PREFLIGHT = {"Origin": "https://app.example", "Access-Control-Request-Method": "GET"}


def kit() -> Any:
    return create_test_kit("acme")


# -- start-up errors ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "build, needle",
    [
        (lambda: PolarisKey(), "pkey sdk --lang python --write"),
        (lambda: PolarisKey(products=[]), "pkey sdk --lang python --write"),
        (lambda: PolarisKey(config="polaris_config"), "import the module"),
        (lambda: PolarisKey(config={"base_url": "https://key.plrs.im", "pinned_keys": {"k": PIN}}), "product_slug"),
        (lambda: PolarisKey(config={"product_slug": "acme"}), "pkey sdk --lang python --write"),
        (lambda: PolarisKey(config={"product_slug": "acme", "pinned_keys": {}}), "empty"),
        (lambda: PolarisKey(config={"product_slug": "acme", "pinned_keys": {"k": "short"}}), "43 base64url"),
        (lambda: PolarisKey(config={"product_slug": "acme", "pinned_keys": {"k": PIN}, "base_url": "key.plrs.im"}), "an http"),
        (lambda: PolarisKey(config={"product_slug": "acme", "pinned_keys": {"k": PIN}}, preflight="skip"), "preflight"),
    ],
)
def test_bad_config_fails_at_start_with_the_fix(build: Any, needle: str) -> None:
    with pytest.raises(PolarisKeySetupError, match=needle):
        build()


def test_a_setup_error_is_still_a_type_and_value_error() -> None:
    with pytest.raises(TypeError):
        PolarisKey()
    with pytest.raises(ValueError):
        PolarisKey(config={"product_slug": "acme", "pinned_keys": {"k": PIN}}, errors="nope")


def test_base_url_is_optional_and_the_same_product_twice_is_refused() -> None:
    polaris = PolarisKey(config={"product_slug": "acme", "pinned_keys": {"k": PIN}}, trust_refresh=False)
    assert polaris._trust["acme"].base_url == "https://key.plrs.im"
    cfg = {"product_slug": "acme", "pinned_keys": {"k": PIN}}
    with pytest.raises(PolarisKeySetupError, match="configured twice"):
        PolarisKey(products=[cfg, cfg])


# -- requirements -------------------------------------------------------------------------


def test_requirement_builders_check_their_arguments() -> None:
    with pytest.raises(TypeError, match="tier"):
        tier()
    with pytest.raises(TypeError, match="entitlement"):
        entitlement("")
    assert sign_in() == signin()
    pytest.importorskip("starlette")
    from polaris_key.server.starlette import PolarisKey as S

    with pytest.raises(TypeError, match="not a requirement"):
        S(**kit().options()).require_all("pro")  # type: ignore[arg-type]


def test_tier_and_all_through_the_core() -> None:
    k = kit()
    polaris = PolarisKey(**k.options())
    pro = k.signed_headers(tier="pro")
    assert polaris.authenticate(pro, require=[tier("pro", "team")]).problem is None
    assert polaris.authenticate(pro, require=[tier("team")]).problem.code == "not_entitled"  # type: ignore[union-attr]
    assert polaris.authenticate(k.signed_headers(), require=[tier("pro")]).problem.code == "not_entitled"  # type: ignore[union-attr]
    both = [signin(), tier("pro"), entitlement("seats", lambda n: n >= 5)]
    assert polaris.authenticate(k.signed_headers(tier="pro", entitlements={"seats": 5}), require=both).problem is None
    first = polaris.authenticate(k.signed_headers(user=None, tier="pro"), require=both)
    assert first.problem.code == "sign_in_required"  # type: ignore[union-attr]  # the first failure wins


def test_get_polaris_license_explains_an_ungated_route() -> None:
    with pytest.raises(PolarisKeySetupError, match="no Polaris Key gate"):
        get_polaris_license(None)
    k = kit()
    refused = PolarisKey(**k.options()).authenticate({})
    with pytest.raises(PolarisKeySetupError, match="license_required"):
        get_polaris_license(refused)
    with pytest.raises(PolarisKeySetupError, match="CORS preflight"):
        get_polaris_license(PolarisAuth(None, None, None, preflight=True))


def test_is_cors_preflight() -> None:
    assert is_cors_preflight("OPTIONS", PREFLIGHT)
    assert is_cors_preflight("options", [("access-control-request-method", "PUT")])
    assert not is_cors_preflight("OPTIONS", {"Origin": "https://app.example"})
    assert not is_cors_preflight("GET", PREFLIGHT)


# -- refusals in the app's own shape ------------------------------------------------------


def test_problem_with_status_keeps_the_localised_copy() -> None:
    p = backend_problem("not_entitled", "acme", "de")
    q = p.with_status(402)
    assert (q.status, q.body["status"], q.title, q.detail, q.locale) == (402, 402, p.title, p.detail, "de")
    assert q.body["code"] == "not_entitled" and q.code == "not_entitled"
    r = backend_problem("license_required", "acme").with_status(402)
    assert "WWW-Authenticate" not in r.headers and r.challenge is None


def test_on_refusal_may_take_the_problem_alone() -> None:
    k = kit()
    seen: Dict[str, Any] = {}
    one = PolarisKey(**k.options(on_refusal=lambda p: seen.setdefault("one", p.code)))
    two = PolarisKey(**k.options(on_refusal=lambda p, ctx: seen.setdefault("two", (p.code, ctx))))
    assert one.on_refusal is not None and two.on_refusal is not None
    problem = backend_problem("license_required", "acme")
    one.on_refusal(problem, "request")
    two.on_refusal(problem, "request")
    assert seen == {"one": "license_required", "two": ("license_required", "request")}


# -- trust diagnostics --------------------------------------------------------------------


def _unknown_kid_polaris(kit_: Any) -> Any:
    polaris = PolarisKey(**kit_.options(**kit_.trust.options()))
    for t in polaris._trust.values():
        t.last_attempt = int(kit_.clock.now())  # the start-up refresh is done: only an unknown kid fetches
    return polaris


def test_an_unreachable_trust_fetch_logs_why_and_keeps_the_pins(caplog: Any) -> None:
    k = kit()
    polaris = _unknown_kid_polaris(k)
    rotated = k.trust.add_key("rotated-2027")
    k.trust.offline = True
    with caplog.at_level(logging.DEBUG, logger="polaris_key.server"):
        assert polaris.authenticate(k.headers(rotated.sign())).problem.code == "license_invalid"  # type: ignore[union-attr]
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "ConnectError" in text and "keeping the last verified keys and the pins" in text
    assert polaris.authenticate(k.signed_headers()).problem is None
    assert k.trust.calls


def test_a_non_2xx_trust_fetch_says_to_check_the_slug(caplog: Any) -> None:
    k = kit()
    stranger = create_test_kit("acme", kid="unpinned-kid")  # signs with a key the pins do not hold
    not_found = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(404)))
    polaris = PolarisKey(**k.options(trust_refresh=True, http_client=not_found))
    for t in polaris._trust.values():
        t.last_attempt = int(k.clock.now())
    with caplog.at_level(logging.DEBUG, logger="polaris_key.server"):
        polaris.authenticate(k.headers(stranger.sign()))
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "answered 404" in text and "check base_url and the product slug" in text


def test_the_fake_trust_publishes_a_second_key() -> None:
    k = kit()
    polaris = _unknown_kid_polaris(k)
    rotated = k.trust.add_key("rotated-2027")
    headers = k.headers(rotated.sign(entitlements={"x": True}))
    assert polaris.authenticate(headers).problem is None
    assert k.trust.calls == ["https://key.plrs.im/acme/.well-known/polaris-trust.jws"]


# -- the testing kit ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "verdict, code",
    [
        ("license_required", "license_required"),
        ("license_invalid", "license_invalid"),
        ("license_stale", "license_stale"),
        ("not_entitled", "not_entitled"),
        ("sign_in_required", "sign_in_required"),
    ],
)
def test_headers_for_each_verdict(verdict: str, code: str) -> None:
    k = kit()
    polaris = PolarisKey(**k.options())
    require = [entitlement("export.pdf")] if verdict == "not_entitled" else [signin()] if verdict == "sign_in_required" else []
    auth = polaris.authenticate(k.headers_for(verdict), require=require)  # type: ignore[arg-type]
    assert auth.problem is not None and auth.problem.code == code


def test_headers_for_ok_and_the_clock() -> None:
    k = kit()
    polaris = PolarisKey(**k.options())
    h = k.headers_for("ok", entitlements={"export.pdf": True})
    assert polaris.authenticate(h, require=[entitlement("export.pdf")]).problem is None
    k.clock.advance(2 * 3600)
    assert polaris.authenticate(h).problem.code == "license_stale"  # type: ignore[union-attr]
    with pytest.raises(ValueError, match="not a verdict"):
        k.headers_for("nope")  # type: ignore[arg-type]


# -- Starlette and FastAPI ----------------------------------------------------------------


def test_starlette_gates_tier_all_preflight_and_cache_control() -> None:
    pytest.importorskip("starlette")
    from starlette.applications import Starlette
    from starlette.middleware.cors import CORSMiddleware
    from starlette.responses import JSONResponse, PlainTextResponse, StreamingResponse
    from starlette.routing import Route
    from starlette.testclient import TestClient

    from polaris_key.server.starlette import PolarisKey as SPolaris, get_polaris_license as lic

    k = kit()
    polaris = SPolaris(**k.options())

    @polaris.require_tier("pro", "team")
    async def pro(request: Any) -> Any:
        return JSONResponse({"tier": lic(request).tier})

    @polaris.require_all(signin(), tier("pro"))
    async def both(request: Any) -> Any:
        return PlainTextResponse("both")

    @polaris.require_license()
    async def streamed(request: Any) -> Any:
        return StreamingResponse(iter([b"a", b"b"]))

    @polaris.require_license()
    async def own_cache(request: Any) -> Any:
        return PlainTextResponse("x", headers={"Cache-Control": "max-age=5"})

    async def open_route(request: Any) -> Any:
        return JSONResponse({"has": request.scope.get("state", {}).get("polaris_gated", False)})

    async def forgot_gate(request: Any) -> Any:
        return JSONResponse({"tier": lic(request).tier})

    app = Starlette(
        routes=[
            Route("/pro", pro),
            Route("/both", both),
            Route("/stream", streamed),
            Route("/cache", own_cache),
            Route("/open", open_route),
            Route("/forgot", forgot_gate),
        ]
    )
    polaris.install(app)
    c = TestClient(app, raise_server_exceptions=False)
    assert c.get("/pro", headers=k.signed_headers(tier="pro")).json() == {"tier": "pro"}
    assert c.get("/pro", headers=k.signed_headers(tier="free")).status_code == 403
    assert c.get("/both", headers=k.signed_headers(tier="pro")).text == "both"
    assert c.get("/both", headers=k.signed_headers(tier="pro", user=None)).json()["code"] == "sign_in_required"
    assert c.get("/stream", headers=k.signed_headers()).headers["cache-control"] == "private"
    assert c.get("/cache", headers=k.signed_headers()).headers["cache-control"] == "max-age=5"
    assert c.get("/pro").headers["cache-control"] == "no-store"
    assert "cache-control" not in c.get("/open", headers=k.signed_headers()).headers
    assert c.get("/forgot", headers=k.signed_headers()).status_code == 500


def test_starlette_decorator_sets_private_without_install() -> None:
    pytest.importorskip("starlette")
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route
    from starlette.testclient import TestClient

    from polaris_key.server.starlette import PolarisKey as SPolaris

    k = kit()
    polaris = SPolaris(**k.options())

    @polaris.require_license()
    async def ok(request: Any) -> Any:
        return PlainTextResponse("ok")

    c = TestClient(Starlette(routes=[Route("/", ok)]))
    assert c.get("/", headers=k.signed_headers()).headers["cache-control"] == "private"


def test_fastapi_preflight_tier_all_and_refusal_shape() -> None:
    pytest.importorskip("fastapi")
    from fastapi import Depends, FastAPI
    from fastapi.responses import JSONResponse, StreamingResponse
    from fastapi.testclient import TestClient

    from polaris_key.server.fastapi import PolarisKey as FPolaris, get_polaris_license as lic, problem_response

    k = kit()
    polaris = FPolaris(
        **k.options(on_refusal=lambda p, req: problem_response(p.with_status(402 if p.code == "not_entitled" else p.status)))
    )
    app = FastAPI()
    polaris.install(app)

    @app.api_route("/pro", methods=["GET", "OPTIONS"])
    def pro(auth: PolarisAuth = Depends(polaris.require_tier("pro"))) -> Dict[str, Any]:
        return {"tier": lic(auth).tier} if auth.license else {"preflight": auth.preflight}

    @app.get("/all")
    def both(auth: PolarisAuth = Depends(polaris.require_all(signin(), tier("pro")))) -> Dict[str, Any]:
        return {"tier": get_polaris_license(auth).tier}

    @app.get("/raw")
    def raw(auth: PolarisAuth = Depends(polaris.require_license())) -> Any:
        return JSONResponse({"ok": True})

    @app.get("/stream")
    def stream(auth: PolarisAuth = Depends(polaris.require_license())) -> Any:
        return StreamingResponse(iter([b"a"]))

    c = TestClient(app)
    assert c.get("/pro", headers=k.signed_headers(tier="pro")).json() == {"tier": "pro"}
    assert c.get("/pro", headers=k.signed_headers(tier="pro")).headers["cache-control"] == "private"
    refused = c.get("/pro", headers=k.signed_headers(tier="free"))
    assert (refused.status_code, refused.json()["code"], refused.json()["status"]) == (402, "not_entitled", 402)
    assert c.get("/pro").status_code == 401
    # A preflight carries no license: the gate lets it through.
    assert c.options("/pro", headers=PREFLIGHT).json() == {"preflight": True}
    assert c.get("/all", headers=k.signed_headers(tier="pro")).json() == {"tier": "pro"}
    assert c.get("/raw", headers=k.signed_headers()).headers["cache-control"] == "private"
    assert c.get("/stream", headers=k.signed_headers()).headers["cache-control"] == "private"

    strict = FPolaris(**k.options(preflight="gate"))
    app2 = FastAPI()

    @app2.api_route("/pro", methods=["GET", "OPTIONS"])
    def pro2(auth: PolarisAuth = Depends(strict.require_license())) -> Dict[str, Any]:
        return {}

    assert TestClient(app2).options("/pro", headers=PREFLIGHT).status_code == 401


# -- Flask --------------------------------------------------------------------------------


def test_flask_tier_all_accessor_private_preflight_and_decorator_order() -> None:
    pytest.importorskip("flask")
    from flask import Flask

    from polaris_key.server.flask import PolarisKey as FlPolaris, get_polaris_license as lic, problem_response

    k = kit()
    polaris = FlPolaris(
        **k.options(on_refusal=lambda p, req: problem_response(p.with_status(402 if p.code == "not_entitled" else p.status)))
    )
    app = Flask(__name__)
    polaris.init_app(app)

    @app.get("/pro")
    @polaris.require_tier("pro")
    def pro() -> Any:
        return {"tier": lic().tier}

    @app.route("/both", methods=["GET", "OPTIONS"])
    @polaris.require_all(signin(), tier("pro"))
    def both() -> Any:
        return "both"

    @app.get("/forgot")
    def forgot() -> Any:
        return {"tier": lic().tier}

    c = app.test_client()
    ok = c.get("/pro", headers=k.signed_headers(tier="pro"))
    assert ok.get_json() == {"tier": "pro"} and ok.headers["Cache-Control"] == "private"
    assert c.get("/pro", headers=k.signed_headers(tier="free")).status_code == 402
    assert c.get("/both", headers=k.signed_headers(user=None, tier="pro")).get_json()["code"] == "sign_in_required"
    assert c.options("/both", headers=PREFLIGHT).status_code == 200
    app.testing = False
    assert c.get("/forgot", headers=k.signed_headers()).status_code == 500

    fresh = Flask(__name__)
    polaris.init_app(fresh)
    with pytest.raises(PolarisKeySetupError, match="below @app.get"):

        @polaris.require_license()
        @fresh.get("/wrong")
        def wrong() -> Any:
            return "ungated"


def test_flask_on_refusal_gets_the_request_when_it_asks() -> None:
    pytest.importorskip("flask")
    from flask import Flask

    from polaris_key.server.flask import PolarisKey as FlPolaris

    k = kit()
    polaris = FlPolaris(**k.options(on_refusal=lambda p, req: ({"path": req.path, "code": p.code}, 401)))
    app = Flask(__name__)
    polaris.init_app(app)
    app.get("/x")(polaris.require_license()(lambda: "ok"))
    assert app.test_client().get("/x").get_json() == {"path": "/x", "code": "license_required"}


# -- Django and DRF -----------------------------------------------------------------------


def _django(**extra: Any) -> Any:
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

    return override_settings(POLARIS_KEY=extra)


def test_django_settings_errors_name_the_fix() -> None:
    from polaris_key.server import django as dj

    k = kit()
    with _django():
        with pytest.raises(PolarisKeySetupError, match="needs CONFIG"):
            dj.get_polaris()
    with _django(CONFIG=k.config, MAX_AGE="5"):
        with pytest.raises(PolarisKeySetupError, match="unknown keys"):
            dj.get_polaris()
    with _django(CONFIG="no_such_module.polaris_config"):
        with pytest.raises(PolarisKeySetupError, match="cannot import"):
            dj.get_polaris()
    with _django(CONFIG=k.config, PREFLIGHT="skip"):
        with pytest.raises(PolarisKeySetupError, match="preflight"):
            dj.get_polaris()


def test_django_gates_tier_all_accessor_private_and_preflight() -> None:
    from django.http import JsonResponse
    from django.test import RequestFactory
    from django.utils.decorators import method_decorator
    from django.views import View

    k = kit()
    with _django(CONFIG=k.config, TRUST_REFRESH=False):
        from polaris_key.server import django as dj

        @dj.require_tier("pro")
        def pro(request: Any) -> Any:
            return JsonResponse({"tier": dj.get_polaris_license(request).tier})

        @dj.require_all(signin(), tier("pro"))
        def both(request: Any) -> Any:
            return JsonResponse({})

        class Cbv(View):
            @method_decorator(dj.require_license())
            def get(self, request: Any) -> Any:
                return JsonResponse({"tier": dj.get_polaris_license(request).tier})

        @dj.require_license()
        async def aview(request: Any) -> Any:
            return JsonResponse({"async": True})

        def forgot(request: Any) -> Any:
            return JsonResponse({"tier": dj.get_polaris_license(request).tier})

        rf = RequestFactory()
        mw = dj.PolarisKeyMiddleware(pro)
        res = mw(rf.get("/x", headers=k.signed_headers(tier="pro")))
        assert json.loads(res.content) == {"tier": "pro"} and res["Cache-Control"] == "private"
        assert dj.PolarisKeyMiddleware(pro)(rf.get("/x", headers=k.signed_headers(tier="free"))).status_code == 403
        assert json.loads(both(rf.get("/x", headers=k.signed_headers(tier="pro", user=None))).content)["code"] == "sign_in_required"
        assert json.loads(Cbv.as_view()(rf.get("/x", headers=k.signed_headers(tier="pro"))).content) == {"tier": "pro"}
        # A preflight passes the gate (and reaches the view, which has no license to read).
        assert both(rf.options("/x", headers=PREFLIGHT)).status_code == 200
        with pytest.raises(PolarisKeySetupError, match="no Polaris Key gate"):
            forgot(rf.get("/x", headers=k.signed_headers()))

        import asyncio

        res = asyncio.run(aview(rf.get("/x", headers=k.signed_headers())))
        assert json.loads(res.content) == {"async": True} and res["Cache-Control"] == "private"

    with _django(CONFIG=k.config, TRUST_REFRESH=False, PREFLIGHT="gate"):
        from polaris_key.server import django as dj

        @dj.require_license()
        def view(request: Any) -> Any:
            return JsonResponse({})

        assert view(RequestFactory().options("/x", headers=PREFLIGHT)).status_code == 401


def test_drf_tier_all_accessor_preflight_and_on_refusal() -> None:
    from rest_framework.response import Response
    from rest_framework.test import APIRequestFactory
    from rest_framework.views import APIView

    k = kit()
    with _django(CONFIG=k.config, TRUST_REFRESH=False, ON_REFUSAL=f"{__name__}.teapot"):
        from polaris_key.server import drf

        class V(APIView):
            authentication_classes = [drf.PolarisKeyAuthentication]
            permission_classes = [drf.has_all(signin(), tier("pro"))]

            def get_exception_handler(self) -> Any:
                return drf.exception_handler

            def get(self, request: Any) -> Any:
                return Response({"tier": drf.get_polaris_license(request).tier})

        class Misconfigured(APIView):
            authentication_classes: list = []
            permission_classes = [drf.has_license()]

            def get(self, request: Any) -> Any:
                return Response({})

        f = APIRequestFactory()
        ok = V.as_view()(f.get("/x", headers=k.signed_headers(tier="pro")))
        assert ok.data == {"tier": "pro"}
        res = V.as_view()(f.get("/x", headers=k.signed_headers(tier="free")))
        assert res.status_code == 418
        assert V.as_view()(f.options("/x", headers=PREFLIGHT)).status_code == 200
        with pytest.raises(PolarisKeySetupError, match="PolarisKeyAuthentication"):
            Misconfigured.as_view()(f.get("/x", headers=k.signed_headers()))


def teapot(problem: Any, request: Any) -> Any:
    from django.http import HttpResponse

    return HttpResponse(problem.title, status=418)


urlpatterns: list = []  # ROOT_URLCONF placeholder
