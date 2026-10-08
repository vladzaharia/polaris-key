"""The Identity sub-client — device-code sign-in (RFC 8628) for hosts that cannot complete
a browser redirect: a CLI, a daemon, a game console, a kiosk.

* :meth:`IdentityClient.begin_sign_in` — ``POST /<p>/identity/auth/device/start``: the code
  the player types and the two verification URIs (the complete one, with the code in it, is
  the QR payload). The device code — the POLL credential — stays inside the prompt.
* :meth:`IdentityClient.poll_sign_in` — ``POST /<p>/identity/auth/device/poll``, exactly
  once. The caller paces.
* :meth:`IdentityClient.wait_for_sign_in` — the paced loop: at least ``interval`` between
  polls, longer after a ``slow_down``, never faster because a poll failed, and stopped by
  expiry, by ``timeout`` or by the caller's ``cancel`` event.

A ``ready`` poll stores the device token through Core's token manager and raises the same
acquisition event activation does, so the facade's forced sync runs exactly as it would
after ``license.activate_with_key()``.

A device-code sign-in yields the SIGNED-IN IDENTITY'S OWN licence and nothing else. The
Worker's callback merges nothing (P1-06): a device on an anonymous enrolled licence is not
attached to the account by signing in, and nothing here offers or implies that it is.
Mirrors ``@polaris-key/node``'s ``identity/client.ts``.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

import httpx

from ..constants_generated import Feature
from ..core.context import CoreContext
from ..core.errors import PolarisError
from ..core.token import TokenManager

__all__ = [
    "IdentityClient",
    "SignedInIdentity",
    "SignInPoll",
    "SignInPrompt",
    "SignInResult",
    "SLOW_DOWN_STEP_SECONDS",
]

#: RFC 8628 §3.5: a ``slow_down`` without an interval adds five seconds to the CURRENT
#: interval, so repeated interval-less answers keep lengthening it.
SLOW_DOWN_STEP_SECONDS = 5

#: Transient failures ``wait_for_sign_in`` rides out at the current interval: the network,
#: and a server that answered 5xx. Anything else ends the wait.
_TRANSIENT = frozenset({"network-error", "server-error"})


@dataclass(frozen=True)
class SignInPrompt:
    """What the host shows the player, plus the poll credential the SDK keeps using. Its
    ``repr`` leaves ``deviceCode`` out."""

    #: The poll credential. Never show it, never put it in a URL.
    deviceCode: str = field(repr=False)
    #: What the player types on the verification page, e.g. ``WDJB-MJHT``.
    userCode: str
    #: The page the player opens and types the code into.
    verificationUri: str
    #: The same page with the code pre-filled — the payload for a QR code or a link.
    verificationUriComplete: str
    #: Seconds the code lives for, as the server advertised it.
    expiresIn: int
    #: The minimum seconds between polls, as the server advertised it.
    interval: int
    #: When the code expires on THIS client's clock (epoch seconds).
    expiresAt: int
    #: The label the sign-in page shows (WIRE-CONTRACT-V4 §12.7.1): the Worker's echo, else
    #: (an older Worker) the label sent; ``None`` when there is none.
    deviceName: Optional[str] = None
    #: P1-07's opt-in: the polls ask the Worker to hold the flow at the signed-in identity
    #: (``confirm``) so the device can show it and offer the licence attach before minting.
    confirmIdentity: bool = False


@dataclass(frozen=True)
class SignedInIdentity:
    """Who the device is signed in as, as the Worker shows it: the name and verified e-mail
    (never ``sub`` or other claims). Either may be ``None``."""

    name: Optional[str] = None
    email: Optional[str] = None


@dataclass(frozen=True)
class SignInPoll:
    """One poll's answer. ``status`` is ``"pending"``, ``"slow-down"`` (with ``interval``,
    the seconds to wait before the next poll), ``"confirm"`` (the opt-in: signed in and held
    for the player's acceptance, with ``identity`` and ``attachable``), ``"ready"`` (the token is
    stored and the post-acquisition sync has run; ``identity`` and ``attached`` —
    ``"claimed"`` / ``"migrated"`` / ``None`` — when the Worker sent them), ``"expired"`` or
    ``"error"`` (with ``message``)."""

    status: str
    interval: Optional[int] = None
    message: Optional[str] = None
    identity: Optional[SignedInIdentity] = None
    attachable: Optional[bool] = None
    attached: Optional[str] = None


@dataclass(frozen=True)
class SignInResult:
    """How :meth:`IdentityClient.wait_for_sign_in` ended: ``"ready"`` (with ``identity`` and
    ``attached``), ``"expired"`` or ``"error"`` (with ``message``)."""

    status: str
    message: Optional[str] = None
    identity: Optional[SignedInIdentity] = None
    attached: Optional[str] = None


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
    """The seconds :meth:`IdentityClient.wait_for_sign_in` actually sleeps: never under one
    second (a zero, negative or non-finite interval would spin) and never past the code's own
    lifetime."""
    ceiling = float(expires_in) if math.isfinite(expires_in) and expires_in >= 1 else 1.0
    if not math.isfinite(interval):
        return ceiling if interval > 0 else 1.0
    return min(max(float(interval), 1.0), ceiling)


class IdentityClient:
    def __init__(
        self,
        ctx: CoreContext,
        tokens: TokenManager,
        on_acquired: Callable[[], None],
        *,
        deactivate: Optional[Callable[[], None]] = None,
        profile: Optional[Callable[[], Any]] = None,
        on_signed_out: Optional[Callable[[], None]] = None,
    ) -> None:
        self._ctx = ctx
        self._tokens = tokens
        self._on_acquired = on_acquired
        self._deactivate = deactivate
        self._profile = profile
        self._on_signed_out = on_signed_out
        #: The identity the last ``ready`` poll showed (this process).
        self._identity: Optional[SignedInIdentity] = None

    def begin_sign_in(
        self, device_name: Optional[str] = None, *, confirm_identity: bool = False
    ) -> SignInPrompt:
        """Begin a device-code sign-in.

        Raises ``PolarisError("service-unavailable")`` before any request when this product
        does not run Identity (D-21). No bearer is sent even when the device holds a token:
        a sign-in asks for the IDENTITY's credential, and the server binds the flow to this
        device by its id.
        """
        self._ctx.require_service("identity", Feature.IDENTITY_DEVICECODE)
        body: Dict[str, str] = {"deviceId": self._ctx.device_id}
        # §12.7.1: the per-call name, else the client's ``device_name``, else the platform
        # default, normalised exactly as the Worker will store it. ``""`` sends none.
        label = self._ctx.device_label(device_name)
        if label:
            body["deviceName"] = label
        res = self._post("identity/auth/device/start", body)
        if res.status_code != 200:
            raise PolarisError(
                _error_code(res, "sign-in-unavailable"),
                f"device sign-in could not start (status {res.status_code}).",
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
        return SignInPrompt(
            deviceCode=b["deviceCode"],
            userCode=b["userCode"],
            verificationUri=b["verificationUri"],
            verificationUriComplete=b["verificationUriComplete"],
            expiresIn=_whole_seconds(b["expiresIn"]),
            interval=_whole_seconds(b["interval"]),
            expiresAt=self._ctx.now() + _whole_seconds(b["expiresIn"]),
            deviceName=(
                (b["deviceName"] if isinstance(b["deviceName"], str) else None)
                if "deviceName" in b
                else label
            ),
            confirmIdentity=confirm_identity,
        )

    def poll_sign_in(
        self, prompt: SignInPrompt, *, attach_license: Optional[bool] = None
    ) -> SignInPoll:
        """Poll once. On ``ready`` the token is stored and the post-acquisition sync has
        completed before this returns.

        Raises ``PolarisError("network-error")`` when the request never got an answer and
        ``PolarisError("server-error")`` on a 5xx — neither says anything about the sign-in,
        so neither is folded into a status. :meth:`wait_for_sign_in` rides both out.
        """
        return self._poll(prompt, prompt.interval, attach_license)

    def accept_sign_in(self, prompt: SignInPrompt, *, attach_license: bool = False) -> SignInPoll:
        """Send the player's acceptance of the identity a ``confirm`` poll showed (P1-07):
        ``attach_license`` also attaches this device's anonymous enrolled licence to the account
        (offer it only when the confirmation said ``attachable``). One poll; ``ready`` completes
        the sign-in, a fresh ``confirm`` means what is attachable changed (ask again)."""
        return self._poll(prompt, prompt.interval, bool(attach_license))

    def _poll(
        self, prompt: SignInPrompt, current: int, decision: Optional[bool] = None
    ) -> SignInPoll:
        """One poll, where an interval-less ``slow_down`` lengthens ``current`` — the interval
        the caller is pacing at — rather than the prompt's original one."""
        self._ctx.require_service("identity", Feature.IDENTITY_DEVICECODE)
        body: Dict[str, Any] = {"deviceCode": prompt.deviceCode, "deviceId": self._ctx.device_id}
        extra: Dict[str, str] = {}
        if prompt.confirmIdentity:
            body["confirmIdentity"] = True
            if decision is not None:
                body["attachLicense"] = bool(decision)
            # The device's own token names the anonymous licence an attach would take. Sent only
            # on the opt-in: an ordinary poll asks for the identity's credential with no bearer.
            if self._tokens.current:
                extra["authorization"] = f"Bearer {self._tokens.current}"
        res = self._post("identity/auth/device/poll", body, extra)
        if res.status_code >= 500:
            raise PolarisError(
                "server-error",
                f"device sign-in poll failed with status {res.status_code}.",
            )
        body = _json(res)
        if res.status_code == 429:
            # The Worker's own `slow_down` carries the interval; a rate limiter in front of
            # it may answer 429 without one, which RFC 8628 §3.5 treats the same way.
            interval = body.get("interval")
            return SignInPoll(
                status="slow-down",
                interval=_whole_seconds(interval)
                if _is_seconds(interval)
                else current + SLOW_DOWN_STEP_SECONDS,
            )
        if res.status_code != 200:
            return SignInPoll(
                status="error",
                message=f"device sign-in poll refused (status {res.status_code}).",
            )
        status = body.get("status")
        if status == "pending":
            return SignInPoll(status="pending")
        if status == "timeout":
            return SignInPoll(status="expired")
        if status == "confirm":
            return SignInPoll(
                status="confirm",
                identity=_shown(body.get("identity")),
                attachable=body.get("attachable") is True,
            )
        if status == "ready":
            token = body.get("token")
            if not _is_str(token):
                return SignInPoll(status="error", message="ready without a token.")
            shown = _shown(body.get("identity"))
            self._identity = shown
            self._tokens.set(token, "signin")
            self._on_acquired()
            attached = body.get("attached") if body.get("attached") in ("claimed", "migrated") else None
            return SignInPoll(status="ready", identity=shown, attached=attached)
        return SignInPoll(status="error", message="device sign-in failed.")

    def wait_for_sign_in(
        self,
        prompt: SignInPrompt,
        timeout: Optional[float] = None,
        *,
        cancel: Optional[threading.Event] = None,
        on_confirm: Optional[Callable[[SignedInIdentity, bool], Optional[bool]]] = None,
    ) -> SignInResult:
        """Poll until the sign-in settles.

        The first poll waits one ``interval`` after the prompt was issued; a ``slow_down``
        lengthens the interval for every later poll and never shortens it; a transient
        failure is retried at the SAME interval. Returns ``expired`` once the prompt's
        ``expiresAt`` has passed, without asking the server.

        ``timeout`` (seconds) bounds the wait on top of the prompt's own expiry and raises
        :class:`TimeoutError` when it runs out first. Setting ``cancel`` stops polling and
        raises ``PolarisError("cancelled")``.

        With a ``confirm_identity`` prompt, a ``confirm`` answer calls
        ``on_confirm(identity, attachable)``: return ``True`` to accept and attach this device's
        licence, ``False`` to accept without attaching, or ``None`` to decline (the wait raises
        ``cancelled``). Without ``on_confirm`` the identity is accepted without an attach.
        """
        self._ctx.require_service("identity", Feature.IDENTITY_DEVICECODE)
        deadline = None if timeout is None else time.time() + timeout
        interval = prompt.interval
        decision: Optional[bool] = None
        while True:
            self._check_cancel(cancel)
            if self._ctx.now() >= prompt.expiresAt:
                return SignInResult(status="expired")
            delay = _poll_delay(interval, prompt.expiresIn)
            if deadline is not None and time.time() + delay > deadline:
                self._sleep(max(0.0, deadline - time.time()), cancel)
                self._check_cancel(cancel)
                raise TimeoutError("device sign-in did not complete within the timeout")
            self._sleep(delay, cancel)
            self._check_cancel(cancel)
            if self._ctx.now() >= prompt.expiresAt:
                return SignInResult(status="expired")
            try:
                poll = self._poll(prompt, interval, decision)
            except PolarisError as e:
                if e.code in _TRANSIENT:
                    continue
                raise
            if poll.status == "pending":
                continue
            if poll.status == "confirm":
                if decision is not None and not (decision and not poll.attachable):
                    continue  # the decision was sent; the Worker asks again only if needed
                answer = (
                    on_confirm(poll.identity or SignedInIdentity(), bool(poll.attachable))
                    if on_confirm is not None
                    else False
                )
                if answer is None:
                    raise PolarisError("cancelled", "the player declined the signed-in identity.")
                decision = bool(answer) and bool(poll.attachable)
                continue
            if poll.status == "slow-down":
                interval = max(interval, poll.interval or interval)
                continue
            return SignInResult(
                status=poll.status,
                message=poll.message,
                identity=poll.identity,
                attached=poll.attached,
            )

    # ── Conveniences (SDK parity pass §3.12) ────────────────────────────────────────
    def sign_in_with_browser(
        self,
        *,
        device_name: Optional[str] = None,
        open_url: Optional[Callable[[str], Any]] = None,
        on_prompt: Optional[Callable[[SignInPrompt], None]] = None,
        confirm_identity: bool = False,
        on_confirm: Optional[Callable[[SignedInIdentity, bool], Optional[bool]]] = None,
        timeout: Optional[float] = None,
        cancel: Optional[threading.Event] = None,
    ) -> SignInResult:
        """Sign in through the system browser: begin a device-code sign-in, open its
        ``verificationUriComplete`` (``webbrowser.open`` by default), and wait. The interim for
        native hosts until the redirect-token route lands (I-15). It polls
        ``/identity/auth/device/poll`` like any device-code sign-in (the old
        ``/identity/auth/poll`` is retired; the Worker no longer serves it). ``on_prompt`` sees
        the prompt first (show the
        code and a QR — ``polaris_key.qr.terminal(prompt.verificationUriComplete)`` — for a
        browser on another device)."""
        prompt = self.begin_sign_in(device_name, confirm_identity=confirm_identity)
        if on_prompt is not None:
            on_prompt(prompt)
        opener = open_url
        if opener is None:
            import webbrowser

            opener = webbrowser.open
        try:
            opener(prompt.verificationUriComplete)
        except Exception:
            pass  # no browser here: the prompt's code and QR still work from another device
        return self.wait_for_sign_in(prompt, timeout, cancel=cancel, on_confirm=on_confirm)

    def current(self) -> Optional[Dict[str, Any]]:
        """Who this device is signed in as: ``{"name", "email", "activatedAt"}`` from the
        verified licence document's signed profile when the token came from a sign-in, else
        the identity this process's sign-in showed; ``None`` when the device is not signed in."""
        if self._tokens.current is None:
            return None
        source = getattr(self._tokens, "source", None)
        profile = self._profile() if self._profile is not None else None
        if source == "signin" and profile is not None:
            return {
                "name": getattr(profile, "name", None),
                "email": getattr(profile, "email", None),
                "activatedAt": getattr(profile, "activatedAt", None),
            }
        if self._identity is not None:
            return {"name": self._identity.name, "email": self._identity.email, "activatedAt": None}
        return None

    def sign_out(self) -> None:
        """Sign this device out: release its seat and wipe the credential and cached documents
        (``license.deactivate()``), forget the identity, and raise the licence change event."""
        self._identity = None
        if self._deactivate is not None:
            self._deactivate()
        else:
            self._tokens.clear()
        if self._on_signed_out is not None:
            try:
                self._on_signed_out()
            except Exception:
                pass

    # ── Internals ───────────────────────────────────────────────────────────────────
    @staticmethod
    def _sleep(seconds: float, cancel: Optional[threading.Event]) -> None:
        if cancel is not None:
            cancel.wait(seconds)
        else:
            time.sleep(seconds)

    @staticmethod
    def _check_cancel(cancel: Optional[threading.Event]) -> None:
        if cancel is not None and cancel.is_set():
            raise PolarisError("cancelled", "device sign-in was cancelled.")

    def _post(
        self, path: str, body: Dict[str, Any], extra: Optional[Dict[str, str]] = None
    ) -> httpx.Response:
        url = self._ctx.url(path)
        headers = self._ctx.headers({"content-type": "application/json", **(extra or {})})
        self._ctx.http()  # the local-only refusal propagates as itself, not as a network error
        try:
            return self._ctx.request("POST", url, headers=headers, json=body)
        except httpx.HTTPError as e:
            raise PolarisError("network-error", str(e)) from e


def _json(res: httpx.Response) -> Dict[str, Any]:
    try:
        b = res.json()
    except ValueError:
        return {}
    return b if isinstance(b, dict) else {}


def _shown(v: Any) -> SignedInIdentity:
    if not isinstance(v, dict):
        return SignedInIdentity()
    name = v.get("name") if isinstance(v.get("name"), str) else None
    email = v.get("email") if isinstance(v.get("email"), str) else None
    return SignedInIdentity(name=name, email=email)


def _error_code(res: httpx.Response, fallback: str) -> str:
    """The Worker's flat (``{"error":"x"}``) or nested (``{"error":{"code":"x"}}``) code."""
    err = _json(res).get("error")
    if isinstance(err, str):
        return err
    if isinstance(err, dict) and isinstance(err.get("code"), str):
        return err["code"]
    return fallback
