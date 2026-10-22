"""Flask: the extension pattern. ``init_app`` authenticates every request into ``g.polaris``
(it never refuses by itself); the decorators gate a view. Install with
``pip install polaris-key[flask]``.

    polaris = PolarisKey(config=polaris_config)
    polaris.init_app(app)

    @app.get("/api/export")
    @polaris.require_entitlement("export.pdf")  # below @app.get: the route must register the gated view
    def export():
        return {"tier": get_polaris_license().tier}

Gates: ``require_license()``, ``require_entitlement(name)``, ``require_tier(*tiers)``,
``require_sign_in()`` and ``require_all(*requirements)``. ``get_polaris_license()`` returns the
license of the gated request and raises when the route has no gate. A gated response gets
``Cache-Control: private`` unless the view set one. A CORS preflight passes every gate
(``PolarisKey(preflight="gate")`` refuses it). ``on_refusal`` is ``f(problem)`` or
``f(problem, request)`` and returns the view's response.
"""

from __future__ import annotations

import functools
import inspect
from typing import Any, Callable, Optional, Sequence, Tuple

from flask import Response, current_app, g, request

from ._core import PolarisAuth, PolarisKeyError, PolarisKeySetupError
from ._core import PolarisKey as _Core
from ._core import get_polaris_license as _license_of
from ._problem import Problem
from ._verdict import PolarisLicense, Requirement, as_requirements, entitlement, signin, tier

__all__ = ["PolarisKey", "get_polaris_license", "problem_response"]


def problem_response(problem: Problem) -> Response:
    """The refusal as a response: ``application/problem+json``, ``Cache-Control: no-store`` and, on a 401, the challenge."""
    return Response(problem.body_bytes(), status=problem.status, headers=dict(problem.headers))


def get_polaris_license() -> PolarisLicense:
    """The license of the gated request being handled, never ``None``. Raises
    :class:`PolarisKeySetupError` on a route with no gate."""
    auth = g.get("polaris")
    return _license_of(auth if isinstance(auth, PolarisAuth) and g.get("polaris_gated") else None)


class PolarisKey(_Core):
    """The core plus Flask's shape. ``on_refusal(problem)`` returns the view's response."""

    _apps: Any = None

    def init_app(self, app: Any) -> None:
        app.extensions["polaris_key"] = self
        app.before_request(self._before_request)
        app.after_request(self._after_request)
        self._apps = [*(self._apps or []), app]

    def _after_request(self, response: Any) -> Any:
        if g.get("polaris_gated") and "Cache-Control" not in response.headers:
            response.headers["Cache-Control"] = "private"
        return response

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
            return self.on_refusal(problem, request)
        return problem_response(problem)

    def _decorator(self, require: Tuple[Requirement, ...]) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def wrap(view: Callable[..., Any]) -> Callable[..., Any]:
            for app in self._apps or ():
                if any(registered is view for registered in app.view_functions.values()):
                    raise PolarisKeySetupError(
                        f"PolarisKey: {getattr(view, '__name__', 'the view')} is already registered as a route, "
                        "so this gate would not run; put the gate decorator below @app.get / @app.route"
                    )

            def refused() -> Tuple[bool, Any]:
                if self.lets_through(request.method, request.headers.items()):
                    g.polaris = PolarisAuth(None, None, None, preflight=True)
                    return False, None
                auth = self.check(self._current(), require, request.headers.get("Accept-Language"))
                if auth.problem is not None:
                    g.polaris = auth
                    return True, self._refusal(auth.problem)
                g.polaris = auth
                g.polaris_gated = True
                return False, None

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

    def require_tier(self, *tiers: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """The license's tier is one of ``tiers``."""
        return self._decorator((tier(*tiers),))

    def require_sign_in(self) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return self._decorator((signin(),))

    def require_all(self, *requirements: Requirement) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Several requirements in order, for example ``require_all(signin(), tier("pro"))``;
        the first that fails refuses."""
        return self._decorator(as_requirements(requirements, "require_all"))

    require = require_all
