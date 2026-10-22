"""Django: ``PolarisKeyMiddleware`` puts the license on ``request.polaris``; the decorators gate
a plain view. Install with ``pip install polaris-key[django]``.

    MIDDLEWARE = [..., "polaris_key.server.django.PolarisKeyMiddleware"]
    POLARIS_KEY = {"CONFIG": "myapp.polaris_config"}

    @require_entitlement("export.pdf")
    def export(request):
        return JsonResponse({"tier": get_polaris_license(request).tier})

``POLARIS_KEY`` also takes ``MAX_AGE_SECONDS``, ``ERRORS`` ("respond" or "raise"), ``ON_REFUSAL``
(a dotted path to ``f(problem, request)`` returning the response), ``TRUST_REFRESH`` and
``PRODUCTS`` (several configs). ``CONFIG`` is a dotted path to the ``polaris_config`` module or
its ``CONFIG`` mapping, or the mapping itself. A key it does not know fails at start.

Gates: ``require_license()``, ``require_entitlement(name)``, ``require_tier(*tiers)``,
``require_sign_in()`` and ``require_all(*requirements)``; they wrap a function view (sync or
async) or, through ``method_decorator``, a class-based view's method. ``get_polaris_license(request)``
returns the license of a gated request and raises when the view has no gate. A gated response gets
``Cache-Control: private`` unless the view set one. A CORS preflight passes every gate
(``"PREFLIGHT": "gate"`` refuses it).
"""

from __future__ import annotations

import functools
import inspect
import threading
from typing import Any, Callable, Dict, Optional, Tuple

from django import conf as _conf
from django.core.signals import setting_changed
from django.http import HttpRequest, HttpResponse
from django.utils.module_loading import import_string

from ._core import PolarisAuth, PolarisKeyError, PolarisKeySetupError
from ._core import PolarisKey as PolarisKey
from ._core import get_polaris_license as _license_of
from ._problem import Problem
from ._verdict import PolarisLicense, Requirement, as_requirements, entitlement, signin, tier

__all__ = [
    "PolarisKey",
    "PolarisKeyMiddleware",
    "get_polaris",
    "require_license",
    "require_entitlement",
    "require_tier",
    "require_sign_in",
    "require_all",
    "get_polaris_license",
    "problem_response",
]

_SETTINGS = (
    "CONFIG",
    "PRODUCTS",
    "MAX_AGE_SECONDS",
    "ERRORS",
    "ON_REFUSAL",
    "TRUST_REFRESH",
    "PREFLIGHT",
)

_lock = threading.Lock()
_instance: Optional[PolarisKey] = None


def _resolve(value: Any, setting: str = "CONFIG") -> Any:
    if isinstance(value, str):
        try:
            try:
                return import_string(value)
            except ImportError:
                import importlib

                return importlib.import_module(value)
        except ImportError as exc:
            raise PolarisKeySetupError(
                f"settings.POLARIS_KEY[{setting!r}]: cannot import {value!r} ({exc}); "
                "for CONFIG, use the module `pkey sdk --lang python --write` generates, such as 'myapp.polaris_config'"
            ) from exc
    return value


def get_polaris() -> PolarisKey:
    """The one :class:`PolarisKey` built from ``settings.POLARIS_KEY`` (on first use)."""
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                conf: Dict[str, Any] = dict(getattr(_conf.settings, "POLARIS_KEY", None) or {})
                unknown = sorted(set(conf) - set(_SETTINGS))
                if unknown:
                    raise PolarisKeySetupError(
                        f"settings.POLARIS_KEY has unknown keys {unknown}; the keys are {list(_SETTINGS)}"
                    )
                if "CONFIG" not in conf and "PRODUCTS" not in conf:
                    raise PolarisKeySetupError(
                        'settings.POLARIS_KEY needs CONFIG (or PRODUCTS): POLARIS_KEY = {"CONFIG": "myapp.polaris_config"}, '
                        "the module `pkey sdk --lang python --write` generates"
                    )
                refusal = _resolve(conf["ON_REFUSAL"], "ON_REFUSAL") if conf.get("ON_REFUSAL") else None
                _instance = PolarisKey(
                    config=_resolve(conf["CONFIG"]) if "CONFIG" in conf else None,
                    products=[_resolve(c, "PRODUCTS") for c in conf["PRODUCTS"]] if "PRODUCTS" in conf else None,
                    max_age_seconds=conf.get("MAX_AGE_SECONDS"),
                    errors=conf.get("ERRORS", "respond"),
                    on_refusal=refusal,
                    trust_refresh=conf.get("TRUST_REFRESH", True),
                    preflight=conf.get("PREFLIGHT", "pass"),
                )
    return _instance


def _reset(**_: Any) -> None:
    global _instance
    _instance = None


setting_changed.connect(_reset)


def problem_response(problem: Problem) -> HttpResponse:
    response = HttpResponse(problem.body_bytes(), status=problem.status, content_type=problem.headers["Content-Type"])
    for k, v in problem.headers.items():
        if k != "Content-Type":
            response[k] = v
    return response


def _auth_of(request: HttpRequest) -> PolarisAuth:
    auth = getattr(request, "polaris", None)
    if not isinstance(auth, PolarisAuth):
        auth = get_polaris().authenticate(list(request.headers.items()), request.headers.get("Accept-Language"))
        request.polaris = auth  # type: ignore[attr-defined]
    return auth


def get_polaris_license(request: Any) -> PolarisLicense:
    """The license of a gated request, never ``None``. Raises :class:`PolarisKeySetupError` on a view with no gate."""
    auth = getattr(request, "polaris", None)
    return _license_of(auth if isinstance(auth, PolarisAuth) and getattr(request, "polaris_gated", False) else None)


def _private(request: Any, response: HttpResponse) -> HttpResponse:
    if getattr(request, "polaris_gated", False) and "Cache-Control" not in response:
        response["Cache-Control"] = "private"
    return response


class PolarisKeyMiddleware:
    """Authenticate every request into ``request.polaris``. It never refuses by itself. It also
    adds ``Cache-Control: private`` to the response of a gated view (including a DRF view)."""

    sync_capable = True
    async_capable = False

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        get_polaris()  # a bad configuration fails at start

    def __call__(self, request: HttpRequest) -> HttpResponse:
        _auth_of(request)
        return _private(request, self.get_response(request))


def _request_of(args: Tuple[Any, ...]) -> Tuple[int, HttpRequest]:
    """The request argument: first for a function view, second for a class-based view's method."""
    for at in (0, 1):
        if len(args) > at and isinstance(args[at], HttpRequest):
            return at, args[at]
    raise PolarisKeySetupError(
        "PolarisKey: the gated view's first argument is not a Django request; "
        "put the gate on a function view or use method_decorator on a class-based view's method"
    )


def _refused(
    polaris: PolarisKey, request: HttpRequest, auth: PolarisAuth, require: Tuple[Requirement, ...]
) -> Optional[HttpResponse]:
    """The response that refuses ``request`` (or raises), or ``None`` when it may proceed."""
    if polaris.lets_through(request.method or "", list(request.headers.items())):
        request.polaris = PolarisAuth(None, None, None, preflight=True)  # type: ignore[attr-defined]
        return None
    checked = polaris.check(auth, require, request.headers.get("Accept-Language"))
    request.polaris = checked  # type: ignore[attr-defined]
    if checked.problem is None:
        request.polaris_gated = True  # type: ignore[attr-defined]
        return None
    if polaris.errors == "raise":
        raise PolarisKeyError(checked.problem)
    if polaris.on_refusal is not None:
        return polaris.on_refusal(checked.problem, request)  # type: ignore[no-any-return]
    return problem_response(checked.problem)


def _gate(require: Tuple[Requirement, ...]) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    def wrap(view: Callable[..., Any]) -> Callable[..., Any]:
        if inspect.iscoroutinefunction(view):

            @functools.wraps(view)
            async def ainner(*args: Any, **kwargs: Any) -> Any:
                _, request = _request_of(args)
                polaris = get_polaris()
                auth = getattr(request, "polaris", None)
                if not isinstance(auth, PolarisAuth):
                    auth = await polaris.aauthenticate(
                        list(request.headers.items()), request.headers.get("Accept-Language")
                    )
                    request.polaris = auth  # type: ignore[attr-defined]
                refused = _refused(polaris, request, auth, require)
                return refused if refused is not None else _private(request, await view(*args, **kwargs))

            return ainner

        @functools.wraps(view)
        def inner(*args: Any, **kwargs: Any) -> Any:
            _, request = _request_of(args)
            polaris = get_polaris()
            refused = _refused(polaris, request, _auth_of(request), require)
            return refused if refused is not None else _private(request, view(*args, **kwargs))

        return inner

    return wrap


def require_license() -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    return _gate(())


def require_entitlement(
    name: str, test: Optional[Callable[[Any], bool]] = None
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    return _gate((entitlement(name, test),))


def require_tier(*tiers: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """The license's tier is one of ``tiers``."""
    return _gate((tier(*tiers),))


def require_sign_in() -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    return _gate((signin(),))


def require_all(*requirements: Requirement) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Several requirements in order, for example ``require_all(signin(), tier("pro"))``; the first that fails refuses."""
    return _gate(as_requirements(requirements, "require_all"))
