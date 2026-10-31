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

import os
import tempfile
import threading
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Literal, Optional

from .store import Store

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .context import CoreContext

__all__ = [
    "TokenManager",
    "ReacquireFn",
    "Reacquired",
    "ReacquireRoute",
    "TokenSource",
    "TokenProvenance",
    "provenance_of",
    "choose_reacquire_route",
]

#: How the token was obtained in this process.
TokenSource = Literal["activate", "enroll", "register", "signin", "reacquire"]

#: What a stored token stands for, for the automatic sign-in ladder (I-47.3): only ``signin`` is a
#: signed-in person's own. A key activation, an enrolment or a device registration is not.
#: ``unconfirmed`` is a nearby sign-in's token the person has not confirmed (V5 §15.6.1 rule 12):
#: it is not a sign-in, and a client that starts with it drops the token before any use.
TokenProvenance = Literal["signin", "register", "key", "unconfirmed"]

_PROVENANCES = ("signin", "register", "key", "unconfirmed")


def provenance_of(source: Optional[str]) -> Optional[TokenProvenance]:
    """A token source's provenance; ``None`` (leave the stored one) for an unknown source or a
    re-acquire."""
    if source == "signin":
        return "signin"
    if source in ("register", "enroll"):
        return "register"
    if source == "activate":
        return "key"
    return None


class _TextSlot:
    """One small unsigned text file beside the token store (in memory when the client keeps no
    state directory). ``read`` answers ``None`` for an absent slot and RAISES for a slot that is
    there but unreadable, so a caller can fail closed; ``write("")`` removes it. Writes are atomic
    and 0600. Nothing secret is stored here."""

    def __init__(self, path: Optional[str]) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._memory: Optional[str] = None

    def read(self) -> Optional[str]:
        with self._lock:
            if self.path is None:
                return self._memory
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    return f.read()
            except FileNotFoundError:
                return None

    def write(self, text: str) -> None:
        with self._lock:
            if self.path is None:
                self._memory = text or None
                return
            if not text:
                try:
                    os.unlink(self.path)
                except FileNotFoundError:
                    pass
                return
            directory = os.path.dirname(self.path) or "."
            os.makedirs(directory, mode=0o700, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".pkey-", dir=directory)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(text)
                os.chmod(tmp, 0o600)
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise


_DEFAULT: Any = object()

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
    """A re-acquired token and how it was obtained (which becomes the token's source). The token
    is never in the ``repr``."""

    token: str = field(repr=False)
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
        # Unsigned device-local state for the automatic sign-in ladder (I-47.3), beside the token:
        # what the stored token stands for, and whether the person signed out on purpose.
        state_dir = ctx.local_state_dir()
        self._provenance_slot = _TextSlot(
            os.path.join(state_dir, "token-provenance") if state_dir else None
        )
        self._sign_out_slot = _TextSlot(
            os.path.join(state_dir, "explicit-sign-out") if state_dir else None
        )
        self._sign_out_memory = False

    def load(self) -> None:
        self._token = self._store.get_token()
        self._source = None
        if self.provenance == "unconfirmed":
            # The process ended on the confirm screen: the token goes, locally, before anything
            # reads it. The explicit sign-out flag is left as it was.
            self.clear()
        elif self._token is None and self.provenance is not None:
            self._write_provenance(None)

    @property
    def current(self) -> Optional[str]:
        return self._token

    @property
    def source(self) -> Optional[TokenSource]:
        """How the current token was obtained in this process; ``None`` when it was loaded
        from the store (a restart) or there is none."""
        return self._source

    def set(
        self,
        token: str,
        source: Optional[TokenSource] = None,
        *,
        person_initiated: bool = False,
        provenance: Optional[TokenProvenance] = _DEFAULT,
    ) -> None:
        """Store ``token``. ``source`` is how it was obtained; ``None`` means unknown, which
        routes a later re-acquire exactly as after a restart.

        ``person_initiated`` marks a sign-in the person started (device code, redirect, the licence
        choice): only it ends the explicit-sign-out state. ``provenance`` is what the token stands
        for in the automatic ladder; by default it follows ``source`` (``signin``,
        ``register``/``enroll``, ``activate`` is a key), and an unknown source or a re-acquire
        leaves the stored provenance alone."""
        prov = provenance_of(source) if provenance is _DEFAULT else provenance
        if prov == "unconfirmed":
            # Written BEFORE the token: a crash leaves the old token or the marked one, never a
            # bare token of an unconfirmed nearby sign-in. The explicit sign-out stays as it was.
            self._write_provenance("unconfirmed")
            self._token = token
            self._source = source
            self._store.set_token(token)
            return
        # Crash-safe: cleared first, written last, so a crash between leaves "unknown" (never signin).
        if prov is not None:
            self._write_provenance(None)
        self._token = token
        self._source = source
        self._store.set_token(token)
        if prov is not None:
            self._write_provenance(prov)
        if person_initiated:
            self.set_explicit_sign_out(False)

    def clear(self) -> None:
        self._token = None
        self._source = None
        self._store.clear_token()
        self._write_provenance(None)

    # ── What the stored token stands for, and the explicit sign-out (I-47.3) ────────
    @property
    def provenance(self) -> Optional[TokenProvenance]:
        """What the stored token stands for in the automatic ladder; ``None`` when unknown (an
        unreadable slot reads as unknown, never as ``signin``)."""
        try:
            text = self._provenance_slot.read()
        except (OSError, ValueError):
            return None
        text = (text or "").strip()
        return text if text in _PROVENANCES else None  # type: ignore[return-value]

    @property
    def unconfirmed(self) -> bool:
        """The held token is a nearby sign-in's that the person has not confirmed."""
        return self._token is not None and self.provenance == "unconfirmed"

    def confirm_sign_in(self) -> None:
        """The person confirmed the account: the token becomes a plain sign-in and the explicit
        sign-out state ends."""
        if self._token is None:
            return
        self._write_provenance("signin")
        self.set_explicit_sign_out(False)

    def set_provenance(self, provenance: Optional[TokenProvenance]) -> None:
        """Record that the stored token no longer stands for a signed-in person (a sign-out that
        kept the token)."""
        self._write_provenance(provenance)

    def _write_provenance(self, provenance: Optional[str]) -> None:
        try:
            self._provenance_slot.write(provenance or "")
        except (OSError, ValueError):
            pass  # unsigned convenience state: a failed write reads as unknown, which fails closed

    @property
    def explicit_sign_out(self) -> bool:
        """True after ``identity.sign_out()`` until the person's next sign-in: the automatic
        ladder must not sign the person back in on its own. It fails closed: a flag file that is
        there but cannot be read is "signed out", not "no flag"."""
        if self._sign_out_memory:
            return True
        try:
            text = self._sign_out_slot.read()
        except (OSError, ValueError):
            return True
        return (text or "").strip() == "1"

    def set_explicit_sign_out(self, on: bool) -> None:
        """Set or clear the flag. A failed write never stops a sign-out; the in-memory copy still
        holds for this process."""
        self._sign_out_memory = bool(on)
        try:
            self._sign_out_slot.write("1" if on else "")
        except (OSError, ValueError):
            pass

    def begin_pass(self) -> None:
        """Re-arm the single-attempt budget. Called once at the top of each ``sync()``."""
        self._attempted = False

    def reacquire(self) -> bool:
        """The single re-acquire for an authenticated call made OUTSIDE a sync pass (an
        edge-mint). One attempt per call, never a loop: the caller retries its request once
        when this returns ``True`` and fails on a second 401. It does not touch the sync
        pass's budget.

        It takes the SAME route a document fetch's 401 would (``choose_reacquire_route``):
        §5's single-attempt rule is about the device token, not about which call presented
        it, and a licence-less device has no ``license/token`` route to take."""
        current = self._token
        if not current:
            return False
        try:
            nxt = self._reacquire(self._ctx, current, self._source)
        except Exception:
            return False
        if nxt is None:
            return False
        self.set(nxt.token, nxt.source)
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
