"""Starlette: a pure-ASGI middleware that attaches the licence to ``request.state.polaris``, and
decorators that gate an endpoint. Install the framework with ``pip install polaris-key[fastapi]``.

    polaris = PolarisKey(config=polaris_config)
    app.add_middleware(PolarisKeyMiddleware, polaris=polaris)

    @polaris.require_entitlement("export.pdf")
    async def export(request): ...
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
from ._problem import Problem
from ._verdict import Requirement, entitlement, signin

__all__ = ["PolarisKey", "PolarisKeyMiddleware", "PolarisHTTPError", "request_headers"]


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


def _problem_response(problem: Problem) -> Response:
    return Response(problem.body_bytes(), status_code=problem.status, headers=dict(problem.headers))


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
        auth = self.check(await self.auth_of(request), require, request.headers.get("accept-language"))
        if auth.problem is not None:
            response = self.on_refusal(auth.problem, request) if self.on_refusal else None
            raise PolarisHTTPError(auth.problem, response)
        return auth

    def exception_handler(self, request: Request, exc: Exception) -> Response:
        """Answer a :class:`PolarisKeyError`: ``on_refusal``'s response, else the problem."""
        assert isinstance(exc, PolarisKeyError)
        response = getattr(exc, "response", None)
        return response if response is not None else _problem_response(exc.problem)

    def install(self, app: Any) -> None:
        """Register :meth:`exception_handler` on the app (needed for ``on_refusal``)."""
        app.add_exception_handler(PolarisKeyError, self.exception_handler)

    def _decorator(self, require: Tuple[Requirement, ...]) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def wrap(endpoint: Callable[..., Any]) -> Callable[..., Any]:
            @functools.wraps(endpoint)
            async def inner(request: Request, *args: Any, **kwargs: Any) -> Any:
                await self.gate(request, require)
                result = endpoint(request, *args, **kwargs)
                return await result if inspect.isawaitable(result) else result

            return inner

        return wrap

    def require_license(self) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return self._decorator(())

    def require_entitlement(
        self, name: str, test: Optional[Callable[[Any], bool]] = None
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return self._decorator((entitlement(name, test),))

    def require_sign_in(self) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return self._decorator((signin(),))


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
            started = started or message["type"] == "http.response.start"
            await send(message)

        try:
            await self.app(scope, receive, watch)
        except PolarisKeyError as exc:
            if started or self.polaris.errors == "raise":
                raise
            await self.polaris.exception_handler(Request(scope, receive), exc)(scope, receive, send)
