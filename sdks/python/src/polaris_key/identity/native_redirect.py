"""The native redirect sign-in (WIRE-CONTRACT-V5 §12.12; I-15b.3): the app pushes its authorization
request, opens the system browser at ``authorize`` with the ``request_uri`` it got back, and
receives the code on a redirect it owns: a loopback listener (the desktop default), a registered
scheme or a claimed HTTPS link. ``identity.sign_in.start(channel="redirect")`` with no
``redirect_uri`` begins one; ``identity.sign_in.handle_redirect(url)`` takes a scheme or claimed
delivery.

A port of ``@polaris-key/client-core``'s ``redirect.ts`` (the pure helpers, with its vectors in
``tests/test_identity_native_redirect.py``) plus the host half: :class:`LoopbackListener` and
:class:`NativeSignInSession`.

The pure half: :func:`choose_redirect_class`, :func:`native_redirect_uri` /
:func:`classify_native_redirect_uri`, :func:`push_request`, :func:`parse_pushed_answer`,
:func:`authorize_url_for`, :func:`parse_native_callback` and :func:`native_token_request`.

Listener rules (§12.12 item 6): bind ``127.0.0.1`` only, on an OS-assigned port, BEFORE the request
is pushed and keep the socket until the callback; accept ``GET /pkey/callback`` whose ``Host`` is
``127.0.0.1:<port>`` and whose ``state`` matches (constant time); answer anything else ``404`` and
keep listening; check ``iss``; answer ``303`` to the customer host's return page with
``Referrer-Policy: no-referrer`` and ``no-store``; close on the first match or after 600 s; serve
no HTML and send no CORS headers.

The verifier, the code and the token are never put in a URL, a log or an error message by this
module (the listener's request log is switched off), and a pending request is used for ONE
callback check and one token request, then dropped.
"""

from __future__ import annotations

import hmac
import http.server
import os
import re
import socket
import socketserver
import sys
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from ..constants_generated import ErrorCode, Feature
from ..core.errors import PolarisError
from .redirect import (
    AUTHORIZE_STATE_MAX,
    AUTHORIZE_STATE_MIN,
    KEY_RETURN_ALLOW,
    PKCE_VERIFIER_MAX,
    PKCE_VERIFIER_MIN,
    TOKEN_CONTENT_TYPE,
    RandomBytes,
    RedirectPending,
    SignInError,
    _form_body,
    _query_of,
    generate_code_verifier,
    generate_state,
    pkce_challenge,
    redeem_code,
    token_form,
)
from .sign_in import CANCELLED, EXPIRED, PENDING, SignInDeps, SignInOutcome

__all__ = [
    "LISTENER_LIFETIME_SECONDS",
    "NATIVE_REDIRECT_PATH",
    "PUSHED_REQUEST_TTL_SECONDS",
    "LoopbackListener",
    "NativeCallbackResult",
    "NativePending",
    "NativeSignInSession",
    "NativeTokenRequest",
    "PushedAnswer",
    "PushedRequest",
    "RedirectChoice",
    "authorize_url_for",
    "choose_redirect_class",
    "classify_native_redirect_uri",
    "constant_time_equal",
    "is_headless",
    "native_redirect_uri",
    "native_token_request",
    "parse_native_callback",
    "parse_pushed_answer",
    "push_request",
    "start_native_sign_in",
]

#: The one path of the loopback and scheme redirect URIs (RFC 8252 §7).
NATIVE_REDIRECT_PATH = "/pkey/callback"
#: How long a pushed request lives (RFC 9126 ``expires_in``), and the listener with it.
PUSHED_REQUEST_TTL_SECONDS = 600
LISTENER_LIFETIME_SECONDS = float(PUSHED_REQUEST_TTL_SECONDS)

_VERIFIER = re.compile(r"[A-Za-z0-9\-._~]+")
_PRINTABLE = re.compile(r"[\x21-\x7e]+")
_SCHEME = re.compile(r"[a-z][a-z0-9+.\-]*")
_REQUEST_URI = re.compile(r"urn:ietf:params:oauth:request_uri:[A-Za-z0-9_-]{22}")
_REQUEST_HANDLE = re.compile(r"rq_[A-Za-z0-9_-]{22}")
_BAD_URI = re.compile(r"[\s\x00-\x1f\x7f\\]")
_LOOPBACK = re.compile(r"http://(127\.0\.0\.1|\[::1\]):([0-9]{1,5})(/.*)")
_HTTPS = re.compile(r"https://([^/?#@]+)(/[^?#]*)")
_SCHEMED = re.compile(r"([a-z][a-z0-9+.\-]*):(/[^?#]*)")
_ENDPOINT = re.compile(r"https?://[^\s]+")
_BASE = re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*):(//[^/?#]*)?([^?#]*)")
#: A URL scheme a native redirect never uses: the web's own.
_RESERVED_SCHEMES = frozenset({"http", "https", "javascript", "data", "file"})


def _invalid(message: str) -> PolarisError:
    return PolarisError(ErrorCode.INVALID_ARGUMENT, message)


def constant_time_equal(a: str, b: str) -> bool:
    """String equality without an early exit on the first differing character."""
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


# ── 1. The class ─────────────────────────────────────────────────────────────────────


def is_headless(env: Optional[Mapping[str, str]] = None, platform: Optional[str] = None) -> bool:
    """SIGN-IN D-68: ``SSH_CONNECTION`` or ``SSH_TTY``, ``CI``, or on Linux no ``DISPLAY`` and no
    ``WAYLAND_DISPLAY``. A headless host cannot open a browser for a loopback listener."""
    e = os.environ if env is None else env
    plat = sys.platform if platform is None else platform
    return (
        bool(e.get("SSH_CONNECTION") or e.get("SSH_TTY"))
        or bool(e.get("CI"))
        or (plat.startswith("linux") and not e.get("DISPLAY") and not e.get("WAYLAND_DISPLAY"))
    )


@dataclass(frozen=True)
class RedirectChoice:
    """``kind`` is ``"loopback"``, ``"scheme"`` / ``"claimed"`` (``redirect_uri`` the registered
    URI) or ``"unavailable"`` (``code`` is ``redirect-unavailable``; ``reason`` is
    ``request-not-served`` or ``no-class``): the kit then offers a code."""

    kind: str
    redirect_uri: Optional[str] = None
    code: Optional[str] = None
    reason: Optional[str] = None


def choose_redirect_class(
    *,
    request_endpoint: Optional[str],
    discovery: Optional[Mapping[str, Any]],
    can_listen: bool,
    registered_schemes: Sequence[str] = (),
    registered_claimed: Sequence[str] = (),
) -> RedirectChoice:
    """The order is fixed: loopback (desktop), the registered scheme, claimed HTTPS, else the
    fallback. A class is used only when discovery lists it AND the host has it; discovery with no
    ``request`` or no ``nativeRedirect`` is ``request-not-served``."""
    unavailable = ErrorCode.REDIRECT_UNAVAILABLE
    if not request_endpoint or not isinstance(discovery, Mapping):
        return RedirectChoice(kind="unavailable", code=unavailable, reason="request-not-served")
    if can_listen and discovery.get("loopback") is True:
        return RedirectChoice(kind="loopback")
    schemes = discovery.get("schemes") or []
    for uri in registered_schemes:
        if uri in schemes:
            return RedirectChoice(kind="scheme", redirect_uri=uri)
    claimed = discovery.get("claimedHttps") or []
    for uri in registered_claimed:
        if uri in claimed:
            return RedirectChoice(kind="claimed", redirect_uri=uri)
    return RedirectChoice(kind="unavailable", code=unavailable, reason="no-class")


# ── 2. The redirect URI ──────────────────────────────────────────────────────────────


def classify_native_redirect_uri(uri: Any) -> Optional[str]:
    """``"loopback"``, ``"claimed"`` or ``"scheme"``, or ``None`` when it is none (§12.12:
    ``localhost``, another path, a query, a fragment, userinfo, port 80 or no port)."""
    if not isinstance(uri, str) or uri == "" or len(uri) > 2048 or _BAD_URI.search(uri):
        return None
    loop = _LOOPBACK.fullmatch(uri)
    if loop:
        port_text = loop.group(2)
        port = int(port_text)
        ok = (
            1 <= port <= 65535
            and port != 80
            and loop.group(3) == NATIVE_REDIRECT_PATH
            and not (len(port_text) > 1 and port_text.startswith("0"))
        )
        return "loopback" if ok else None
    https = _HTTPS.fullmatch(uri)
    if https and https.group(2) != "/":
        return "claimed"
    scheme = _SCHEMED.fullmatch(uri)
    if scheme:
        ok = scheme.group(1) not in _RESERVED_SCHEMES and scheme.group(2) == NATIVE_REDIRECT_PATH
        return "scheme" if ok else None
    return None


def native_redirect_uri(cls: str, *, port: Optional[int] = None, scheme: Optional[str] = None) -> str:
    """The loopback redirect URI of a listener's OS-assigned port (``cls="loopback"``), or a
    registered scheme's ``<scheme>:/pkey/callback`` (``cls="scheme"``)."""
    if cls == "loopback":
        if not isinstance(port, int) or isinstance(port, bool) or port < 1 or port > 65535 or port == 80:
            raise _invalid("the loopback port must be an explicit port other than 80.")
        uri = f"http://127.0.0.1:{port}{NATIVE_REDIRECT_PATH}"
    elif cls == "scheme":
        name = scheme or ""
        if _SCHEME.fullmatch(name) is None or name in _RESERVED_SCHEMES:
            raise _invalid("the scheme is not a registrable URL scheme.")
        uri = f"{name}:{NATIVE_REDIRECT_PATH}"
    else:
        raise _invalid("not a native redirect class.")
    if classify_native_redirect_uri(uri) != cls:
        raise _invalid("not a native redirect URI.")
    return uri


# ── 3. The pushed request ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class NativePending:
    """One pending native sign-in. A secret holder: ``code_verifier`` is not in ``repr`` and is
    never logged or put in a URL."""

    redirect_class: str
    redirect_uri: str
    state: str = field(repr=False)
    code_verifier: str = field(repr=False)
    client_id: str
    issuer: str
    authorize_endpoint: str
    token_endpoint: str = field(repr=False)
    #: The push carried ``license_choice=app``: the token endpoint may answer ``choose``.
    license_choice: bool = False
    #: The push carried ``key_return=allow``: the token endpoint may answer ``activated``.
    key_return: bool = False


@dataclass(frozen=True)
class PushedRequest:
    """``POST`` ``body`` to ``url`` with ``content_type``; the caller adds ``X-PKey-Device`` and
    the SDK headers."""

    url: str
    content_type: str
    body: str = field(repr=False)
    pending: NativePending


def _scope_text(scope: Union[str, Sequence[str]]) -> str:
    text = scope if isinstance(scope, str) else " ".join(scope)
    parts = [p for p in text.split(" ") if p != ""]
    if not parts or any(_PRINTABLE.fullmatch(p) is None for p in parts):
        raise _invalid("scope must be a space-delimited list of printable scopes.")
    return " ".join(parts)


def push_request(
    *,
    request_endpoint: str,
    authorize_endpoint: str,
    token_endpoint: str,
    issuer: str,
    client_id: str,
    redirect_uri: str,
    device_name: Optional[str] = None,
    return_uri: Optional[str] = None,
    scope: Union[None, str, Sequence[str]] = None,
    nonce: Optional[str] = None,
    login_hint: Optional[str] = None,
    name_hint: Optional[str] = None,
    purpose: Optional[str] = None,
    license_choice: Optional[str] = None,
    choice_available: bool = False,
    key_return: bool = False,
    random: Optional[RandomBytes] = None,
    state: Optional[str] = None,
    code_verifier: Optional[str] = None,
) -> PushedRequest:
    """Build the pushed request. Nothing here touches the network. Member order: ``response_type
    client_id redirect_uri state code_challenge code_challenge_method [scope] [nonce] [login_hint]
    [name_hint] [purpose] [license_choice] [key_return] [device_name] [return_uri]``. ``scope`` is left out when
    not given (the Worker defaults it); ``license_choice="app"`` is sent only when
    ``choice_available`` (I-08b); ``key_return=True`` sends ``key_return=allow`` (off by default)."""
    redirect_class = classify_native_redirect_uri(redirect_uri)
    if redirect_class is None:
        raise _invalid("redirect_uri is not a native redirect URI.")
    if return_uri is not None and classify_native_redirect_uri(return_uri) != "scheme":
        raise _invalid("return_uri must be a registered scheme's redirect URI.")
    for name, value in (
        ("request", request_endpoint),
        ("authorize", authorize_endpoint),
        ("token", token_endpoint),
    ):
        if not isinstance(value, str) or _ENDPOINT.fullmatch(value) is None:
            raise _invalid(f"the {name} endpoint is not an absolute URL.")
    if not isinstance(issuer, str) or issuer == "":
        raise _invalid("discovery names no issuer.")
    if not isinstance(client_id, str) or client_id == "":
        raise _invalid("client_id is empty.")
    st = state if state is not None else generate_state(random)
    if len(st) < AUTHORIZE_STATE_MIN or len(st) > AUTHORIZE_STATE_MAX or _PRINTABLE.fullmatch(st) is None:
        raise _invalid("state must be 16 to 512 printable characters.")
    verifier = code_verifier if code_verifier is not None else generate_code_verifier(random)
    if len(verifier) < PKCE_VERIFIER_MIN or len(verifier) > PKCE_VERIFIER_MAX or _VERIFIER.fullmatch(verifier) is None:
        raise _invalid("the PKCE verifier must be 43 to 128 unreserved characters.")
    if nonce is not None and _PRINTABLE.fullmatch(nonce) is None:
        raise _invalid("nonce must be printable characters.")

    pairs: List[Tuple[str, str]] = [
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("state", st),
        ("code_challenge", pkce_challenge(verifier)),
        ("code_challenge_method", "S256"),
    ]
    if scope is not None:
        pairs.append(("scope", _scope_text(scope)))
    if nonce:
        pairs.append(("nonce", nonce))
    if login_hint:
        pairs.append(("login_hint", login_hint))
    if name_hint:
        pairs.append(("name_hint", name_hint))
    if purpose:
        pairs.append(("purpose", purpose))
    sent_choice = license_choice == "app" and choice_available is True
    if sent_choice:
        pairs.append(("license_choice", "app"))
    if key_return is True:
        pairs.append(("key_return", KEY_RETURN_ALLOW))
    if device_name:
        pairs.append(("device_name", device_name))
    if return_uri:
        pairs.append(("return_uri", return_uri))
    return PushedRequest(
        url=request_endpoint,
        content_type=TOKEN_CONTENT_TYPE,
        body=_form_body(pairs),
        pending=NativePending(
            redirect_class=redirect_class,
            redirect_uri=redirect_uri,
            state=st,
            code_verifier=verifier,
            client_id=client_id,
            issuer=issuer,
            authorize_endpoint=authorize_endpoint,
            token_endpoint=token_endpoint,
            license_choice=sent_choice,
            key_return=key_return is True,
        ),
    )


@dataclass(frozen=True)
class PushedAnswer:
    """``kind`` is ``"pushed"`` (``request_uri``, ``expires_in``), ``"refused"`` (the Worker's flat
    ``error``, the ``status`` and ``retry_after_seconds`` when it named one; a 5xx or a body with
    no ``error`` is ``server_error``) or ``"malformed"``."""

    kind: str
    request_uri: Optional[str] = None
    expires_in: Optional[int] = None
    error: Optional[str] = None
    status: Optional[int] = None
    retry_after_seconds: Optional[int] = None


def parse_pushed_answer(status: int, body: Any) -> PushedAnswer:
    """Read the answer of ``POST /<p>/identity/request``: ``201 {request_uri, expires_in}``."""
    if status != 201:
        b = body if isinstance(body, dict) else {}
        err = b.get("error")
        retry = b.get("retryAfter")
        seconds: Optional[int] = None
        if isinstance(retry, (int, float)) and not isinstance(retry, bool) and 0 < retry < float("inf"):
            seconds = min(int(-(-retry // 1)), 3600)
        return PushedAnswer(
            kind="refused",
            error=err if isinstance(err, str) and err != "" else "server_error",
            status=status,
            retry_after_seconds=seconds,
        )
    if not isinstance(body, dict):
        return PushedAnswer(kind="malformed")
    request_uri, expires_in = body.get("request_uri"), body.get("expires_in")
    if (
        not isinstance(request_uri, str)
        or _REQUEST_URI.fullmatch(request_uri) is None
        or not isinstance(expires_in, int)
        or isinstance(expires_in, bool)
        or expires_in < 1
        or expires_in > PUSHED_REQUEST_TTL_SECONDS
    ):
        return PushedAnswer(kind="malformed")
    return PushedAnswer(kind="pushed", request_uri=request_uri, expires_in=expires_in)


# ── 5. The authorize URL ─────────────────────────────────────────────────────────────


def authorize_url_for(authorize_endpoint: str, client_id: str, request_uri: str) -> str:
    """``authorize?client_id=<id>&request_uri=<uri>``: the only parameters a pushed request takes."""
    from ..core.manage import manage_form_encode

    if _REQUEST_URI.fullmatch(request_uri) is None:
        raise _invalid("not a pushed request URI.")
    sep = "&" if "?" in authorize_endpoint else "?"
    return (
        f"{authorize_endpoint}{sep}client_id={manage_form_encode(client_id)}"
        f"&request_uri={manage_form_encode(request_uri)}"
    )


# ── 6. The redirect back ─────────────────────────────────────────────────────────────

#: Refusals that leave a session waiting: a delivery that is not this sign-in's (another URL, a
#: wrong state, an unreadable query) cannot be allowed to end it.
_NOT_THIS_SIGN_IN = frozenset({"malformed", "redirect-mismatch", "state-mismatch"})
_SUCCESS_PARAMS = frozenset({"code", "state", "iss", "request"})
_ERROR_PARAMS = frozenset({"error", "error_description", "state", "iss", "request"})


@dataclass(frozen=True)
class NativeCallbackResult:
    """``kind`` is ``"code"``, ``"cancelled"`` or ``"failed"``. ``request`` is the ``rq_`` handle a
    loopback delivery carries. A failure's ``code`` is ``sign-in-failed`` and ``reason`` one of
    ``malformed``, ``redirect-mismatch``, ``state-mismatch``, ``issuer-mismatch``,
    ``authorization-error``, ``missing-code``, ``unexpected-parameter``, ``request-invalid``."""

    kind: str
    code: Optional[str] = field(default=None, repr=False)
    request: Optional[str] = None
    reason: Optional[str] = None
    error: Optional[str] = None


def _failed(reason: str, error: Optional[str] = None) -> NativeCallbackResult:
    return NativeCallbackResult(kind="failed", reason=reason, error=error)


def _base_of(url: str) -> Optional[str]:
    m = _BASE.match(url)
    if m is None:
        return None
    return f"{m.group(1).lower()}:{(m.group(2) or '').lower()}{m.group(3)}"


def parse_native_callback(
    pending: Union[NativePending, RedirectPending, Any], callback_url: Any
) -> NativeCallbackResult:
    """Check the redirect back to the app. The first failure wins, in this order: an absolute URL
    with no fragment; at the redirect URI the request named; no repeated parameter; ``state``
    (constant time); ``iss`` (RFC 9207: a callback with no ``iss`` is refused); ``error``
    (``access_denied`` is ``cancelled``); ``code``; no parameter beyond ``code state iss request``
    (or ``error error_description state iss request``); on loopback, ``request=`` an ``rq_`` handle
    (a scheme or claimed delivery has none, and one that carries it must still hold a valid one)."""
    if not isinstance(callback_url, str) or "#" in callback_url:
        return _failed("malformed")
    got, want = _base_of(callback_url), _base_of(pending.redirect_uri)
    if got is None or want is None:
        return _failed("malformed")
    if got != want:
        return _failed("redirect-mismatch")
    q = _query_of(callback_url)
    if q is None:
        return _failed("malformed")
    state = q.get("state")
    if state is None or not constant_time_equal(state, pending.state):
        return _failed("state-mismatch")
    iss = q.get("iss")
    if iss is None or not constant_time_equal(iss, pending.issuer):
        return _failed("issuer-mismatch")
    error, code = q.get("error"), q.get("code")
    if error is None and (code is None or code == ""):
        return _failed("missing-code")
    allowed = _ERROR_PARAMS if error is not None else _SUCCESS_PARAMS
    if any(name not in allowed for name in q):
        return _failed("unexpected-parameter")
    request = q.get("request")
    redirect_class = getattr(pending, "redirect_class", None) or classify_native_redirect_uri(pending.redirect_uri)
    if request is not None:
        if _REQUEST_HANDLE.fullmatch(request) is None:
            return _failed("request-invalid")
    elif redirect_class == "loopback" and error is None:
        return _failed("request-invalid")
    if error is not None:
        if error == "access_denied":
            return NativeCallbackResult(kind="cancelled", request=request)
        return _failed("authorization-error", error)
    return NativeCallbackResult(kind="code", code=code, request=request)


# ── 7. The token request ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class NativeTokenRequest:
    """``POST`` ``body`` to ``url``; ``headers`` hold the pusher's ``X-PKey-Device`` (a different
    device is ``invalid_grant``) and the content type. The caller adds the SDK headers."""

    url: str
    headers: Dict[str, str]
    body: str = field(repr=False)


def native_token_request(
    pending: NativePending, code: str, device_id: str, device_name: Optional[str] = None
) -> NativeTokenRequest:
    """``POST /<p>/identity/token`` for a code from a pushed request (§12.5)."""
    if not isinstance(device_id, str) or _PRINTABLE.fullmatch(device_id) is None:
        raise _invalid("device_id is empty or not printable.")
    return NativeTokenRequest(
        url=pending.token_endpoint,
        headers={"X-PKey-Device": device_id, "Content-Type": TOKEN_CONTENT_TYPE},
        body=token_form(pending.client_id, pending.code_verifier, pending.redirect_uri, code, device_name),
    )


# ── The loopback listener ────────────────────────────────────────────────────────────

#: ``accept(callback_url) -> (location, final)``: ``location`` is where to ``303`` (``None``
#: answers ``404``); ``final`` closes the listener after this answer.
Accept = Callable[[str], Tuple[Optional[str], bool]]


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    # Exclusive: no other socket may share the port while this one holds it.
    allow_reuse_address = False

    def server_bind(self) -> None:
        exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if exclusive is not None:  # Windows: SO_REUSEADDR would let another process share it.
            self.socket.setsockopt(socket.SOL_SOCKET, exclusive, 1)
        # TCPServer's bind, not HTTPServer's: that one asks the resolver for the host's FQDN.
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = int(self.socket.getsockname()[1])

    def handle_error(self, request: Any, client_address: Any) -> None:
        # The default prints a traceback (and the client address); nothing request-derived is logged.
        return None


class _Handler(http.server.BaseHTTPRequestHandler):
    """One request. Never writes a body, never logs a request line (it carries the code)."""

    protocol_version = "HTTP/1.0"
    timeout = 5.0
    server: _Server

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return None

    def log_request(self, code: Any = "-", size: Any = "-") -> None:
        return None

    def log_error(self, format: str, *args: Any) -> None:  # noqa: A002
        return None

    def _answer(self, status: int, location: Optional[str] = None) -> None:
        self.send_response(status)
        if location is not None:
            self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def send_error(  # type: ignore[override]
        self, code: int, message: Optional[str] = None, explain: Optional[str] = None
    ) -> None:
        # The standard library answers an HTML page; the listener serves none.
        self.close_connection = True
        self._answer(code)

    def do_GET(self) -> None:
        listener: LoopbackListener = self.server.listener  # type: ignore[attr-defined]
        target = self.path
        path, _, _query = target.partition("?")
        host = self.headers.get("Host")
        if (
            not target.startswith("/")
            or path != NATIVE_REDIRECT_PATH
            or host is None
            or host.lower() != f"127.0.0.1:{listener.port}"
        ):
            self._answer(404)
            return
        location, final = listener._accept_target(target)
        self._answer(303 if location is not None else 404, location)
        if final:
            listener._close_soon()

    def _not_found(self) -> None:
        self._answer(404)

    do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _not_found


class LoopbackListener:
    """A listener on ``127.0.0.1``. The socket is bound when it is built (an OS-assigned
    :attr:`port`), so the redirect URI is known before the request is pushed and no other
    process can take the port. :meth:`start` serves until the first accepted callback, the
    :attr:`lifetime` or :meth:`close`."""

    def __init__(self, *, lifetime: float = LISTENER_LIFETIME_SECONDS) -> None:
        self._server = _Server(("127.0.0.1", 0), _Handler)
        self._server.listener = self  # type: ignore[attr-defined]
        #: The OS-assigned port.
        self.port: int = int(self._server.server_address[1])
        self._lifetime = lifetime
        self._lock = threading.Lock()
        self._accept: Optional[Accept] = None
        self._thread: Optional[threading.Thread] = None
        self._timer: Optional[threading.Timer] = None
        self._done = False
        self._closed = False

    def start(self, accept: Accept) -> None:
        with self._lock:
            if self._closed or self._thread is not None:
                return
            self._accept = accept
            self._thread = threading.Thread(
                target=self._server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True
            )
            self._thread.start()
            self._timer = threading.Timer(self._lifetime, self.close)
            self._timer.daemon = True
            self._timer.start()

    def _accept_target(self, target: str) -> Tuple[Optional[str], bool]:
        """One request at the callback path. The first accepted one wins; every later one is a 404."""
        with self._lock:
            if self._done or self._closed or self._accept is None:
                return None, False
            accept = self._accept
        location, final = accept(f"http://127.0.0.1:{self.port}{target}")
        if final:
            with self._lock:
                if self._done:
                    return None, False
                self._done = True
        return location, final

    def _close_soon(self) -> None:
        threading.Thread(target=self.close, daemon=True).start()

    def close(self) -> None:
        """Stop listening and release the port. Safe to call more than once, from any thread."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            started = self._thread is not None
            timer = self._timer
        if timer is not None:
            timer.cancel()
        if started:
            self._server.shutdown()
        self._server.server_close()

    @property
    def closed(self) -> bool:
        return self._closed


# ── The session ──────────────────────────────────────────────────────────────────────


def _return_location(base: str, request: str, cancelled: bool) -> str:
    from ..core.manage import manage_form_encode

    sep = "&" if "?" in base else "?"
    return f"{base}{sep}request={manage_form_encode(request)}" + ("&cancelled=1" if cancelled else "")


class NativeSignInSession:
    """A native redirect sign-in: :attr:`authorize_url` is open in the system browser (or
    :meth:`reopen` opens it again), and :meth:`wait` settles it when the redirect arrives, on the
    loopback listener or through :meth:`handle_redirect`. Single use."""

    channel = "redirect"

    def __init__(
        self,
        *,
        pending: NativePending,
        authorize_url: str,
        expires_at: float,
        deps: SignInDeps,
        listener: Optional[Any],
        return_page: Optional[str],
        device_name: Optional[str],
    ) -> None:
        #: Open this in the system browser. It carries ``client_id`` and ``request_uri`` only.
        self.authorize_url = authorize_url
        #: ``"loopback"``, ``"scheme"`` or ``"claimed"``.
        self.redirect_class = pending.redirect_class
        #: The redirect URI the request named.
        self.redirect_uri = pending.redirect_uri
        #: When the pushed request lapses on THIS client's clock (epoch seconds).
        self.expires_at = expires_at
        #: The device label the sign-in page shows (§12.7.1), or ``None``.
        self.device_name = device_name
        #: Whether the host's opener ran for the first open.
        self.opened = False
        self._pending: Optional[NativePending] = pending
        self._deps = deps
        self._listener = listener
        self._return_page = return_page
        self._lock = threading.Lock()
        self._arrived = threading.Event()
        self._arrival: Optional[NativeCallbackResult] = None
        self._closed = False
        self._outcome: Optional[SignInOutcome] = None
        self._error: Optional[PolarisError] = None
        self._settle_lock = threading.Lock()

    def __repr__(self) -> str:
        return (
            f"NativeSignInSession(channel={self.channel!r}, redirect_class={self.redirect_class!r}, "
            f"authorize_url={self.authorize_url!r})"
        )

    # -- the person's browser --

    def reopen(self) -> bool:
        """SIGN-IN §3.17 *Open browser again*: the SAME authorize URL (no new push, state or
        verifier) while the request lives. ``False`` when it was cancelled or settled, or when no
        opener ran; ``sign-in-expired`` once the pushed request has lapsed."""
        with self._lock:
            closed = self._closed
        if closed:
            return False
        if self._deps.ctx.now() >= self.expires_at:
            raise PolarisError(ErrorCode.SIGN_IN_EXPIRED, "the sign-in request has expired; start again.")
        return self._open()

    def _open(self) -> bool:
        try:
            return bool(self._deps.open_url(self.authorize_url))
        except Exception:
            return False

    # -- the redirect back --

    def _view(self) -> Optional[NativePending]:
        with self._lock:
            return self._pending

    def _arrive(self, result: NativeCallbackResult) -> bool:
        with self._lock:
            if self._closed or self._arrival is not None:
                return False
            self._arrival = result
            self._arrived.set()
        return True

    def _on_listener_callback(self, url: str) -> Tuple[Optional[str], bool]:
        pending = self._view()
        if pending is None:
            return None, True
        result = parse_native_callback(pending, url)
        if result.kind == "failed" and result.reason in _NOT_THIS_SIGN_IN:
            return None, False
        if not self._arrive(result):
            return None, True
        if result.kind != "failed" and result.request and self._return_page:
            return _return_location(self._return_page, result.request, result.kind == "cancelled"), True
        return None, True

    def handle_redirect(self, url: str) -> SignInOutcome:
        """A scheme or claimed-HTTPS delivery: the URL the OS handed the app. Checks the redirect
        URI, ``state`` and ``iss`` before anything is sent, then redeems the code from this device.
        A delivery that is not this sign-in's (another URL or a wrong ``state``) is a
        ``sign-in-failed`` that leaves the sign-in waiting."""
        pending = self._view()
        if pending is None:
            raise SignInError(
                ErrorCode.SIGN_IN_FAILED,
                "this sign-in is already finished or was cancelled; start a new one.",
            )
        result = parse_native_callback(pending, url)
        if result.kind == "failed" and result.reason in _NOT_THIS_SIGN_IN:
            raise SignInError(ErrorCode.SIGN_IN_FAILED, f"the sign-in redirect was refused ({result.reason}).")
        if not self._arrive(result):
            raise SignInError(ErrorCode.SIGN_IN_FAILED, "this sign-in already received its redirect.")
        return self._settle()

    def _settle(self) -> SignInOutcome:
        """Redeem the arrived callback, once. A second call answers the same outcome or error."""
        with self._settle_lock:
            if self._error is not None:
                raise self._error
            if self._outcome is not None:
                return self._outcome
            with self._lock:
                arrival, pending = self._arrival, self._pending
                self._pending = None
            self._shut()
            try:
                if arrival is not None and arrival.kind == "cancelled":
                    self._outcome = SignInOutcome(kind=CANCELLED)
                elif arrival is None or pending is None:
                    raise SignInError(ErrorCode.SIGN_IN_FAILED, "this sign-in has no redirect to redeem.")
                elif arrival.kind == "failed":
                    raise SignInError(ErrorCode.SIGN_IN_FAILED, f"the sign-in redirect was refused ({arrival.reason}).")
                else:
                    # The label went with the push; the token request does not repeat it.
                    self._outcome = redeem_code(
                        self._deps,
                        RedirectPending(
                            authorize_url=self.authorize_url,
                            state=pending.state,
                            code_verifier=pending.code_verifier,
                            redirect_uri=pending.redirect_uri,
                            client_id=pending.client_id,
                            issuer=pending.issuer,
                            token_endpoint=pending.token_endpoint,
                            license_choice=pending.license_choice,
                            key_return=pending.key_return,
                        ),
                        arrival.code or "",
                        None,
                    )
            except PolarisError as e:
                self._error = e
                raise
            return self._outcome

    # -- ending --

    def _shut(self) -> None:
        with self._lock:
            self._closed = True
            listener = self._listener
        if listener is not None:
            listener.close()

    def cancel(self) -> None:
        """The person cancelled in the app: drop the pending request and close the listener.
        ``wait`` then answers ``cancelled``."""
        with self._lock:
            self._pending = None
            if self._arrival is None:
                self._arrival = NativeCallbackResult(kind="cancelled")
            self._arrived.set()
        self._shut()

    def wait(
        self,
        timeout: Optional[float] = None,
        *,
        once: bool = False,
        cancel_token: Optional[threading.Event] = None,
    ) -> SignInOutcome:
        """Block until the redirect arrives and the code is redeemed: ``signed_in``, ``choose``,
        ``cancelled`` or ``expired`` (the pushed request lapsed). ``once=True`` checks once and may
        answer ``pending``. A refusal raises a :class:`SignInError`; ``timeout`` (seconds) raises
        :class:`TimeoutError`; setting ``cancel_token`` cancels the sign-in."""
        deadline = None if timeout is None else self._deps.ctx.now() + timeout
        while True:
            if cancel_token is not None and cancel_token.is_set():
                self.cancel()
            if self._arrived.is_set():
                return self._settle()
            if self._deps.ctx.now() >= self.expires_at:
                with self._lock:
                    self._pending = None
                self._shut()
                return SignInOutcome(kind=EXPIRED)
            if once:
                return SignInOutcome(kind=PENDING)
            if deadline is not None and self._deps.ctx.now() >= deadline:
                raise TimeoutError("native sign-in did not complete within the timeout")
            self._arrived.wait(0.1)


# ── Starting one ─────────────────────────────────────────────────────────────────────


def _origin(url: str) -> Optional[str]:
    m = re.match(r"([A-Za-z][A-Za-z0-9+.\-]*)://([^/?#]*)", url)
    return f"{m.group(1).lower()}://{m.group(2).lower()}" if m else None


def _text(v: Any) -> Optional[str]:
    return v if isinstance(v, str) and v != "" else None


def start_native_sign_in(
    deps: SignInDeps,
    *,
    scope: Union[None, str, Sequence[str]] = None,
    login_hint: Optional[str] = None,
    name_hint: Optional[str] = None,
    purpose: Optional[str] = None,
    license_choice: Optional[str] = None,
    key_return: bool = False,
    device_name: Optional[str] = None,
    return_uri: Optional[str] = None,
    loopback: Optional[bool] = None,
    registered_schemes: Sequence[str] = (),
    registered_claimed: Sequence[str] = (),
    open_browser: bool = True,
) -> NativeSignInSession:
    """Begin a native redirect sign-in (§12.12). The class is the first that applies: loopback
    (unless ``loopback=False`` or the host is headless, D-68), a registered scheme, a claimed
    HTTPS link; none is ``redirect-unavailable`` (nothing was sent: the caller offers a code).

    The order of a loopback start is the listener's bind, the pushed request, then the browser,
    so the port is held before the Worker learns it. ``return_uri`` is a registered scheme's
    redirect URI for *Return to <App>*; it never carries a code. Every endpoint is used only
    when discovery names it, and the ones the device's headers reach must be on this product."""
    ctx = deps.ctx
    doc = deps.load_discovery() if deps.load_discovery is not None else deps.discovery()
    ctx.require_service("identity", Feature.IDENTITY_REDIRECT_NATIVE)
    services = doc.get("services") if isinstance(doc, dict) else None
    found = services.get("identity") if isinstance(services, dict) else None
    fragment: Dict[str, Any] = found if isinstance(found, dict) else {}
    listed = fragment.get("endpoints")
    endpoints: Dict[str, Any] = listed if isinstance(listed, dict) else {}
    request_endpoint = _text(endpoints.get("request"))
    authorize, token, issuer = (
        _text(endpoints.get("authorize")),
        _text(endpoints.get("token")),
        _text(fragment.get("issuer")),
    )
    return_page = _text(endpoints.get("signinReturn"))
    if return_page is not None:
        # The 303 target is the product's own customer host: the API origin or the issuer's.
        allowed = {_origin(ctx.base_url), _origin(issuer or "")}
        if _origin(return_page) not in allowed or not return_page.startswith("https://"):
            raise PolarisError(ErrorCode.INVALID_OPTIONS, "the return page is outside this product.")
    advertised = fragment.get("nativeRedirect")
    native = advertised if isinstance(advertised, dict) else None
    if request_endpoint is not None and (not authorize or not token or not issuer):
        raise PolarisError(ErrorCode.SIGN_IN_UNAVAILABLE, "this product's discovery serves no redirect sign-in.")
    headless = (deps.headless or is_headless)()
    can_listen = (not headless if loopback is None else loopback) and return_page is not None
    choice = choose_redirect_class(
        request_endpoint=request_endpoint,
        discovery=native,
        can_listen=can_listen,
        registered_schemes=registered_schemes,
        registered_claimed=registered_claimed,
    )
    if choice.kind == "unavailable":
        raise PolarisError(
            ErrorCode.REDIRECT_UNAVAILABLE,
            f"no native redirect can start here; sign in with a code instead ({choice.reason}).",
        )
    assert request_endpoint and authorize and token and issuer
    product_origin = ctx.url("")
    if not token.startswith(product_origin) or not request_endpoint.startswith(product_origin):
        raise PolarisError(ErrorCode.BAD_RESPONSE, "an endpoint points outside this product.")
    choice_available = all(
        _text(endpoints.get(k)) is not None
        for k in ("choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel")
    )
    label = ctx.device_label(device_name)
    entropy = deps.entropy or {}

    listener: Optional[Any] = None
    try:
        if choice.kind == "loopback":
            # Bind first, push second: the port is ours before the Worker learns it.
            listener = (deps.listener_factory or LoopbackListener)()
            redirect_uri = native_redirect_uri("loopback", port=listener.port)
        else:
            assert choice.redirect_uri is not None
            redirect_uri = choice.redirect_uri
        pushed = push_request(
            request_endpoint=request_endpoint,
            authorize_endpoint=authorize,
            token_endpoint=token,
            issuer=issuer,
            client_id=ctx.product,
            redirect_uri=redirect_uri,
            device_name=label,
            return_uri=return_uri,
            scope=scope,
            login_hint=login_hint,
            name_hint=name_hint,
            purpose=purpose,
            license_choice=license_choice,
            choice_available=choice_available,
            key_return=key_return,
            state=entropy.get("state"),
            code_verifier=entropy.get("code_verifier"),
        )
        res = ctx.request(
            "POST",
            pushed.url,
            headers=ctx.headers({"content-type": pushed.content_type}),
            content=pushed.body.encode("utf-8"),
        )
        try:
            body: Any = res.json()
        except ValueError:
            body = None
        answer = parse_pushed_answer(res.status_code, body)
        if answer.kind == "refused":
            retry = answer.retry_after_seconds
            if retry is None:
                header = (res.headers.get("retry-after") or "").strip()
                retry = min(int(header), 3600) if header.isdigit() else None
            raise SignInError(
                answer.error or ErrorCode.SERVER_ERROR,
                f"the Worker refused the sign-in request ({answer.error}).",
                status=res.status_code,
                retry_after_seconds=retry,
            )
        if answer.kind == "malformed" or answer.request_uri is None or answer.expires_in is None:
            raise PolarisError(
                ErrorCode.BAD_RESPONSE,
                "the request endpoint answered without a complete pushed request.",
                status=res.status_code,
            )
        session = NativeSignInSession(
            pending=pushed.pending,
            authorize_url=authorize_url_for(authorize, ctx.product, answer.request_uri),
            expires_at=ctx.now() + answer.expires_in,
            deps=deps,
            listener=listener,
            return_page=return_page,
            device_name=label,
        )
        if listener is not None:
            listener.start(session._on_listener_callback)
    except BaseException:
        if listener is not None:
            listener.close()
        raise
    if open_browser:
        session.opened = session._open()
    return session
