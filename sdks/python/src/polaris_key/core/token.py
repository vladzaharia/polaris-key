"""The device credential — wire contract v3 §6.

A ``pkeyt_`` token is what a device authenticates every document fetch with. Core holds it
because it is the DEVICE's credential, not the licence's: a config-only product's
registered devices hold real tokens with no licence behind them (D-08), and the token
survives a licence changing tier or expiring.

THE ONE RE-ACQUIRE

§5: a 401 gets exactly ONE ``POST /<p>/license/token`` attempt, then one retry of the
failed fetch. Not a loop — a device whose token has genuinely been revoked would otherwise
hammer the control plane forever, and the recorded hard 401 is the offline revocation
signal (§4.3) that a retry loop would keep postponing.

v3 makes that rule harder to state than v2 did, because ``sync()`` now drives TWO
documents in one pass and both can 401. :meth:`TokenManager.reacquire_once` collapses
them: the first caller spends the budget, every later caller in the same pass is told no,
and the result is one network call no matter how many documents were in flight.
:meth:`begin_pass` (called once per ``sync()``) is what re-arms it — without that the memo
would make the second sync of a session unable to recover from a rotated token.

WHICH ROUTE THE ONE ATTEMPT TAKES

§5's parenthesis: "Registered-without-license devices re-register instead; same
single-attempt rule." ``POST /<p>/license/token`` needs a LICENSED device (and the route
does not exist at all when License is off), so a config-only product's registered device
would lose its credential for good on its first 401. :func:`choose_reacquire_route` picks
``POST /<p>/devices/register`` for such a device; the budget above is shared, so it is
still one network call per pass whichever route is taken. A wrong guess is safe: register
answers a licensed device ``registration_closed``, license/token answers a licence-less one
401, and either way the single attempt is spent and the hard-401 path applies.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable, Literal, Optional

from .store import Store

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .context import CoreContext

__all__ = [
    "TokenManager",
    "ReacquireFn",
    "Reacquired",
    "ReacquireRoute",
    "TokenSource",
    "choose_reacquire_route",
]

#: How the token was obtained in this process.
TokenSource = Literal["activate", "enroll", "register", "reacquire"]

#: The two routes the §5 single re-acquire can take.
ReacquireRoute = Literal["license-token", "devices-register"]


def choose_reacquire_route(
    *, license_enabled: bool, source: Optional[TokenSource]
) -> ReacquireRoute:
    """Pick the route for the §5 single re-acquire (P1b-06; the same rule in every SDK).

    * License disabled for the product ⇒ ``devices-register`` (license/token does not
      exist);
    * the token was minted by ``devices.register()`` (or re-registered) in this process ⇒
      ``devices-register``;
    * otherwise ⇒ ``license-token``, as before.

    There is deliberately NO restart heuristic ("no verified licence document and no
    bundle ⇒ register"). After a restart a licensed device whose cache is empty is
    indistinguishable from a licence-less one, and the recorded ``sync-errors`` transcript
    pins that state to ``POST /license/token``. Telling them apart needs the token source
    persisted, which is a client-core store-contract change and therefore plan-mode.
    """
    if not license_enabled:
        return "devices-register"
    if source == "register":
        return "devices-register"
    return "license-token"


@dataclass(frozen=True)
class Reacquired:
    """A re-acquired token and how it was obtained (which becomes the token's source)."""

    token: str
    source: TokenSource


#: Re-acquire the device token. Injected rather than imported so Core does not depend on
#: the license or devices modules: the facade composes :func:`choose_reacquire_route` with
#: the two mint routes, and the single-attempt rule here applies to whichever it takes.
ReacquireFn = Callable[["CoreContext", str, Optional[TokenSource]], Optional[Reacquired]]


class TokenManager:
    def __init__(self, ctx: "CoreContext", store: Store, reacquire: ReacquireFn) -> None:
        self._ctx = ctx
        self._store = store
        self._reacquire = reacquire
        self._token: Optional[str] = None
        # In memory only: persisting it would change client-core's store contract
        # (CacheRecordV3), so after a restart the source is unknown and
        # `choose_reacquire_route` keys on License alone.
        self._source: Optional[TokenSource] = None
        self._attempted = False

    def load(self) -> None:
        self._token = self._store.get_token()
        self._source = None

    @property
    def current(self) -> Optional[str]:
        return self._token

    @property
    def source(self) -> Optional[TokenSource]:
        """How the current token was obtained in this process; ``None`` when it was loaded
        from the store (a restart) or there is none."""
        return self._source

    def set(self, token: str, source: Optional[TokenSource] = None) -> None:
        """Store ``token``. ``source`` is how it was obtained; ``None`` means unknown, which
        routes a later re-acquire exactly as after a restart."""
        self._token = token
        self._source = source
        self._store.set_token(token)

    def clear(self) -> None:
        self._token = None
        self._source = None
        self._store.clear_token()

    def begin_pass(self) -> None:
        """Re-arm the single-attempt budget. Called once at the top of each ``sync()``."""
        self._attempted = False

    def reacquire(self) -> bool:
        """The single re-acquire for an authenticated call made OUTSIDE a sync pass (an
        edge-mint). One attempt per call, never a loop: the caller retries its request once
        when this returns ``True`` and fails on a second 401. It does not touch the sync
        pass's budget."""
        current = self._token
        if not current:
            return False
        try:
            nxt = self._reacquire(self._ctx, current)
        except Exception:
            return False
        if not nxt:
            return False
        self.set(nxt)
        return True

    def reacquire_once(self) -> bool:
        """At most one re-acquire per sync pass, shared across every 401 in it.

        Returns ``True`` when a NEW token is in hand and the caller should retry its fetch
        once; ``False`` when the attempt already happened and failed, or is unavailable.
        """
        if self._attempted:
            return False
        current = self._token
        if not current:
            return False
        self._attempted = True
        try:
            nxt = self._reacquire(self._ctx, current, self._source)
        except Exception:
            return False
        if nxt is None:
            return False
        self.set(nxt.token, nxt.source)
        return True
