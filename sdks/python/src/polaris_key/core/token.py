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
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable, Optional

from .store import Store

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .context import CoreContext

__all__ = ["TokenManager", "ReacquireFn"]

#: Re-acquire the device token. Injected rather than imported so Core does not depend on
#: the license module: for a registered-without-licence device the mint path is
#: ``POST /devices/register``, and the same single-attempt rule applies to it.
ReacquireFn = Callable[["CoreContext", str], Optional[str]]


class TokenManager:
    def __init__(self, ctx: "CoreContext", store: Store, reacquire: ReacquireFn) -> None:
        self._ctx = ctx
        self._store = store
        self._reacquire = reacquire
        self._token: Optional[str] = None
        self._attempted = False

    def load(self) -> None:
        self._token = self._store.get_token()

    @property
    def current(self) -> Optional[str]:
        return self._token

    def set(self, token: str) -> None:
        self._token = token
        self._store.set_token(token)

    def clear(self) -> None:
        self._token = None
        self._store.clear_token()

    def begin_pass(self) -> None:
        """Re-arm the single-attempt budget. Called once at the top of each ``sync()``."""
        self._attempted = False

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
            nxt = self._reacquire(self._ctx, current)
        except Exception:
            return False
        if not nxt:
            return False
        self.set(nxt)
        return True
