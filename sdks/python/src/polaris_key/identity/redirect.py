"""The authorization-code redirect (WIRE-CONTRACT-V4 §12.4, §12.5; I-10a.17):
``identity.sign_in.start(channel="redirect", redirect_uri=...)`` builds the authorize URL for a
browser the HOST opens (a system browser, a webview), and ``complete(callback_url)`` redeems the
code the redirect brought back. A port of ``@polaris-key/client-core``'s ``identityRedirect.ts``
(its vectors are ported in ``tests/test_identity_redirect.py``) and of ``@polaris-key/node``'s
``identity/redirect.ts``.

The pure half (no I/O): :func:`start_redirect` (S256 PKCE, ``state``, the authorize URL),
:func:`check_callback` (the redirect URI, ``state``, then ``iss`` (RFC 9207), then ``error``, then
``code``; a refusal never reaches the token endpoint), :func:`token_form` (the form body of
``POST /<p>/identity/token``) and :func:`parse_token_answer` (a token response, ``choose`` by its
``status`` member alone, or a refusal carrying the Worker's OAuth ``error``).

The session half: :class:`RedirectSession` is SINGLE USE. ``complete`` and ``cancel`` drop the PKCE
verifier before the first request; a second ``complete`` (a replayed callback) is refused locally
without one. A refused or failed completion never wipes the device token, the cache or the stored
identity: only a ``signed_in`` outcome changes state. The token endpoint must be on this product's
origin, so the device's headers go nowhere else. The host supplies an ``https:`` redirect URI the
product registered; loopback, custom-scheme and claimed-HTTPS redirects are I-15's.

The verifier, the code and the token are never put in a URL, a log or an error message by this
module; the authorize URL carries only the challenge.
"""

from __future__ import annotations

import base64
import hashlib
import math
import re
import secrets
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union
from urllib.parse import unquote_plus

from ..constants_generated import ErrorCode, Feature
from ..core.errors import PolarisError
from ..core.manage import manage_form_encode
from .sign_in import SIGNED_IN, CHOOSE, CANCELLED, SignInActivation, SignInDeps, SignInOutcome

__all__ = [
    "AUTHORIZE_STATE_MAX",
    "AUTHORIZE_STATE_MIN",
    "DEFAULT_REDIRECT_SCOPE",
    "PKCE_VERIFIER_MAX",
    "PKCE_VERIFIER_MIN",
    "TOKEN_CONTENT_TYPE",
    "CallbackResult",
    "RedirectPending",
    "RedirectSession",
    "SignInError",
    "TokenAnswer",
    "check_callback",
    "generate_code_verifier",
    "generate_state",
    "is_redirect_uri",
    "parse_token_answer",
    "pkce_challenge",
    "start_redirect",
    "start_redirect_sign_in",
    "token_form",
]

#: RFC 7636 §4.1: the verifier is 43 to 128 characters of ``A-Z a-z 0-9 - . _ ~``.
PKCE_VERIFIER_MIN = 43
PKCE_VERIFIER_MAX = 128
#: WIRE-CONTRACT-V4 §12.4: ``state`` is 16 to 512 printable ASCII characters.
AUTHORIZE_STATE_MIN = 16
AUTHORIZE_STATE_MAX = 512
#: The scope a sign-in asks for when the host names none (a subset of ``profile email cloudSync``).
DEFAULT_REDIRECT_SCOPE = "profile email"
#: The ``Content-Type`` of the token request.
TOKEN_CONTENT_TYPE = "application/x-www-form-urlencoded"

_VERIFIER = re.compile(r"[A-Za-z0-9\-._~]+")
_PRINTABLE = re.compile(r"[\x21-\x7e]+")
_GRANT = re.compile(r"sg_[A-Za-z0-9_-]{43}")
_ENDPOINT = re.compile(r"https?://[^\s]+")
_REDIRECT_URI = re.compile(r"https://([^/?#]*)([^#]*)")
_REDIRECT_BAD = re.compile(r"[\s\x00-\x1f\x7f\\]")
_ORIGIN_PATH = re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*)://([^/?#]*)([^?#]*)")
_BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")

#: Random bytes. Default :func:`secrets.token_bytes`; a test injects a fixed source.
RandomBytes = Callable[[int], bytes]


class SignInError(PolarisError):
    """A redirect sign-in the Worker (or the callback) refused. ``code`` is the Worker's own
    (``invalid_grant``, ``invalid_client``, ``rate_limited``, ...) or ``sign-in-failed``;
    ``retry_after_seconds`` is set when it named one."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: Optional[int] = None,
        retry_after_seconds: Optional[int] = None,
    ) -> None:
        super().__init__(code, message, status=status)
        self.retry_after_seconds = retry_after_seconds


def _invalid(message: str) -> PolarisError:
    return PolarisError(ErrorCode.INVALID_ARGUMENT, message)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def generate_code_verifier(random: Optional[RandomBytes] = None) -> str:
    """A fresh PKCE verifier: 32 random bytes, 43 base64url characters."""
    return _b64url((random or secrets.token_bytes)(32))


def generate_state(random: Optional[RandomBytes] = None) -> str:
    """A fresh ``state``: 32 random bytes, 43 base64url characters."""
    return _b64url((random or secrets.token_bytes)(32))


def pkce_challenge(verifier: str) -> str:
    """The S256 challenge: ``base64url(SHA-256(ASCII(verifier)))``, unpadded (RFC 7636 §4.2)."""
    return _b64url(hashlib.sha256(verifier.encode("utf-8")).digest())


def is_redirect_uri(raw: Any) -> bool:
    """The shared rule for a host-supplied redirect URI: absolute ``https:``, no userinfo, no
    fragment, no whitespace or control characters. (Loopback, scheme and claimed-HTTPS URIs are
    I-15's.)"""
    if not isinstance(raw, str) or raw == "" or len(raw) > 2048:
        return False
    if _REDIRECT_BAD.search(raw):
        return False
    m = _REDIRECT_URI.fullmatch(raw)
    if m is None or m.group(1) == "" or "@" in m.group(1):
        return False
    return "#" not in raw


def _scope_string(scope: Union[None, str, Sequence[str]]) -> str:
    if scope is None:
        return DEFAULT_REDIRECT_SCOPE
    text = scope if isinstance(scope, str) else " ".join(scope)
    parts = [p for p in text.split(" ") if p != ""]
    if not parts or any(_PRINTABLE.fullmatch(p) is None for p in parts):
        raise _invalid("scope must be a space-delimited list of printable scopes.")
    return " ".join(parts)


def _form_body(pairs: Sequence[Tuple[str, str]]) -> str:
    return "&".join(f"{manage_form_encode(k)}={manage_form_encode(v)}" for k, v in pairs)


@dataclass(frozen=True)
class RedirectPending:
    """One pending redirect sign-in. The session holds it between the navigation and the
    callback, uses it for ONE :func:`check_callback` (and one token request), then drops it.
    ``code_verifier`` is a secret: it is not in ``repr``, never in a URL or a log."""

    #: The URL to open in the browser. Carries the challenge, never the verifier.
    authorize_url: str
    state: str
    code_verifier: str = field(repr=False)
    redirect_uri: str
    client_id: str
    issuer: str
    token_endpoint: str = field(repr=False)
    #: The authorize request carried ``license_choice=app``: the token endpoint may answer ``choose``.
    license_choice: bool = False


def start_redirect(
    *,
    authorize_endpoint: str,
    token_endpoint: str,
    issuer: str,
    client_id: str,
    redirect_uri: str,
    scope: Union[None, str, Sequence[str]] = None,
    login_hint: Optional[str] = None,
    name_hint: Optional[str] = None,
    purpose: Optional[str] = None,
    license_choice: Optional[str] = None,
    choice_available: bool = False,
    random: Optional[RandomBytes] = None,
    state: Optional[str] = None,
    code_verifier: Optional[str] = None,
) -> RedirectPending:
    """Build the authorize request. Query order is fixed so every SDK emits the same bytes:
    ``response_type client_id redirect_uri state code_challenge code_challenge_method scope
    [login_hint] [name_hint] [purpose] [license_choice]``, each value form-encoded (space as
    ``+``). A hint that is empty is not sent; a hint is sent verbatim (the Worker normalises, and
    drops a login hint that is not an e-mail). ``license_choice="app"`` is sent only when
    ``choice_available`` (discovery has the ``choice*`` endpoints); otherwise the card chooses
    and nothing is sent. Raises ``invalid-argument`` before anything is built."""
    if not is_redirect_uri(redirect_uri):
        raise _invalid("redirect_uri must be an absolute https URL with no fragment.")
    for name, value in (("authorize", authorize_endpoint), ("token", token_endpoint)):
        if not isinstance(value, str) or _ENDPOINT.fullmatch(value) is None:
            raise _invalid(f"the {name} endpoint is not an absolute URL.")
    if not isinstance(issuer, str) or issuer == "":
        raise _invalid("discovery names no issuer.")
    if not isinstance(client_id, str) or client_id == "":
        raise _invalid("client_id is empty.")
    st = state if state is not None else generate_state(random)
    if (
        len(st) < AUTHORIZE_STATE_MIN
        or len(st) > AUTHORIZE_STATE_MAX
        or _PRINTABLE.fullmatch(st) is None
    ):
        raise _invalid("state must be 16 to 512 printable characters.")
    verifier = code_verifier if code_verifier is not None else generate_code_verifier(random)
    if (
        len(verifier) < PKCE_VERIFIER_MIN
        or len(verifier) > PKCE_VERIFIER_MAX
        or _VERIFIER.fullmatch(verifier) is None
    ):
        raise _invalid("the PKCE verifier must be 43 to 128 unreserved characters.")

    pairs: List[Tuple[str, str]] = [
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("state", st),
        ("code_challenge", pkce_challenge(verifier)),
        ("code_challenge_method", "S256"),
        ("scope", _scope_string(scope)),
    ]
    if login_hint:
        pairs.append(("login_hint", login_hint))
    if name_hint:
        pairs.append(("name_hint", name_hint))
    if purpose:
        pairs.append(("purpose", purpose))
    sent_choice = license_choice == "app" and choice_available is True
    if sent_choice:
        pairs.append(("license_choice", "app"))
    sep = "&" if "?" in authorize_endpoint else "?"
    return RedirectPending(
        authorize_url=f"{authorize_endpoint}{sep}{_form_body(pairs)}",
        state=st,
        code_verifier=verifier,
        redirect_uri=redirect_uri,
        client_id=client_id,
        issuer=issuer,
        token_endpoint=token_endpoint,
        license_choice=sent_choice,
    )


# ── The callback ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CallbackResult:
    """What the redirect back to the app was. ``kind`` is ``"code"`` (``code`` to redeem),
    ``"cancelled"`` (``error=access_denied``: the person pressed Cancel) or ``"failed"``
    (``code`` is the registry's ``sign-in-failed`` and ``reason`` one of ``malformed``,
    ``redirect-mismatch``, ``state-mismatch``, ``issuer-mismatch``, ``authorization-error``,
    ``missing-code``; ``error`` is the callback's own ``error`` value when it carried one)."""

    kind: str
    code: Optional[str] = field(default=None, repr=False)
    reason: Optional[str] = None
    error: Optional[str] = None


def _fail(reason: str, error: Optional[str] = None) -> CallbackResult:
    return CallbackResult(kind="failed", code=ErrorCode.SIGN_IN_FAILED, reason=reason, error=error)


def _decode(s: str) -> Optional[str]:
    if _BAD_ESCAPE.search(s):
        return None
    try:
        return unquote_plus(s, errors="strict")
    except UnicodeDecodeError:
        return None


def _query_of(url: str) -> Optional[Dict[str, str]]:
    """The query pairs of ``url`` (before any ``#``), names and values decoded (``+`` is a space);
    ``None`` when a name repeats or an escape is malformed."""
    q = url.find("?")
    if q == -1:
        return {}
    end = url.find("#")
    text = url[q + 1 : None if end == -1 else end]
    out: Dict[str, str] = {}
    for part in text.split("&"):
        if part == "":
            continue
        eq = part.find("=")
        name = _decode(part if eq == -1 else part[:eq])
        value = _decode("" if eq == -1 else part[eq + 1 :])
        if name is None or value is None or name in out:
            return None
        out[name] = value
    return out


def _origin_path(url: str) -> Optional[str]:
    """``scheme://authority/path``, lower-cased scheme and host, no query or fragment."""
    m = _ORIGIN_PATH.match(url)
    if m is None:
        return None
    return f"{m.group(1).lower()}://{m.group(2).lower()}{m.group(3)}"


def check_callback(
    state: str, redirect_uri: str, issuer: str, callback_url: str
) -> CallbackResult:
    """Check the redirect back to the app. The order is fixed and the first failure wins: the
    callback is at the redirect URI; no parameter repeats; ``state`` is this request's; ``iss`` is
    the discovery issuer (a callback with no ``iss`` is refused: the Worker always sends it); then
    ``error`` (``access_denied`` is ``cancelled``, any other is ``failed``); then ``code``.

    Pure: the caller drops the pending request after the first call, whatever the result."""
    if not isinstance(callback_url, str):
        return _fail("malformed")
    got = _origin_path(callback_url)
    want = _origin_path(redirect_uri)
    if got is None or want is None:
        return _fail("malformed")
    if got != want:
        return _fail("redirect-mismatch")
    q = _query_of(callback_url)
    if q is None:
        return _fail("malformed")
    if q.get("state") != state:
        return _fail("state-mismatch")
    if q.get("iss") != issuer:
        return _fail("issuer-mismatch")
    error = q.get("error")
    if error is not None:
        return CallbackResult(kind="cancelled") if error == "access_denied" else _fail(
            "authorization-error", error
        )
    code = q.get("code")
    if code is None or code == "":
        return _fail("missing-code")
    return CallbackResult(kind="code", code=code)


# ── The token request and its answer ─────────────────────────────────────────────────


def token_form(
    client_id: str,
    code_verifier: str,
    redirect_uri: str,
    code: str,
    device_name: Optional[str] = None,
) -> str:
    """The form body of ``POST /<p>/identity/token`` (§12.5). Member order is fixed:
    ``grant_type client_id code code_verifier redirect_uri [device_name]``."""
    pairs: List[Tuple[str, str]] = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", code_verifier),
        ("redirect_uri", redirect_uri),
    ]
    if device_name:
        pairs.append(("device_name", device_name))
    return _form_body(pairs)


@dataclass(frozen=True)
class TokenAnswer:
    """The token endpoint's answer. ``kind`` is ``"token"`` (``access_token``, ``scope``,
    ``subject``, ``schema_version``, ``device``, ``license``), ``"choose"`` (``grant``,
    ``expires_in``, ``choices``: I-08b, the app shows the licence choice), ``"refused"`` (``error``
    is the Worker's flat OAuth / Polaris code, ``status`` the HTTP status, ``retry_after_seconds``
    when it named one; a 5xx or a body with no ``error`` is ``server_error``) or ``"malformed"``
    (a ``200`` that is neither, or lacks a member the call needs). The secrets are not in
    ``repr``."""

    kind: str
    access_token: Optional[str] = field(default=None, repr=False)
    scope: Optional[str] = None
    subject: Optional[str] = None
    schema_version: int = 1
    device: Optional[Dict[str, Any]] = None
    license: Optional[Dict[str, Any]] = None
    grant: Optional[str] = field(default=None, repr=False)
    expires_in: Optional[float] = None
    choices: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    status: Optional[int] = None
    retry_after_seconds: Optional[int] = None


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def parse_token_answer(status: int, body: Any) -> TokenAnswer:
    """Read the token endpoint's answer. ``choose`` is decided by the ``status`` member alone,
    never by the absence of ``access_token``."""
    if status != 200:
        b = body if isinstance(body, dict) else {}
        err = b.get("error")
        error = err if isinstance(err, str) and err != "" else "server_error"
        retry = b.get("retryAfter")
        seconds = (
            int(math.ceil(retry))
            if _is_number(retry) and math.isfinite(retry) and retry > 0
            else None
        )
        return TokenAnswer(kind="refused", error=error, status=status, retry_after_seconds=seconds)
    if not isinstance(body, dict):
        return TokenAnswer(kind="malformed")
    if body.get("status") == "choose":
        grant, expires_in, choices = body.get("grant"), body.get("expiresIn"), body.get("choices")
        if (
            not isinstance(grant, str)
            or _GRANT.fullmatch(grant) is None
            or not _is_number(expires_in)
            or not isinstance(choices, dict)
        ):
            return TokenAnswer(kind="malformed")
        return TokenAnswer(kind="choose", grant=grant, expires_in=expires_in, choices=choices)
    token, scope, subject = body.get("access_token"), body.get("scope"), body.get("subject")
    device = body.get("device")
    lic = body.get("license", False)
    if (
        not isinstance(token, str)
        or token == ""
        or not isinstance(scope, str)
        or not isinstance(subject, str)
        or subject == ""
        or not isinstance(device, dict)
        or (lic is not None and not isinstance(lic, dict))
    ):
        return TokenAnswer(kind="malformed")
    sv = body.get("schemaVersion")
    return TokenAnswer(
        kind="token",
        access_token=token,
        scope=scope,
        subject=subject,
        schema_version=sv if _is_number(sv) else 1,
        device=device,
        license=lic,
    )


# ── The session ──────────────────────────────────────────────────────────────────────


class RedirectSession:
    """A redirect sign-in: open :attr:`authorize_url` in a browser (:meth:`reopen` uses the
    host's opener), then hand the URL the browser was sent back to :meth:`complete`. Single use."""

    channel = "redirect"

    def __init__(
        self, pending: RedirectPending, deps: SignInDeps, device_name: Optional[str]
    ) -> None:
        #: Open this in the browser. It carries the challenge and ``state``, never the verifier.
        self.authorize_url = pending.authorize_url
        self._pending: Optional[RedirectPending] = pending
        self._deps = deps
        self._device_name = device_name
        self._lock = threading.Lock()
        self._cancelled = False

    def __repr__(self) -> str:
        return f"RedirectSession(channel={self.channel!r}, authorize_url={self.authorize_url!r})"

    def reopen(self) -> bool:
        """Open :attr:`authorize_url` in the host's browser; ``False`` when no opener ran."""
        try:
            return bool(self._deps.open_url(self.authorize_url))
        except Exception:
            return False

    def cancel(self) -> None:
        """Forget the pending request (the host closed the browser). ``complete`` then refuses."""
        with self._lock:
            self._pending = None
            self._cancelled = True

    def wait(self, *args: Any, **kwargs: Any) -> SignInOutcome:
        """A redirect sign-in settles through :meth:`complete`, not ``wait``; a cancelled one
        answers ``cancelled``."""
        with self._lock:
            if self._cancelled:
                return SignInOutcome(kind=CANCELLED)
        raise PolarisError(
            ErrorCode.INVALID_ARGUMENT,
            "a redirect sign-in settles through complete(callback_url), not wait().",
        )

    def complete(self, callback_url: str) -> SignInOutcome:
        """Redeem the callback the browser was sent to. Checks the redirect URI, ``state`` and
        ``iss`` first (a mismatch is ``sign-in-failed``, nothing sent), then POSTs the form body to
        discovery's ``token`` endpoint. ``error=access_denied`` answers ``cancelled``; any other
        callback error is ``sign-in-failed``. The Worker's refusal is raised as a
        :class:`SignInError` under its own code (``invalid_grant``, ``invalid_client``,
        ``rate_limited`` with ``retry_after_seconds``, ...). ``license_choice="app"`` and a choice
        due answers ``choose`` (no token was stored): finish with ``identity.choice``."""
        with self._lock:
            pending = self._pending
            # One use, whatever happens next: a replayed callback never reaches the token endpoint.
            self._pending = None
        if pending is None:
            raise SignInError(
                ErrorCode.SIGN_IN_FAILED,
                "this sign-in is already finished or was cancelled; start a new one.",
            )
        checked = check_callback(pending.state, pending.redirect_uri, pending.issuer, callback_url)
        if checked.kind == "cancelled":
            return SignInOutcome(kind=CANCELLED)
        if checked.kind == "failed":
            raise SignInError(
                ErrorCode.SIGN_IN_FAILED,
                f"the sign-in redirect was refused ({checked.reason}).",
            )
        return self._redeem(pending, checked.code or "")

    def _redeem(self, pending: RedirectPending, code: str) -> SignInOutcome:
        deps = self._deps
        ctx = deps.ctx
        form = token_form(
            pending.client_id,
            pending.code_verifier,
            pending.redirect_uri,
            code,
            ctx.device_label(self._device_name),
        )
        # A 5xx raises `server-error` and no answer `network-error` (CoreContext.request).
        res = ctx.request(
            "POST",
            pending.token_endpoint,
            headers=ctx.headers({"content-type": TOKEN_CONTENT_TYPE}),
            content=form.encode("utf-8"),
        )
        try:
            body: Any = res.json()
        except ValueError:
            body = None
        answer = parse_token_answer(res.status_code, body)
        if answer.kind == "malformed":
            raise PolarisError(
                ErrorCode.BAD_RESPONSE,
                "the token endpoint answered without a complete sign-in.",
                status=res.status_code,
            )
        if answer.kind == "refused":
            retry = answer.retry_after_seconds
            if retry is None:
                header = (res.headers.get("retry-after") or "").strip()
                retry = int(header) if header.isdigit() else None
            raise SignInError(
                answer.error or ErrorCode.SERVER_ERROR,
                f"the token endpoint refused the sign-in ({answer.error}).",
                status=res.status_code,
                retry_after_seconds=retry,
            )
        if answer.kind == "choose":
            # Only `license_choice=app` makes the Worker answer this; nothing is stored and
            # `identity.choice.*` finishes it.
            if not pending.license_choice:
                raise PolarisError(
                    ErrorCode.BAD_RESPONSE,
                    "the token endpoint asked for a licence choice this sign-in did not request.",
                    status=200,
                )
            return SignInOutcome(
                kind=CHOOSE,
                grant=answer.grant,
                expires_in=answer.expires_in,
                choices=answer.choices,
            )
        assert answer.access_token is not None and answer.subject is not None
        deps.tokens.set(answer.access_token, "signin")
        deps.store_identity(None)
        if deps.write_subject is not None:
            deps.write_subject(answer.subject)
        deps.on_acquired()
        deps.emit("identity", change="signed_in", subject=answer.subject)
        lic = answer.license
        license_id = lic.get("id") if isinstance(lic, dict) and isinstance(lic.get("id"), str) else None
        return SignInOutcome(
            kind=SIGNED_IN,
            subject=answer.subject,
            scope=answer.scope,
            activation=SignInActivation(license_id=license_id),
        )


def start_redirect_sign_in(
    deps: SignInDeps,
    *,
    redirect_uri: str,
    scope: Union[None, str, Sequence[str]] = None,
    login_hint: Optional[str] = None,
    name_hint: Optional[str] = None,
    purpose: Optional[str] = None,
    license_choice: Optional[str] = None,
    device_name: Optional[str] = None,
) -> RedirectSession:
    """Begin a redirect sign-in. Refuses before any sign-in request when the product does not run
    Identity (``service-unavailable``) or its discovery serves no ``authorize``, ``token`` or
    ``issuer`` (``sign-in-unavailable``): an endpoint is used only when discovery names it, never
    built. The token endpoint must be on this product: the device's headers go nowhere else."""
    ctx = deps.ctx
    doc = deps.load_discovery() if deps.load_discovery is not None else deps.discovery()
    ctx.require_service("identity", Feature.IDENTITY_REDIRECT_WEB)
    services = doc.get("services") if isinstance(doc, dict) else None
    fragment = services.get("identity") if isinstance(services, dict) else None
    fragment = fragment if isinstance(fragment, dict) else {}
    endpoints = fragment.get("endpoints") if isinstance(fragment.get("endpoints"), dict) else {}

    def text(v: Any) -> Optional[str]:
        return v if isinstance(v, str) and v != "" else None

    authorize, token, issuer = (
        text(endpoints.get("authorize")),
        text(endpoints.get("token")),
        text(fragment.get("issuer")),
    )
    if not authorize or not token or not issuer:
        raise PolarisError(
            ErrorCode.SIGN_IN_UNAVAILABLE, "this product's discovery serves no redirect sign-in."
        )
    if not token.startswith(ctx.url("")):
        raise PolarisError(
            ErrorCode.BAD_RESPONSE, "the token endpoint points outside this product."
        )
    choice_available = all(
        text(endpoints.get(k)) is not None
        for k in ("choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel")
    )
    entropy = deps.entropy or {}
    pending = start_redirect(
        authorize_endpoint=authorize,
        token_endpoint=token,
        issuer=issuer,
        client_id=ctx.product,
        redirect_uri=redirect_uri,
        scope=scope,
        login_hint=login_hint,
        name_hint=name_hint,
        purpose=purpose,
        license_choice=license_choice,
        choice_available=choice_available,
        state=entropy.get("state"),
        code_verifier=entropy.get("code_verifier"),
    )
    return RedirectSession(pending, deps, device_name)
