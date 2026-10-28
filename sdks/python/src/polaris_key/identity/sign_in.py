"""``identity.sign_in.start(**opts)``: the one way to sign in (I-10a.15). Mirrors
``@polaris-key/node``'s ``identity/signIn.ts``.

``channel="device-code"`` is RFC 8628 for hosts that cannot complete a browser redirect (a CLI,
a daemon, a console, a kiosk); ``channel="redirect"`` is the authorization-code flow in
``redirect.py`` (a host-supplied https ``redirect_uri``, ``complete(callback_url)``). ``start``
answers a :class:`SignInSession` or a ``RedirectSession``.

The session holds what the person is shown (``user_code``, the two verification URIs,
``expires_in``, ``interval``, ``device_name``) and keeps the POLL credential (the device code)
private: it is not an attribute, and ``repr`` never lists it.

* :meth:`SignInSession.reopen` opens ``verification_uri_complete`` in the host's browser
  (``False`` when no opener ran).
* :meth:`SignInSession.cancel` stops; ``wait()`` then answers ``cancelled``.
* :meth:`SignInSession.wait` is the paced loop (at least ``interval`` between polls, longer after
  a ``slow_down``, never faster because a poll failed) until the sign-in settles:
  ``signed_in | expired | cancelled``. ``once=True`` polls exactly once and may answer
  ``pending`` (the caller paces). A person's refusal raises ``sign-in-denied``, a failure after
  approval ``sign-in-failed``. ``timeout`` (seconds) raises :class:`TimeoutError`.

A device-code sign-in yields the SIGNED-IN IDENTITY'S OWN licence and nothing else: nothing is
attached unless the host asks (``wait(confirm=...)``, then ``identity.attach``), P1-07. On
``ready`` the token is stored through Core's token manager, the acquisition sync runs, and the
subject is read and persisted.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

import httpx

from ..constants_generated import ErrorCode, Feature, UnsupportedReason
from ..core.caps import Unsupported, UnsupportedError
from ..core.context import CoreContext, server_message_of
from ..core.errors import PolarisError
from ..core.token import TokenManager

__all__ = [
    "SLOW_DOWN_STEP_SECONDS",
    "SignInNamespace",
    "SignInOutcome",
    "SignInActivation",
    "SignInSession",
    "SignedInIdentity",
]

#: RFC 8628 §3.5: a ``slow_down`` without an interval adds five seconds to the CURRENT interval,
#: so repeated interval-less answers keep lengthening it.
SLOW_DOWN_STEP_SECONDS = 5

#: Transient failures ``wait`` rides out at the current interval: the network, and a 5xx.
_TRANSIENT = frozenset({"network-error", "server-error"})

#: The outcome kinds.
PENDING = "pending"
CHOOSE = "choose"
SIGNED_IN = "signed_in"
CANCELLED = "cancelled"
EXPIRED = "expired"


@dataclass(frozen=True)
class SignedInIdentity:
    """Who the device is signed in as, as the Worker shows it: the name and verified e-mail
    (never ``sub`` or other claims). Either may be ``None``."""

    name: Optional[str] = None
    email: Optional[str] = None


@dataclass(frozen=True)
class SignInActivation:
    """The activation a sign-in produced: the device now holds the identity's token.
    ``attached`` is ``"claimed"`` / ``"migrated"`` when the opt-in attach ran."""

    license_id: Optional[str] = None
    attached: Optional[str] = None


@dataclass(frozen=True)
class SignInOutcome:
    """How a sign-in session ended, or (``once``) has not yet. ``kind`` is ``"pending"``,
    ``"choose"``, ``"signed_in"``, ``"cancelled"`` or ``"expired"``.

    ``pending`` carries ``interval`` (seconds before the next poll) and ``slow_down`` (the Worker
    asked for a longer one); ``signed_in`` carries ``subject`` (the pairwise ``ps_...`` subject, or
    ``None`` when the product serves none), ``activation`` and ``identity``."""

    kind: str
    interval: Optional[int] = None
    slow_down: bool = False
    subject: Optional[str] = None
    activation: Optional[SignInActivation] = None
    identity: Optional[SignedInIdentity] = None
    #: Redirect channel, ``signed_in``: the granted scope, space-delimited.
    scope: Optional[str] = None
    #: Redirect channel, ``choose`` (``license_choice="app"`` and a choice is due): no token was
    #: stored. ``grant`` is a credential, so it is kept out of ``repr``; finish with
    #: ``identity.choice.complete(grant, ...)`` or ``cancel(grant)`` before ``expires_in`` seconds
    #: pass (300, §12.5.1).
    grant: Optional[str] = field(default=None, repr=False)
    expires_in: Optional[float] = None
    choices: Optional[Dict[str, Any]] = None


def _is_str(v: Any) -> bool:
    return isinstance(v, str) and len(v) > 0


def _is_seconds(v: Any) -> bool:
    return (
        isinstance(v, (int, float))
        and not isinstance(v, bool)
        and math.isfinite(v)
        and v > 0
    )


def _whole_seconds(v: float) -> int:
    """Round a server's seconds UP, so a 0.5 is one second rather than zero."""
    return int(math.ceil(v))


def _poll_delay(interval: float, expires_in: float) -> float:
    """The seconds ``wait`` actually sleeps: never under one second (a zero, negative or
    non-finite interval would spin) and never past the code's own lifetime."""
    ceiling = float(expires_in) if math.isfinite(expires_in) and expires_in >= 1 else 1.0
    if not math.isfinite(interval):
        return ceiling if interval > 0 else 1.0
    return min(max(float(interval), 1.0), ceiling)


def _json(res: httpx.Response) -> Dict[str, Any]:
    try:
        b = res.json()
    except ValueError:
        return {}
    return b if isinstance(b, dict) else {}


def _shown(v: Any) -> Optional[SignedInIdentity]:
    """The identity a poll answer shows, or ``None``. Only ``name`` and ``email``, each a string."""
    if not isinstance(v, dict):
        return None
    name = v.get("name") if isinstance(v.get("name"), str) and v.get("name") else None
    email = v.get("email") if isinstance(v.get("email"), str) and v.get("email") else None
    return SignedInIdentity(name=name, email=email) if (name or email) else None


def _error_code(res: httpx.Response, fallback: str) -> str:
    """The Worker's flat (``{"error":"x"}``) or nested (``{"error":{"code":"x"}}``) code."""
    err = _json(res).get("error")
    if isinstance(err, str):
        return err
    if isinstance(err, dict) and isinstance(err.get("code"), str):
        return err["code"]  # type: ignore[no-any-return]
    return fallback


class SignInDeps:
    """What a session needs from the identity client."""

    def __init__(
        self,
        ctx: CoreContext,
        tokens: TokenManager,
        *,
        discovery: Callable[[], Optional[Dict[str, Any]]],
        on_acquired: Callable[[], None],
        store_identity: Callable[[Optional[SignedInIdentity]], None],
        fetch_subject: Callable[[], Optional[str]],
        license_id: Callable[[], Optional[str]],
        open_url: Callable[[str], bool],
        emit: Callable[..., Any],
        load_discovery: Optional[Callable[[], Optional[Dict[str, Any]]]] = None,
        write_subject: Optional[Callable[[Optional[str]], None]] = None,
    ) -> None:
        self.ctx = ctx
        self.tokens = tokens
        #: The discovery document this session loaded, or ``None`` (never loads one).
        self.discovery = discovery
        self.on_acquired = on_acquired
        self.store_identity = store_identity
        #: The subject of the account now signed in; ``None`` when the product serves none.
        self.fetch_subject = fetch_subject
        self.license_id = license_id
        self.open_url = open_url
        self.emit = emit
        #: Discovery, loading it first when this session has not (the redirect channel and the
        #: choice calls need the endpoints); ``None`` uses :attr:`discovery`.
        self.load_discovery = load_discovery
        #: Persist the account subject (a redirect sign-in's token answer carries it).
        self.write_subject = write_subject
        #: Conformance replay only: the exact ``state`` and ``code_verifier`` of a recorded
        #: redirect conversation.
        self.entropy: Optional[Dict[str, str]] = None


def _post(
    ctx: CoreContext, path: str, body: Dict[str, Any], extra: Optional[Dict[str, str]] = None
) -> httpx.Response:
    """One POST. Raises ``local-only``, ``network-error`` or ``server-error``
    (:meth:`CoreContext.request`); every other answer is returned."""
    headers = ctx.headers({"content-type": "application/json", **(extra or {})})
    return ctx.request("POST", ctx.url(path), headers=headers, json=body)


class SignInSession:
    """A running device-code sign-in (see the module docstring)."""

    channel = "device-code"

    def __init__(
        self,
        *,
        device_code: str,
        user_code: str,
        verification_uri: str,
        verification_uri_complete: str,
        expires_in: int,
        interval: int,
        expires_at: int,
        device_name: Optional[str],
        deps: SignInDeps,
    ) -> None:
        self.__device_code = device_code
        #: What the person types on the verification page, e.g. ``WDJB-MJHT``.
        self.user_code = user_code
        #: The page the person opens and types the code into.
        self.verification_uri = verification_uri
        #: The same page with the code pre-filled: the payload for a QR code or a link.
        self.verification_uri_complete = verification_uri_complete
        #: Seconds the code lives for, as the Worker advertised it.
        self.expires_in = expires_in
        #: The minimum seconds between polls, as advertised; a ``slow_down`` lengthens it.
        self.interval = interval
        #: When the code expires on THIS client's clock (epoch seconds).
        self.expires_at = expires_at
        #: The device label the sign-in page shows (§12.7.1), or ``None``.
        self.device_name = device_name
        self._deps = deps
        self._cancelled = threading.Event()

    def __repr__(self) -> str:
        # Never print the poll credential: it is not an attribute, and the repr lists the shown ones.
        return (
            f"SignInSession(channel={self.channel!r}, user_code={self.user_code!r}, "
            f"verification_uri={self.verification_uri!r}, expires_in={self.expires_in!r}, "
            f"interval={self.interval!r}, expires_at={self.expires_at!r}, "
            f"device_name={self.device_name!r})"
        )

    def reopen(self) -> bool:
        """Open ``verification_uri_complete`` in the host's browser; ``False`` when no opener ran."""
        try:
            return bool(self._deps.open_url(self.verification_uri_complete))
        except Exception:
            return False

    def cancel(self) -> None:
        """Stop. A running ``wait`` answers ``cancelled``; the code simply expires on the Worker."""
        self._cancelled.set()

    def wait(
        self,
        timeout: Optional[float] = None,
        *,
        once: bool = False,
        confirm: Optional[Callable[[SignedInIdentity, bool], bool]] = None,
        cancel_token: Optional[threading.Event] = None,
    ) -> SignInOutcome:
        """Poll until the sign-in settles (see the module docstring).

        ``confirm(identity, attachable)`` opts in to the device-confirmed attach (P1-07): the
        wait asks the Worker to hold at the identity, calls ``confirm`` with it and sends the
        answer as ``attachLicense``. Without it no opt-in is sent. ``cancel_token`` is a
        :class:`threading.Event` another thread may set: ``wait`` then answers ``cancelled``."""
        deps = self._deps
        deps.ctx.require_service("identity", Feature.IDENTITY_DEVICECODE)
        deadline = None if timeout is None else time.time() + timeout
        # The attach opt-in: hold at the identity first, then send the person's decision.
        opt_in: Dict[str, bool] = {"confirmIdentity": True} if confirm is not None else {}

        def stopped() -> bool:
            return self._cancelled.is_set() or (cancel_token is not None and cancel_token.is_set())

        while True:
            if stopped():
                return SignInOutcome(kind=CANCELLED)
            if not once:
                if deps.ctx.now() >= self.expires_at:
                    return SignInOutcome(kind=EXPIRED)
                delay = _poll_delay(self.interval, self.expires_in)
                if deadline is not None and time.time() + delay > deadline:
                    self._sleep(max(0.0, deadline - time.time()), cancel_token)
                    if stopped():
                        return SignInOutcome(kind=CANCELLED)
                    raise TimeoutError("device sign-in did not complete within the timeout")
                self._sleep(delay, cancel_token)
                if stopped():
                    return SignInOutcome(kind=CANCELLED)
                if deps.ctx.now() >= self.expires_at:
                    return SignInOutcome(kind=EXPIRED)
            try:
                poll = self._poll(opt_in)
            except PolarisError as e:
                if not once and e.code in _TRANSIENT:
                    continue
                raise
            status = poll["s"]
            if status == "ready":
                return poll["outcome"]  # type: ignore[no-any-return]
            if stopped():
                return SignInOutcome(kind=CANCELLED)
            if status == "expired":
                return SignInOutcome(kind=EXPIRED)
            if status == "pending":
                if once:
                    return SignInOutcome(kind=PENDING, interval=self.interval)
                continue
            if status == "slow-down":
                self.interval = max(self.interval, poll["interval"])
                if once:
                    return SignInOutcome(kind=PENDING, interval=self.interval, slow_down=True)
                continue
            # confirm: the Worker holds the flow at the identity until the host decides.
            attach = (
                bool(confirm(poll["identity"], bool(poll["attachable"])))
                if confirm is not None
                else False
            )
            opt_in = {"attachLicense": attach and bool(poll["attachable"])}
            if once:
                return SignInOutcome(kind=PENDING, interval=self.interval)

    def _sleep(self, seconds: float, token: Optional[threading.Event]) -> None:
        """Sleep ``seconds`` in quarter-second slices, so ``cancel()`` and a ``cancel_token``
        stop the wait within one slice. The slices are counted down, not read off a clock, so a
        host whose clock is pinned or faked still terminates."""
        left = max(0.0, seconds)
        while left > 0 and not (self._cancelled.is_set() or (token is not None and token.is_set())):
            step = min(left, 0.25)
            time.sleep(step)
            left -= step

    def _poll(self, opt_in: Dict[str, bool]) -> Dict[str, Any]:
        deps = self._deps
        ctx, tokens = deps.ctx, deps.tokens
        body: Dict[str, Any] = {"deviceCode": self.__device_code, "deviceId": ctx.device_id}
        if opt_in.get("confirmIdentity"):
            body["confirmIdentity"] = True
        if "attachLicense" in opt_in:
            body["attachLicense"] = bool(opt_in["attachLicense"])
        # The attach names the licence by the device's own bearer; an ordinary poll sends none.
        extra: Dict[str, str] = {}
        if (opt_in.get("confirmIdentity") or "attachLicense" in opt_in) and tokens.current:
            extra["authorization"] = f"Bearer {tokens.current}"
        # A 5xx raises `server-error` and no answer `network-error` (CoreContext.request).
        res = _post(ctx, "identity/auth/device/poll", body, extra)
        if res.status_code != 200 and res.status_code != 429:
            raise PolarisError(
                ErrorCode.SIGN_IN_FAILED,
                server_message_of(res)
                or f"device sign-in poll refused (status {res.status_code}).",
                status=res.status_code,
            )
        answer = _json(res)
        if res.status_code == 429:
            # The Worker's own `slow_down` carries the interval; a rate limiter in front of it may
            # answer 429 without one, which RFC 8628 §3.5 treats the same way.
            interval = answer.get("interval")
            return {
                "s": "slow-down",
                "interval": _whole_seconds(float(interval))
                if _is_seconds(interval)
                else self.interval + SLOW_DOWN_STEP_SECONDS,
            }
        identity = _shown(answer.get("identity"))
        status = answer.get("status")
        if status == "pending":
            return {"s": "pending"}
        if status == "timeout":
            return {"s": "expired"}
        if status == "error":
            # DENY-01: `reason: access_denied` is the person pressing Deny; a bare `error` is a
            # sign-in that failed after approval (the provider, an activation, a mint).
            if answer.get("reason") == "access_denied":
                raise PolarisError(ErrorCode.SIGN_IN_DENIED, "device sign-in was refused.")
            raise PolarisError(ErrorCode.SIGN_IN_FAILED, "device sign-in failed.")
        if status == "confirm":
            return {
                "s": "confirm",
                "identity": identity or SignedInIdentity(),
                "attachable": answer.get("attachable") is True,
            }
        if status == "ready":
            token = answer.get("token")
            if not _is_str(token):
                raise PolarisError(
                    ErrorCode.SIGN_IN_FAILED, "device sign-in answered ready without a token."
                )
            tokens.set(token, "signin")
            deps.store_identity(identity)
            deps.on_acquired()
            try:
                subject = deps.fetch_subject()
            except Exception:
                subject = None
            attached = answer.get("attached") if answer.get("attached") in ("claimed", "migrated") else None
            deps.emit("identity", change="signed_in", subject=subject)
            return {
                "s": "ready",
                "outcome": SignInOutcome(
                    kind=SIGNED_IN,
                    subject=subject,
                    activation=SignInActivation(license_id=deps.license_id(), attached=attached),
                    identity=identity,
                ),
            }
        raise PolarisError(ErrorCode.SIGN_IN_FAILED, "device sign-in failed.")


def start_device_code(
    deps: SignInDeps,
    *,
    device_name: Optional[str] = None,
    login_hint: Optional[str] = None,
    name_hint: Optional[str] = None,
    purpose: Optional[str] = None,
    scope: Any = None,
    license_choice: Optional[str] = None,
) -> SignInSession:
    """Begin a device-code sign-in. Refuses before any request when the product cannot sign in:
    ``service-unavailable`` (an :class:`UnsupportedError`) when it does not run Identity (D-21),
    and ``disabled`` when this session's discovery says Identity is on but no sign-in provider is
    set up. A 404 from the start route (a stale discovery map: device routes never say "Identity
    is off") is the same ``service-unavailable``. Otherwise the one taxonomy: ``network-error``,
    ``server-error``, or the Worker's code (``sign-in-unavailable`` when it names none).

    No bearer is sent even when the device holds a token: a sign-in asks for the IDENTITY's
    credential, and the Worker binds the flow to this device by its id."""
    ctx = deps.ctx
    ctx.require_service("identity", Feature.IDENTITY_DEVICECODE)
    doc = deps.discovery()
    services = doc.get("services") if isinstance(doc, dict) else None
    identity = services.get("identity") if isinstance(services, dict) else None
    if isinstance(identity, dict) and identity.get("configured") is False:
        raise PolarisError(
            ErrorCode.DISABLED,
            "this product has not set up sign-in, so a device sign-in cannot start.",
        )
    body: Dict[str, Any] = {"deviceId": ctx.device_id}
    # §12.7.1: the per-call name, else the client's ``device_name``, else the platform default,
    # normalised exactly as the Worker will store it. ``""`` sends none.
    label = ctx.device_label(device_name)
    if label:
        body["deviceName"] = label
    if login_hint is not None:
        body["loginHint"] = login_hint
    if name_hint is not None:
        body["nameHint"] = name_hint
    if purpose is not None:
        body["purpose"] = purpose
    if scope is not None:
        body["scope"] = scope if isinstance(scope, str) else " ".join(scope)
    if license_choice is not None:
        body["licenseChoice"] = license_choice
    res = _post(ctx, "identity/auth/device/start", body)
    if res.status_code == 404:
        raise UnsupportedError(
            Unsupported(
                Feature.IDENTITY_DEVICECODE,
                UnsupportedReason.PRODUCT,
                "the product does not run the identity service",
            ),
            ErrorCode.SERVICE_UNAVAILABLE,
        )
    if res.status_code != 200:
        raise PolarisError(
            _error_code(res, ErrorCode.SIGN_IN_UNAVAILABLE),
            server_message_of(res)
            or f"device sign-in could not start (status {res.status_code}).",
            status=res.status_code,
        )
    b = _json(res)
    if not (
        _is_str(b.get("deviceCode"))
        and _is_str(b.get("userCode"))
        and _is_str(b.get("verificationUri"))
        and _is_str(b.get("verificationUriComplete"))
        and _is_seconds(b.get("expiresIn"))
        and _is_seconds(b.get("interval"))
    ):
        raise PolarisError(
            "bad_response", "device sign-in start answered without a complete prompt."
        )
    return SignInSession(
        device_code=b["deviceCode"],
        user_code=b["userCode"],
        verification_uri=b["verificationUri"],
        verification_uri_complete=b["verificationUriComplete"],
        expires_in=_whole_seconds(b["expiresIn"]),
        interval=_whole_seconds(b["interval"]),
        expires_at=ctx.now() + _whole_seconds(b["expiresIn"]),
        # The echo is what the page shows; an older Worker sends none, so show what was sent.
        device_name=(
            (b["deviceName"] if isinstance(b["deviceName"], str) else None)
            if "deviceName" in b
            else label
        ),
        deps=deps,
    )


class SignInNamespace:
    """``client.identity.sign_in``: ``start(**opts)`` is its one verb."""

    def __init__(
        self,
        start: Callable[..., SignInSession],
        start_redirect: Optional[Callable[..., Any]] = None,
    ) -> None:
        self._start = start
        self._start_redirect = start_redirect

    def start(self, channel: str = "device-code", **opts: Any) -> Any:
        """Start a sign-in. ``channel="device-code"`` (the default) takes ``device_name``,
        ``login_hint``, ``name_hint``, ``purpose``, ``scope`` and ``license_choice`` and answers a
        :class:`SignInSession`. ``channel="redirect"`` takes the same plus the required https
        ``redirect_uri`` and answers a :class:`~polaris_key.identity.redirect.RedirectSession`
        with ``authorize_url`` and ``complete(callback_url)``. Any other channel answers the typed
        ``version`` N/A (loopback, scheme and claimed-HTTPS redirects are I-15's)."""
        if channel == "device-code":
            return self._start(**opts)
        if channel == "redirect" and self._start_redirect is not None:
            return self._start_redirect(**opts)
        raise UnsupportedError(
            Unsupported(
                Feature.IDENTITY_REDIRECT_WEB,
                UnsupportedReason.VERSION,
                f"this SDK version has no {channel!r} sign-in channel",
            ),
        )
