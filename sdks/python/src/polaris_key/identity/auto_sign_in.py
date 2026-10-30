"""``identity.auto_sign_in()`` and ``identity.nearby.available()`` (I-47.3; CC-01-auto-sign-in §1).
Mirrors Swift's ``AutoSignIn.swift`` and Kotlin's ``AutoSignIn.kt`` (the desktop, no platform provider).

The automatic sign-in ladder, as far as a Python host goes:

* rung 1, a stored session: this device holds a token that came from a sign-in, and a licence. No
  network. A key activation, an enrolment or a device registration is not a sign-in, and neither is a
  device an account sign-out left activated (``sign_out()`` records that);
* rungs 2 to 4 (silent restore, the platform provider, its one sheet) do not exist here: Python has no
  platform identity, so the ladder ends at the regular form;
* rung 6, the regular sign-in, is the app's: :attr:`~polaris_key.identity.client.IdentityClient.sign_in`.

The answer is one of three results, each with a ``kind`` (Node's ``signedIn`` and ``needsSignIn`` in
snake case, as :class:`~polaris_key.identity.sign_in.SignInOutcome` spells ``signed_in``):

* :class:`AutoSignInSignedIn` (``signed_in``): rung 1;
* :class:`AutoSignInNeedsSignIn` (``needs_sign_in``) with ``reason`` ``signed_out`` (the person signed out
  on this device and has not signed in since: show the form, start nothing on its own) or
  ``no_credential``;
* :class:`AutoSignInUnavailable` (``unavailable``) with ``code``: Identity is off for this product.

``explicit_sign_out`` is set by ``sign_out()`` once the Worker accepted it and cleared only by a sign-in
the person started (device code, redirect, the licence choice). It is kept beside the token, so it
survives a restart, and it fails closed: a flag that cannot be read is "signed out".

Nothing here logs, prints or keeps a token; a result carries the pairwise subject and the licence id
only.

:class:`NearbyNamespace` (``identity.nearby``) answers ``available(role=...)``: whether this runtime can
take part in nearby sign-in as the new device (``"requester"``) or the signed-in one (``"approver"``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from ..constants_generated import ErrorCode
from ..core.context import CoreContext
from ..core.errors import PolarisError
from ..core.token import TokenManager
from .account import Account, identity_fragment_from

__all__ = [
    "AutoSignInNeedsSignIn",
    "AutoSignInResult",
    "AutoSignInSignedIn",
    "AutoSignInUnavailable",
    "NEARBY_ROLES",
    "NearbyNamespace",
    "run_auto_sign_in",
]

#: The two sides of a nearby sign-in: the new device asking, and the signed-in device approving.
NEARBY_ROLES = ("requester", "approver")

#: The discovery endpoints each role calls (WIRE-CONTRACT-V5 §12.11.6).
_ROLE_ENDPOINTS: Dict[str, tuple] = {
    "requester": ("nearbyStart", "nearbyPoll"),
    "approver": ("nearbyApprove",),
}


@dataclass(frozen=True)
class AutoSignInSignedIn:
    """Rung 1: a stored sign-in and a licence. ``subject`` is the stored pairwise subject, if any."""

    subject: Optional[str]
    license_id: Optional[str]
    kind: str = "signed_in"


@dataclass(frozen=True)
class AutoSignInNeedsSignIn:
    """No session: show the regular form. ``reason`` is ``"signed_out"`` or ``"no_credential"``.
    ``link_handle`` is always ``None`` here (only a platform exchange makes one)."""

    reason: str
    link_handle: Optional[str] = None
    kind: str = "needs_sign_in"


@dataclass(frozen=True)
class AutoSignInUnavailable:
    """Identity is off for this product; ``code`` is ``service-unavailable``."""

    code: str
    kind: str = "unavailable"


AutoSignInResult = Any  # Union of the three above; kept loose for 3.9 compatibility.


def run_auto_sign_in(
    ctx: CoreContext,
    tokens: TokenManager,
    account: Account,
    *,
    license_id: Callable[[], Optional[str]],
    discover: Callable[[], Optional[Dict[str, Any]]],
) -> AutoSignInResult:
    """The ladder. A refusal is a result; nothing here raises for a missing session."""
    # Rung 1: a token the device holds as a sign-in, with a licence. No network.
    if tokens.current and tokens.provenance == "signin":
        lic = license_id()
        if lic is not None:
            return AutoSignInSignedIn(subject=account.stored_subject(), license_id=lic)
    # Identity off is known only from discovery (loaded once). An unreachable Worker says nothing about
    # it, so the answer then falls through to the regular form.
    try:
        discover()
    except Exception:
        pass
    else:
        if not ctx.enabled("identity"):
            return AutoSignInUnavailable(code=ErrorCode.SERVICE_UNAVAILABLE)
    if tokens.explicit_sign_out:
        return AutoSignInNeedsSignIn(reason="signed_out")
    return AutoSignInNeedsSignIn(reason="no_credential")


class NearbyNamespace:
    """``identity.nearby``: nearby sign-in. ``available(role=...)`` today; the approver and the
    route client join it in later slices."""

    def __init__(
        self,
        ctx: CoreContext,
        discover: Callable[[], Optional[Dict[str, Any]]],
        runtime_supported: Optional[Callable[[str], bool]] = None,
    ) -> None:
        self._ctx = ctx
        self._discover = discover
        #: Whether this runtime can browse (``requester``) or advertise (``approver``) on the LAN. The
        #: facade supplies it from Cloud Connect's nearby engine; with none the runtime is unsupported.
        self._runtime_supported = runtime_supported

    def available(self, *, role: str) -> bool:
        """True when all of these hold: Identity is on; discovery names ``nearby`` and the endpoints
        ``role`` calls (``requester``: ``nearbyStart`` and ``nearbyPoll``; ``approver``:
        ``nearbyApprove``), each inside this product; and the runtime can take part (it would not
        answer ``nearby-unsupported``). It never raises for a missing capability, and starts no
        nearby work: an unreachable Worker is ``False``. An unknown ``role`` raises ``invalid-options``."""
        if role not in NEARBY_ROLES:
            raise PolarisError(
                ErrorCode.INVALID_OPTIONS, 'nearby role must be "requester" or "approver".'
            )
        try:
            doc = self._discover()
        except Exception:
            return False
        fragment = identity_fragment_from(doc)
        if fragment is None or fragment.get("nearby") is not True:
            return False
        endpoints = fragment["endpoints"]
        base = self._ctx.url("")
        for name in _ROLE_ENDPOINTS[role]:
            url = endpoints.get(name)
            if not url or not url.startswith(base):
                return False
        supported = self._runtime_supported
        if supported is None:
            return False
        try:
            return bool(supported(role))
        except Exception:
            return False
