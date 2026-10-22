"""Starlette: a pure-ASGI middleware that attaches the licence to ``request.state.polaris``, and
decorators that gate an endpoint. Install the framework with ``pip install polaris-key[fastapi]``.

    polaris = PolarisKey(config=polaris_config)
    polaris.install(app)  # or app.add_middleware(PolarisKeyMiddleware, polaris=polaris)

    @polaris.require_entitlement("export.pdf")
    async def export(request):
        return JSONResponse({"tier": get_polaris_license(request).tier})

Gates: ``require_license()``, ``require_entitlement(name)``, ``require_tier(*tiers)``,
``require_sign_in()`` and ``require_all(*requirements)``. ``get_polaris_license(request)`` returns
the licence of a gated request and raises when the route has no gate. A gated response gets
``Cache-Control: private`` unless the handler set one. A CORS preflight passes every gate
(``PolarisKey(preflight="gate")`` refuses it).
"""

from __future__ import annotations

import functools
import inspect
from typing import Any, Callable, List, Optional, Sequence, Tuple

from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Receive, Scope, Send

from ._core import PolarisAuth, PolarisKeyError
from ._core import PolarisKey as _Core
from ._core import get_polaris_license as _license_of
from ._problem import Problem
from ._verdict import PolarisLicense, Requirement, as_requirements, entitlement, signin, tier

__all__ = [
    "PolarisKey",
    "PolarisKeyMiddleware",
    "PolarisCacheControlMiddleware",
    "PolarisHTTPError",
    "get_polaris_license",
    "problem_response",
    "request_headers",
]

_GATED = "polaris_gated"


class PolarisHTTPError(PolarisKeyError, HTTPException):  # type: ignore[misc]
    """A :class:`PolarisKeyError` that is also a Starlette ``HTTPException``, so an app with no
    handler still answers the right status and ``WWW-Authenticate``. ``response`` is what
    ``on_refusal`` returned, when it was set."""

    def __init__(self, problem: Problem, response: Optional[Response] = None) -> None:
        PolarisKeyError.__init__(self, problem)
        # The un-handled default is Starlette's own text/JSON reply, so the body is the human
        # sentence and the content type is left to it; `exception_handler` sends the problem.
        headers = {k: v for k, v in problem.headers.items() if k != "Content-Type"}
        HTTPException.__init__(self, problem.status, problem.detail, headers)
        self.response = response


def request_headers(request: Any) -> List[Tuple[str, str]]:
    """Every header field of a request, in order (repeated fields kept apart)."""
    return [(k.decode("latin-1"), v.decode("latin-1")) for k, v in request.scope.get("headers", [])]


def problem_response(problem: Problem) -> Response:
    """The refusal as a response: ``application/problem+json``, ``Cache-Control: no-store`` and, on a 401, the challenge."""
    return Response(problem.body_bytes(), status_code=problem.status, headers=dict(problem.headers))


_problem_response = problem_response


def get_polaris_license(request: Any) -> PolarisLicense:
    """The licence of a gated request (or of the :class:`PolarisAuth` a FastAPI dependency
    returned), never ``None``. Raises :class:`PolarisKeySetupError` on a route with no gate."""
    if isinstance(request, PolarisAuth):
        return _license_of(request)
    state = request.scope.get("state") or {}
    auth = state.get("polaris")
    return _license_of(auth if isinstance(auth, PolarisAuth) and state.get(_GATED) else None)


def _private(headers: List[Tuple[bytes, bytes]]) -> List[Tuple[bytes, bytes]]:
    if any(k.lower() == b"cache-control" for k, _ in headers):
        return headers
    return [*headers, (b"cache-control", b"private")]


class PolarisCacheControlMiddleware:
    """Pure ASGI: add ``Cache-Control: private`` to the response of a gated request that set none,
    whatever the handler returned (a dict, a streamed or a raw response). ``PolarisKey.install``
    adds it; :class:`PolarisKeyMiddleware` does the same."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def private(message: Any) -> None:
            if message["type"] == "http.response.start" and (scope.get("state") or {}).get(_GATED):
                message = {**message, "headers": _private(list(message.get("headers", [])))}
            await send(message)

        await self.app(scope, receive, private)


class PolarisKey(_Core):
    """The core plus Starlette's shape: ``require_license()``, ``require_entitlement(name)`` and
    ``require_sign_in()`` decorate an endpoint taking a ``Request``."""

    async def auth_of(self, request: Request) -> PolarisAuth:
        """The request's licence, from the middleware or made now (no route requirement)."""
        cached = request.scope.get("state", {}).get("polaris") if "state" in request.scope else None
        if isinstance(cached, PolarisAuth):
            return cached
        auth = await self.aauthenticate(request_headers(request), request.headers.get("accept-language"))
        request.scope.setdefault("state", {})["polaris"] = auth
        return auth

    async def gate(self, request: Request, require: Sequence[Requirement]) -> PolarisAuth:
        """The licence, with the route's requirements checked. Raises :class:`PolarisHTTPError`."""
        if self.lets_through(request.method, request_headers(request)):
            return PolarisAuth(None, None, None, preflight=True)
        auth = self.check(await self.auth_of(request), require, request.headers.get("accept-language"))
        if auth.problem is not None:
            response = self.on_refusal(auth.problem, request) if self.on_refusal else None
            raise PolarisHTTPError(auth.problem, response)
        state = request.scope.setdefault("state", {})
        state["polaris"] = auth
        state[_GATED] = True
        return auth

    def exception_handler(self, request: Request, exc: Exception) -> Response:
        """Answer a :class:`PolarisKeyError`: ``on_refusal``'s response, else the problem."""
        assert isinstance(exc, PolarisKeyError)
        response = getattr(exc, "response", None)
        return response if response is not None else _problem_response(exc.problem)

    def install(self, app: Any) -> None:
        """Register :meth:`exception_handler` (needed for ``on_refusal``) and the
        ``Cache-Control: private`` middleware on the app."""
        app.add_exception_handler(PolarisKeyError, self.exception_handler)
        app.add_middleware(PolarisCacheControlMiddleware)

    def _decorator(self, require: Tuple[Requirement, ...]) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def wrap(endpoint: Callable[..., Any]) -> Callable[..., Any]:
            @functools.wraps(endpoint)
            async def inner(request: Request, *args: Any, **kwargs: Any) -> Any:
                await self.gate(request, require)
                result = endpoint(request, *args, **kwargs)
                result = await result if inspect.isawaitable(result) else result
                if isinstance(result, Response) and "cache-control" not in result.headers:
                    result.headers["Cache-Control"] = "private"
                return result

            return inner

        return wrap

    def require_license(self) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return self._decorator(())

    def require_entitlement(
        self, name: str, test: Optional[Callable[[Any], bool]] = None
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return self._decorator((entitlement(name, test),))

    def require_tier(self, *tiers: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """The licence's tier is one of ``tiers``."""
        return self._decorator((tier(*tiers),))

    def require_sign_in(self) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return self._decorator((signin(),))

    def require_all(self, *requirements: Requirement) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Several requirements in order, for example ``require_all(signin(), tier("pro"))``;
        the first that fails refuses."""
        return self._decorator(as_requirements(requirements, "require_all"))

    require = require_all


class PolarisKeyMiddleware:
    """Pure ASGI: authenticate every HTTP request, never refuse by itself, put the result on
    ``request.state.polaris``, and answer a :class:`PolarisKeyError` an endpoint raised."""

    def __init__(self, app: ASGIApp, polaris: PolarisKey) -> None:
        self.app = app
        self.polaris = polaris

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in scope.get("headers", [])]
        al = next((v for k, v in headers if k.lower() == "accept-language"), None)
        auth = await self.polaris.aauthenticate(headers, al)
        scope.setdefault("state", {})["polaris"] = auth
        started = False

        async def watch(message: Any) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                if scope["state"].get(_GATED):
                    message = {**message, "headers": _private(list(message.get("headers", [])))}
            await send(message)

        try:
            await self.app(scope, receive, watch)
        except PolarisKeyError as exc:
            if started or self.polaris.errors == "raise":
                raise
            await self.polaris.exception_handler(Request(scope, receive), exc)(scope, receive, send)
