"""The light half of local pairing (CC-29.9): the host-facing value types, the typed refusals and the option
check. It imports no asyncio and no socket, so ``polaris_key.connect`` and the local-links facade load without
the pairing window (:mod:`.local_pairing`)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Dict, Optional, Tuple

from ..constants_generated import ErrorCode, Feature, UnsupportedReason
from ..core.caps import Unsupported, UnsupportedError
from ..core.errors import PolarisError
from ..core.peer_contact import MAX_CONTACT_CATS
from .errors import LanError
from .local_state import LocalLinkStore

if TYPE_CHECKING:  # session.py loads the stream binding (asyncio): only when a pairing runs
    from .session import SessionClosed

__all__ = [
    "LocalCode",
    "LocalPairFailure",
    "LocalPaired",
    "LocalSource",
    "check_options",
    "full",
    "off",
    "reachable_full",
]

LABEL_MAX = 64
_CAT = re.compile(r"[a-z0-9-]{1,32}\Z")


@dataclass(frozen=True)
class LocalSource:
    """What local pairing reads of the client. ``store`` is blocking; the services run it on a worker thread."""

    slug: str
    #: Seconds since the epoch.
    now: Callable[[], int]
    #: The cached discovery answer ``localPairing`` is true (§15.12 "Gates").
    allowed: Callable[[], bool]
    store: LocalLinkStore
    #: The links changed (stored, renamed, re-marked, forgotten): the listener and the adverts follow. Safe
    #: from any thread.
    notify: Callable[[], None]
    #: Called by ``notify()`` and when the gate moves; returns the unsubscribe.
    on_change: Callable[[Callable[[], None]], Callable[[], None]]


@dataclass(frozen=True)
class LocalCode:
    """The code a shower shows now. It changes after every failed guess."""

    #: The 8 digits as two groups of four, like ``4812 3456``.
    code: str
    #: The text of the QR, ``PKP1:<SLUG>:<INSTANCE>:<SECRET>`` in upper case.
    qr: str
    #: The public two digits of the code, the advert's ``n``.
    nameplate: str

    def __repr__(self) -> str:
        return "<LocalCode>"


@dataclass(frozen=True)
class LocalPaired:
    """What ``pair`` and ``join`` report once a link is stored."""

    #: Names the link on this device; ``list()`` has the rest.
    id: str
    label: Optional[str]
    #: The categories both people approved.
    categories: Tuple[str, ...]


@dataclass(frozen=True)
class LocalPairFailure:
    """``declined`` here, ``timeout`` a deadline ran out, ``full`` at the cap, ``too-many-tries`` the fifth failed
    guess, ``closed`` otherwise."""

    reason: str
    close: Optional[SessionClosed] = None


def off(detail: str) -> UnsupportedError:
    return UnsupportedError(
        Unsupported(Feature.CONNECT_LOCAL, UnsupportedReason.PRODUCT, detail), ErrorCode.LOCAL_PAIRING_OFF
    )


def full() -> PolarisError:
    return PolarisError(ErrorCode.LOCAL_LINKS_FULL, "This device holds the most local links it can for this app.")


def reachable_full() -> PolarisError:
    """Eight links are reachable already: turn one off before another is advertised (§15.12)."""
    return PolarisError(
        ErrorCode.LOCAL_LINKS_FULL, "Eight local links are already reachable on this network; turn one off first."
    )


def check_options(o: Dict[str, Any]) -> None:
    """Raises :class:`LanError` ``bad_input`` for options of ``pair`` or ``join`` that break a rule."""

    def bad(m: str) -> None:
        raise LanError("bad_input", m)

    if not callable(o.get("on_confirm")):
        bad("on_confirm is required.")
    c = o.get("categories")
    if (
        not isinstance(c, (list, tuple))
        or len(c) > MAX_CONTACT_CATS
        or not all(isinstance(x, str) and _CAT.match(x) for x in c)
        or len(set(c)) != len(c)
    ):
        bad("categories must be at most 8 distinct strings of a-z, 0-9 and '-' (1 to 32 characters).")
    lab = o.get("label")
    if lab is not None and (not isinstance(lab, str) or len(lab) > LABEL_MAX):
        bad("The label is not valid.")


