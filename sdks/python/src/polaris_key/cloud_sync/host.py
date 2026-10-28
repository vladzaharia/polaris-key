"""The Python Cloud Sync host: the first production host of :class:`CloudSyncMachine`.

A port of ``packages/sdk-node/src/cloudSync/host.ts`` (U-06.2), with every SEC-SYNC-HOST fix. The machine
does no I/O; this module is everything around it:

* one machine per client, built from app code (``encryption``, default ``"e2e"``), the discovery
  ``services.sync`` member, the key ring (``keyring.attach``) and the product catalog;
* the catalog comes from ``/config/schema``, cached beside the journal, with the app's compiled mirror
  before the first fetch; it is fetched again when a pull's ``catalogVersion`` differs, at most every
  five minutes;
* every request the machine queues goes through the transport (bearer, ``X-PKey-*``), and in E2E mode
  through the host codec (:func:`seal_push` / :func:`open_pull`) on the way out and in;
* the journal is written to ``<state_dir>/cloud-sync.json`` (0600);
* a real-clock timer (a daemon :class:`threading.Timer`) drives ``advance`` while the machine holds work;
  an ``atexit`` hook flushes, bounded by ``SYNC_SIGNOUT_FLUSH_MS``.

Rules this host keeps (plans/U-sync-clients-slices.md section 9):

* S1  The opened result is the codec's own; the served body's ``sealed`` / ``invalid`` / ``seq`` are
  stripped by :func:`open_pull`, never read here.
* S2  The mode is app code's. The Worker's discovery and bodies only let the machine detect a downgrade;
  the served catalog's ``cloudSync.encryption`` is dropped from the routes.
* S3  A locked ring sends nothing and reads nothing: no request is made while the codec is locked, and
  this host never adds a GET of its own.
* S7  The root is not here; the codec holds it in the key ring's memory.
* S10 An answer that cannot be opened is dropped without advancing the cursor.

Threads: the machine is not thread-safe. Every call into it holds :attr:`CloudSyncHost.lock` (reentrant;
the API layer takes it for ``set`` and ``status``), and the lock is released across each HTTP exchange.
One pump runs at a time.

Nothing in the licence path imports this module.
"""

from __future__ import annotations

import atexit
import json
import math
import os
import re
import threading
import time
import weakref
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Set

from ..constants_generated import SYNC_KEY_PATTERN, SYNC_SIGNOUT_FLUSH_MS
from ..core.b64url import b64url_encode
from ..core.context import CoreContext
from ..core.token import TokenManager
from .host_codec import open_pull, seal_push
from .machine import CloudSyncMachine
from .routes import synced_settings
from .state import OPEN_KEYS_MAX, CloudSyncFile, CloudSyncStateFile, is_catalog_shape
from .transport import send_sync

__all__ = [
    "CATALOG_REFETCH_MS",
    "MAX_CATALOG_BYTES",
    "MAX_CATALOG_ENTRIES",
    "TICK_MS",
    "CloudSyncHost",
    "CloudSyncHostDeps",
    "CloudSyncHostOptions",
]

Json = Any
Obj = Dict[str, Any]

#: How often the real-clock timer wakes the machine while it holds work (ms).
TICK_MS = 250
#: The most exchanges one pump makes, whatever the machine keeps asking for.
MAX_EXCHANGES = 64
#: The most entries and bytes of a catalog the host will route by.
MAX_CATALOG_ENTRIES = 1024
MAX_CATALOG_BYTES = 1024 * 1024
#: A served catalog is fetched again at most this often (the first fetch is free).
CATALOG_REFETCH_MS = 5 * 60_000

_EMPTY_CATALOG: Obj = {"schemaVersion": 0, "entries": []}
_SYNC_KEY = re.compile(SYNC_KEY_PATTERN)


@dataclass
class CloudSyncHostOptions:
    """What app code sets. Never read from the Worker."""

    #: The product's mode. Default ``"e2e"``. An app that says ``"server"`` still refuses to talk to a
    #: Worker it has seen speak E2E (the machine's pin).
    encryption: str = "e2e"
    #: The catalog compiled into the app (``pkey mirror``): used until ``/config/schema`` has been
    #: fetched once, and authoritative for every key it names.
    catalog: Optional[Mapping[str, Any]] = None
    #: Renames the app declares (old name to current name). Never taken from a served body.
    aliases: Optional[Mapping[str, str]] = None


@dataclass
class CloudSyncHostDeps:
    """What the host needs from the client; each is a function so the host holds no stale copy."""

    ctx: CoreContext
    tokens: TokenManager = field(repr=False)
    keyring: Any = field(repr=False)
    #: The loaded discovery document, or ``None`` before the first discovery.
    discovery: Callable[[], Optional[Mapping[str, Any]]]
    #: ``GET /config/schema`` (diagnostic and unsigned; ``None`` on any failure).
    fetch_schema: Callable[[], Optional[Mapping[str, Any]]]
    #: The signed config document's values and the keys it locks.
    document: Callable[[], Obj]
    #: The person the device's session is for now, or ``None`` when not known. A request queued for
    #: another person is dropped, not sent under this session's token.
    subject: Optional[Callable[[], Optional[str]]] = field(default=None)
    #: Test seam: the clock, in epoch milliseconds.
    clock: Optional[Callable[[], int]] = field(default=None)


def _routes_of(catalog: Mapping[str, Any]) -> List[Obj]:
    """The routes of a catalog, without any mode the catalog states (the app decides the mode)."""
    return [{k: v for k, v in r.items() if k != "encryption"} for r in synced_settings(catalog)]


def _vetted(c: Any) -> Optional[Obj]:
    """A catalog fit to route by: the right shape and size, every entry key a valid sync key, and one
    entry per key. ``None`` when it is not."""
    if not is_catalog_shape(c) or len(c["entries"]) > MAX_CATALOG_ENTRIES:
        return None
    try:
        if len(json.dumps(c)) > MAX_CATALOG_BYTES:
            return None
    except (TypeError, ValueError):
        return None
    seen: Set[str] = set()
    entries = []
    for e in c["entries"]:
        k = e.get("key") if isinstance(e, dict) else None
        if not isinstance(k, str) or _SYNC_KEY.match(k) is None or k in seen:
            continue
        seen.add(k)
        entries.append(e)
    out: Obj = {**c, "entries": entries}
    try:
        _routes_of(out)
    except Exception:  # noqa: BLE001 - a catalog whose routes cannot be derived is not fit to route by
        return None
    return out


def _is_obj(v: Any) -> bool:
    return isinstance(v, dict)


def _dump(v: Any) -> str:
    return json.dumps(v, sort_keys=True)


class CloudSyncHost:
    def __init__(self, deps: CloudSyncHostDeps, opts: Optional[CloudSyncHostOptions] = None) -> None:
        self._deps = deps
        self._opts = opts or CloudSyncHostOptions()
        state_dir = deps.ctx.dirs.state
        self._file = CloudSyncStateFile(state_dir, deps.ctx.product)
        self._lock = threading.RLock()
        self._pump_lock = threading.Lock()
        self._save_lock = threading.RLock()
        self._tlock = threading.Lock()
        self._listeners: List[Callable[[List[Obj]], None]] = []
        self._machine: Optional[CloudSyncMachine] = None
        self._detach: Optional[Callable[[], None]] = None
        #: The catalog compiled into the app: authoritative for every key it names.
        self._mirror: Optional[Obj] = None
        #: The last catalog the Worker served: it may only add keys the mirror lacks.
        self._served: Optional[Obj] = None
        #: The catalog the machine routes by (:meth:`_effective`).
        self._catalog: Obj = _EMPTY_CATALOG
        self._last_fetch_at: Optional[int] = None
        self._used = 0
        self._routes: List[Obj] = []
        self._open_keys: Dict[str, None] = {}
        self._document_json = ""
        self._tried_catalog_version: Optional[int] = None
        self._rebuild_wanted = False
        self._again = False
        self._timer: Optional[threading.Timer] = None
        self._exit_hook: Optional[Callable[[], None]] = None
        self._started = False
        self._closed = False
        #: After a purge the journal stays unsaved until a principal signs in again.
        self._purged = False
        #: The person the machine's queued requests belong to (``None`` for none).
        self._bound: Optional[str] = None
        #: What the key ring last said about the root; applied to the machine at the next pump.
        self._root_pending: Optional[bool] = None
        self._building = False
        #: The thread running a pump (or a purge's final emit): it may not wait on itself.
        self._pump_thread: Optional[int] = None

    # ── basics ───────────────────────────────────────────────────────────────────────────────

    def _now(self) -> int:
        clock = self._deps.clock
        return clock() if clock is not None else int(time.time() * 1000)

    @property
    def machine(self) -> CloudSyncMachine:
        """The machine; raises before :meth:`start`."""
        if self._machine is None:
            raise RuntimeError("Cloud Sync host: start() has not run")
        return self._machine

    @property
    def started(self) -> bool:
        return self._started and not self._closed

    @contextmanager
    def locked(self) -> Iterator[CloudSyncMachine]:
        """Hold the machine lock for a call into the machine (``set``, ``status``, ``sign_in``...)."""
        with self._lock:
            yield self.machine

    def on_events(self, fn: Callable[[List[Obj]], None]) -> Callable[[], None]:
        """Subscribe to the machine's events (batches, in order). Returns an unsubscribe function."""
        self._listeners.append(fn)

        def off() -> None:
            if fn in self._listeners:
                self._listeners.remove(fn)

        return off

    # ── start ────────────────────────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Load the saved journal and catalog, build the machine, attach it to the key ring and install
        the exit flush. Idempotent. Makes no request unless a catalog has to be fetched (none cached and
        none compiled in)."""
        with self._lock:
            if self._started or self._closed:
                return
            self._started = True
            saved = self._file.load()
            self._open_keys = {k: None for k in saved["openKeys"]}
            self._mirror = _vetted(self._opts.catalog)
            self._served = _vetted(saved["catalog"])
            self._build(saved["persisted"])
            self._install_exit()
        if saved["catalog"] is None and self._opts.catalog is None:
            self._refetch_catalog(None)
        self.touch()

    def _install_exit(self) -> None:
        ref = weakref.ref(self)

        def hook() -> None:
            host = ref()
            if host is not None:
                try:
                    host.flush(SYNC_SIGNOUT_FLUSH_MS)
                except Exception:  # noqa: BLE001 - nothing to report at exit
                    pass

        self._exit_hook = hook
        atexit.register(hook)

    def _effective(self) -> Obj:
        """The routes' catalog: the mirror as it is, plus served entries only for keys the mirror does
        not name and the person's own open settings do not use. The Worker's catalog never changes a
        route the app compiled in, and never turns an open setting into a declared one."""
        mirror, served = self._mirror, self._served
        taken = {e["key"] for e in (mirror["entries"] if mirror else [])}
        extra = [
            e
            for e in (served["entries"] if served else [])
            if e["key"] not in taken and e["key"] not in self._open_keys
        ]
        base = mirror or served or _EMPTY_CATALOG
        version = (served or mirror or {}).get("schemaVersion", 0)
        return {**base, "schemaVersion": version, "entries": [*(mirror["entries"] if mirror else []), *extra]}

    def _build(self, persisted: Optional[Obj]) -> None:
        """(Re)build the machine from the journal, the catalog and the document."""
        if self._detach is not None:
            self._detach()
            self._detach = None
        self._catalog = self._effective()
        self._routes = _routes_of(self._catalog)
        document = self._deps.document()
        self._document_json = _dump(document)
        keyring = self._deps.keyring
        m = CloudSyncMachine(
            {
                "product": self._deps.ctx.product,
                "catalog": {"settings": self._routes},
                "document": document,
                "now": self._now(),
                "encryption": self._opts.encryption,
                "hasRoot": bool(keyring.unlocked),
                "newClientId": lambda: "c_" + b64url_encode(os.urandom(16)),
            },
            persisted,
        )
        self._machine = m
        self._apply_discovery(m)
        self._building = True
        try:
            self._detach = keyring.attach(_RootFeed(self))
        finally:
            self._building = False
        self._root_pending = None

    def _apply_discovery(self, m: CloudSyncMachine) -> None:
        doc = self._deps.discovery()
        if doc is None:
            return
        services = doc.get("services")
        sync = services.get("sync") if isinstance(services, dict) else None
        if not isinstance(sync, dict) or sync.get("enabled") is not True:
            return
        e = sync.get("encryption")
        m.set_discovery({"encryption": e} if e in ("e2e", "server") else {})

    def note_discovery(self) -> None:
        """Discovery just loaded: tell the machine what ``services.sync`` says."""
        with self._lock:
            if self._machine is None:
                return
            self._apply_discovery(self._machine)
        self._wake()

    def note_document_refreshed(self) -> None:
        """The signed config document refreshed: lift a block, and rebuild if the document changed."""
        with self._lock:
            if self._machine is None:
                return
            self._machine.refresh()
            if _dump(self._deps.document()) != self._document_json:
                self._rebuild_wanted = True
        self._wake()

    def catch_up(self) -> None:
        """Bring the machine's clock to the real one, so an edit made now is stamped and debounced from
        now (the machine only moves when told)."""
        with self._lock:
            if self._machine is None:
                return
            dt = self._now() - self._machine.now
            if dt > 0:
                self._machine.advance(dt)

    def _root_changed(self, present: bool) -> None:
        # Called by the key ring while it holds its own lock: record it and let a thread apply it, so
        # the ring lock and the machine lock are never held together.
        self._root_pending = bool(present)
        if not self._building:
            self._wake()

    def _wake(self) -> None:
        """Run a pump on a background thread (the caller must not wait on the network)."""
        if self.started:
            threading.Thread(target=self._touch_quietly, daemon=True).start()

    def _touch_quietly(self) -> None:
        try:
            self.touch()
        except Exception:  # noqa: BLE001 - a background wake never raises
            pass

    # ── the pump ─────────────────────────────────────────────────────────────────────────────

    def touch(self) -> None:
        """Run the machine now: advance its clock, exchange every queued request, save. Never raises."""
        if not self.started or not self._deps.ctx.enabled("sync"):
            return
        if self._pump_thread == threading.get_ident():
            # A listener reacting to an event from inside the pump: the pump runs again after it.
            self._again = True
            return
        while True:
            if self._pump_lock.acquire(blocking=False):
                self._pump_thread = threading.get_ident()
                try:
                    self._pump()
                except Exception:  # noqa: BLE001 - the pump never throws into app code
                    pass
                finally:
                    self._pump_thread = None
                    self._pump_lock.release()
                self._arm()
                return
            self._again = True
            with self._pump_lock:  # wait for the pump that is running
                pass
            if not self._again:
                return

    def _pump(self) -> None:
        self._used = 0
        while True:
            self._again = False
            with self._lock:
                if self._rebuild_wanted:
                    self._rebuild()
                m = self.machine
                self._apply_root(m)
                dt = self._now() - m.now
                if dt > 0:
                    m.advance(dt)
            while self._used < MAX_EXCHANGES:
                with self._lock:
                    reqs = m.take_requests()
                if not reqs:
                    break
                for req in reqs:
                    self._used += 1
                    self._exchange(m, req)
            self._emit(m)
            if not (self._again and self._used < MAX_EXCHANGES):
                break
        # Saving commits the debounced edits (`persist()`), so a pump that exchanged nothing leaves the
        # file alone and an edit keeps its debounce window.
        if self._used > 0:
            self._save()

    def _apply_root(self, m: CloudSyncMachine) -> None:
        pending, self._root_pending = self._root_pending, None
        if pending is not None:
            m.set_root(pending)

    def _receive(self, m: CloudSyncMachine, res: Obj, opened: Optional[Obj] = None) -> None:
        with self._lock:
            m.receive(res, opened)

    def bind_subject(self, subject: Optional[str]) -> None:
        """Tell the host whose requests the machine now holds (``None`` for none)."""
        self._bound = subject

    def _exchange(self, m: CloudSyncMachine, req: Obj) -> None:
        """One request: seal it (E2E), send it, open the answer, hand both to the machine."""
        bound = self._bound
        codec = self._deps.keyring.codec
        e2e = m.encryption_mode() == "e2e"
        # S3: a locked ring sends nothing, a pull included.
        if e2e and codec.locked:
            return self._receive(m, {"error": "transport"})

        wire: Obj = req
        mutations: Optional[List[Obj]] = None
        if req.get("method") == "POST":
            body: Any = req.get("body")
            mutations = body.get("mutations") if _is_obj(body) else None
            self._note_open_keys(mutations)
            if e2e:
                try:
                    wire = {"method": "POST", "path": req["path"], "body": seal_push(body, codec, self._routes)}
                except Exception:  # noqa: BLE001
                    # Locked, or a mutation that cannot be sealed: nothing is sent.
                    return self._receive(m, {"error": "transport"})

        # Queued for one person: if the session is another person's now, nothing is sent.
        now: Optional[str] = None
        if self._deps.subject is not None:
            try:
                now = self._deps.subject()
            except Exception:  # noqa: BLE001 - an unknown subject does not block a send
                now = None
        if bound is not None and now is not None and now != bound:
            return self._receive(m, {"error": "transport"})
        res = send_sync(self._deps.ctx, self._deps.tokens, wire)
        ok = "status" in res and res["status"] == 200 and _is_obj(res.get("body"))
        if not e2e or not ok:
            # Server mode, an error answer, or no answer: the machine reads it as it is.
            if e2e and "status" in res and res["status"] == 200:
                return self._receive(m, {"error": "transport"})
            return self._receive(m, res)
        try:
            body_out, opened = open_pull(
                res["body"],
                codec,
                mutations=mutations,
                aliases=self._opts.aliases,
                open_keys=list(self._open_keys),
            )
        except Exception:  # noqa: BLE001
            # Locked since the request left, or a repeated mutationId: the answer is dropped and the
            # cursor stays.
            return self._receive(m, {"error": "transport"})
        self._note_opened_keys(body_out, opened)
        self._receive(m, {"status": 200, "body": body_out}, opened)
        self._maybe_refetch(body_out)

    # ── the catalog ──────────────────────────────────────────────────────────────────────────

    def _maybe_refetch(self, body: Json) -> None:
        """A pull that names another ``catalogVersion`` than the catalog held: fetch it again, once."""
        if not _is_obj(body):
            return
        v = body.get("catalogVersion")
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
            return
        if v == self._catalog.get("schemaVersion") or v == self._tried_catalog_version:
            return
        self._refetch_catalog(int(v))

    def _refetch_catalog(self, version: Optional[int]) -> None:
        now = self._now()
        # Rate-limited, and counted in the pump's budget like any other request.
        if self._used >= MAX_EXCHANGES or (
            self._last_fetch_at is not None and now - self._last_fetch_at < CATALOG_REFETCH_MS
        ):
            return
        self._last_fetch_at = now
        self._tried_catalog_version = version
        self._used += 1
        try:
            fetched = _vetted(self._deps.fetch_schema())
        except Exception:  # noqa: BLE001
            fetched = None
        if fetched is None:
            return
        with self._lock:
            if _dump(fetched) == _dump(self._served):
                return
            before = _dump(_routes_of(self._catalog))
            self._served = fetched
            # Rebuild only when the routes the machine uses would change.
            effective = self._effective()
            if _dump(_routes_of(effective)) == before:
                self._catalog = effective
                return
            self._rebuild_wanted = True
            self._again = True

    def _rebuild(self) -> None:
        """New catalog or document: the machine is rebuilt from its own journal (never mid-request).
        Called with the lock held."""
        self._rebuild_wanted = False
        old = self.machine
        persisted = old.persist()
        self._emit_from(old)
        self._build(persisted)
        self._save(persisted)

    # ── open keys ────────────────────────────────────────────────────────────────────────────

    def _note_open_keys(self, mutations: Optional[List[Obj]]) -> None:
        declared = {r["key"] for r in self._routes}
        for mu in mutations or []:
            target: Any = mu.get("target") if _is_obj(mu) else None
            if _is_obj(target) and isinstance(target.get("setting"), str) and target["setting"] not in declared:
                self._add_open_key(target["setting"])

    def _note_opened_keys(self, body: Json, opened: Obj) -> None:
        """Names from rows this host opened (``sealed``): a served name, an unopened row or a plaintext
        row never enters the set, so a Worker cannot fill it to push real names out."""
        if not _is_obj(body) or not isinstance(body.get("changes"), list):
            return
        declared = {r["key"] for r in self._routes}
        rows = opened.get("changes") or []
        for i, c in enumerate(body["changes"]):
            row = rows[i] if i < len(rows) else None
            if (
                row is not None
                and row.get("sealed") is True
                and _is_obj(c)
                and isinstance(c.get("setting"), str)
                and c["setting"] not in declared
            ):
                self._add_open_key(c["setting"])

    def _add_open_key(self, name: str) -> None:
        self._open_keys.pop(name, None)
        self._open_keys[name] = None
        while len(self._open_keys) > OPEN_KEYS_MAX:
            del self._open_keys[next(iter(self._open_keys))]

    # ── events and state ─────────────────────────────────────────────────────────────────────

    def _emit(self, m: CloudSyncMachine) -> None:
        self._emit_from(m)

    def _emit_from(self, m: CloudSyncMachine) -> None:
        with self._lock:
            events = m.take_events()
        if not events:
            return
        for fn in list(self._listeners):
            try:
                fn(events)
            except Exception:  # noqa: BLE001 - a listener's failure never reaches the machine
                pass

    def _save(self, persisted: Optional[Obj] = None) -> None:
        """Persist the journal. Committing the debounced edits is what ``persist()`` does by contract.
        The file never holds the root."""
        with self._save_lock:
            if self._purged or self._machine is None:
                return
            with self._lock:
                snapshot = persisted if persisted is not None else self.machine.persist()
            file: CloudSyncFile = {
                "v": 1,
                "product": self._deps.ctx.product,
                "persisted": snapshot,
                "catalog": self._served,
                "openKeys": list(self._open_keys),
            }
            try:
                self._file.save(file)
            except Exception:  # noqa: BLE001 - failing to persist never fails the call that produced it
                pass

    # ── the timer ────────────────────────────────────────────────────────────────────────────

    def _arm(self) -> None:
        """The real-clock timer: wake while the machine holds work (an edit waiting out its debounce, a
        request to retry, a sign-out flush). It never keeps the process alive."""
        with self._tlock:
            if self._timer is not None or self._closed or self._machine is None:
                return
            with self._lock:
                s = self._machine.status()
            busy = s["pending"] > 0 and s["state"] in ("pending", "syncing", "paused")
            if not busy:
                return
            t = threading.Timer(TICK_MS / 1000, self._on_timer)
            t.daemon = True
            self._timer = t
            t.start()

    def _on_timer(self) -> None:
        with self._tlock:
            self._timer = None
        self._touch_quietly()

    def _cancel_timer(self) -> None:
        with self._tlock:
            t, self._timer = self._timer, None
        if t is not None:
            t.cancel()

    # ── the API layer's calls ────────────────────────────────────────────────────────────────

    def import_local_once(self, values: Mapping[str, Json]) -> None:
        """Offer the legacy ``local-config.json`` to the machine, once per install."""
        done = self._file.imported()
        with self._lock:
            self.machine.import_local({} if done else dict(values))
        if not done:
            try:
                self._file.mark_imported()
            except Exception:  # noqa: BLE001
                pass

    def resume(self) -> None:
        """A principal signed in: the journal is saved again."""
        self._purged = False

    def purge(self) -> None:
        """Forget the person's synced data (S6): the machine is rebuilt empty and ``cloud-sync.json``,
        which holds the opened snapshot in the clear, is deleted. Nothing is saved again until
        :meth:`resume`. Works before :meth:`start` too (the file may predate this process). Raises only if
        the file could not be removed; the in-memory data is gone either way."""
        with self._save_lock:
            self._purged = True
            # At once, before waiting for any pump: a sign-out that outlives its bounds, or a process
            # that exits, must not leave the snapshot on disk. `_purged` stops any save racing this.
            self._remove_quietly()
        self._open_keys = {}
        self._cancel_timer()
        try:
            if self.started:
                with self._pump_lock:  # any pump in progress ends first
                    self._pump_thread = threading.get_ident()
                    try:
                        self._open_keys = {}
                        self._emit_from(self.machine)
                        with self._lock:
                            self._build(None)
                            self.machine.import_local({})
                    finally:
                        self._pump_thread = None
        finally:
            with self._save_lock:
                self._file.remove()

    def _remove_quietly(self) -> None:
        try:
            self._file.remove()
        except Exception:  # noqa: BLE001 - the final removal below reports a failure
            pass

    def flush(self, max_ms: int = SYNC_SIGNOUT_FLUSH_MS) -> None:
        """Send what is waiting and save, giving up (the journal is kept) after ``max_ms``."""
        if not self.started:
            return
        with self._lock:
            self.machine.flush()
        worker = threading.Thread(target=self._touch_quietly, daemon=True)
        worker.start()
        worker.join(max_ms / 1000)
        self._save()

    def close(self) -> None:
        """Stop the timer and the exit hook; save the journal. Safe to call more than once."""
        if self._closed:
            return
        was = self.started
        self._closed = True
        self._cancel_timer()
        if self._exit_hook is not None:
            atexit.unregister(self._exit_hook)
            self._exit_hook = None
        if self._detach is not None:
            self._detach()
            self._detach = None
        if was and self._machine is not None:
            with self._pump_lock:
                pass
            self._save()


class _RootFeed:
    """What the key ring is attached with: it tells the host, and the host tells the machine on its next
    pump (the ring calls this under its own lock)."""

    __slots__ = ("_host",)

    def __init__(self, host: CloudSyncHost) -> None:
        self._host = weakref.proxy(host)

    def set_root(self, present: bool) -> None:
        try:
            self._host._root_changed(present)
        except ReferenceError:
            pass
