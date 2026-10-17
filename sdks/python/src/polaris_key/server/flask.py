"""Flask: the extension pattern. ``init_app`` authenticates every request into ``g.polaris``
(it never refuses by itself); the decorators gate a view. Install with
``pip install polaris-key[flask]``.

    polaris = PolarisKey(config=polaris_config)
    polaris.init_app(app)

    @app.get("/api/export")
    @polaris.require_entitlement("export.pdf")
    def export():
        return {"tier": g.polaris.license.tier}
"""

from __future__ import annotations

import functools
import inspect
from typing import Any, Callable, Optional, Sequence, Tuple

from flask import Response, current_app, g, request

from ._core import PolarisAuth, PolarisKeyError
from ._core import PolarisKey as _Core
from ._problem import Problem
from ._verdict import Requirement, entitlement, signin

__all__ = ["PolarisKey"]


class PolarisKey(_Core):
    """The core plus Flask's shape. ``on_refusal(problem)`` returns the view's response."""

    def init_app(self, app: Any) -> None:
        app.extensions["polaris_key"] = self
        app.before_request(self._before_request)

    def _before_request(self) -> None:
        g.polaris = self.authenticate(request.headers.items(), request.headers.get("Accept-Language"))

    def _current(self) -> PolarisAuth:
        auth = g.get("polaris")
        if not isinstance(auth, PolarisAuth):
            self._before_request()
            auth = g.polaris
        return auth  # type: ignore[no-any-return]

    def _refusal(self, problem: Problem) -> Any:
        if self.errors == "raise":
            raise PolarisKeyError(problem)
        if self.on_refusal is not None:
            return self.on_refusal(problem)
        return Response(problem.body_bytes(), status=problem.status, headers=dict(problem.headers))

    def _decorator(self, require: Tuple[Requirement, ...]) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def wrap(view: Callable[..., Any]) -> Callable[..., Any]:
            def refused() -> Tuple[bool, Any]:
                auth = self.check(self._current(), require, request.headers.get("Accept-Language"))
                g.polaris = auth
                return (True, self._refusal(auth.problem)) if auth.problem is not None else (False, None)

            if inspect.iscoroutinefunction(view):

                @functools.wraps(view)
                async def ainner(*args: Any, **kwargs: Any) -> Any:
                    stop, response = refused()
                    return response if stop else await view(*args, **kwargs)

                return ainner

            @functools.wraps(view)
            def inner(*args: Any, **kwargs: Any) -> Any:
                stop, response = refused()
                return response if stop else view(*args, **kwargs)

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

    def require(self, *requirements: Requirement) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return self._decorator(tuple(requirements))
