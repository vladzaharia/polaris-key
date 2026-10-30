"""``identity.sign_in.start(channel="nearby")``: the new device's side of nearby sign-in (I-47.8;
WIRE-CONTRACT-V5 §12.11.5, §15.6.1). Mirrors ``@polaris-key/node``'s ``identity/nearbySession.ts`` (I-47.6).

D is a device with no way to sign in. The session joins the two halves that never call each other:

* the Worker half (:class:`~polaris_key.identity.nearby.NearbyRoutes`): ``nearby/start`` first, which
  answers the request handle, then ``nearby/poll`` until it answers;
* the LAN half (``client.cloud_connect.nearby.request``, CC-15): browse for approvers nearby, list them,
  and carry the vouch once the person taps one. It calls no route.

What the person sees: :attr:`NearbySignInSession.approvers` (cleaned labels, at most 8), then
:meth:`NearbySignInSession.choose` for the tapped one, which answers the ``code`` to show (``123 456``) and
sends the vouch request once it is shown. The person on the other device picks that code among three.

THE POLL IS THE AUTHORITY. :meth:`NearbySignInSession.wait` polls from the start (at least ``interval``
apart, longer after a ``slow_down``, at the server's ``Retry-After`` after a 503) and settles only on what
the Worker's poll says: a token is ``signed_in`` (stored through the token manager, as a device-code
sign-in stores it), ``timeout`` is ``expired``, a denial raises ``sign-in-denied``. :attr:`result` is what
``VOUCH_RESULT`` said over the LAN and is for display only: it never signs anyone in.

A ``KEYRING_WRAP`` (record ``0x0030``) the approver sends is captured and held; it is applied after a
sign-in the person confirmed (:meth:`confirm_account`), and dropped by :meth:`decline_account`. Nothing
here prints or keeps the handle, the proofs, the code, the token or a wrap in a ``repr``.

``cancel()`` stops the polling and closes the LAN side (a request nobody collects simply lapses on the
Worker). After ``signed_in`` the LAN request stays open until :meth:`confirm_account`,
:meth:`decline_account`, :meth:`close` or its own 300 s end, so a wrap sent just after the approval is not
lost.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional

from ..constants_generated import ErrorCode, Feature, UnsupportedReason
from ..core.caps import Unsupported, UnsupportedError
from ..core.errors import PolarisError
from ..core.peer_display import clean_label, clean_platform
from .nearby import NearbyCredentials, NearbyRoutes, NearbyStarted, NearbyUnavailable
from .sign_in import (
    CANCELLED,
    EXPIRED,
    PENDING,
    SIGNED_IN,
    SignInActivation,
    SignInDeps,
    SignInOutcome,
)

__all__ = [
    "KEYRING_WRAP_RECORD",
    "NearbyApprover",
    "NearbyCode",
    "NearbyDeps",
    "NearbySignInSession",
    "start_nearby_sign_in",
]

#: The Sync record an approver sends the wrap in (§15.6, ``KEYRING_WRAP``).
KEYRING_WRAP_RECORD = 0x0030

#: Transient failures ``wait`` rides out at the current interval: the network, and a 5xx.
_TRANSIENT = frozenset({"network-error", "server-error"})
#: The longest a ``Retry-After`` holds the poll back, seconds.
_MAX_RETRY_AFTER = 60


@dataclass(frozen=True)
class NearbyApprover:
    """One approver in the list. Unauthenticated display data (any device on the network can be listed):
    show it as "reported by the device", never as proof of who is asking."""

    id: str
    label: Optional[str]
    platform: str


@dataclass(frozen=True)
class NearbyCode:
    """The code D shows, like ``123 456``. Not in a ``repr``."""

    code: str = field(repr=False)

    def __str__(self) -> str:
        return self.code


@dataclass
class NearbyDeps:
    """What the session reads of the client. ``creds`` is D's device id, key port and bearer (made
    when none exist); ``nearby`` is ``client.cloud_connect.nearby``; ``supported`` says whether this runtime
    can browse the network (``nearby-unsupported`` otherwise)."""

    routes: NearbyRoutes
    creds: Callable[[], NearbyCredentials]
    nearby: Callable[[], Any]
    supported: Callable[[str], bool]


def _unsupported(reason: str, detail: str, code: str) -> UnsupportedError:
    return UnsupportedError(Unsupported(Feature.IDENTITY_NEARBY, reason, detail), code)


class NearbySignInSession:
    """A running nearby sign-in on D (see the module docstring)."""

    channel = "nearby"

    def __init__(
        self,
        *,
        started: NearbyStarted,
        request: Any,
        creds: Callable[[], NearbyCredentials],
        deps: SignInDeps,
        routes: NearbyRoutes,
        expires_at: int,
        device_name: Optional[str],
    ) -> None:
        self.__started = started
        self._request = request
        self._creds = creds
        self._deps = deps
        self._routes = routes
        #: Seconds the request lives, as the Worker advertised it.
        self.expires_in = started.expires_in
        #: The minimum seconds between polls, as advertised; a ``slow_down`` lengthens it.
        self.interval = started.interval
        #: When the request lapses on THIS client's clock (epoch seconds).
        self.expires_at = expires_at
        #: The label the approving device is shown (§12.7.1), or ``None``.
        self.device_name = device_name
        self._code: Optional[NearbyCode] = None
        self._cancelled = threading.Event()
        self._lock = threading.Lock()
        self._wrap: Optional[bytes] = None
        self._closed = False
        self._off_record = request.on_record(self._on_record)

    def __repr__(self) -> str:
        return (
            f"NearbySignInSession(channel={self.channel!r}, expires_in={self.expires_in!r}, "
            f"interval={self.interval!r}, expires_at={self.expires_at!r}, device_name={self.device_name!r})"
        )

    def __reduce__(self) -> Any:
        raise TypeError("a nearby sign-in session cannot be pickled")

    # ── What the person sees ────────────────────────────────────────────────────────
    @property
    def approvers(self) -> List[NearbyApprover]:
        """The approvers nearby that said ``HELLO``, at most 8, labels cleaned; empty once the person
        chose one."""
        return [_view(a) for a in self._request.approvers]

    def on_approvers(self, fn: Callable[[List[NearbyApprover]], None]) -> Callable[[], None]:
        """Call ``fn`` with the list each time it changes. It runs on the Connect thread: keep it short and
        do not call a blocking method from it. Returns the unsubscribe."""
        return self._request.on_approvers(lambda items: fn([_view(a) for a in items]))  # type: ignore[no-any-return]

    @property
    def code(self) -> Optional[NearbyCode]:
        """The code to show, once :meth:`choose` ran; ``None`` before."""
        return self._code

    @property
    def result(self) -> Optional[str]:
        """What ``VOUCH_RESULT`` said over the LAN (``approved``, ``denied``, ``expired`` …). For display
        only: the poll decides the sign-in."""
        return self._request.result  # type: ignore[no-any-return]

    def on_result(self, fn: Callable[[str], None]) -> Callable[[], None]:
        """Call ``fn`` with the ``VOUCH_RESULT`` status (display only), on the Connect thread."""
        return self._request.on_result(fn)  # type: ignore[no-any-return]

    def choose(self, approver_id: str) -> NearbyCode:
        """The person tapped this approver. Starts the code on that session only (the others close) and
        answers the code to show; the vouch request goes out once it is shown. Raises ``LanError`` when
        that approver is gone, one is already chosen, or the request ended."""
        shown = self._request.choose(approver_id)
        self._code = NearbyCode(shown.code)
        return self._code

    # ── The Worker's say ────────────────────────────────────────────────────────────
    def cancel(self) -> None:
        """Stop. A running ``wait`` answers ``cancelled``; the LAN side closes and the request simply
        lapses on the Worker."""
        self._cancelled.set()
        self.close()

    def wait(
        self,
        timeout: Optional[float] = None,
        *,
        once: bool = False,
        cancel_token: Optional[threading.Event] = None,
    ) -> SignInOutcome:
        """Poll until the sign-in settles: ``signed_in | expired | cancelled``. ``once=True`` polls
        exactly once and may answer ``pending`` (``interval``; ``slow_down`` when the Worker asked for a
        longer one). A denial raises ``sign-in-denied``; a failure ``sign-in-failed`` or the Worker's own
        code. ``timeout`` (seconds) raises :class:`TimeoutError`. ``cancel_token`` is a
        :class:`threading.Event` another thread may set."""
        deps = self._deps
        deps.ctx.require_service("identity", Feature.IDENTITY_NEARBY)
        deadline = None if timeout is None else time.time() + timeout
        hold = 0.0

        def stopped() -> bool:
            return self._cancelled.is_set() or (cancel_token is not None and cancel_token.is_set())

        while True:
            if stopped():
                return SignInOutcome(kind=CANCELLED)
            if not once:
                if deps.ctx.now() >= self.expires_at:
                    self.close()
                    return SignInOutcome(kind=EXPIRED)
                delay = max(float(self.interval), hold, 1.0)
                hold = 0.0
                if deadline is not None and time.time() + delay > deadline:
                    self._sleep(max(0.0, deadline - time.time()), cancel_token)
                    if stopped():
                        return SignInOutcome(kind=CANCELLED)
                    raise TimeoutError("nearby sign-in did not complete within the timeout")
                self._sleep(delay, cancel_token)
                if stopped():
                    return SignInOutcome(kind=CANCELLED)
                if deps.ctx.now() >= self.expires_at:
                    self.close()
                    return SignInOutcome(kind=EXPIRED)
            try:
                r = self._routes.poll(self._creds(), self.__started)
            except PolarisError as e:
                if not once and e.code in _TRANSIENT:
                    continue
                raise
            if isinstance(r, NearbyUnavailable):
                # The operator's gate went off while the person was waiting.
                self.close()
                raise _unsupported(
                    UnsupportedReason.PRODUCT, "nearby sign-in is no longer served", ErrorCode.SERVICE_UNAVAILABLE
                )
            kind = getattr(r, "kind", None)
            if kind == "refused":
                self.close()
                raise PolarisError(
                    r.code if r.code else ErrorCode.SIGN_IN_FAILED,
                    "nearby sign-in was refused.",
                    status=r.status,
                )
            if kind == "signed_in":
                return SignInOutcome(
                    kind=SIGNED_IN,
                    subject=r.subject,
                    activation=SignInActivation(license_id=r.license_id or deps.license_id()),
                    identity=r.identity,
                    scope=r.scope,
                )
            if stopped():
                return SignInOutcome(kind=CANCELLED)
            if kind == "timeout":
                self.close()
                return SignInOutcome(kind=EXPIRED)
            if kind == "denied":
                self.close()
                raise PolarisError(ErrorCode.SIGN_IN_DENIED, "nearby sign-in was refused.")
            if kind == "retry":
                hold = float(min(r.retry_after_seconds or self.interval, _MAX_RETRY_AFTER))
            elif kind == "slow_down":
                self.interval = max(self.interval, r.interval or self.interval)
                if once:
                    return SignInOutcome(kind=PENDING, interval=self.interval, slow_down=True)
                continue
            if once:
                return SignInOutcome(kind=PENDING, interval=self.interval)

    def _sleep(self, seconds: float, token: Optional[threading.Event]) -> None:
        """Sleep in quarter-second slices so ``cancel()`` and ``cancel_token`` stop the wait within one
        slice; counted down, not read off a clock, so a pinned or faked clock still terminates."""
        left = max(0.0, seconds)
        while left > 0 and not (self._cancelled.is_set() or (token is not None and token.is_set())):
            step = min(left, 0.25)
            time.sleep(step)
            left -= step

    # ── After the sign-in ───────────────────────────────────────────────────────────
    def confirm_account(self) -> None:
        """The person confirmed that the signed-in account is theirs: the records held from the approver
        (the key ring's wrap) are released. It counts for this session only; it is not a standing consent."""
        self._request.confirm_account()

    def decline_account(self) -> None:
        """The person said "not you" (or the screen timed out): every held record is dropped and the LAN
        session closes."""
        with self._lock:
            self._wrap = None
        self._request.decline_account()

    def close(self) -> None:
        """Close the LAN side. Idempotent; a failure to close is not an error."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
        try:
            self._off_record()
        except Exception:
            pass
        try:
            self._request.close()
        except Exception:
            pass

    def _on_record(self, rec: Any) -> None:
        """A Sync record, delivered once the person confirmed the account. Only ``KEYRING_WRAP`` is kept."""
        if getattr(rec, "type", None) == KEYRING_WRAP_RECORD:
            with self._lock:
                self._wrap = bytes(rec.body)


def _view(a: Any) -> NearbyApprover:
    label = clean_label(a.label) if isinstance(a.label, str) else None
    return NearbyApprover(id=a.id, label=label, platform=clean_platform(a.platform or ""))


def start_nearby_sign_in(
    nd: NearbyDeps, deps: SignInDeps, *, device_name: Optional[str] = None
) -> NearbySignInSession:
    """Begin a nearby sign-in on D. Refuses before anything is sent when it cannot run: the typed
    ``service-unavailable`` N/A when the product's discovery names no nearby approval, ``nearby-unsupported``
    when this runtime cannot browse, ``local-only`` without a transport. Then ``nearby/start``, then the LAN
    request (a failure there leaves the Worker's request to lapse), polling from the start."""
    ctx = deps.ctx
    ctx.http()  # local-only refuses here, before keys or discovery
    if not nd.supported("requester"):
        raise _unsupported(
            UnsupportedReason.RUNTIME, "this runtime cannot look for nearby devices", ErrorCode.NEARBY_UNSUPPORTED
        )
    creds = nd.creds()
    started = nd.routes.start(creds, device_name=device_name)
    if isinstance(started, NearbyUnavailable):
        raise _unsupported(
            UnsupportedReason.PRODUCT,
            "this product's discovery does not name nearby approval",
            ErrorCode.SERVICE_UNAVAILABLE,
        )
    if getattr(started, "kind", None) == "refused":
        raise PolarisError(
            started.code if started.code else ErrorCode.SIGN_IN_UNAVAILABLE,
            "nearby sign-in could not start.",
            status=started.status,
        )
    label = ctx.device_label(device_name) or None
    request = nd.nearby().request(started.request, label=label, expires_in=started.expires_in)
    return NearbySignInSession(
        started=started,
        request=request,
        creds=nd.creds,
        deps=deps,
        routes=nd.routes,
        expires_at=ctx.now() + int(math.ceil(started.expires_in)),
        device_name=label,
    )
