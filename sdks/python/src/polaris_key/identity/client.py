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


@dataclass(frozen=True)
class SignInPoll:
    """One poll's answer. ``status`` is ``"pending"``, ``"slow-down"`` (with ``interval``,
    the seconds to wait before the next poll), ``"ready"`` (the token is stored and the
    post-acquisition sync has run), ``"expired"`` or ``"error"`` (with ``message``)."""

    status: str
    interval: Optional[int] = None
    message: Optional[str] = None


@dataclass(frozen=True)
class SignInResult:
    """How :meth:`IdentityClient.wait_for_sign_in` ended: ``"ready"``, ``"expired"`` or
    ``"error"`` (with ``message``)."""

    status: str
    message: Optional[str] = None


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
    ) -> None:
        self._ctx = ctx
        self._tokens = tokens
        self._on_acquired = on_acquired

    def begin_sign_in(self, device_name: Optional[str] = None) -> SignInPrompt:
        """Begin a device-code sign-in.

        Raises ``PolarisError("service-unavailable")`` before any request when this product
        does not run Identity (D-21). No bearer is sent even when the device holds a token:
        a sign-in asks for the IDENTITY's credential, and the server binds the flow to this
        device by its id.
        """
        self._ctx.require_service("identity", Feature.IDENTITY_DEVICECODE)
        body: Dict[str, str] = {"deviceId": self._ctx.device_id}
        name = (device_name or "").strip()
        if name:
            body["deviceName"] = name
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
        )

    def poll_sign_in(self, prompt: SignInPrompt) -> SignInPoll:
        """Poll once. On ``ready`` the token is stored and the post-acquisition sync has
        completed before this returns.

        Raises ``PolarisError("network-error")`` when the request never got an answer and
        ``PolarisError("server-error")`` on a 5xx — neither says anything about the sign-in,
        so neither is folded into a status. :meth:`wait_for_sign_in` rides both out.
        """
        return self._poll(prompt, prompt.interval)

    def _poll(self, prompt: SignInPrompt, current: int) -> SignInPoll:
        """One poll, where an interval-less ``slow_down`` lengthens ``current`` — the interval
        the caller is pacing at — rather than the prompt's original one."""
        self._ctx.require_service("identity", Feature.IDENTITY_DEVICECODE)
        res = self._post(
            "identity/auth/device/poll",
            {"deviceCode": prompt.deviceCode, "deviceId": self._ctx.device_id},
        )
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
        if status == "ready":
            token = body.get("token")
            if not _is_str(token):
                return SignInPoll(status="error", message="ready without a token.")
            self._tokens.set(token, "signin")
            self._on_acquired()
            return SignInPoll(status="ready")
        return SignInPoll(status="error", message="device sign-in failed.")

    def wait_for_sign_in(
        self,
        prompt: SignInPrompt,
        timeout: Optional[float] = None,
        *,
        cancel: Optional[threading.Event] = None,
    ) -> SignInResult:
        """Poll until the sign-in settles.

        The first poll waits one ``interval`` after the prompt was issued; a ``slow_down``
        lengthens the interval for every later poll and never shortens it; a transient
        failure is retried at the SAME interval. Returns ``expired`` once the prompt's
        ``expiresAt`` has passed, without asking the server.

        ``timeout`` (seconds) bounds the wait on top of the prompt's own expiry and raises
        :class:`TimeoutError` when it runs out first. Setting ``cancel`` stops polling and
        raises ``PolarisError("cancelled")``.
        """
        self._ctx.require_service("identity", Feature.IDENTITY_DEVICECODE)
        deadline = None if timeout is None else time.time() + timeout
        interval = prompt.interval
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
                poll = self._poll(prompt, interval)
            except PolarisError as e:
                if e.code in _TRANSIENT:
                    continue
                raise
            if poll.status == "pending":
                continue
            if poll.status == "slow-down":
                interval = max(interval, poll.interval or interval)
                continue
            return SignInResult(status=poll.status, message=poll.message)

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

    def _post(self, path: str, body: Dict[str, Any]) -> httpx.Response:
        url = self._ctx.url(path)
        headers = self._ctx.headers({"content-type": "application/json"})
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


def _error_code(res: httpx.Response, fallback: str) -> str:
    """The Worker's flat (``{"error":"x"}``) or nested (``{"error":{"code":"x"}}``) code."""
    err = _json(res).get("error")
    if isinstance(err, str):
        return err
    if isinstance(err, dict) and isinstance(err.get("code"), str):
        return err["code"]
    return fallback
