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

A ``KEYRING_WRAP`` (record ``0x0030``) the approver sends is captured and held; it is adopted into the key
ring after a sign-in the person confirmed (:meth:`confirm_account`: the ring, epoch and ``kid`` are checked
against a fresh read, and a server copy that differs never replaces it), and dropped by
:meth:`decline_account`. With no channel copy nothing is applied during the hand-off (T21): the normal
``keyring.unlock()`` opens the server's copy later. Nothing
here prints or keeps the handle, the proofs, the code, the token or a wrap in a ``repr``.

``cancel()`` stops the polling and closes the LAN side (a request nobody collects simply lapses on the
Worker). After ``signed_in`` the LAN request stays open until :meth:`confirm_account`,
:meth:`decline_account`, :meth:`close` or its own 300 s end, so a wrap sent just after the approval is not
lost.

UNCONFIRMED UNTIL :meth:`confirm_account` (V5 §15.6.1 rule 12, D-21). The token is held under the
``unconfirmed`` provenance: not a sign-in, dropped at the next start, and the stored subject and the
``signed_in`` identity event (so Cloud Sync and Connect) wait for the confirmation. A decline, a
:meth:`cancel`/:meth:`close`, or the ``expires_in``-second screen deadline (a daemon timer, counted from
the moment :meth:`wait` answered ``signed_in``) ends it: the wrap and every held record are dropped, the
device signs out as a best effort, and the token goes locally whatever the Worker answered. A ``signed_in``
poll that lands after such an end does the same at once. The LAN peer closing after ``approved`` is NOT an
end (rule 8: the server copy is the fallback, and M's CLI stops its listener right after approving).
:attr:`ended` / :meth:`on_end` let a screen leave. :meth:`wait` keeps its first terminal outcome.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional, cast

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
    #: The person confirmed the account: the token becomes a sign-in, the subject is stored and the
    #: ``signed_in`` identity event is raised (Cloud Sync and Connect start only now).
    confirm: Callable[[str], Any]
    #: Drop the unconfirmed sign-in locally whatever the Worker answered: the token, its mark and the
    #: stored identity.
    drop_local: Callable[[], Any]
    #: Whether the held token is still the given one, the token this session's poll stored. A later
    #: sign-in made another way replaces it, and this session then leaves it alone.
    holds: Callable[[str], bool]
    #: ``client.keyring``, where the approver's ``KEYRING_WRAP`` is adopted (``None``: it is dropped).
    keyring: Optional[Callable[[], Any]] = None
    #: ``identity.sign_out``: a declined account signs the device out again (V5 §15.6.1 rule 12).
    sign_out: Optional[Callable[[], Any]] = None


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
        keyring: Optional[Callable[[], Any]] = None,
        sign_out: Optional[Callable[[], Any]] = None,
        confirm: Callable[[str], Any],
        drop_local: Callable[[], Any],
        holds: Callable[[str], bool],
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
        self._keyring = keyring
        self._sign_out = sign_out
        self._wrap_state = "none"
        self._on_wrap: List[Callable[[str], None]] = []
        self._signed_in = False
        self._confirmed = False
        #: The person's confirmation has begun: the deadline and an end no longer discard (``_confirmed``
        #: follows once the held records are handed over, so a wrap in them is taken here, not off-thread).
        self._confirming = False
        self._confirm = confirm
        self._drop_local = drop_local
        self._holds = holds
        self._token: Optional[str] = None
        self._subject: Optional[str] = None
        self._ended = False
        self._on_end: List[Callable[[], None]] = []
        self._deadline: Optional[threading.Timer] = None
        self._final: Optional[Any] = None  # the first terminal outcome (a SignInOutcome or an exception)
        self._wait_lock = threading.Lock()
        self._discard_lock = threading.Lock()
        #: The key ring's answer to the channel copy of the wrap (``None`` until one was adopted).
        self.keyring_result: Optional[Any] = None
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
        lapses on the Worker. After ``signed_in`` and before the confirmation it also signs the device out
        (D-21)."""
        self.close()

    @property
    def ended(self) -> bool:
        """True once the sign-in ended unconfirmed (a decline, a cancel or close, the screen deadline)."""
        return self._ended

    def on_end(self, fn: Callable[[], None]) -> Callable[[], None]:
        """Call ``fn`` once when the sign-in ends unconfirmed, so a screen can leave (on whichever thread
        ended it; keep it short). Called at once when it already ended. Returns the unsubscribe."""
        with self._lock:
            if not self._ended:
                self._on_end.append(fn)

                def off() -> None:
                    with self._lock:
                        if fn in self._on_end:
                            self._on_end.remove(fn)

                return off
        try:
            fn()
        except Exception:
            pass
        return lambda: None

    def _halt(self) -> bool:
        """The end of this sign-in: no further poll is honoured, the deadline stops, listeners hear of it
        (once, and only while unconfirmed). Answers whether THIS call ended the sign-in: a confirmation
        that began first wins, and one decision is taken under the lock."""
        self._cancelled.set()
        timer, self._deadline = self._deadline, None
        if timer is not None:
            timer.cancel()
        with self._lock:
            if self._ended or self._confirming:
                return False
            self._ended = True
            listeners, self._on_end = self._on_end, []
        for fn in listeners:
            try:
                fn()
            except Exception:
                pass
        return True

    def _arm_deadline(self) -> None:
        """The confirm screen's deadline: ``expires_in`` seconds from the moment the poll answered, on a
        monotonic timer."""
        timer = threading.Timer(float(self.expires_in), self._on_deadline)
        timer.daemon = True
        self._deadline = timer
        timer.start()

    def _on_deadline(self) -> None:
        # Discard only when this call ended the sign-in: a confirm that won the lock first stands.
        if self._halt():
            self._discard()

    def _discard(self) -> None:
        """The one end path for an unconfirmed sign-in; idempotent and serialized. The held wrap is
        dropped, the LAN request declines and closes, the Worker is asked to sign out as a best effort,
        and whatever it answered the token, its mark and the stored identity go."""
        with self._discard_lock:
            with self._lock:
                self._wrap = None
            try:
                self._request.decline_account()
            except Exception:
                pass
            self._close_lan()
            if not self._signed_in:
                return
            token, self._token = self._token, None
            if token is None or not self._holds(token):
                # Another sign-in holds the device now: this session ends without touching it.
                self._signed_in = False
                return
            if self._sign_out is not None:
                try:
                    self._sign_out()
                except Exception:
                    pass
            try:
                self._drop_local()
            except Exception:
                pass
            self._signed_in = False

    def _settled(self) -> SignInOutcome:
        f = self._final
        if isinstance(f, BaseException):
            raise f
        return cast(SignInOutcome, f)

    def _end_ok(self, outcome: SignInOutcome) -> SignInOutcome:
        self._final = outcome
        return outcome

    def _fail(self, error: BaseException) -> BaseException:
        self._final = error
        return error

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
        :class:`threading.Event` another thread may set. The first terminal outcome (a sign-in, an expiry, a
        refusal) is kept: a later call gets the same one, with no poll (the token is handed over once)."""
        with self._wait_lock:
            if self._final is not None:
                return self._settled()
            return self._wait(timeout, once, cancel_token)

    def _wait(
        self, timeout: Optional[float], once: bool, cancel_token: Optional[threading.Event]
    ) -> SignInOutcome:
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
                    self._close_lan()
                    return self._end_ok(SignInOutcome(kind=EXPIRED))
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
                    self._close_lan()
                    return self._end_ok(SignInOutcome(kind=EXPIRED))
            try:
                r = self._routes.poll(self._creds(), self.__started)
            except PolarisError as e:
                if not once and e.code in _TRANSIENT:
                    continue
                raise
            if isinstance(r, NearbyUnavailable):
                # The operator's gate went off while the person was waiting.
                self._close_lan()
                raise self._fail(
                    _unsupported(
                        UnsupportedReason.PRODUCT,
                        "nearby sign-in is no longer served",
                        ErrorCode.SERVICE_UNAVAILABLE,
                    )
                )
            kind = getattr(r, "kind", None)
            if kind == "refused":
                self._close_lan()
                raise self._fail(
                    PolarisError(
                        r.code if r.code else ErrorCode.SIGN_IN_FAILED,
                        "nearby sign-in was refused.",
                        status=r.status,
                    )
                )
            if kind == "signed_in":
                # The routes stored the token (unconfirmed). A decline or cancel that got in before this
                # answer discards it at once; nothing is handed to the caller (D-21).
                self._signed_in = True
                self._subject = r.subject
                self._token = r.token
                if self._cancelled.is_set():
                    self._discard()
                    return SignInOutcome(kind=CANCELLED)
                self._arm_deadline()
                return self._end_ok(
                    SignInOutcome(
                        kind=SIGNED_IN,
                        subject=r.subject,
                        activation=SignInActivation(license_id=r.license_id or deps.license_id()),
                        identity=r.identity,
                        scope=r.scope,
                    )
                )
            if stopped():
                return SignInOutcome(kind=CANCELLED)
            if kind == "timeout":
                self._close_lan()
                return self._end_ok(SignInOutcome(kind=EXPIRED))
            if kind == "denied":
                self._close_lan()
                raise self._fail(PolarisError(ErrorCode.SIGN_IN_DENIED, "nearby sign-in was refused."))
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
    def confirm_account(self) -> Optional[Any]:
        """The person confirmed that the signed-in account is theirs: the records held from the approver
        are released and the key ring's wrap, if one came over the LAN, is adopted
        (:meth:`~polaris_key.keyring.KeyringClient.adopt_wrap`, which checks it against a fresh read of the
        ring). It counts for this session only; it is not a standing consent. Answers the key ring's
        :class:`~polaris_key.keyring.UnlockResult` (also :attr:`keyring_result`), or ``None`` when no wrap
        came over the channel: nothing is applied then, and the normal ``keyring.unlock()`` opens the
        server's copy later. Raises ``sign-in-failed`` before the poll has signed this device in: there is
        no account to confirm yet, and nothing is released."""
        stale = False
        with self._lock:
            # One decision under the lock: the end and the confirmation cannot both win.
            if self._ended:
                raise PolarisError(ErrorCode.SIGN_IN_FAILED, "The sign-in ended before it was confirmed.")
            if not self._signed_in or self._subject is None:
                raise PolarisError(ErrorCode.SIGN_IN_FAILED, "Nothing to confirm: the device is not signed in.")
            if not self._confirming and (self._token is None or not self._holds(self._token)):
                stale = True
            first = not self._confirming
            if not stale:
                self._confirming = True
        if stale:
            # A later sign-in replaced this one's token: nothing of it is written, nothing signed out.
            if self._halt():
                self._discard()
            raise PolarisError(ErrorCode.SIGN_IN_FAILED, "The sign-in ended before it was confirmed.")
        timer, self._deadline = self._deadline, None
        if timer is not None:
            timer.cancel()
        if first:
            try:
                self._confirm(self._subject)
            except BaseException:
                with self._lock:
                    self._confirming = False
                raise
        try:
            # The engine hands over the records it held, on this thread, before this returns.
            self._request.confirm_account()
        except Exception:
            pass  # the chosen session is gone: no records, the server copy is the fallback
        with self._lock:
            self._confirmed = True
        # A wrap that arrives later is taken as it comes (``_on_record``).
        return self._apply_wrap()

    @property
    def wrap(self) -> str:
        """What became of the wrap the approver sent: ``none`` until one arrives and is taken, then
        ``applied`` (the key ring opened it) or ``refused``."""
        return self._wrap_state

    def on_wrap(self, fn: Callable[[str], None]) -> Callable[[], None]:
        """Call ``fn`` with the :attr:`wrap` state each time it changes (not on the Connect thread, and a
        failure inside ``fn`` is swallowed). Returns the unsubscribe."""
        with self._lock:
            self._on_wrap.append(fn)

        def off() -> None:
            with self._lock:
                if fn in self._on_wrap:
                    self._on_wrap.remove(fn)

        return off

    def _apply_wrap(self) -> Optional[Any]:
        """Adopt the channel copy of the wrap once, after a sign-in the person confirmed. A failure to read
        the ring is not an error here: the server's copy is the fallback."""
        if not (self._signed_in and self._confirmed) or self._keyring is None:
            return None
        with self._lock:
            wrap, self._wrap = self._wrap, None
        if wrap is None:
            return None
        state = "refused"
        try:
            self.keyring_result = self._keyring().adopt_wrap(wrap)
            if getattr(self.keyring_result, "kind", None) == "unlocked":
                state = "applied"
        except PolarisError:
            self.keyring_result = None
        with self._lock:
            self._wrap_state = state
            listeners = list(self._on_wrap)
        for fn in listeners:
            try:
                fn(state)
            except Exception:
                pass
        return self.keyring_result

    def decline_account(self) -> None:
        """The person said "not you" (or the screen timed out): every held record is dropped, the LAN
        session closes and the device signs out again (V5 §15.6.1 rule 12: it keeps no key and no token of
        an account that is not theirs). Safe to call more than once."""
        self._halt()
        self._discard()

    def close(self) -> None:
        """End the session: the LAN side closes (idempotent; a failure to close is not an error). After
        ``signed_in`` and before the confirmation this is an end like a decline: the device signs out."""
        ended = self._halt()
        self._close_lan()
        if ended and self._signed_in:
            self._discard()

    def _close_lan(self) -> None:
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
                late = self._signed_in and self._confirmed
            if late:
                # The person already confirmed: take the wrap as it arrives, off the Connect thread (the
                # key ring checks it against a fresh read of the ring over the network).
                threading.Thread(target=self._apply_wrap, name="pkey-nearby-wrap", daemon=True).start()


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
        keyring=nd.keyring,
        sign_out=nd.sign_out,
        confirm=nd.confirm,
        drop_local=nd.drop_local,
        holds=nd.holds,
    )
