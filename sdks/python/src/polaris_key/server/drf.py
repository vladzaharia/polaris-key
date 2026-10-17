"""Django REST framework: an authentication class and permission factories. A refusal is raised
(``errors="throw"`` is DRF's default): ``AuthenticationFailed`` for a missing, invalid or stale
licence and ``PermissionDenied`` for a missing entitlement or sign-in, both carrying the
:class:`~polaris_key.server.Problem`. :func:`exception_handler` shapes it as problem+json; or
use your own ``EXCEPTION_HANDLER`` and read ``exc.problem``.

    class ExportView(APIView):
        authentication_classes = [PolarisKeyAuthentication]  # request.auth is the PolarisAuth
        permission_classes = [has_entitlement("export.pdf")]

    REST_FRAMEWORK = {"EXCEPTION_HANDLER": "polaris_key.server.drf.exception_handler"}
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Tuple, Type

from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed, ErrorDetail, PermissionDenied
from rest_framework.permissions import BasePermission
from rest_framework.response import Response

from ._core import PolarisAuth
from ._problem import Problem
from ._verdict import Requirement, entitlement, signin
from .django import get_polaris

__all__ = [
    "PolarisKeyAuthentication",
    "PolarisPrincipal",
    "PolarisAuthenticationFailed",
    "PolarisPermissionDenied",
    "has_license",
    "has_entitlement",
    "has_sign_in",
    "exception_handler",
]


class PolarisAuthenticationFailed(AuthenticationFailed):
    def __init__(self, problem: Problem) -> None:
        super().__init__(detail=ErrorDetail(problem.detail, code=problem.code))
        self.problem = problem


class PolarisPermissionDenied(PermissionDenied):
    def __init__(self, problem: Problem) -> None:
        super().__init__(detail=ErrorDetail(problem.detail, code=problem.code))
        self.problem = problem


class PolarisPrincipal:
    """``request.user`` for a gated request: the licence, not an account. ``repr`` is redacted."""

    is_authenticated = True
    is_anonymous = False
    is_active = True

    def __init__(self, auth: PolarisAuth) -> None:
        self.auth = auth

    @property
    def pk(self) -> Optional[str]:
        return self.auth.user.subject if self.auth.user else None

    def __str__(self) -> str:
        return "PolarisPrincipal"

    __repr__ = __str__


class PolarisKeyAuthentication(BaseAuthentication):
    """Verify ``X-PKey-License``; ``request.auth`` is the :class:`PolarisAuth`."""

    def authenticate(self, request: Any) -> Tuple[PolarisPrincipal, PolarisAuth]:
        raw = request._request
        auth = getattr(raw, "polaris", None)
        if not isinstance(auth, PolarisAuth):
            auth = get_polaris().authenticate(list(raw.headers.items()), raw.headers.get("Accept-Language"))
            raw.polaris = auth
        if auth.license is None:
            assert auth.problem is not None
            raise PolarisAuthenticationFailed(auth.problem)
        return PolarisPrincipal(auth), auth

    def authenticate_header(self, request: Any) -> str:
        # Makes DRF answer 401; exception_handler() swaps in the full challenge.
        return f'PKey-License realm="{get_polaris().realm}"'


def _permission(require: Tuple[Requirement, ...]) -> Type[BasePermission]:
    class PolarisPermission(BasePermission):
        def has_permission(self, request: Any, view: Any) -> bool:
            auth = request.auth
            if not isinstance(auth, PolarisAuth):
                return False
            checked = get_polaris().check(auth, require, request.headers.get("Accept-Language"))
            if checked.problem is not None:
                raise PolarisPermissionDenied(checked.problem)
            return True

    return PolarisPermission


def has_license() -> Type[BasePermission]:
    return _permission(())


def has_entitlement(name: str, test: Optional[Callable[[Any], bool]] = None) -> Type[BasePermission]:
    return _permission((entitlement(name, test),))


def has_sign_in() -> Type[BasePermission]:
    return _permission((signin(),))


def exception_handler(exc: Exception, context: Any) -> Optional[Response]:
    """DRF's handler, with the Polaris Key refusals answered as ``application/problem+json``."""
    problem = getattr(exc, "problem", None)
    if isinstance(exc, (PolarisAuthenticationFailed, PolarisPermissionDenied)) and isinstance(problem, Problem):
        return Response(
            problem.body,
            status=problem.status,
            headers={k: v for k, v in problem.headers.items() if k != "Content-Type"},
            content_type=problem.headers["Content-Type"],
        )
    from rest_framework.views import exception_handler as drf_exception_handler

    return drf_exception_handler(exc, context)
