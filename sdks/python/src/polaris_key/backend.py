"""``client.backend`` — the client half of a product backend (WIRE-CONTRACT-V4 §14, framework
drop-ins §6). It sends the app's signed licence document to the app's own backend::

    httpx.Client(auth=client.backend.httpx_auth())
    requests.get(url, auth=client.backend.requests_auth())
    headers = client.backend.headers()      # raw: you decide where they go

The headers are ``X-PKey-License`` (the compact licence JWS, when one is held) and
``X-PKey-Device``. Never the device token, never the config document. A URL whose origin is not
in ``backend.origins`` (exact, HTTPS only except loopback) is refused with
``backend-origin-not-allowed`` before anything is sent. Redirects: ``requests`` is checked on every
hop before it is sent; ``httpx`` runs an auth once per request and follows redirects inside it, so
keep ``follow_redirects`` off (httpx's default; you send the next hop, and it goes through this
auth) or list every redirect target in ``backend.origins``. A response that arrives through a redirect to
another origin raises anyway, but by then that hop has seen the headers. The rule is :func:`client_backend_action` (``backend-matrix.json``'s
``client`` section): refresh a document within ``REFRESH_MARGIN_SECONDS`` of its expiry before
sending, force a sync and retry once on ``license_stale`` or ``license_invalid``, and never retry
``not_entitled`` or ``sign_in_required``: those raise a :class:`~polaris_key.PolarisError` with
the status and the copy. Concurrent callers share one sync. A failed sync hands back the
backend's own response. The developer's own ``Authorization`` header passes through untouched.
"""

from __future__ import annotations

import json
import threading
from concurrent.futures import Future
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Callable, Dict, Generator, Iterable, Optional, Tuple
from urllib.parse import urljoin, urlsplit

import httpx

from . import copy
from .constants_generated import ErrorCode
from .core.errors import PolarisError
from .core.models import REFRESH_MARGIN_SECONDS
from .server._verdict import HEADER_LICENSE

__all__ = ["BackendClient", "client_backend_action", "normalize_backend_origin"]

HEADER_DEVICE = "X-PKey-Device"
_LOOPBACK = frozenset({"localhost", "127.0.0.1", "[::1]", "::1"})
_RETRY_CODES = frozenset({"license_stale", "license_invalid"})
_SURFACED = frozenset({"not_entitled", "sign_in_required"})
_DEFAULT_PORTS = {"https": 443, "http": 80}


def client_backend_action(
    document: Optional[Tuple[int, int]],
    now: int,
    response: Optional[Tuple[int, Optional[str]]],
    retried: bool = False,
) -> str:
    """§14.5: ``send``, ``refresh-then-send``, ``refresh-and-retry`` or ``surface``.

    ``document`` is ``(issuedAt, expiresAt)`` or ``None``; ``response`` is ``(status, code)``
    (the problem body's ``code``) or ``None`` before sending.
    """
    if response is None:
        if document is None:
            return "send"
        return "refresh-then-send" if now > document[1] - REFRESH_MARGIN_SECONDS else "send"
    status, code = response
    if status == 401 and code in _RETRY_CODES and not retried:
        return "refresh-and-retry"
    return "surface"


def normalize_backend_origin(origin: str) -> str:
    """One exact origin (``scheme://host[:port]``, lower-cased, default port dropped), or a
    ``PolarisError`` ``invalid-options``."""

    def bad() -> PolarisError:
        return PolarisError(
            ErrorCode.INVALID_OPTIONS,
            f"backend.origins: {origin!r} is not an exact origin "
            "(https://host[:port]; http only on loopback).",
        )

    if not isinstance(origin, str) or "*" in origin:
        raise bad()
    try:
        parts = urlsplit(origin)
        port = parts.port
    except ValueError:
        raise bad() from None
    host = parts.hostname
    if (
        host is None
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
        or parts.username is not None
        or parts.password is not None
        or origin.endswith("?")
        or origin.endswith("#")
    ):
        raise bad()
    scheme = parts.scheme.lower()
    shown = f"[{host}]" if ":" in host else host
    if not (scheme == "https" or (scheme == "http" and shown in _LOOPBACK)):
        raise bad()
    return _origin(scheme, shown, port)


def _origin(scheme: str, host: str, port: Optional[int]) -> str:
    if port is None or port == _DEFAULT_PORTS.get(scheme):
        return f"{scheme}://{host}"
    return f"{scheme}://{host}:{port}"


def _origin_of(url: str) -> Optional[str]:
    try:
        parts = urlsplit(url)
        host = parts.hostname
        if host is None or parts.scheme.lower() not in ("http", "https"):
            return None
        shown = f"[{host}]" if ":" in host else host
        return _origin(parts.scheme.lower(), shown, parts.port)
    except ValueError:
        return None


def _problem_code(status: int, body: Callable[[], bytes]) -> Optional[str]:
    """The problem body's ``code`` on a 401 or 403, else ``None``."""
    if status not in (401, 403):
        return None
    try:
        parsed = json.loads(body())
    except Exception:
        return None
    code = parsed.get("code") if isinstance(parsed, dict) else None
    return code if isinstance(code, str) else None


@dataclass
class _Flight:
    force: bool
    future: "Future[bool]"


class BackendClient:
    """``client.backend``. Built by :class:`~polaris_key.PolarisKeyClient`."""

    def __init__(
        self,
        *,
        held: Callable[[], Optional[Tuple[str, int, int]]],
        device_id: Callable[[], str],
        now: Callable[[], int],
        sync: Callable[[bool], bool],
        origins: Iterable[str] = (),
    ) -> None:
        self._held = held
        self._device_id = device_id
        self._now = now
        self._sync = sync
        self._allowed = frozenset(normalize_backend_origin(o) for o in origins)
        self._lock = threading.Lock()
        self._flight: Optional[_Flight] = None

    @property
    def origins(self) -> Tuple[str, ...]:
        """The configured origins, normalised."""
        return tuple(sorted(self._allowed))

    # ── The headers ─────────────────────────────────────────────────────────────────
    def headers(self) -> Dict[str, str]:
        """``X-PKey-License`` and ``X-PKey-Device``, raw. A document within the refresh margin
        of its expiry is synced first. Without a licence only ``X-PKey-Device`` is returned."""
        self._freshen()
        return self._build()

    def _build(self) -> Dict[str, str]:
        held = self._held()
        out: Dict[str, str] = {}
        if held is not None:
            out[HEADER_LICENSE] = held[0]
        out[HEADER_DEVICE] = self._device_id()
        return out

    def _action(self, response: Optional[Tuple[int, Optional[str]]], retried: bool = False) -> str:
        held = self._held()
        return client_backend_action(
            (held[1], held[2]) if held is not None else None, self._now(), response, retried
        )

    def _freshen(self) -> None:
        if self._action(None) == "refresh-then-send":
            self._shared(False)

    def _shared(self, force: bool) -> bool:
        """One sync for every concurrent caller; a forced caller joins only a forced one. True
        when the licence document is now current (applied or unchanged)."""
        with self._lock:
            live = self._flight
            if live is not None and (live.force or not force):
                flight, owner = live, False
            else:
                flight, owner = _Flight(force, Future()), True
                self._flight = flight
        if owner:
            try:
                try:
                    ok = bool(self._sync(force))
                except Exception:
                    ok = False
                flight.future.set_result(ok)
            finally:
                with self._lock:
                    if self._flight is flight:
                        self._flight = None
        return flight.future.result()

    # ── Origins ─────────────────────────────────────────────────────────────────────
    def _assert_allowed(self, url: str) -> None:
        origin = _origin_of(url)
        if origin is None or origin not in self._allowed:
            raise PolarisError(
                ErrorCode.BACKEND_ORIGIN_NOT_ALLOWED,
                copy.message(ErrorCode.BACKEND_ORIGIN_NOT_ALLOWED, origin or url),
            )

    @staticmethod
    def _surface(status: int, code: Optional[str]) -> None:
        if status == 403 and code in _SURFACED:
            raise PolarisError(code, copy.message(code), status=status)

    # ── httpx ───────────────────────────────────────────────────────────────────────
    def httpx_auth(self) -> httpx.Auth:
        """An ``httpx.Auth`` for ``httpx.Client`` and ``httpx.AsyncClient``."""
        return _HttpxAuth(self)

    # ── requests ────────────────────────────────────────────────────────────────────
    def requests_auth(self) -> Any:
        """A ``requests.auth.AuthBase`` (needs ``requests``, the ``polaris-key[requests]``
        extra)."""
        try:
            from requests.auth import AuthBase
        except ImportError as e:  # pragma: no cover - exercised only without requests
            raise ImportError(
                "client.backend.requests_auth() needs requests: pip install 'polaris-key[requests]'"
            ) from e
        return _make_requests_auth(AuthBase)(self)


class _HttpxAuth(httpx.Auth):
    requires_request_body = True

    def __init__(self, backend: BackendClient) -> None:
        self._backend = backend

    def _attach(self, request: httpx.Request) -> None:
        for name, value in self._backend._build().items():
            request.headers[name] = value

    def _check_history(self, response: httpx.Response) -> None:
        """A response that came through a redirect to another origin is not handed back."""
        for hop in (*response.history, response):
            self._backend._assert_allowed(str(hop.url))

    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        b = self._backend
        b._assert_allowed(str(request.url))
        b._freshen()
        self._attach(request)
        response = yield request
        self._check_history(response)
        code = _problem_code(response.status_code, lambda: (response.read(), response.content)[1])
        if b._action((response.status_code, code)) == "refresh-and-retry":
            if b._shared(True):
                self._attach(request)
                response = yield request
                code = _problem_code(
                    response.status_code, lambda: (response.read(), response.content)[1]
                )
        b._surface(response.status_code, code)

    async def async_auth_flow(
        self, request: httpx.Request
    ) -> AsyncGenerator[httpx.Request, httpx.Response]:
        import asyncio

        b = self._backend
        b._assert_allowed(str(request.url))
        await asyncio.to_thread(b._freshen)
        self._attach(request)
        response = yield request
        self._check_history(response)
        await response.aread()
        code = _problem_code(response.status_code, lambda: response.content)
        if b._action((response.status_code, code)) == "refresh-and-retry":
            if await asyncio.to_thread(b._shared, True):
                self._attach(request)
                response = yield request
                await response.aread()
                code = _problem_code(response.status_code, lambda: response.content)
        b._surface(response.status_code, code)


def _make_requests_auth(base: Any) -> Any:
    class _RequestsAuth(base):  # type: ignore[misc, valid-type]
        def __init__(self, backend: BackendClient) -> None:
            self._backend = backend

        def __call__(self, r: Any) -> Any:
            b = self._backend
            b._assert_allowed(r.url)
            b._freshen()
            r.headers.update(b._build())
            r.register_hook("response", self._on_response)
            return r

        def _on_response(self, r: Any, **kwargs: Any) -> Any:
            b = self._backend
            # A redirect: the next hop carries our headers, so it must be an allowed origin.
            location = r.headers.get("location")
            if r.status_code in (301, 302, 303, 307, 308) and location:
                b._assert_allowed(urljoin(r.url, location))
                return r
            code = _problem_code(r.status_code, lambda: r.content)
            retried = getattr(r.request, "_pkey_retried", False)
            if b._action((r.status_code, code), retried) == "refresh-and-retry" and b._shared(True):
                r.content  # read the body so the connection is released
                r.close()
                prep = r.request.copy()
                prep.headers.update(b._build())
                prep._pkey_retried = True  # type: ignore[attr-defined]
                retry = r.connection.send(prep, **kwargs)
                retry.history.append(r)
                retry.request = prep
                r = retry
                code = _problem_code(r.status_code, lambda: r.content)
            b._surface(r.status_code, code)
            return r

    return _RequestsAuth
