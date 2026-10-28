"""The Cloud Sync settings API (U-06.10): what app code sees on top of the host (``host.py``).

A port of ``packages/sdk-node/src/cloudSync/api.ts``.

* ``client.cloud_sync.status()`` / ``flush()``     the machine's status, and "send what is waiting";
* ``client.events.on("cloudSync", fn)``           the machine's events, in order;
* ``config.set`` / ``clear`` / ``setting(k).sync()``   routed through the machine while a principal is held.

The identity session's subject drives the machine: a stored or new subject signs it in, a sign-out
flushes (bounded) and signs it out. Rules kept here (plans/U-sync-clients-slices.md section 9):

* S6  When the machine leaves a principal (``signOut``, ``accountRequired``, ``subjectChanged``) the key
      ring is forgotten and the synced data deleted, each tried whatever the other did: the root goes
      first, a failure is logged and never replaces the sign-out's own error, and nothing held means
      nothing to fail. The sign-in offer follows the forget.
* S7  No event, log line or error here carries a value or the root; events name keys only.

Licence state is never read or written from this module.

Threads: identity events are handled one at a time and in order on a worker thread (a sign-in makes a
request; the emitter never waits on it). The machine's events arrive on whichever thread ran the pump;
the forget they ask for runs on its own thread because the purge waits for that pump to end.
"""

from __future__ import annotations

import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Mapping, Optional

from ..config.client import ConfigClient
from ..constants_generated import SYNC_SIGNOUT_FLUSH_MS, Feature
from ..core.context import CoreContext
from .host import CloudSyncHost

__all__ = ["CloudSyncApi", "CloudSyncClient"]

Obj = Dict[str, Any]

#: The reasons the machine leaves a principal, each of which drops the key ring.
FORGETTING = frozenset({"signOut", "accountRequired", "subjectChanged"})

#: The longest a caller waits for a forget that is still waiting on a pump (seconds).
_CHAIN_WAIT = 30.0

#: The longest a sign-out waits for the purge to finish after the flush (seconds).
_FORGET_WAIT = 5.0


class CloudSyncClient:
    """``client.cloud_sync``: the two verbs. A product without the Sync service gets the typed N/A."""

    def __init__(self, api: "CloudSyncApi") -> None:
        self._api = api

    def status(self) -> Obj:
        """The machine's status (``state``, ``pending`` ...). ``local`` before Cloud Sync has started.
        Raises the typed ``product`` N/A when the product does not run the Sync service."""
        return self._api.status()

    def flush(self) -> Obj:
        """Send what is waiting now (bounded by the sign-out flush window), save the journal and answer
        the status."""
        return self._api.flush()


class CloudSyncApi:
    def __init__(
        self,
        *,
        ctx: CoreContext,
        host: CloudSyncHost,
        keyring: Any,
        config: ConfigClient,
        subject: Callable[[], Optional[str]],
        emit: Callable[[Obj], None],
        log: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._ctx = ctx
        self._host = host
        self._keyring = keyring
        self._config = config
        #: The persisted subject of the signed-in account, or ``None``.
        self._stored_subject = subject
        #: ``client.events.emit("cloudSync", ...)``.
        self._emit = emit
        #: Diagnostics; never given a value or a secret.
        self._log = log or (lambda _m: None)
        self._attach_lock = threading.RLock()
        self._attached = False
        self._subject_value: Optional[str] = None
        self._forgot = False
        self._closed = False
        self._chain: List[threading.Thread] = []
        self._chain_lock = threading.Lock()
        self._tl = threading.local()
        self._listening = False
        self._pool: Optional[ThreadPoolExecutor] = None
        self._pool_lock = threading.Lock()
        self._port = _Port(self)

    # ── What app code calls ──────────────────────────────────────────────────────────────────

    def status(self) -> Obj:
        self._ctx.require_service("sync", Feature.SYNC_SETTINGS)
        if not self._host.started:
            return {"state": "local", "pending": 0}
        with self._host.locked() as m:
            return m.status()

    def flush(self) -> Obj:
        self._ctx.require_service("sync", Feature.SYNC_SETTINGS)
        self._attach()
        self._drain_work()
        self._host.flush()
        self._join_chain()
        return self.status()

    # ── What the client calls ────────────────────────────────────────────────────────────────

    def attach(self) -> None:
        """Start the host and sign the machine in as the stored subject. Idempotent; a no-op while the
        product does not run the Sync service."""
        self._attach()

    def attach_soon(self) -> None:
        """:meth:`attach` on the worker thread; never raises (the client's discovery calls it)."""
        self._submit(self._quietly(self._attach))

    @property
    def _subject(self) -> Optional[str]:
        """The person the machine is signed in as; the host is told, so no request outlives them."""
        return self._subject_value

    @_subject.setter
    def _subject(self, subject: Optional[str]) -> None:
        self._subject_value = subject
        self._host.bind_subject(subject)

    def on_identity(self, change: str, subject: Optional[str] = None) -> None:
        """An ``identity`` event: queued, handled in order on the worker thread."""
        self._submit(self._quietly(lambda: self._on_identity(change, subject)))

    def close(self) -> None:
        self._closed = True
        with self._pool_lock:
            pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False)

    # ── The worker thread ────────────────────────────────────────────────────────────────────

    def _submit(self, fn: Callable[[], Any]) -> "Optional[Future[Any]]":
        with self._pool_lock:
            if self._closed:
                return None
            if self._pool is None:
                self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="polaris-sync-id")
            return self._pool.submit(fn)

    def _drain_work(self) -> None:
        """Wait for every identity event queued so far."""
        f = self._submit(lambda: None)
        if f is not None:
            f.result()

    @staticmethod
    def _quietly(fn: Callable[[], Any]) -> Callable[[], None]:
        def run() -> None:
            try:
                fn()
            except Exception:  # noqa: BLE001 - identity handling never reaches the emitter
                pass

        return run

    # ── Start ────────────────────────────────────────────────────────────────────────────────

    def _attach(self) -> None:
        if not self._ctx.enabled("sync"):
            return
        with self._attach_lock:
            if self._attached:
                return
            self._start()
            self._attached = True

    def _start(self) -> None:
        host = self._host
        host.start()
        if not self._listening:
            self._listening = True
            host.on_events(self._on_events)
        self._config.use_sync(self._port)
        # A journal saved while signed in still names its subject.
        with host.locked() as m:
            self._subject = m.persist().get("subject")
        try:
            subject = self._stored_subject()
        except Exception:  # noqa: BLE001 - no stored subject is no principal
            subject = None
        if subject is not None:
            self._sign_in(subject)
        elif self._subject is not None:
            self._leave()

    def _sign_in(self, subject: str) -> None:
        host = self._host
        if not host.started:
            return
        # Another person: the first one leaves (unsent edits dropped, then forgotten) before this one
        # starts. The device credential is already the new person's, so nothing is sent for the old one.
        if self._subject is not None and self._subject != subject:
            self._sign_out_now()
        # Once per install (the machine ignores a second call), before the first principal arrives so
        # the values enter at the floor and a newer cloud value wins.
        host.import_local_once(self._config.importable())
        host.resume()
        self._subject = subject
        with host.locked() as m:
            m.sign_in(subject)
        host.touch()
        self._join_chain()

    def _on_identity(self, change: str, subject: Optional[str]) -> None:
        self._attach()
        if not self._host.started:
            return
        target = None if change == "signed_out" else subject
        if target is None:
            return self._leave()
        if target != self._subject:
            self._sign_in(target)

    # ── Leaving ──────────────────────────────────────────────────────────────────────────────

    def _sign_out_now(self) -> None:
        """The person changed: the credential in use is already the new person's, so this never talks
        to the server. Unsynced edits are discarded and the old synced values leave memory before
        anything waits. The only flush is ``before_sign_out``, while the old credential is current."""
        host = self._host
        self._subject = None
        with host.locked() as m:
            m.sign_out(discard_unsynced=True)
        host.touch()
        self._join_chain()

    def before_sign_out(self) -> None:
        """The identity client's pre-sign-out hook: flush (bounded), sign out, forget."""
        host = self._host
        self._drain_work()
        if not host.started or self._subject is None:
            return
        self._forgot = False
        try:
            with host.locked() as m:
                m.sign_out()
            host.flush(SYNC_SIGNOUT_FLUSH_MS)
        finally:
            # The machine's own ``signedOut`` event forgets; if it never came (a failure above), forget now.
            self._join_chain()
            if not self._forgot:
                self._forget_bounded()
            self._subject = None

    def _leave(self) -> None:
        """The device was deactivated or the identity forgotten: leave the principal without a flush."""
        host = self._host
        if self._subject is None:
            return
        with host.locked() as m:
            m.sign_out()
        host.touch()
        self._join_chain()

    def on_deactivated(self) -> None:
        """Called when the licence is deactivated: the principal is gone with the device."""
        self._drain_work()
        if self._host.started:
            self._leave()
        self._join_chain()
        # Deactivation drops the synced data whether or not a principal was held.
        self._forget_bounded()
        self._subject = None

    # ── The machine's events ─────────────────────────────────────────────────────────────────

    def _on_events(self, events: List[Obj]) -> None:
        left = any(e.get("type") == "signedOut" and e.get("reason") in FORGETTING for e in events)
        # The root leaves memory before anything else runs.
        forgotten = self._forget_async() if left else None
        offers = [e for e in events if e.get("type") == "signInOffered"]
        try:
            for e in events:
                if e.get("type") == "signedOut":
                    self._subject = None
                if e.get("type") == "change":
                    self._config.note_sync_change(e["keys"], e["origin"])
                if left and e.get("type") == "signInOffered":
                    continue
                self._emit(e)
        finally:
            if forgotten is not None:
                self._after(forgotten, offers)

    def _after(self, forgotten: threading.Thread, offers: List[Obj]) -> None:
        """Offer sign-in once the forget has finished (on its own thread)."""

        def run() -> None:
            forgotten.join()
            for e in offers or [{"type": "signInOffered", "signInUrl": None}]:
                try:
                    self._emit(e)
                except Exception:  # noqa: BLE001
                    pass

        self._spawn(run)

    def _spawn(self, fn: Callable[[], None]) -> threading.Thread:
        t = threading.Thread(target=fn, name="polaris-sync-forget", daemon=True)
        with self._chain_lock:
            self._chain = [c for c in self._chain if c.is_alive()]
            self._chain.append(t)
        t.start()
        return t

    def _join_chain(self) -> None:
        """Wait for the forgets and sign-in offers started so far (bounded)."""
        me = threading.current_thread()
        while True:
            with self._chain_lock:
                pending = [t for t in self._chain if t.is_alive() and t is not me]
            if not pending:
                return
            for t in pending:
                t.join(_CHAIN_WAIT)
                if t.is_alive():
                    self._log("cloud sync: a forget is still waiting on a request")
                    return

    def _forget_ring(self) -> None:
        try:
            self._keyring.forget()
        except Exception:  # noqa: BLE001
            # The root is already gone (``forget`` locks first); only the pin file failed to go.
            self._log("cloud sync: the key ring pin could not be removed")

    def _purge(self) -> None:
        self._tl.purging = True
        try:
            self._host.purge()
        except Exception:  # noqa: BLE001
            self._log("cloud sync: the synced data could not be deleted")
            # The app hears of it too (no values, no path): it may warn the person.
            try:
                self._emit({"type": "purgeFailed"})
            except Exception:  # noqa: BLE001
                pass
        finally:
            self._tl.purging = False

    def _forget(self) -> None:
        """Drop the ring (the root first), then the synced data on disk and in memory. Each step is
        tried whatever the other did; a failure is logged and never raised."""
        self._forgot = True
        self._forget_ring()
        self._purge()

    def _forget_bounded(self) -> None:
        """:meth:`_forget` that a slow pump cannot hold up: the ring now, the purge on its own thread
        and waited for at most ``_FORGET_WAIT`` (the file is already gone by then; see ``purge``)."""
        self._forgot = True
        self._forget_ring()
        t = self._spawn(self._purge)
        t.join(_FORGET_WAIT)
        if t.is_alive():
            self._log("cloud sync: the purge is still waiting on a request")

    def _forget_async(self) -> threading.Thread:
        """:meth:`_forget` for a caller inside a pump: the ring now, the purge on its own thread (it
        waits for that pump to end). A purge that is itself draining these events covers it."""
        self._forgot = True
        self._forget_ring()
        covered = bool(getattr(self._tl, "purging", False))
        return self._spawn(lambda: None if covered else self._purge())


class _Port:
    """The config client's port onto the machine."""

    def __init__(self, api: CloudSyncApi) -> None:
        self._api = api

    def active(self) -> bool:
        return self._api._host.started and self._api._subject is not None

    def _result(self, r: Mapping[str, Any]) -> Mapping[str, Any]:
        # The machine queued the edit; one pump reports its events (nothing is due before the
        # debounce, so this does not wait on the network).
        self._api._host.touch()
        return r

    def set(self, key: str, value: Any) -> Mapping[str, Any]:
        host = self._api._host
        host.catch_up()
        with host.locked() as m:
            r = m.set(key, value)
        return self._result(r)

    def clear(self, key: str) -> Mapping[str, Any]:
        host = self._api._host
        host.catch_up()
        with host.locked() as m:
            r = m.clear(key)
        return self._result(r)

    def get(self, key: str) -> Mapping[str, Any]:
        with self._api._host.locked() as m:
            return m.get(key)

    def state(self, key: str) -> str:
        with self._api._host.locked() as m:
            return str(m.setting_state(key)["sync"])
