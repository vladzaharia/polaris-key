"""The client licence gate — wire contract v3 §5.

Mirrors ``@plrs/client-core``'s ``gate.ts``. Computes the renderable status from the
cached signed licence document + the monotonic clock floor + the last sync outcome. The
server enforces version/channel on ``GET /<p>/license/document`` (a 403 → ``blocked``);
the client reflects that plus offline grace.

TWO THINGS ARE NEW IN v3, both consequences of the suite service model:

* ``license_service_enabled=False`` ⇒ ``not-applicable`` (usable TRUE). A config-only or
  release-only product has no licence to be missing, so it must boot USABLE rather than
  sitting on ``needs-activation`` forever (D-08).
* ``activation`` replaces v2's ``has_token`` boolean: a device is activated either by an
  online-minted ``plrst_`` token or by a verified offline bundle import (§7). Both are
  activated; only ``None`` is not.

And ONE ordering changed: the activation guard now runs BEFORE the unsigned ``blocked``
hint, so an unactivated device with a stale build block reports ``needs-activation``
rather than a version error it cannot act on. The gate matrix pins that row.

Everything below those guards is the v2 state machine, unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Union

from ..core.models import (
    ActivationSource,
    AllowedRange,
    BlockedState,
    LicenseDoc,
    LicenseStatus,
)

__all__ = ["LicenseState", "BlockedState", "AllowedRange", "license_state", "is_usable"]


@dataclass(frozen=True)
class LicenseState:
    """The renderable gate state."""

    status: LicenseStatus
    graceUntil: Optional[int] = None
    lastVerifiedAt: Optional[int] = None
    allowedRange: Optional[AllowedRange] = None


def _has_valid_window(doc: LicenseDoc) -> bool:
    """True when the doc's time window is comparable to an int.

    Defence in depth for R4-13: :func:`license_state` is the client's hottest read path
    and a ``TypeError`` escaping it turns every gate check into a crash. Documents reach
    here only after ``LicenseDoc.from_dict`` type-checks them, but a caller constructing
    one by hand (or a future store format) must degrade to "no document", never raise.
    """
    return all(
        isinstance(v, int) and not isinstance(v, bool)
        for v in (doc.expiresAt, doc.graceUntil)
    )


def license_state(
    *,
    license_service_enabled: bool = True,
    activation: Optional[ActivationSource] = None,
    doc: Optional[LicenseDoc] = None,
    now: int,
    high_water_mark: int = 0,
    last_sync_unauthorized: bool = False,
    blocked: Optional[BlockedState] = None,
    last_verified_at: Optional[int] = None,
) -> LicenseState:
    """Compute the gate status. Order matches ``@plrs/client-core``'s ``gate.ts`` exactly.

    §4.2 — winding the system clock back below the newest signed ``issuedAt`` we have
    already verified buys nothing: the gate never sees a time earlier than that floor.
    Both artifact sources feed it; derived from the document alone the floor can never
    exceed that document's own ``graceUntil``, so it would never actually close the
    window (R4-04).
    """
    now = max(now, high_water_mark)
    # §5 — a product without the licence service has no licence state to report, and must
    # not be held hostage by one. This precedes every other rule, including `blocked`.
    if not license_service_enabled:
        return LicenseState(status="not-applicable")
    # §5 — neither a token nor an imported bundle: nothing has been granted yet.
    if activation is None:
        return LicenseState(status="needs-activation")
    if blocked is not None:
        return LicenseState(status=blocked.reason, allowedRange=blocked.allowedRange)
    if last_sync_unauthorized:
        return LicenseState(status="revoked")
    if doc is None or not _has_valid_window(doc):
        return LicenseState(status="needs-activation")
    if now > doc.graceUntil:
        return LicenseState(status="expired", graceUntil=doc.graceUntil)
    if now > doc.expiresAt:
        return LicenseState(
            status="grace", graceUntil=doc.graceUntil, lastVerifiedAt=last_verified_at
        )
    return LicenseState(
        status="ok", graceUntil=doc.graceUntil, lastVerifiedAt=last_verified_at
    )


def is_usable(state: Union[LicenseState, LicenseStatus]) -> bool:
    """True when the gate permits running: ``ok``, ``grace``, or ``not-applicable``.

    Accepts either the whole :class:`LicenseState` or a bare status string, so both
    ``is_usable(state)`` and the v2 ``is_usable(state.status)`` call shape keep working.
    """
    status = state if isinstance(state, str) else state.status
    return status in ("ok", "grace", "not-applicable")
