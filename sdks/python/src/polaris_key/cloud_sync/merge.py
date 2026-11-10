"""MergeRequest: the one conflict a person or an app is asked to settle (plans/U-08.md §2.2-§2.4;
WIRE-CONTRACT-V5 §11.5). A port of client-core's ``sync/merge.ts``.

``revision`` is the only policy that asks. Two sources feed one registry: the machine's record requests
(``w:<collection>/<record>``, journalled by the machine) and the saves layer's requests (``w:saves/<id>``,
memory only: S5).

A request is a live object: its members read the current state, so a host that holds one sees it reopen
after a failed keep. :meth:`MergeRequest.keep` blocks until the keep is answered and never raises; a
refusal is ``{"ok": False, "code": ..., "reopened": ...}``.

Threads: a listener runs on the thread that opened the request (the host's pump, or a save write's
thread). Return a choice from the listener to decide it at once; do not call ``keep`` on the pump thread
and wait (a ``keep`` made there is queued and answers ``{"ok": True, ..., "applying": True}`` without
waiting for the cloud).
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Optional

from ..constants_generated import ErrorCode, MergeEvent

__all__ = [
    "MergeRegistry",
    "MergeRequest",
    "HostMergeMachine",
    "SYNC_MERGE_CLOSED",
    "merge_choice_name",
]

Obj = Dict[str, Any]

#: ``keep`` on a request that has closed (or never existed): the client code of plans/U-08.md §2.3.
SYNC_MERGE_CLOSED: str = ErrorCode.SYNC_MERGE_CLOSED

_CHOICES = ("local", "remote", "both", "value")

#: How long a keep waits between looks at the machine, and how long a request may stay absent with no
#: closing event before the keep answers ``sync-merge-closed`` (a sign-out discards a request silently).
_POLL = 0.1
_ABSENT_GRACE = 0.3


def merge_choice_name(choice: Any) -> str:
    """``"local"``, ``"remote"``, ``"both"`` or ``"value"`` (for ``{"value": ...}``)."""
    return choice if isinstance(choice, str) else "value"


def _valid_choice(choice: Any) -> bool:
    if isinstance(choice, str):
        return choice in _CHOICES and choice != "value"
    return isinstance(choice, dict) and "value" in choice


def _closed_outcome() -> Obj:
    return {"ok": False, "code": SYNC_MERGE_CLOSED, "reopened": False}


def _bad_request() -> Obj:
    return {"ok": False, "code": "bad_request", "reopened": False}


def _copy_side(s: Optional[Obj]) -> Optional[Obj]:
    if s is None:
        return None
    return {**s, "file": dict(s["file"]) if s.get("file") else None}


def _newer_of(local: Optional[Obj], remote: Optional[Obj]) -> Optional[str]:
    """Which copy is newer by ``savedAt``; ``None`` unless both carry one and they differ."""
    if local is None or remote is None:
        return None
    a, b = local.get("savedAt"), remote.get("savedAt")
    if a is None or b is None or a == b:
        return None
    return "local" if a > b else "remote"


class MergeRequest:
    """One open request. ``keep(choice)`` is ``"local"``, ``"remote"``, ``"both"`` (saves) or
    ``{"value": json}`` (records) and answers ``{"ok": True, "kept", "version", "copyId"?}`` or
    ``{"ok": False, "code", "reopened"}``."""

    def __init__(self, view: Obj, registry: "MergeRegistry", backend: Optional[Callable[[Any], Obj]]) -> None:
        self._view = view
        self._registry = registry
        self._backend = backend
        #: Set once the request has closed; ``keep`` on it answers ``sync-merge-closed``.
        self.closed = False

    @property
    def id(self) -> str:
        return self._view["id"]

    @property
    def cause(self) -> str:
        return self._view["cause"]

    @property
    def collection(self) -> str:
        return self._view["collection"]

    @property
    def record(self) -> str:
        return self._view["record"]

    @property
    def local(self) -> Optional[Obj]:
        return _copy_side(self._view["local"])

    @property
    def remote(self) -> Optional[Obj]:
        return _copy_side(self._view["remote"])

    @property
    def choices(self) -> List[str]:
        return list(self._view["choices"])

    @property
    def newer(self) -> Optional[str]:
        return _newer_of(self._view["local"], self._view["remote"])

    @property
    def state(self) -> str:
        return self._view["state"]

    @property
    def error(self) -> Optional[str]:
        return self._view["error"]

    def keep(self, choice: Any) -> Obj:
        return self._registry.keep_request(self, choice)

    def __repr__(self) -> str:
        return f"<MergeRequest {self.id} {self.state}>"


class HostMergeMachine:
    """The machine as the registry uses it, through the host (which holds its lock and pumps it)."""

    def __init__(self, host: Any) -> None:
        self._host = host

    def conflicts(self) -> List[Obj]:
        if not self._host.started:
            return []
        with self._host.locked() as m:
            return m.conflicts()

    def keep(self, request_id: str, choice: Any) -> Obj:
        self._host.catch_up()
        with self._host.locked() as m:
            return m.keep(request_id, choice)

    def records(self, collection: str) -> List[Obj]:
        if not self._host.started:
            return []
        with self._host.locked() as m:
            return m.records(collection)

    def pump(self) -> None:
        """Run the host's pump on a background thread (the caller waits for the answer itself)."""
        threading.Thread(target=self._host.touch, daemon=True).start()

    def in_pump(self) -> bool:
        return bool(self._host.in_pump())


class _Waiter:
    def __init__(self, name: str) -> None:
        self.name = name
        self.event = threading.Event()
        self.outcome: Optional[Obj] = None
        self.absent_since: Optional[float] = None

    def settle(self, outcome: Obj) -> None:
        if self.outcome is None:
            self.outcome = outcome
            self.event.set()


class MergeRegistry:
    """The open requests of one client, from the machine and from the saves layer."""

    def __init__(
        self,
        machine: Optional[HostMergeMachine] = None,
        notice: Optional[Callable[["MergeRequest"], None]] = None,
    ) -> None:
        self._machine = machine
        self._notice = notice
        self._lock = threading.RLock()
        self._machine_reqs: Dict[str, MergeRequest] = {}
        self._extra: Dict[str, MergeRequest] = {}
        self._listeners: List[Callable[[MergeRequest], Any]] = []
        self._watchers: List[Callable[[Obj], None]] = []
        self._pending: Dict[str, _Waiter] = {}
        #: How the machine last closed a request, from its closing event (cleared when a keep starts).
        self._closed_how: Dict[str, str] = {}
        self._noticed = False

    # ── what the host calls ──────────────────────────────────────────────────────────────────

    def conflicts(self) -> List[MergeRequest]:
        """The open requests in id order."""
        self._refresh()
        return self._all()

    def count(self) -> int:
        return len(self.conflicts())

    def on_conflict(self, fn: Callable[[MergeRequest], Any]) -> Callable[[], None]:
        """Listen for requests as they open; the ones already open are replayed. A returned choice
        decides the request at once. Returns the remover."""
        with self._lock:
            self._listeners.append(fn)
        self._refresh()
        for r in self._all():
            if r.state == "open":
                self._offer(fn, r)

        def off() -> None:
            with self._lock:
                if fn in self._listeners:
                    self._listeners.remove(fn)

        return off

    def on_event(self, fn: Callable[[Obj], None]) -> Callable[[], None]:
        """``conflictOpened`` / ``conflictClosed`` (dicts). Returns the remover."""
        with self._lock:
            self._watchers.append(fn)

        def off() -> None:
            with self._lock:
                if fn in self._watchers:
                    self._watchers.remove(fn)

        return off

    def feed(self, events: Iterable[Obj]) -> None:
        """The machine's events, after ``take_events``: opens, closes and settled keeps."""
        for e in events:
            t = e.get("type")
            if t == "conflict":
                self._machine_opened(e["id"])
            elif t == "conflictClosed":
                self._machine_closed(e["id"], e["how"])
        self._settle_from_state()

    # ── the saves layer ──────────────────────────────────────────────────────────────────────

    def find(self, request_id: str) -> Optional[MergeRequest]:
        with self._lock:
            return self._extra.get(request_id)

    def open(self, view: Obj, backend: Callable[[Any], Obj]) -> MergeRequest:
        """Open a request, or reopen the one with that id (its sides and choices replaced). A listener
        may decide it inline."""
        with self._lock:
            have = self._extra.get(view["id"])
            r = have if have is not None else MergeRequest(view, self, backend)
            r._view = view
            self._extra[view["id"]] = r
        self._announce(r)
        return r

    def update(self, request_id: str, view: Obj) -> None:
        """Replace what an open request shows (a later write replaced the local copy; the state moved)."""
        with self._lock:
            r = self._extra.get(request_id)
            if r is not None:
                r._view = {**r._view, **view}

    def reannounce(self, request_id: str) -> None:
        """Tell the listeners again that a saves request is open (a keep conflicted again)."""
        with self._lock:
            r = self._extra.get(request_id)
        if r is not None:
            self._announce(r)

    def close(self, request_id: str, how: str) -> None:
        """Close a saves request. No-op when it is not open."""
        with self._lock:
            r = self._extra.pop(request_id, None)
            if r is None:
                return
            r.closed = True
        self._emit({"type": MergeEvent.CONFLICTCLOSED, "id": request_id, "how": how})

    # ── keep ─────────────────────────────────────────────────────────────────────────────────

    def keep_request(self, r: MergeRequest, choice: Any) -> Obj:
        self._refresh()
        if r.closed:
            return _closed_outcome()
        if r.state == "applying":
            return _bad_request()
        if not _valid_choice(choice) or merge_choice_name(choice) not in r._view["choices"]:
            return _bad_request()
        if r._backend is not None:
            return r._backend(choice)
        return self._keep_machine(r, choice, merge_choice_name(choice))

    def _keep_machine(self, r: MergeRequest, choice: Any, name: str) -> Obj:
        m = self._machine
        if m is None:
            return _closed_outcome()
        remote = r._view["remote"]
        remote_version = remote["version"] if remote else None
        with self._lock:
            self._closed_how.pop(r.id, None)
        res = m.keep(r.id, choice)
        if not res.get("ok"):
            return {"ok": False, "code": res["error"], "reopened": False}
        # ``remote`` is settled by the machine at once; the closing event arrives with the next batch.
        if name == "remote":
            with self._lock:
                r.closed = True
                self._machine_reqs.pop(r.id, None)
            m.pump()  # the closing event and the read of the server copy go out with the next pump
            return {"ok": True, "kept": "remote", "version": remote_version}
        if m.in_pump():
            # On the pump thread the answer cannot arrive until this call returns.
            return {"ok": True, "kept": name, "version": None, "applying": True}
        waiter = _Waiter(name)
        with self._lock:
            self._pending[r.id] = waiter
        m.pump()
        try:
            while True:
                if waiter.event.wait(_POLL):
                    break
                self._settle_from_state()
                if waiter.event.is_set():
                    break
        finally:
            with self._lock:
                if self._pending.get(r.id) is waiter:
                    del self._pending[r.id]
        assert waiter.outcome is not None
        return waiter.outcome

    # ── machine requests ─────────────────────────────────────────────────────────────────────

    @staticmethod
    def _machine_view(c: Obj) -> Obj:
        return {
            "id": c["id"],
            "cause": c["cause"],
            "collection": c["collection"],
            "record": c["record"],
            "local": _copy_side(c["local"]),
            "remote": _copy_side(c["remote"]),
            "choices": list(c["choices"]),
            "state": c["state"],
            "error": c["error"],
        }

    def _live(self) -> Dict[str, Obj]:
        if self._machine is None:
            return {}
        return {c["id"]: c for c in self._machine.conflicts()}

    def _refresh(self) -> None:
        """Bring the machine's requests in line with its state (a request that vanished is closed)."""
        if self._machine is None:
            return
        live = self._live()
        with self._lock:
            for rid in list(self._machine_reqs):
                r = self._machine_reqs[rid]
                c = live.get(rid)
                if c is not None:
                    r._view = self._machine_view(c)
                else:
                    r.closed = True
                    del self._machine_reqs[rid]
            for rid, c in live.items():
                if rid not in self._machine_reqs:
                    self._machine_reqs[rid] = MergeRequest(self._machine_view(c), self, None)

    def _all(self) -> List[MergeRequest]:
        with self._lock:
            both = [*self._machine_reqs.values(), *self._extra.values()]
        return sorted(both, key=lambda r: r.id.encode("utf-8"))

    def _machine_opened(self, request_id: str) -> None:
        live = self._live().get(request_id)
        if live is None:
            return
        with self._lock:
            r = self._machine_reqs.get(request_id)
            if r is not None:
                r._view = self._machine_view(live)
            else:
                r = MergeRequest(self._machine_view(live), self, None)
                self._machine_reqs[request_id] = r
        self._announce(r)

    def _machine_closed(self, request_id: str, how: str) -> None:
        with self._lock:
            r = self._machine_reqs.pop(request_id, None)
            if r is not None:
                r.closed = True
            self._closed_how[request_id] = how
        self._emit({"type": MergeEvent.CONFLICTCLOSED, "id": request_id, "how": how})

    def _version_of(self, collection: str, record: str) -> Optional[int]:
        if self._machine is None:
            return None
        for row in self._machine.records(collection):
            if row["id"] == record:
                return row["version"]
        return None

    def _settle_from_state(self) -> None:
        """Settle the keeps that wait: a request that closed answers ``ok`` (or ``sync-merge-closed`` when
        a delete or an exact write superseded it); one that is open again reopened for the person, with
        the failure code when the keep's set was refused for good."""
        with self._lock:
            waiting = list(self._pending.items())
        if not waiting:
            return
        live = self._live()
        now = time.monotonic()
        for rid, w in waiting:
            c = live.get(rid)
            if c is None:
                with self._lock:
                    how = self._closed_how.get(rid)
                if how is None:
                    if w.absent_since is None:
                        w.absent_since = now
                    elif now - w.absent_since >= _ABSENT_GRACE:
                        w.settle(_closed_outcome())
                elif how == "superseded":
                    w.settle(_closed_outcome())
                else:
                    collection, record = rid[2:].split("/", 1)
                    w.settle(
                        {
                            "ok": True,
                            "kept": how,
                            "version": self._version_of(collection, record),
                        }
                    )
            else:
                w.absent_since = None
                if c["state"] == "open":
                    w.settle({"ok": False, "code": c["error"] or "conflict", "reopened": True})

    # ── announcing ───────────────────────────────────────────────────────────────────────────

    def _announce(self, r: MergeRequest) -> None:
        self._emit({"type": MergeEvent.CONFLICTOPENED, "request": r})
        with self._lock:
            listeners = list(self._listeners)
            first = not listeners and not self._noticed
            if first:
                self._noticed = True
        if not listeners:
            if first and self._notice is not None:
                try:
                    self._notice(r)
                except Exception:  # noqa: BLE001 - the notice is advice
                    pass
            return
        for fn in listeners:
            if r.state != "open" or r.closed:
                break
            self._offer(fn, r)

    def _offer(self, fn: Callable[[MergeRequest], Any], r: MergeRequest) -> None:
        """Hand a request to a listener; a returned choice decides it at once."""
        try:
            answer = fn(r)
        except Exception:  # noqa: BLE001 - a listener's failure is its own
            return
        if not _valid_choice(answer):
            return
        # Decided off this thread: a keep waits for the pump, which may be the thread running us.
        threading.Thread(target=self._decide, args=(r, answer), daemon=True).start()

    def _decide(self, r: MergeRequest, choice: Any) -> None:
        try:
            self.keep_request(r, choice)
        except Exception:  # noqa: BLE001
            pass

    def _emit(self, e: Obj) -> None:
        with self._lock:
            watchers = list(self._watchers)
        for fn in watchers:
            try:
                fn(e)
            except Exception:  # noqa: BLE001 - a listener's failure never reaches the machine
                pass

