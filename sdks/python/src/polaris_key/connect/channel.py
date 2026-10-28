"""What the LAN and relay transports share (CC-10.10; WIRE-CONTRACT-V5 §15.3, §15.5). Mirrors
``packages/sdk-node/src/connect/channel.ts``: the account context and session options a ``PeerSession``
is built from, and the handling of the two documents a peer may push on an open session, ``RING`` and
``TRUST``.

Rules this module keeps:

- the device's X25519 private key never leaves the key port: the session is given the
  :class:`~polaris_key.connect.client.PeerSource` static-key handle, whose ``dh`` calls the port;
- a pushed document is never trusted because a peer sent it. ``RING`` is re-verified and stored by the
  identity client under its replacement rules; ``TRUST`` is verified against the usable pins and applied
  by the trust custodian. Each outcome, stored or refused, is reported as a :class:`ConnectNotice`; none
  is dropped silently;
- the blocking calls into the client (store a roster, apply trust, refresh identity) never run on the
  Connect loop: ``spawn`` runs them one at a time on a worker thread.
"""

from __future__ import annotations

import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

from ..core.peer_session import AccountContext
from .client import PeerSource

__all__ = [
    "ConnectNotice",
    "MAX_DOCS_QUEUED",
    "PeerDocs",
    "PeerDocsSource",
    "REFRESH_GAP_SECONDS",
    "channel_base",
    "peer_account",
]

REFRESH_GAP_SECONDS = 60
#: Pushed documents handled at once; the rest are refused as ``busy``.
MAX_DOCS_QUEUED = 8
MAX_RETRIES = 5


@dataclass(frozen=True)
class ConnectNotice:
    """A pushed document's outcome. ``type`` is ``ring`` or ``trust``; ``outcome`` is ``stored`` (a
    roster, with its ``epoch``), ``applied`` (trust) or ``refused`` (with a ``reason``)."""

    type: str
    outcome: str
    epoch: Optional[int] = None
    reason: Optional[str] = None


@dataclass(frozen=True)
class PeerDocsSource:
    """The client calls pushed documents need. Every member but ``now`` may be ``None`` (the
    document is then refused as ``unsupported``, or no refresh is made)."""

    now: Callable[[], int]
    #: Ask the Worker for a newer roster; raises on failure.
    refresh: Optional[Callable[[], Any]] = None
    #: Verify and store a pushed roster: returns an object with ``stored``, ``epoch``, ``reason``.
    adopt_ring: Optional[Callable[[str], Any]] = None
    #: Verify and apply a pushed trust manifest: returns an object with ``applied`` and ``reason``.
    apply_trust: Optional[Callable[[str], Any]] = None


def peer_account(
    src: PeerSource, ring: Callable[[], Optional[Tuple[str, int]]]
) -> AccountContext:
    """The account context of a session. ``ring`` is the newest roster a session handed up, if any."""
    return AccountContext(
        trust=src.trust,
        expected_aud=src.slug,
        cert_jws=src.cert_jws,
        own_sub=src.sub,
        own_device_id=src.device_id,
        held_ring=lambda: ring() or (src.ring_jws, src.ring_epoch),
        disc_keys=[src.keys.current, src.keys.previous],
    )


def channel_base(
    src: PeerSource,
    *,
    caps: Sequence[str] = ("app/1",),
    label: Optional[str] = None,
    ring: Callable[[], Optional[Tuple[str, int]]] = lambda: None,
    now: Optional[Callable[[], int]] = None,
    rekey_messages: Optional[int] = None,
    rekey_seconds: Optional[float] = None,
) -> Dict[str, Any]:
    """The keyword arguments every ``PeerSession`` of a transport shares (all but ``role``, ``send`` and
    ``on_event``). The same for LAN and relay."""
    o: Dict[str, Any] = {
        "mode": "a",
        "slug": src.slug,
        "static_key": src.static_key,
        "account": peer_account(src, ring),
        "caps": list(caps),
        "hello": {"label": label, "platform": sys.platform, "app": src.slug},
    }
    if now is not None:
        o["now"] = now
    if rekey_messages is not None:
        o["rekey_messages"] = rekey_messages
    if rekey_seconds is not None:
        o["rekey_seconds"] = rekey_seconds
    return o


class _Worker:
    """One daemon thread that runs jobs in order; created on first use."""

    def __init__(self) -> None:
        self._ex: Optional[ThreadPoolExecutor] = None
        self._lock = threading.Lock()
        self._closed = False

    def __call__(self, job: Callable[[], None]) -> None:
        with self._lock:
            if self._closed:
                return
            if self._ex is None:
                self._ex = ThreadPoolExecutor(max_workers=1, thread_name_prefix="polaris-key-docs")
            ex = self._ex
        ex.submit(job)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            ex, self._ex = self._ex, None
        if ex is not None:
            ex.shutdown(wait=False, cancel_futures=True)


def _default_timer(fn: Callable[[], None], seconds: float) -> Callable[[], None]:
    t = threading.Timer(seconds, fn)
    t.daemon = True
    t.start()
    return t.cancel


class PeerDocs:
    """Handles ``RING``, ``TRUST`` and "a peer is on a newer roster". ``spawn`` runs a job off the
    caller's thread, in order (default: one worker thread); ``timer(fn, seconds)`` schedules a deferred
    retry and returns its cancel (default: a daemon ``threading.Timer``). Tests pass ``spawn=lambda f:
    f()``."""

    def __init__(
        self,
        src: PeerDocsSource,
        on_stored: Callable[[], None] = lambda: None,
        *,
        spawn: Optional[Callable[[Callable[[], None]], None]] = None,
        timer: Optional[Callable[[Callable[[], None], float], Callable[[], None]]] = None,
    ) -> None:
        self._src = src
        self._on_stored = on_stored
        self._worker: Optional[_Worker] = _Worker() if spawn is None else None
        self._spawn: Callable[[Callable[[], None]], None] = (
            spawn if spawn is not None else self._worker  # type: ignore[assignment]
        )
        self._timer = timer or _default_timer
        self._lock = threading.Lock()
        self._queued: Set[str] = set()
        self._last_refresh = float("-inf")
        self._retry: Optional[Callable[[], None]] = None
        self._tries = 0
        self._closed = False
        self._clock: Callable[[], float] = time.monotonic
        self._last_busy: Dict[str, float] = {}
        self._fns: List[Callable[[ConnectNotice], None]] = []
        #: The newest roster a session handed up, ``(jws, epoch)``, held until an identity load catches up.
        self.pushed: Optional[Tuple[str, int]] = None

    def __repr__(self) -> str:
        return "<PeerDocs>"

    def on_notice(self, fn: Callable[[ConnectNotice], None]) -> Callable[[], None]:
        with self._lock:
            self._fns.append(fn)

        def off() -> None:
            with self._lock:
                if fn in self._fns:
                    self._fns.remove(fn)

        return off

    def close(self) -> None:
        """Stop a pending retry and the worker. Nothing runs or is stored after this."""
        with self._lock:
            self._closed = True
            cancel, self._retry = self._retry, None
        if cancel is not None:
            cancel()
        if self._worker is not None:
            self._worker.close()

    # What a link reports; hand these to ``LinkHandlers``.

    def on_ring(self, jws: str, epoch: int) -> None:
        if self.pushed is None or epoch > self.pushed[1]:
            self.pushed = (jws, epoch)
        self.ring(jws)

    def on_trust(self, jws: str) -> None:
        self.trust(jws)

    def on_ring_wanted(self) -> None:
        self.want_ring()

    def ring(self, jws: str) -> None:
        """A roster a peer pushed (already verified once by the session)."""

        def job() -> None:
            adopt = self._src.adopt_ring
            if adopt is None:
                return self._emit(ConnectNotice("ring", "refused", reason="unsupported"))
            r = adopt(jws)
            if not r.stored:
                return self._emit(ConnectNotice("ring", "refused", reason=r.reason))
            self._emit(ConnectNotice("ring", "stored", epoch=r.epoch))
            self._on_stored()
            # The certificate and K_disc that go with the new roster come from the Worker. If the
            # minute's slot is taken, or the fetch fails, it is tried again.
            self._want(True)

        self._run("ring", jws, job)

    def trust(self, jws: str) -> None:
        """A trust manifest a peer pushed (not verified by the session)."""

        def job() -> None:
            apply = self._src.apply_trust
            if apply is None:
                return self._emit(ConnectNotice("trust", "refused", reason="unsupported"))
            r = apply(jws)
            self._emit(
                ConnectNotice("trust", "applied")
                if r.applied
                else ConnectNotice("trust", "refused", reason=r.reason)
            )

        self._run("trust", jws, job)

    def want_ring(self) -> bool:
        """A peer is on a newer roster, or the relay said the roster changed: fetch it (a fresh
        ``identity(refresh=True)``, verified under the normal replacement rules). At most one a
        minute. True when a fetch started."""
        return self._want(False)

    def _want(self, retry: bool) -> bool:
        src = self._src
        if src.refresh is None or self._closed:
            return False
        t = src.now()
        with self._lock:
            if t - self._last_refresh < REFRESH_GAP_SECONDS:
                gap = self._last_refresh + REFRESH_GAP_SECONDS - t
                started = False
            else:
                self._last_refresh = t
                gap = 0
                started = True
        if not started:
            if retry:
                self._defer(gap)
            return False
        try:
            src.refresh()
            if self._closed:
                return True
            self._tries = 0
            self._on_stored()
        except Exception:
            self._tries += 1
            if retry and self._tries <= MAX_RETRIES:
                self._defer(REFRESH_GAP_SECONDS)
        return True

    def _defer(self, seconds: float) -> None:
        with self._lock:
            if self._retry is not None or self._closed:
                return

            def fire() -> None:
                with self._lock:
                    self._retry = None
                self._spawn(self._retry_want)

            self._retry = self._timer(fire, max(1.0, seconds))

    def _retry_want(self) -> None:
        self._want(True)

    def _run(self, kind: str, jws: str, job: Callable[[], None]) -> None:
        """One at a time, at most ``MAX_DOCS_QUEUED`` waiting, and a document already waiting is not
        queued twice: the excess is refused visibly, not worked on."""
        key = kind + ":" + jws
        # One slot is kept for a RING (G11): a flood of TRUST documents cannot starve a roster push.
        limit = MAX_DOCS_QUEUED if kind == "ring" else MAX_DOCS_QUEUED - 1
        notify = False
        with self._lock:
            if self._closed:
                return
            if key in self._queued or len(self._queued) >= limit:
                busy = True
                # At most one busy notice per kind per second; the rest are dropped, not notified.
                t = self._clock()
                if t - self._last_busy.get(kind, float("-inf")) >= 1.0:
                    self._last_busy[kind] = t
                    notify = True
            else:
                busy = False
                self._queued.add(key)
        if busy:
            if notify:
                self._emit(ConnectNotice(kind, "refused", reason="busy"))
            return None

        def go() -> None:
            if self._closed:
                with self._lock:
                    self._queued.discard(key)
                return
            try:
                job()
            except Exception:
                self._emit(ConnectNotice(kind, "refused", reason="failed"))
            finally:
                with self._lock:
                    self._queued.discard(key)

        self._spawn(go)

    def _emit(self, n: ConnectNotice) -> None:
        with self._lock:
            fns = list(self._fns)
        for f in fns:
            try:
                f(n)
            except Exception:
                pass  # a host callback never ends a session or a document's handling
