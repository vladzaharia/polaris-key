"""FastAPI: dependencies that gate a route and hand it the :class:`PolarisAuth`. The dependency
declares an ``APIKeyHeader("X-PKey-License")`` scheme, so ``/docs`` shows it.

    polaris = PolarisKey(config=polaris_config)
    polaris.install(app)

    @app.get("/api/export")
    def export(auth: Annotated[PolarisAuth, Depends(polaris.require_entitlement("export.pdf"))]):
        return {"tier": auth.license.tier}
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Sequence, Tuple

from fastapi import Request, Security
from fastapi.security import APIKeyHeader

from ._core import PolarisAuth
from ._verdict import HEADER_LICENSE, Requirement, entitlement, signin
from .starlette import PolarisHTTPError, PolarisKey as _StarlettePolarisKey, PolarisKeyMiddleware

__all__ = ["PolarisKey", "PolarisKeyMiddleware", "PolarisAuth", "PolarisHTTPError"]

_scheme = APIKeyHeader(name=HEADER_LICENSE, auto_error=False, description="The app's signed licence document")


class PolarisKey(_StarlettePolarisKey):
    """The Starlette adapter whose ``require_*`` methods return FastAPI dependencies."""

    def _dependency(self, require: Tuple[Requirement, ...]) -> Callable[..., Any]:
        async def dependency(request: Request, _license: Optional[str] = Security(_scheme)) -> PolarisAuth:
            return await self.gate(request, require)

        return dependency

    def require_license(self) -> Callable[..., Any]:  # type: ignore[override]
        return self._dependency(())

    def require_entitlement(  # type: ignore[override]
        self, name: str, test: Optional[Callable[[Any], bool]] = None
    ) -> Callable[..., Any]:
        return self._dependency((entitlement(name, test),))

    def require_sign_in(self) -> Callable[..., Any]:  # type: ignore[override]
        return self._dependency((signin(),))

    def require(self, *requirements: Requirement) -> Callable[..., Any]:
        """Several requirements in order, for example ``require(entitlement("pro"), signin())``."""
        return self._dependency(tuple(requirements))
