"""The monotonic clock floor — wire contract v3 §4.2.

::

    highWaterMark = max(issuedAt of every currently-verified cached artifact)
    effectiveNow  = max(systemClock, highWaterMark)

The fold is over the WHOLE artifact set — license document, config document, and the
trust manifest — not over any single one. A floor built from a document alone is provably
inert: ``doc.issuedAt < doc.graceUntil`` always holds, so it can never reach the end of
grace, and a clock wound back inside the document's own window still reads ``ok``. The
trust manifest is what makes the floor bite, which is why Core refreshes trust on its own
schedule instead of riding a service's document fetch. The corpus pins the defective form
as ``floor-config-doc-alone-does-not-stop-rollback`` so it cannot silently return.

Only RE-VERIFIED content may be folded in: a rejected artifact must contribute nothing, or
planting a file would become a way to force every client to ``expired``.
"""

from __future__ import annotations

from typing import Iterable, Optional, Sequence

__all__ = ["high_water_mark", "effective_now"]


def high_water_mark(issued_ats: Iterable[Optional[int]]) -> int:
    """Fold the verified artifact set into a single floor.

    Returns ``0`` for an empty set (a fresh install has no signed clock yet, and
    ``max(now, 0)`` is just ``now``).
    """
    mark = 0
    for issued_at in issued_ats:
        if issued_at is not None and issued_at > mark:
            mark = issued_at
    return mark


def effective_now(system_now: int, floor: int) -> int:
    """The time every gate comparison runs at.

    The floor is a MINIMUM, never a substitute: with an honest clock ahead of every
    signed artifact this returns the system clock unchanged, so the floor costs nothing
    when the clock is truthful.
    """
    return system_now if system_now > floor else floor


def fold(*issued_ats: Optional[int]) -> int:
    """Varargs convenience over :func:`high_water_mark`."""
    seq: Sequence[Optional[int]] = issued_ats
    return high_water_mark(seq)
