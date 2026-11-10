"""``identity.access_token()`` (identity.accesstoken, D6, WIRE-CONTRACT-V5 §12.13.10): the app's own
short-lived access token for its own backend, from its device token (RFC 8693 device exchange).

WHAT IT PROVES: this device holds a sign-in (``sub`` is the device's pairwise subject, ``client_id``
the product). It is NOT a licence check: no tier, no entitlement, and a signed-in device has one
whether or not its licence is valid. A backend that sells a licensed feature also checks the licence
(the server drop-ins).

Discovery gates it: only a product whose identity fragment carries ``accessToken: true`` (its issuer is
served) is asked; otherwise the call raises the typed ``service-unavailable`` N/A with no request. The
token lives in memory only (never stored, never logged), is reused until 60 seconds before it expires
(§12.13.10 rule 4, not the 30 minute document margin), is asked for once at a time, is bound to the device
token it was asked with (another token is a miss) and is dropped at sign-out. After a 429 the SDK asks
nothing until the wait has passed. The endpoint must be on the Worker's origin and is never followed
through a redirect. The SDK never verifies it: the app's backend does, against the issuer's key set.

Mirrors ``@polaris-key/client-core``'s ``identityAccessToken.ts`` and ``@polaris-key/node``'s
``identity/accessToken.ts``.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlsplit

from ..constants_generated import ErrorCode, Feature, UnsupportedReason
from ..core.caps import Unsupported, UnsupportedError
from ..core.context import CoreContext, refusal_error
from ..core.errors import PolarisError
from ..core.manage import manage_form_encode
from ..core.token import TokenManager
from .account import identity_fragment_from

__all__ = [
    "ACCESS_TOKEN_REUSE_MARGIN_SECONDS",
    "AccessToken",
    "AccessTokenCache",
    "AccessTokens",
    "access_token_form",
    "read_access_token",
]

#: §12.13.10 rule 4: a cached token is reused until this many seconds before it expires.
ACCESS_TOKEN_REUSE_MARGIN_SECONDS = 60

_TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
_DEVICE_SUBJECT_TOKEN_TYPE = "urn:polaris-key:token-type:device"
_ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"
_TOKEN_CONTENT_TYPE = "application/x-www-form-urlencoded"
#: The longest ``access_token`` accepted: a longer value is ``bad_response``.
_MAX_ACCESS_TOKEN_CHARS = 8192
_COMPACT_JWS = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")


@dataclass(frozen=True)
class AccessToken:
    """What ``identity.access_token()`` answers. ``access_token`` is the compact ``at+jwt``, for
    ``Authorization: Bearer ...`` on the app's own backend; it is kept in memory only and is left out of
    ``repr``."""

    access_token: str = field(repr=False)
    expires_in: int
    #: Epoch seconds, by the SDK's clock.
    expires_at: int
    token_type: str = "Bearer"


def access_token_form(client_id: str, device_token: str) -> str:
    """The exchange form body. Member order is fixed so every SDK sends the same bytes."""
    if not client_id or not device_token:
        raise PolarisError(
            ErrorCode.INVALID_ARGUMENT, "an access token needs the product and the device token."
        )
    pairs = (
        ("grant_type", _TOKEN_EXCHANGE_GRANT_TYPE),
        ("client_id", client_id),
        ("subject_token", device_token),
        ("subject_token_type", _DEVICE_SUBJECT_TOKEN_TYPE),
        ("requested_token_type", _ACCESS_TOKEN_TYPE),
    )
    return "&".join(f"{manage_form_encode(k)}={manage_form_encode(v)}" for k, v in pairs)


def read_access_token(body: Any) -> "tuple[str, int]":
    """Read a ``200`` answer: exactly an ``access_token`` (a compact JWS), ``issued_token_type`` the
    access-token type, ``token_type`` ``Bearer`` and a positive integer ``expires_in``; anything else is
    ``bad_response``. Nothing is verified. Answers ``(access_token, expires_in)``."""
    b: Dict[str, Any] = body if isinstance(body, dict) else {}
    token = b.get("access_token")
    expires = b.get("expires_in")
    if (
        not isinstance(token, str)
        or len(token) > _MAX_ACCESS_TOKEN_CHARS
        or _COMPACT_JWS.fullmatch(token) is None
        or b.get("issued_token_type") != _ACCESS_TOKEN_TYPE
        or b.get("token_type") != "Bearer"
        or not isinstance(expires, int)
        or isinstance(expires, bool)
        or expires <= 0
    ):
        raise PolarisError(
            ErrorCode.BAD_RESPONSE,
            "the access token exchange answered without a usable access token.",
        )
    return token, expires


class _Flight:
    """One exchange in progress, the device token it asks with, and what the callers waiting on it get."""

    def __init__(self, key: str) -> None:
        self.key = key
        self.done = threading.Event()
        self.token: Optional[AccessToken] = None
        self.error: Optional[BaseException] = None


class AccessTokenCache:
    """The one in-memory access token of a client. ``get(key, exchange)`` returns the held token while it
    was asked for with the same ``key`` (the device token) and more than
    :data:`ACCESS_TOKEN_REUSE_MARGIN_SECONDS` remain, and otherwise runs ``exchange`` once: callers with the
    same key that arrive while it runs share its answer, a caller with another key does not. ``refresh=True``
    skips the held token (an app whose backend refused it asks for a new one); it still joins an exchange in
    flight. A refused or failed exchange is not cached. After :meth:`hold_off` no exchange starts until the
    time has passed. ``clear`` drops the token and detaches any exchange in flight, so its answer is not kept
    after a sign-out."""

    def __init__(self, now: Callable[[], int]) -> None:
        self._now = now
        self._lock = threading.Lock()
        self._held: Optional[AccessToken] = None
        self._held_key: Optional[str] = None
        self._pending: Optional[_Flight] = None
        self._generation = 0
        self._not_before = 0

    def hold_off(self, seconds: int) -> None:
        """No exchange starts for ``seconds`` (a 429's wait). The limit is the device's, so a sign-out
        does not lift it."""
        with self._lock:
            self._not_before = max(self._not_before, self._now() + seconds)

    def get(
        self, key: str, exchange: Callable[[], "tuple[str, int]"], *, refresh: bool = False
    ) -> AccessToken:
        with self._lock:
            t = self._now()
            held = self._held
            if (
                not refresh
                and held is not None
                and self._held_key == key
                and held.expires_at - ACCESS_TOKEN_REUSE_MARGIN_SECONDS > t
            ):
                return AccessToken(held.access_token, held.expires_at - t, held.expires_at)
            flight = self._pending
            if flight is not None and flight.key == key:
                owner = False
            else:
                if self._not_before > t:
                    wait = self._not_before - t
                    raise PolarisError(
                        ErrorCode.RATE_LIMITED,
                        f"too many access token requests: try again in {wait} seconds.",
                        status=429,
                        retry_after_seconds=wait,
                    )
                flight = self._pending = _Flight(key)
                generation = self._generation
                owner = True
        if not owner:
            flight.done.wait()
            if flight.error is not None:
                raise flight.error
            assert flight.token is not None
            return flight.token
        try:
            token_text, expires_in = exchange()
            expires_at = self._now() + expires_in
            token = AccessToken(token_text, expires_in, expires_at)
            with self._lock:
                # Kept only while this is still the client's exchange: a `clear()` (sign-out) or a call
                # with another device token while it ran means the answer is not ours to keep.
                if self._generation == generation and self._pending is flight:
                    self._held = token
                    self._held_key = key
            flight.token = token
            return token
        except BaseException as e:
            flight.error = e
            raise
        finally:
            with self._lock:
                if self._pending is flight:
                    self._pending = None
            flight.done.set()

    def clear(self) -> None:
        """Drop the token and any exchange in flight (sign-out, deactivation)."""
        with self._lock:
            self._generation += 1
            self._held = None
            self._held_key = None
            self._pending = None


class AccessTokens:
    """``identity.access_token()``. Constructed by :class:`~polaris_key.identity.client.IdentityClient`."""

    def __init__(
        self,
        ctx: CoreContext,
        tokens: TokenManager,
        discover: Callable[[], Optional[Dict[str, Any]]],
    ) -> None:
        self._ctx = ctx
        self._tokens = tokens
        self._discover = discover
        self._cache = AccessTokenCache(ctx.now)

    def clear(self) -> None:
        """Drop the held token (sign-out, deactivation)."""
        self._cache.clear()

    def get(self, refresh: bool = False) -> AccessToken:
        ctx = self._ctx
        doc = self._discover()
        ctx.require_service("identity", Feature.IDENTITY_ACCESSTOKEN)
        fragment = identity_fragment_from(doc)
        endpoint = fragment["endpoints"].get("token") if fragment else None
        if not fragment or fragment.get("accessToken") is not True or not endpoint:
            raise _unavailable(
                "this product's discovery names no access token exchange: its sign-in issuer is not served"
            )
        if _origin_of(endpoint) != _origin_of(ctx.base_url):
            raise _unavailable("this product's access token endpoint is not on the Worker's origin")
        # Read at the time of the call: a device that is not signed in has none, and nothing is sent.
        device_token = self._tokens.current
        if not device_token:
            raise PolarisError(ErrorCode.NO_TOKEN, "Sign in before asking for an access token.")
        try:
            return self._cache.get(
                device_token, lambda: self._exchange(endpoint, device_token), refresh=refresh
            )
        except PolarisError as e:
            if e.code == ErrorCode.INVALID_GRANT:
                # The Worker's one refusal for a device that holds no sign-in: nothing held is good any more.
                self._cache.clear()
            elif e.code == ErrorCode.RATE_LIMITED and e.retry_after_seconds:
                self._cache.hold_off(e.retry_after_seconds)
            raise

    def _exchange(self, endpoint: str, device_token: str) -> "tuple[str, int]":
        ctx = self._ctx
        res = ctx.request(
            "POST",
            endpoint,
            headers=ctx.headers({"content-type": _TOKEN_CONTENT_TYPE}),
            content=access_token_form(ctx.product, device_token).encode("utf-8"),
            # The device token is in the body: never replay it at a redirect's address.
            follow_redirects=False,
        )
        if 300 <= res.status_code < 400:
            raise PolarisError(
                ErrorCode.BAD_RESPONSE,
                "the access token endpoint answered with a redirect.",
                status=res.status_code,
            )
        if res.status_code != 200:
            err = refusal_error(res, "access token")
            if err.retry_after_seconds is None:
                err.retry_after_seconds = _retry_after_of(res)
            raise err
        try:
            body = res.json()
        except ValueError:
            body = None
        return read_access_token(body)


def _unavailable(detail: str) -> UnsupportedError:
    return UnsupportedError(
        Unsupported(Feature.IDENTITY_ACCESSTOKEN, UnsupportedReason.PRODUCT, detail),
        ErrorCode.SERVICE_UNAVAILABLE,
    )


def _origin_of(url: str) -> "tuple[str, str, int]":
    """(scheme, host, port) of an absolute URL, the port defaulted; empty parts when it is not one."""
    try:
        u = urlsplit(url)
        scheme = u.scheme.lower()
        return scheme, (u.hostname or "").lower(), u.port or (443 if scheme == "https" else 80)
    except ValueError:
        return "", "", 0


def _retry_after_of(res: Any) -> Optional[int]:
    """The 429's wait: the ``Retry-After`` header, else the body's ``retryAfter`` (the recording carries
    only that), rounded up."""
    raw = res.headers.get("retry-after")
    if raw is not None:
        try:
            n = int(str(raw).strip())
            if n >= 0:
                return n
        except ValueError:
            pass
    try:
        b = res.json()
    except ValueError:
        return None
    v = b.get("retryAfter") if isinstance(b, dict) else None
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 and v == v and v != float("inf"):
        return int(-(-v // 1))
    return None
