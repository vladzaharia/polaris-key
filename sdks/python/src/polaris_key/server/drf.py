"""Django REST framework: an authentication class and permission factories. A refusal is raised
(``errors="throw"`` is DRF's default): ``AuthenticationFailed`` for a missing, invalid or stale
license and ``PermissionDenied`` for a missing entitlement or sign-in, both carrying the
:class:`~polaris_key.server.Problem`. :func:`exception_handler` shapes it as problem+json; or
use your own ``EXCEPTION_HANDLER`` and read ``exc.problem``.

    class ExportView(APIView):
        authentication_classes = [PolarisKeyAuthentication]  # request.auth is the PolarisAuth
        permission_classes = [has_entitlement("export.pdf")]

    REST_FRAMEWORK = {"EXCEPTION_HANDLER": "polaris_key.server.drf.exception_handler"}

Permissions: ``has_license()``, ``has_entitlement(name)``, ``has_tier(*tiers)``, ``has_sign_in()``
and ``has_all(*requirements)``; they need :class:`PolarisKeyAuthentication` on the view.
``get_polaris_license(request)`` returns the license of a gated request. ``exception_handler`` also
honors ``POLARIS_KEY["ON_REFUSAL"]``. With ``polaris_key.server.django.PolarisKeyMiddleware``
installed, a gated response gets ``Cache-Control: private``. A CORS preflight passes
(``"PREFLIGHT": "gate"`` refuses it).
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Tuple, Type

from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed, ErrorDetail, PermissionDenied
from rest_framework.permissions import BasePermission
from rest_framework.response import Response

from ._core import PolarisAuth, PolarisKeySetupError
from ._core import get_polaris_license as _license_of
from ._problem import Problem
from ._verdict import PolarisLicense, Requirement, as_requirements, entitlement, signin, tier
from .django import get_polaris

__all__ = [
    "PolarisKeyAuthentication",
    "PolarisPrincipal",
    "PolarisAuthenticationFailed",
    "PolarisPermissionDenied",
    "has_license",
    "has_entitlement",
    "has_tier",
    "has_sign_in",
    "has_all",
    "get_polaris_license",
    "exception_handler",
]


def get_polaris_license(request: Any) -> PolarisLicense:
    """The license of a gated request, never ``None``. Raises :class:`PolarisKeySetupError`
    when the view has no Polaris Key permission."""
    raw = getattr(request, "_request", request)
    auth = getattr(raw, "polaris", None)
    return _license_of(auth if isinstance(auth, PolarisAuth) and getattr(raw, "polaris_gated", False) else None)


class PolarisAuthenticationFailed(AuthenticationFailed):
    def __init__(self, problem: Problem) -> None:
        super().__init__(detail=ErrorDetail(problem.detail, code=problem.code))
        self.problem = problem


class PolarisPermissionDenied(PermissionDenied):
    def __init__(self, problem: Problem) -> None:
        super().__init__(detail=ErrorDetail(problem.detail, code=problem.code))
        self.problem = problem


class PolarisPrincipal:
    """``request.user`` for a gated request: the license, not an account. ``repr`` is redacted."""

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

    def authenticate(self, request: Any) -> Optional[Tuple[PolarisPrincipal, PolarisAuth]]:
        raw = request._request
        polaris = get_polaris()
        if polaris.lets_through(raw.method or "", list(raw.headers.items())):
            return None  # a CORS preflight carries no license; DRF answers OPTIONS itself
        auth = getattr(raw, "polaris", None)
        if not isinstance(auth, PolarisAuth):
            auth = polaris.authenticate(list(raw.headers.items()), raw.headers.get("Accept-Language"))
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
            polaris = get_polaris()
            if polaris.lets_through(request.method or "", list(request.headers.items())):
                return True
            auth = request.auth
            if not isinstance(auth, PolarisAuth):
                raise PolarisKeySetupError(
                    f"{type(view).__name__}: a Polaris Key permission needs PolarisKeyAuthentication in the view's "
                    "authentication_classes (or REST_FRAMEWORK DEFAULT_AUTHENTICATION_CLASSES)"
                )
            checked = polaris.check(auth, require, request.headers.get("Accept-Language"))
            if checked.problem is not None:
                raise PolarisPermissionDenied(checked.problem)
            request._request.polaris_gated = True
            return True

    return PolarisPermission


def has_license() -> Type[BasePermission]:
    return _permission(())


def has_entitlement(name: str, test: Optional[Callable[[Any], bool]] = None) -> Type[BasePermission]:
    return _permission((entitlement(name, test),))


def has_tier(*tiers: str) -> Type[BasePermission]:
    """The license's tier is one of ``tiers``."""
    return _permission((tier(*tiers),))


def has_sign_in() -> Type[BasePermission]:
    return _permission((signin(),))


def has_all(*requirements: Requirement) -> Type[BasePermission]:
    """Several requirements in order, for example ``has_all(signin(), tier("pro"))``; the first that fails refuses."""
    return _permission(as_requirements(requirements, "has_all"))


def exception_handler(exc: Exception, context: Any) -> Optional[Response]:
    """DRF's handler, with the Polaris Key refusals answered as ``application/problem+json``."""
    problem = getattr(exc, "problem", None)
    if isinstance(exc, (PolarisAuthenticationFailed, PolarisPermissionDenied)) and isinstance(problem, Problem):
        on_refusal = get_polaris().on_refusal
        if on_refusal is not None:
            return on_refusal(problem, context.get("request"))  # type: ignore[no-any-return]
        return Response(
            problem.body,
            status=problem.status,
            headers={k: v for k, v in problem.headers.items() if k != "Content-Type"},
            content_type=problem.headers["Content-Type"],
        )
    from rest_framework.views import exception_handler as drf_exception_handler

    return drf_exception_handler(exc, context)
