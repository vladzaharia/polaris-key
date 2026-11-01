"""The records handle of a Cloud Sync collection (plans/C-26 D-2): ``client.cloud_sync.collection(name)``.

A port of ``packages/client-core/src/sync/collection.ts``. The catalog checks are made before anything is
journalled, so a refused call changes nothing and sends nothing. The refusals are returned, never raised,
and are the registered codes (``errors.json``): ``collection_unknown`` for a name the served catalog does
not declare, ``op_invalid_for_policy`` for a verb the collection's policy does not allow, ``value_invalid``
for a value or name over a cap, and ``signed_out`` while nobody is signed in.

Results are mappings: ``{"ok": True}`` (a compare-and-set also carries ``"mutationId"``) or
``{"ok": False, "error": <code>}``. A listener gets ``{"type": "change", "ids": [...], "origin": ...}`` or
``{"type": "outcome", "outcome": {...}}`` (a compare-and-set ``put`` or ``delete``'s result).
"""

from __future__ import annotations

import re
import threading
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Set, Union

from ..constants_generated import SYNC_KEY_PATTERN, SYNC_MAX_UNION_ELEMENT_BYTES
from ..core.sync_crypto import canonical_json, is_blinded_name
from .host import CloudSyncHost

__all__ = ["SyncCollection"]

Json = Any
Obj = Dict[str, Any]
Result = Dict[str, Any]
Listener = Callable[[Obj], None]
Version = Union[int, str]

#: A merge field name: non-empty, at most 1 KiB (section 13.3).
_MAX_FIELD_BYTES = 1024

_PUT_POLICIES = frozenset(("lastWrite", "max", "min", "revision"))

_KEY = re.compile(SYNC_KEY_PATTERN)


def _spellable(v: Any) -> bool:
    """Whether the SDK's own canonical JSON can spell ``v``: a number or text that cannot be spelled
    identically everywhere is never sealed."""
    try:
        canonical_json(v)
        return True
    except (ValueError, TypeError, RecursionError):
        return False


def _field_ok(n: Any) -> bool:
    """A field name the host can seal: non-empty, at most 1 KiB, no U+0000, no lone surrogate."""
    return isinstance(n, str) and n != "" and "\x00" not in n and _utf8(n) <= _MAX_FIELD_BYTES and _spellable(n)


def _sealable(id: Any, values: Sequence[Any]) -> bool:
    """The record id and every value can be sealed: a refused call journals nothing."""
    return isinstance(id, str) and _KEY.fullmatch(id) is not None and not is_blinded_name(id) and all(
        _spellable(v) for v in values
    )


def _err(code: str) -> Result:
    return {"ok": False, "error": code}


def _utf8(s: str) -> int:
    return len(s.encode("utf-8", "surrogatepass"))


def _version_ok(v: Any) -> bool:
    return v == "*" or (isinstance(v, int) and not isinstance(v, bool))


class SyncCollection:
    """The handle ``client.cloud_sync.collection(name)`` returns. It reads the host's machine at each
    call (the machine is rebuilt when the served catalog changes)."""

    def __init__(self, name: str, host: CloudSyncHost) -> None:
        self.name = name
        self._host = host
        self._listeners: List[Listener] = []
        self._lock = threading.Lock()
        self._unsubscribe: Optional[Callable[[], None]] = None
        self._untap: Optional[Callable[[], None]] = None
        self._tickets: Set[int] = set()

    # ── reads ────────────────────────────────────────────────────────────────────────────────

    @property
    def policy(self) -> Optional[str]:
        """The policy the served catalog declares for this name, or ``None``."""
        d = self._decl()
        return d["policy"] if d is not None else None

    def get(self, id: str) -> Optional[Obj]:
        """The effective value (pending edits over the cloud copy) as ``{"value", "from"}``, or ``None``.
        An undeclared name is ``None``; stored JSON comes back untouched, so an unknown field survives."""
        self._host.catch_up()
        with self._host.locked() as m:
            return m.record(self.name, id) if m.collection_decl(self.name) is not None else None

    def ids(self) -> List[str]:
        """The ids of the records a person holds, in byte order, pending creates included."""
        self._host.catch_up()
        with self._host.locked() as m:
            if m.collection_decl(self.name) is None:
                return []
            # E2E: a record that holds a file and no value is listed under its wire id; it has no name.
            e2e = m.encryption_mode() == "e2e"
            return [i for i in m.record_ids(self.name) if not (e2e and is_blinded_name(i))]

    # ── writes ───────────────────────────────────────────────────────────────────────────────

    def put(self, id: str, value: Json, *, if_version: Optional[Version] = None) -> Result:
        """``lastWrite``, ``max``, ``min``: a stamped write. ``revision``: a write based on the version
        held, or on ``if_version`` (a number, or ``"*"`` to create only) as an exact compare-and-set,
        whose outcome goes to the listener as ``{"type": "outcome"}``."""
        with self._host.locked() as m:
            d = self._check(m, id, lambda p: p in _PUT_POLICIES)
            if "error" in d:
                return d
            if if_version is not None:
                if d["policy"] != "revision":
                    return _err("op_invalid_for_policy")
                if not _version_ok(if_version) or not _sealable(id, [value]):
                    return _err("value_invalid")
                self._host.catch_up()
                r = m.put_at(self.name, id, value, if_version)
                if not r["ok"]:
                    return self._fail(r["error"])
                self._track(r["mutationId"])
            else:
                if not _sealable(id, [value]):
                    return _err("value_invalid")
                self._host.catch_up()
                r = m.put(self.name, id, value)
                if not r["ok"]:
                    return self._fail(r["error"])
        return self._done(r)

    def update(self, id: str, changes: Mapping[str, Any]) -> Result:
        """``merge``: ``changes`` is ``{"set": {field: value}, "remove": [field]}``; write the named fields
        and drop the named ones. Others stay as stored."""
        with self._host.locked() as m:
            d = self._check(m, id, lambda p: p == "merge")
            if "error" in d:
                return d
            sets = changes.get("set") or {}
            removes = list(changes.get("remove") or [])
            if not isinstance(sets, Mapping) or not all(isinstance(f, str) for f in removes):
                return _err("value_invalid")
            names = [*sets.keys(), *removes]
            if (
                not names
                or len(set(names)) != len(names)
                or not all(_field_ok(n) for n in names)
                or not _sealable(id, list(sets.values()))
            ):
                return _err("value_invalid")
            self._host.catch_up()
            r = m.update(self.name, id, {"set": dict(sets), "remove": removes})
            if not r["ok"]:
                return self._fail(r["error"])
        return self._done(r)

    def add(self, id: str, element: Json) -> Result:
        """``union``: add an element (at most 1 KiB of canonical JSON)."""
        return self._element(id, element, True)

    def remove(self, id: str, element: Json) -> Result:
        """``union``: remove an element, observed at the current cursor."""
        return self._element(id, element, False)

    def delete(self, id: str, *, if_version: Optional[Version] = None) -> Result:
        """Delete the record. For ``revision``, ``if_version`` is the compare-and-set base (default: the
        version held, else ``"*"``)."""
        with self._host.locked() as m:
            d = self._check(m, id, lambda _p: True)
            if "error" in d:
                return d
            if not _sealable(id, []):
                return _err("value_invalid")
            self._host.catch_up()
            if d["policy"] == "revision":
                base = if_version
                if base is None:
                    base = next((r["version"] for r in m.records(self.name) if r["id"] == id), "*")
                elif not _version_ok(base):
                    return _err("value_invalid")
                r = m.remove_at(self.name, id, base)
                if not r["ok"]:
                    return self._fail(r["error"])
                self._track(r["mutationId"])
            else:
                if if_version is not None:
                    return _err("op_invalid_for_policy")
                r = m.delete(self.name, id)
                if not r["ok"]:
                    return self._fail(r["error"])
        return self._done(r)

    # ── events ───────────────────────────────────────────────────────────────────────────────

    def on(self, listener: Listener) -> Callable[[], None]:
        """Changes to this collection, including the ones this device makes. Returns the remover."""
        with self._lock:
            self._listeners.append(listener)
            first = self._unsubscribe is None
        if first:
            self._watch()

        def off() -> None:
            with self._lock:
                if listener in self._listeners:
                    self._listeners.remove(listener)
                empty = not self._listeners
            if empty:
                self._unwatch()

        return off

    # ── internals ────────────────────────────────────────────────────────────────────────────

    def _decl(self) -> Optional[Obj]:
        if not self._host.started:
            return None
        with self._host.locked() as m:
            return m.collection_decl(self.name)

    def _check(self, m: Any, id: str, allowed: Callable[[str], bool]) -> Obj:
        d = m.collection_decl(self.name)
        if d is None:
            return _err("collection_unknown")
        if not m.signed_in():
            return _err("signed_out")
        if not allowed(d["policy"]):
            return _err("op_invalid_for_policy")
        return d

    def _element(self, id: str, element: Json, adding: bool) -> Result:
        with self._host.locked() as m:
            d = self._check(m, id, lambda p: p == "union")
            if "error" in d:
                return d
            if not _sealable(id, [element]):
                return _err("value_invalid")
            try:
                spelled = canonical_json(element)
            except (ValueError, TypeError):
                return _err("value_invalid")
            if _utf8(spelled) > SYNC_MAX_UNION_ELEMENT_BYTES:
                return _err("value_invalid")
            self._host.catch_up()
            r = m.add(self.name, id, element) if adding else m.remove(self.name, id, element)
            if not r["ok"]:
                return self._fail(r["error"])
        return self._done(r)

    def _done(self, r: Mapping[str, Any]) -> Result:
        # The machine queued the edit; one pump reports its events (nothing is due before the debounce,
        # so this does not wait on the network).
        self._host.touch()
        out: Result = {"ok": True}
        if "mutationId" in r:
            out["mutationId"] = r["mutationId"]
        return out

    @staticmethod
    def _fail(error: str) -> Result:
        if error == "signed-out":
            return _err("signed_out")
        return _err("collection_unknown")

    def _track(self, ticket: int) -> None:
        """Outcomes are reported to a listener, so a ticket is kept only while one is registered. Called
        under the host lock: the outcome cannot arrive before the ticket is held."""
        with self._lock:
            if self._listeners:
                self._tickets.add(ticket)

    def _watch(self) -> None:
        host = self._host
        host.watch_records(self.name, True)
        self._unsubscribe = host.on_events(self._on_events)
        self._untap = host.tap_outcomes(self._on_outcome)

    def _unwatch(self) -> None:
        unsubscribe, untap = self._unsubscribe, self._untap
        self._unsubscribe = self._untap = None
        if unsubscribe is not None:
            unsubscribe()
            if untap is not None:
                untap()
            self._host.watch_records(self.name, False)
        with self._lock:
            self._tickets.clear()

    def _on_events(self, events: List[Obj]) -> None:
        for e in events:
            if e.get("type") == "records" and e.get("collection") == self.name:
                self._emit({"type": "change", "ids": list(e["ids"]), "origin": e["origin"]})

    def _on_outcome(self, o: Obj) -> None:
        with self._lock:
            if o.get("mutationId") not in self._tickets:
                return
            self._tickets.discard(o["mutationId"])
        self._emit({"type": "outcome", "outcome": o})

    def _emit(self, e: Obj) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for fn in listeners:
            try:
                fn(e)
            except Exception:  # noqa: BLE001 - a listener's failure never reaches the machine
                pass
