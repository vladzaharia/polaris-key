"""Django: ``PolarisKeyMiddleware`` puts the licence on ``request.polaris``; the decorators gate
a plain view. Install with ``pip install polaris-key[django]``.

    MIDDLEWARE = [..., "polaris_key.server.django.PolarisKeyMiddleware"]
    POLARIS_KEY = {"CONFIG": "myapp.polaris_config"}

    @require_entitlement("export.pdf")
    def export(request):
        return JsonResponse({"tier": request.polaris.license.tier})

``POLARIS_KEY`` also takes ``MAX_AGE_SECONDS``, ``ERRORS`` ("respond" or "raise"), ``ON_REFUSAL``
(a dotted path to ``f(problem, request)`` returning the response), ``TRUST_REFRESH`` and
``PRODUCTS`` (several configs). ``CONFIG`` is a dotted path to the ``polaris_config`` module or
its ``CONFIG`` mapping, or the mapping itself.
"""

from __future__ import annotations

import functools
import threading
from typing import Any, Callable, Dict, Optional, Tuple

from django import conf as _conf
from django.core.signals import setting_changed
from django.http import HttpRequest, HttpResponse
from django.utils.module_loading import import_string

from ._core import PolarisAuth, PolarisKeyError
from ._core import PolarisKey as PolarisKey
from ._problem import Problem
from ._verdict import Requirement, entitlement, signin

__all__ = [
    "PolarisKey",
    "PolarisKeyMiddleware",
    "get_polaris",
    "require_license",
    "require_entitlement",
    "require_sign_in",
    "problem_response",
]

_lock = threading.Lock()
_instance: Optional[PolarisKey] = None


def _resolve(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return import_string(value)
        except ImportError:
            import importlib

            return importlib.import_module(value)
    return value


def get_polaris() -> PolarisKey:
    """The one :class:`PolarisKey` built from ``settings.POLARIS_KEY`` (on first use)."""
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                conf: Dict[str, Any] = dict(getattr(_conf.settings, "POLARIS_KEY", None) or {})
                if "CONFIG" not in conf and "PRODUCTS" not in conf:
                    raise RuntimeError("settings.POLARIS_KEY needs CONFIG (or PRODUCTS)")
                refusal = _resolve(conf["ON_REFUSAL"]) if conf.get("ON_REFUSAL") else None
                _instance = PolarisKey(
                    config=_resolve(conf["CONFIG"]) if "CONFIG" in conf else None,
                    products=[_resolve(c) for c in conf["PRODUCTS"]] if "PRODUCTS" in conf else None,
                    max_age_seconds=conf.get("MAX_AGE_SECONDS"),
                    errors=conf.get("ERRORS", "respond"),
                    on_refusal=refusal,
                    trust_refresh=conf.get("TRUST_REFRESH", True),
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


class PolarisKeyMiddleware:
    """Authenticate every request into ``request.polaris``. It never refuses by itself."""

    sync_capable = True
    async_capable = False

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        get_polaris()  # a bad configuration fails at start

    def __call__(self, request: HttpRequest) -> HttpResponse:
        _auth_of(request)
        return self.get_response(request)


def _gate(require: Tuple[Requirement, ...]) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    def wrap(view: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(view)
        def inner(request: HttpRequest, *args: Any, **kwargs: Any) -> Any:
            polaris = get_polaris()
            auth = polaris.check(_auth_of(request), require, request.headers.get("Accept-Language"))
            request.polaris = auth  # type: ignore[attr-defined]
            if auth.problem is not None:
                if polaris.errors == "raise":
                    raise PolarisKeyError(auth.problem)
                if polaris.on_refusal is not None:
                    return polaris.on_refusal(auth.problem, request)
                return problem_response(auth.problem)
            return view(request, *args, **kwargs)

        return inner

    return wrap


def require_license() -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    return _gate(())


def require_entitlement(
    name: str, test: Optional[Callable[[Any], bool]] = None
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    return _gate((entitlement(name, test),))


def require_sign_in() -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    return _gate((signin(),))
