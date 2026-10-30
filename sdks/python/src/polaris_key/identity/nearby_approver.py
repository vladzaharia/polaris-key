"""``identity.nearby.on_request(handler, ...)``: the signed-in device's side of nearby sign-in (I-47.9;
WIRE-CONTRACT-V5 §12.11.5, §15.6.1). Mirrors ``@polaris-key/node``'s ``identity/nearbyApprover.ts`` (I-47.7).

M is a device that is signed in. It advertises only while the host's ``on_request`` runs (``prompt=True``
while "Approve a nearby device" is open, or ``prompt=False`` with ``background=True`` when the person
allowed background approval); the SDK core never advertises on its own. Each session that reaches the code
stage becomes an :class:`NearbyAsk` handed to the handler, on the Connect thread: show it, and hand it to the
thread that talks to the person (a blocking call from the handler raises ``RuntimeError``).

The ask carries ``device`` (the label D reported, cleaned: display data, not proof of who is asking),
``platform`` and the three ``codes``. The person picks the one D shows:

* :meth:`NearbyAsk.pick` with the matching code delivers D's verified request; the route client then sends
  ``nearby/approve`` with EXACTLY that request's handle, device id and keys, and the answer goes to the
  vouch's ``finish`` step. The step it returns is one of the ``NearbyApproval`` states, one to one:
  ``approved``, ``mismatch``, ``not-nearby``, ``denied``, ``expired``, ``device-limit``, ``choose``,
  ``account-required``, ``rate-limited``. A ``choose`` step carries the licence ``choices`` and
  :meth:`NearbyApprovalStep.choose` / :meth:`NearbyApprovalStep.cancel` (a deny) finish the same approval;
* :meth:`NearbyAsk.deny` before a matched pick is "None of these match": the session closes, nothing is
  sent, no route is called. After a matched pick it sends ``decision: deny``.

NO SILENT APPROVAL: ``nearby/approve`` is reachable only from a ``pick()`` that matched on that session,
with the keys of the verified request; ``deny`` is sent only after a matched code. A wrong code is
``mismatch`` and calls no route. M's 409 ``device_keys_required`` registers its keys once and retries once.
A 404 is read through a fresh discovery (N11) by the vouch's finish step. Sign-out stops the approver (the
facade's sign-out hook, through Cloud Connect's order); nothing is left listening after ``stop()``.

Nothing here prints or keeps the handle, the proofs, the keys, the code or the token in a ``repr``.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from ..connect.errors import LanError
from ..constants_generated import ErrorCode
from ..core.errors import PolarisError
from .nearby import NearbyApproveResult, NearbyCredentials, NearbyRoutes

__all__ = ["NearbyApprovalStep", "NearbyAsk", "start_nearby_approver"]

#: The ``NearbyApproval`` states (ui-matrix), the steps a ``pick`` can end in.
STEPS = (
    "approved",
    "mismatch",
    "not-nearby",
    "denied",
    "expired",
    "device-limit",
    "choose",
    "account-required",
    "rate-limited",
)


@dataclass(frozen=True)
class NearbyApprovalStep:
    """Where an approval stands. ``kind`` is one of :data:`STEPS`. ``approved`` carries ``device_label``;
    ``rate-limited`` ``retry_after_seconds``; ``choose`` the licence ``choices`` and the two ways on."""

    kind: str
    device_label: Optional[str] = None
    choices: Optional[Dict[str, Any]] = None
    retry_after_seconds: Optional[int] = None
    _choose: Optional[Callable[[Dict[str, Any]], "NearbyApprovalStep"]] = field(default=None, repr=False)
    _cancel: Optional[Callable[[], "NearbyApprovalStep"]] = field(default=None, repr=False)

    def choose(self, choice: Dict[str, Any]) -> "NearbyApprovalStep":
        """``choose`` only: approve with ``{"kind": "license", "licenseId": …}`` or ``{"kind": "create"}``."""
        if self.kind != "choose" or self._choose is None:
            raise PolarisError(ErrorCode.INVALID_OPTIONS, "There is no licence to choose.")
        return self._choose(choice)

    def cancel(self) -> "NearbyApprovalStep":
        """``choose`` only: the person declines at the choice, which is a deny (the code matched)."""
        if self.kind != "choose" or self._cancel is None:
            raise PolarisError(ErrorCode.INVALID_OPTIONS, "There is no licence choice to cancel.")
        return self._cancel()


class NearbyAsk:
    """One session asking for approval (see the module docstring)."""

    def __init__(
        self,
        approval: Any,
        routes: NearbyRoutes,
        creds: Callable[[], NearbyCredentials],
    ) -> None:
        self._approval = approval
        self._routes = routes
        self._creds = creds
        self._lock = threading.Lock()
        self._request: Any = None
        self._done = False
        #: What D's ``HELLO`` reported (cleaned): "reported by the device", never proof of who is asking.
        self.device: Optional[str] = approval.label
        self.platform: str = approval.platform
        #: The three codes, in the order to show them, each like ``123 456``.
        self.codes: List[str] = list(approval.codes)

    def __repr__(self) -> str:
        return "<NearbyAsk>"

    def __reduce__(self) -> Any:
        raise TypeError("a nearby ask cannot be pickled")

    # ── The person's picks ──────────────────────────────────────────────────────────
    def pick(self, code: str) -> NearbyApprovalStep:
        """The person picked this code. A wrong one closes the session and answers ``mismatch`` (no route
        is called); the right one approves, and the step says how it went."""
        with self._lock:
            if self._done or self._request is not None:
                raise PolarisError(ErrorCode.INVALID_OPTIONS, "This request has been answered.")
            try:
                picked = self._approval.pick(code)
            except LanError:
                # The session ended under the person (D left, the deadline passed).
                self._done = True
                return NearbyApprovalStep("expired")
            if picked == "mismatch":
                self._done = True
                return NearbyApprovalStep("mismatch")
            if not hasattr(picked, "request"):
                # "invalid": D's request did not verify and the session closed. Nothing is sent.
                self._done = True
                return NearbyApprovalStep("expired")
            self._request = picked
            return self._send("approve", None)

    def deny(self) -> NearbyApprovalStep:
        """Before a matched pick: "None of these match" (the session closes, no route is called). After
        one: sends ``deny``."""
        with self._lock:
            if self._done:
                raise PolarisError(ErrorCode.INVALID_OPTIONS, "This request has been answered.")
            if self._request is None:
                self._done = True
                try:
                    self._approval.decline()
                except Exception:
                    pass
                return NearbyApprovalStep("denied")
            return self._send("deny", None)

    # ── The Worker's answer, through the vouch's finish step ────────────────────────
    def _send(self, decision: str, choice: Optional[Dict[str, Any]]) -> NearbyApprovalStep:
        vr = self._request
        try:
            r = self._routes.approve(
                self._creds(),
                request=vr.request,
                device_id=vr.device_id,
                sign_key=vr.sign_key,
                agree_key=vr.agree_key,
                decision=decision,
                choice=choice,
            )
        except PolarisError as e:
            if e.code in (ErrorCode.NETWORK_ERROR, ErrorCode.SERVER_ERROR):
                # No answer: the session closes `peer_bye`; the request lapses on the Worker.
                return self._end("expired")
            if e.code == ErrorCode.NO_TOKEN:
                return self._end("account-required")
            self._end("expired")
            raise
        return self._finish(r)

    def _finish(self, r: NearbyApproveResult) -> NearbyApprovalStep:
        from ..connect.nearby import ApproveAnswerInput

        if r.kind == "unavailable":
            return self._end("expired")
        ans = self._routes.answer_for_finish(r)
        out: Any = None
        try:
            if ans.keys_retried:
                # The route client already registered M's keys and retried once: tell the machine the
                # registration happened, so a second `device_keys_required` closes instead of waiting.
                self._approval.finish(
                    ApproveAnswerInput(409, json.dumps({"code": ErrorCode.DEVICE_KEYS_REQUIRED}), True)
                )
            out = self._approval.finish(ApproveAnswerInput(ans.http, ans.body, ans.discovery_nearby))
        except LanError:
            # The LAN session ended under us (D left). The Worker's answer still stands.
            out = None
        if r.kind == "choose":
            if out is not None and out.wait == "choice":
                return NearbyApprovalStep("choose", choices=r.choices, _choose=self._choose, _cancel=self.deny)
            self._done = True
            return NearbyApprovalStep("expired")
        self._done = True
        if r.kind == "approved":
            # The Worker bound D whatever the LAN says: VOUCH_RESULT is D's display, the poll its authority.
            return NearbyApprovalStep("approved", device_label=r.device_label)
        if r.kind == "denied":
            return NearbyApprovalStep("denied")
        code, status = r.code, r.status
        if code == ErrorCode.NOT_NEARBY:
            return NearbyApprovalStep("not-nearby")
        if code == ErrorCode.DEVICE_LIMIT:
            return NearbyApprovalStep("device-limit")
        if code == ErrorCode.ACCOUNT_REQUIRED:
            return NearbyApprovalStep("account-required")
        if status == 429 or code == ErrorCode.RATE_LIMITED:
            return NearbyApprovalStep("rate-limited", retry_after_seconds=r.retry_after_seconds)
        return NearbyApprovalStep("expired")

    def _choose(self, choice: Dict[str, Any]) -> NearbyApprovalStep:
        with self._lock:
            if self._done or self._request is None:
                raise PolarisError(ErrorCode.INVALID_OPTIONS, "This request has been answered.")
            return self._send("approve", choice)

    def _end(self, kind: str) -> NearbyApprovalStep:
        self._done = True
        try:
            self._approval.close()
        except Exception:
            pass
        return NearbyApprovalStep(kind)


def start_nearby_approver(
    *,
    nearby: Any,
    routes: NearbyRoutes,
    creds: Callable[[], NearbyCredentials],
    handler: Callable[[NearbyAsk], None],
    **options: Any,
) -> Any:
    """``cloud_connect.nearby.on_request`` with each session wrapped as an :class:`NearbyAsk`. Returns the
    handle (``stop``, ``pause``, ``resume``, ``set_prompt``, ``reopen``, ``status``)."""

    def wrapped(approval: Any) -> None:
        handler(NearbyAsk(approval, routes, creds))

    return nearby.on_request(wrapped, **options)
