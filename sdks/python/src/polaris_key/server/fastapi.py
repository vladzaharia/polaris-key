"""FastAPI: dependencies that gate a route and hand it the :class:`PolarisAuth`. The dependency
declares an ``APIKeyHeader("X-PKey-License")`` scheme, so ``/docs`` shows it.

    polaris = PolarisKey(config=polaris_config)
    polaris.install(app)

    @app.get("/api/export")
    def export(auth: Annotated[PolarisAuth, Depends(polaris.require_entitlement("export.pdf"))]):
        return {"tier": get_polaris_license(auth).tier}

``get_polaris_license(auth)`` is the licence without the ``Optional``. Dependencies:
``require_license()``, ``require_entitlement(name)``, ``require_tier(*tiers)``,
``require_sign_in()`` and ``require_all(*requirements)`` (``require`` is the same). ``install``
registers the refusal handler and the ``Cache-Control: private`` middleware. A CORS preflight
passes every gate (``PolarisKey(preflight="gate")`` refuses it).
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Sequence, Tuple

from fastapi import Request, Response, Security
from fastapi.security import APIKeyHeader

from ._core import PolarisAuth
from ._verdict import HEADER_LICENSE, Requirement, as_requirements, entitlement, signin, tier
from .starlette import (
    PolarisCacheControlMiddleware,
    PolarisHTTPError,
    PolarisKey as _StarlettePolarisKey,
    PolarisKeyMiddleware,
    get_polaris_license,
    problem_response,
)

__all__ = [
    "PolarisKey",
    "PolarisKeyMiddleware",
    "PolarisCacheControlMiddleware",
    "PolarisAuth",
    "PolarisHTTPError",
    "get_polaris_license",
    "problem_response",
]

_scheme = APIKeyHeader(name=HEADER_LICENSE, auto_error=False, description="The app's signed licence document")


class PolarisKey(_StarlettePolarisKey):
    """The Starlette adapter whose ``require_*`` methods return FastAPI dependencies."""

    def _dependency(self, require: Tuple[Requirement, ...]) -> Callable[..., Any]:
        async def dependency(
            request: Request, response: Response, _license: Optional[str] = Security(_scheme)
        ) -> PolarisAuth:
            auth = await self.gate(request, require)
            if auth.license is not None and "cache-control" not in response.headers:
                response.headers["Cache-Control"] = "private"
            return auth

        return dependency

    def require_license(self) -> Callable[..., Any]:  # type: ignore[override]
        return self._dependency(())

    def require_entitlement(  # type: ignore[override]
        self, name: str, test: Optional[Callable[[Any], bool]] = None
    ) -> Callable[..., Any]:
        return self._dependency((entitlement(name, test),))

    def require_tier(self, *tiers: str) -> Callable[..., Any]:  # type: ignore[override]
        """The licence's tier is one of ``tiers``."""
        return self._dependency((tier(*tiers),))

    def require_sign_in(self) -> Callable[..., Any]:  # type: ignore[override]
        return self._dependency((signin(),))

    def require_all(self, *requirements: Requirement) -> Callable[..., Any]:  # type: ignore[override]
        """Several requirements in order, for example ``require_all(signin(), tier("pro"))``;
        the first that fails refuses."""
        return self._dependency(as_requirements(requirements, "require_all"))

    require = require_all
