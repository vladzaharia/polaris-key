"""The Cloud Sync reference client state machine, ported from client-core's ``cloud-sync.ts``
(plans/U-01.md §2.3, §2.4, §4.1 as amended by plans/U-01b.md §2.5; S-17 §5.4-§5.6; WIRE-CONTRACT-V5 §11.5).

Client behaviour, outside the wire contract: the journal reducer, the hybrid logical clock, the
per-key debounce, conflict rebase, the per-subject partitions, the first-sign-in move, the setting
routes (synced, local, locked, refused and open), the one-time import of the legacy ``config.local``
store, the paused state and the parked rejections. ``sync-scenarios.json`` pins it scenario by scenario.

The machine does no I/O and imports no catalog: the host derives the setting routes with
:func:`polaris_key.cloud_sync.routes.synced_settings` and passes them in. It owns a fake-able clock
(:meth:`advance`), queues the requests it would send (:meth:`take_requests`) and the events it would
emit (:meth:`take_events`), and is told what the transport answered (:meth:`receive`). At most one
request is in flight. Retry backoff and the live poke are host concerns and are not modelled.

End-to-end mode: the machine stays plaintext. The host codec seals and blinds on the way out and
opens on the way in. What the machine owns is the policy around that boundary: ``locked`` (no root
for the ring), the pin (never talk past a Worker that does not advertise ``e2e``), and
``encryptionSince`` (per partition, only ever lowered, held at or below the lowest sealed version).

Everything is plain JSON data (dicts and lists), so the journal and the persisted state are what
the corpus compares. Nothing here touches licence state.
"""

from __future__ import annotations

import copy
import math
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..constants_generated import (
    SYNC_CLIENT_ID_PATTERN,
    SYNC_DEBOUNCE_MS,
    SYNC_HLC_PATTERN,
    SYNC_IMPORT_HLC,
    SYNC_MAX_CLOCK_SKEW_MS,
    SYNC_MAX_MUTATIONS,
    SYNC_MAX_VALUE_BYTES,
    SYNC_PENDING_DAYS,
    SYNC_SIGNOUT_FLUSH_MS,
    ErrorCode,
)

#: The client code for the pin (``conformance/parity/errors.json``).
SYNC_ENCRYPTION_PINNED: str = ErrorCode.SYNC_ENCRYPTION_PINNED

_HLC_RE = re.compile(SYNC_HLC_PATTERN)
_CLIENT_ID_RE = re.compile(SYNC_CLIENT_ID_PATTERN)

#: The partition of a device nobody has signed in on.
LOCAL_PARTITION = "local"

_DAY_MS = 86_400_000

#: The most keys a partition's "ever sealed" latch holds (E2E); the oldest go first.
SEALED_LATCH_MAX = 4096

Json = Any
Obj = Dict[str, Any]
CallResult = Dict[str, Any]


def _OK() -> CallResult:
    return {"ok": True}


class _Absent:
    """The type of ``_ABSENT``."""

    __slots__ = ()

    def __deepcopy__(self, memo: Any) -> "_Absent":
        return self

    def __copy__(self) -> "_Absent":
        return self

    def __repr__(self) -> str:
        return "<absent>"


#: "No value": the TypeScript ``undefined``. A JSON ``null`` (``None``) is a real value.
_ABSENT: Any = _Absent()


def _fail(error: str) -> CallResult:
    return {"ok": False, "error": error}


# ── helpers ───────────────────────────────────────────────────────────────────────────────────


def _clone(v: Any) -> Any:
    return copy.deepcopy(v)


def _is_object(v: Any) -> bool:
    return isinstance(v, dict)


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_integer(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    return isinstance(v, int) or (isinstance(v, float) and math.isfinite(v) and v == int(v))


def _byte_order(s: str) -> bytes:
    """Sort key matching the TypeScript ``a < b`` on strings (UTF-16 code units)."""
    return s.encode("utf-16-be", "surrogatepass")


def _sorted(keys: Any) -> List[str]:
    return sorted(keys, key=_byte_order)


def json_equal(a: Any, b: Any) -> bool:
    """Structural equality over JSON values (object member order ignored; a boolean is not a number)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, list) or isinstance(b, list):
        return isinstance(a, list) and isinstance(b, list) and len(a) == len(b) and all(
            json_equal(x, y) for x, y in zip(a, b)
        )
    if isinstance(a, dict) and isinstance(b, dict):
        return len(a) == len(b) and all(k in b and json_equal(a[k], b[k]) for k in a)
    if _is_number(a) and _is_number(b):
        return bool(a == b)
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return False
    return a is b or (type(a) is type(b) and a == b)


def _canonical_json(v: Any) -> str:
    """Canonical JSON: object members in byte order, no whitespace."""
    if isinstance(v, list):
        return "[" + ",".join(_canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(f"{_dumps(k)}:{_canonical_json(v[k])}" for k in _sorted(v)) + "}"
    return _dumps(v)


def _dumps(v: Any) -> str:
    import json

    if isinstance(v, float) and math.isfinite(v) and v == int(v) and abs(v) < 1e21:
        v = int(v)
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def json_bytes(v: Any) -> int:
    """The UTF-8 length of a value's canonical JSON (the 8 KiB setting bound)."""
    return len(_canonical_json(v).encode("utf-8", "surrogatepass"))


def format_hlc(physical_ms: int, counter: int) -> str:
    if isinstance(physical_ms, bool) or not isinstance(physical_ms, int) or not 0 <= physical_ms <= 0xFFFFFFFFFFFF:
        raise ValueError(f"HLC physical part out of range: {physical_ms}")
    if isinstance(counter, bool) or not isinstance(counter, int) or counter < 0 or counter > 0xFFFF:
        raise ValueError(f"HLC counter out of range: {counter}")
    return f"{physical_ms:012x}:{counter:04x}"


def parse_hlc(hlc: str) -> Tuple[int, int]:
    if not isinstance(hlc, str) or not _HLC_RE.search(hlc):
        raise ValueError(f"not an HLC: {hlc}")
    return int(hlc[:12], 16), int(hlc[13:], 16)


def value_valid(value: Any, schema: Optional[Obj]) -> bool:
    """Whether ``value`` satisfies the schema subset (absent schema: anything)."""
    if not schema:
        return True
    t = schema.get("type")
    if t in ("number", "integer"):
        if not _is_number(value) or not math.isfinite(value):
            return False
        if t == "integer" and not _is_integer(value):
            return False
        if schema.get("minimum") is not None and value < schema["minimum"]:
            return False
        if schema.get("maximum") is not None and value > schema["maximum"]:
            return False
    elif t == "string":
        if not isinstance(value, str):
            return False
    elif t == "boolean":
        if not isinstance(value, bool):
            return False
    elif t == "object":
        if not _is_object(value):
            return False
    enum = schema.get("enum")
    return enum is None or any(json_equal(e, value) for e in enum)


def apply_setting_op(policy: str, base: Any, op: Obj) -> Any:
    """One setting operation applied to a value under the key's policy. ``_ABSENT`` is "no value";
    a JSON ``null`` (``None``) is a value."""
    name = op["op"]
    if name == "clear":
        return _ABSENT
    if name == "set":
        v = op.get("value")
        if policy in ("max", "min") and _is_number(base) and _is_number(v):
            return max(base, v) if policy == "max" else min(base, v)
        return _clone(v)
    if name == "setMember":
        o = dict(base) if _is_object(base) else {}
        o[op["member"]] = _clone(op.get("value"))
        return o
    if name == "removeMember":
        o = dict(base) if _is_object(base) else {}
        o.pop(op["member"], None)
        return o
    return base


def _apply_record_op(base: Any, op: Obj) -> Any:
    name = op["op"]
    if name == "set":
        return _clone(op.get("value"))
    if name in ("setMember", "removeMember"):
        return apply_setting_op("merge", base, op)
    if name == "add":
        arr = list(base) if isinstance(base, list) else []
        if not any(json_equal(x, op.get("element")) for x in arr):
            arr.append(_clone(op.get("element")))
        return arr
    if name == "remove":
        return [x for x in (base if isinstance(base, list) else []) if not json_equal(x, op.get("element"))]
    return base


def _record_key(c: str, i: str) -> str:
    return f"{c}/{i}"


def _decidable(b: Obj) -> bool:
    """A conflict copy the client may compare: opened sealed (not unreadable, not plaintext)."""
    return b.get("bad") is not True and "plain" not in b


def _new_partition(client_id: Optional[str]) -> Obj:
    return {
        "clientId": client_id,
        "nextMutationId": 1,
        "cursor": 0,
        "pending": [],
        "held": {},
        "settings": {},
        "records": {},
        "device": {},
        "signedOutAt": None,
        "headroom": None,
    }


_JOURNAL_ONLY = ("preContact", "moved", "parked")


def wire_of(op: Obj) -> Obj:
    """The wire form of a journalled mutation (journal-only marks stripped)."""
    return _clone({k: v for k, v in op.items() if k not in _JOURNAL_ONLY})


#: The rejection codes that park a setting edit instead of reverting it (R5).
_PARKING = {"quota_exceeded": "quota", "entitlement_required": "entitlement"}


def _error_code(body: Any) -> Any:
    return body["error"].get("code") if _is_object(body) and _is_object(body.get("error")) else None


def _same_value(a: Obj, b: Obj) -> bool:
    """Whether two setting operations write the same value: the same key, and the same member
    unless one of them writes the whole value."""
    if "setting" not in a["target"] or "setting" not in b["target"]:
        return False
    if a["target"]["setting"] != b["target"]["setting"]:
        return False

    def whole(o: Obj) -> bool:
        return o["op"] in ("set", "clear")

    return whole(a) or whole(b) or a.get("member") == b.get("member")


def _js_string(r: Obj, name: str) -> str:
    if name not in r:
        return "undefined"
    v = r[name]
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _without(items: List[Obj], drop: Obj) -> List[Obj]:
    return [o for o in items if o is not drop]


# ── the machine ───────────────────────────────────────────────────────────────────────────────


class CloudSyncMachine:
    """The Cloud Sync client state machine. ``opts`` keys mirror the TypeScript ``CloudSyncOptions``:
    ``product``, ``catalog`` (``{settings, collections?}``), ``document`` (``{values, locked?}``), ``now``,
    ``offsetMs``, ``contacted``, ``subject``, ``network``, ``onSignOut``, ``deviceLocal``, ``imported``,
    ``newClientId`` (a callable), ``encryption``, ``hasRoot`` and ``discovery``."""

    def __init__(self, opts: Obj, persisted: Optional[Obj] = None) -> None:
        self._product: str = opts["product"]
        self._catalog: Obj = opts["catalog"]
        self._document: Obj = opts["document"]
        self._on_sign_out: str = opts.get("onSignOut") or "clear"
        self._new_client_id: Callable[[], str] = opts["newClientId"]
        enc = opts.get("encryption")
        self._app_encryption: str = "e2e" if enc is None else enc
        self._root: bool = bool(opts.get("hasRoot", False))
        # What the Worker advertised this session: "e2e", "server", "omitted" or None (not yet known).
        self._advertised: Optional[str] = None
        self._now: int = opts["now"]
        self._network: str = opts.get("network") or "online"
        self._drafts: Dict[str, Obj] = {}
        self._in_flight: Optional[Obj] = None
        self._signing_out: Optional[Obj] = None
        self._need_snapshot = False
        self._pull_wanted = False
        self._paused = False
        self._outbox: List[Obj] = []
        self._events: List[Obj] = []
        if persisted is not None:
            self._s: Obj = _clone(persisted)
        else:
            self._s = {
                "subject": opts.get("subject"),
                "partitions": {LOCAL_PARTITION: _new_partition(None)},
                "hlc": [0, 0],
                "offsetMs": opts.get("offsetMs") or 0,
                "contacted": bool(opts.get("contacted", False)),
                "aliases": {},
                "blocked": None,
                "deviceLocal": _clone(opts.get("deviceLocal") or {}),
                "imported": bool(opts.get("imported", False)),
            }
        self._s["partitions"].setdefault(LOCAL_PARTITION, _new_partition(None))
        self._s.setdefault("e2eSeen", False)
        discovery = opts.get("discovery")
        if discovery:
            self._advertised = discovery.get("encryption") or "omitted"
        if self._s["subject"] is not None:
            self._partition_for(self._s["subject"])
        self._expire_partitions()
        self._pull_wanted = True
        self._kick()

    # ── host surface ──────────────────────────────────────────────────────────────────────────

    @property
    def now(self) -> int:
        return self._now

    @property
    def network_state(self) -> str:
        return self._network

    def persist(self) -> Obj:
        """What survives a relaunch (the drafts are committed first, as the exit flush does)."""
        self._commit_all_drafts()
        return _clone(self._s)

    def take_requests(self) -> List[Obj]:
        out, self._outbox = self._outbox, []
        return out

    def take_events(self) -> List[Obj]:
        out, self._events = self._events, []
        return out

    # ── SDK calls ─────────────────────────────────────────────────────────────────────────────

    def set(self, key: str, value: Json) -> CallResult:
        """``config.set`` while Cloud Sync is on."""
        return self._edit(key, {"value": _clone(value)})

    def clear(self, key: str) -> CallResult:
        """``config.clear`` while Cloud Sync is on."""
        return self._edit(key, {"clear": True})

    def import_local(self, values: Obj) -> CallResult:
        """Once per install, with the legacy ``config.local`` contents. Synced and undeclared keys
        enter at the HLC floor, so a newer cloud value always wins; ``local`` keys stay on the device;
        locked, refused, invalid and over-size values are not imported. A second call does nothing."""
        if self._s["imported"]:
            return _OK()
        self._s["imported"] = True
        before = self._value_map()
        local = self._s["partitions"][LOCAL_PARTITION]
        for key in _sorted(values):
            value = values[key]
            r = self._route(key)
            if r is not None and r["route"] in ("locked", "refused"):
                continue
            if r is not None and r["route"] == "synced" and not value_valid(value, r.get("schema")):
                continue
            if json_bytes(value) > SYNC_MAX_VALUE_BYTES:
                continue
            if r is not None and r["route"] == "local":
                if key not in self._s["deviceLocal"]:
                    self._s["deviceLocal"][key] = _clone(value)
                continue
            if self._s["subject"] is None:
                if key not in local["device"]:
                    local["device"][key] = {"value": _clone(value), "editedHlc": SYNC_IMPORT_HLC}
                continue
            self._enqueue_setting(self._active(), key, value, SYNC_IMPORT_HLC, {"moved": True})
        self._emit_changes(before, {}, "local")
        self._kick()
        return _OK()

    def flush(self) -> CallResult:
        """Commit every debounced edit now and push."""
        self._commit_all_drafts()
        self._kick()
        return _OK()

    def refresh(self) -> CallResult:
        """A licence or config document fetch succeeded: the only thing that lifts a ``/sync`` 401 or
        a non-``account_required`` 403."""
        if self._s["blocked"] in ("unauthorized", "attestation", "forbidden"):
            self._s["blocked"] = None
            self._kick()
        return _OK()

    def encryption_mode(self) -> str:
        """The effective mode: E2E when the app requires it or this device has ever accepted E2E."""
        return "e2e" if self._requires_e2e() else "server"

    def encryption_since(self) -> Optional[int]:
        """``encryptionSince`` of the active partition's last E2E pull, or ``None``."""
        if self._s["subject"] is None:
            return None
        return self._active().get("encryptionSince")

    def set_root(self, present: bool) -> None:
        """The ring's root arrived (unlock) or went away (lock). Unlocking sends the held operations
        in ``mutationId`` order; locking sends and reads nothing more."""
        if self._root == present:
            return
        self._root = present
        self._gate_changed()

    def set_discovery(self, discovery: Optional[Obj]) -> None:
        """What discovery says about ``services.sync.encryption``. A Worker that omits the member is
        ``omitted``, the same refusal as ``server`` for an app that requires E2E. ``None`` forgets it."""
        before = self._advertised
        self._advertised = None if discovery is None else (discovery.get("encryption") or "omitted")
        if self._advertised == "e2e" and self._requires_e2e():
            self._s["e2eSeen"] = True
        if before != self._advertised:
            self._gate_changed()

    def put(self, collection: str, record_id: str, value: Json) -> CallResult:
        """Write a record: compare-and-swap for ``revision``, a stamped ``set`` for ``lastWrite``,
        ``max`` and ``min``, member operations for ``merge``."""
        decl = self._collection(collection)
        if decl is None or decl["policy"] == "union":
            return _fail("collection-unknown")
        if self._s["subject"] is None:
            return _fail("signed-out")
        p = self._active()
        rk = _record_key(collection, record_id)
        target = {"record": [collection, record_id]}

        def is_record(o: Obj) -> bool:
            return "record" in o["target"] and _record_key(*o["target"]["record"]) == rk

        if decl["policy"] == "revision":
            if self._in_flight_touches(rk):
                p["held"][rk] = _clone(value)
            else:
                queued = next((o for o in p["pending"] if is_record(o)), None)
                if queued is not None:
                    queued["value"] = _clone(value)
                else:
                    row = p["records"].get(rk)
                    self._enqueue(
                        p,
                        {
                            "target": target,
                            "op": "set",
                            "value": _clone(value),
                            "baseVersion": row["version"] if row is not None else "*",
                        },
                    )
        else:
            edited = self._tick_hlc()
            marks: Obj = {} if self._s["contacted"] else {"preContact": True}
            if decl["policy"] == "merge":
                rec = self._record(collection, record_id)
                current = rec["value"] if rec is not None else None
                cur: Obj = current if isinstance(current, dict) else {}
                nxt: Obj = value if isinstance(value, dict) else {}
                for member in _sorted(nxt):
                    if member not in cur or not json_equal(cur[member], nxt[member]):
                        self._enqueue(
                            p,
                            {
                                "target": target,
                                "op": "setMember",
                                "member": member,
                                "value": _clone(nxt[member]),
                                "editedHlc": edited,
                                **marks,
                            },
                        )
                for member in _sorted(cur):
                    if member not in nxt:
                        self._enqueue(
                            p,
                            {"target": target, "op": "removeMember", "member": member, "editedHlc": edited, **marks},
                        )
            else:
                queued = (
                    None
                    if self._in_flight_touches(rk)
                    else next((o for o in p["pending"] if is_record(o) and o["op"] == "set"), None)
                )
                if queued is not None:
                    queued["value"] = _clone(value)
                    queued["editedHlc"] = edited
                else:
                    self._enqueue(
                        p, {"target": target, "op": "set", "value": _clone(value), "editedHlc": edited, **marks}
                    )
        self._kick()
        return _OK()

    def add(self, collection: str, record_id: str, element: Json) -> CallResult:
        """Add to a ``union`` record (an OR-set)."""
        return self._union_op(collection, record_id, element, "add")

    def remove(self, collection: str, record_id: str, element: Json) -> CallResult:
        """Remove from a ``union`` record, observed at the current cursor."""
        return self._union_op(collection, record_id, element, "remove")

    def sign_in(self, subject: str) -> CallResult:
        if self._s["subject"] == subject:
            return _OK()
        if self._s["subject"] is not None:
            self._leave("signOut", False)
        self._commit_all_drafts()
        before = self._value_map()
        self._s["blocked"] = None
        self._signing_out = None
        self._expire_partitions()
        p = self._partition_for(subject)
        p["signedOutAt"] = None
        local = self._s["partitions"][LOCAL_PARTITION]
        moving = _sorted(k for k in local["device"] if self._syncs(k))
        # A sign-in change re-sends every parked edit (R5), except one a moved local edit replaces.
        for key in moving:
            self._drop_parked_by_local_edit(p, key)
        self._unpark(p, lambda _reason: True)
        for key in moving:
            d = local["device"][key]
            marks: Obj = {"moved": True}
            if d.get("preContact"):
                marks["preContact"] = True
            if d.get("cleared"):
                self._enqueue(
                    p, {"target": self._target_of(key), "op": "clear", "editedHlc": d["editedHlc"], **marks}
                )
            else:
                self._enqueue_setting(p, key, d.get("value"), d["editedHlc"], marks)
            del local["device"][key]
        self._s["subject"] = subject
        self._pull_wanted = True
        self._need_snapshot = False
        self._emit_changes(before, {}, "remote")
        self._kick()
        return _OK()

    def sign_out(self, discard_unsynced: bool = False) -> CallResult:
        if self._s["subject"] is None:
            return _OK()
        self._commit_all_drafts()
        discard = bool(discard_unsynced)
        p = self._active()
        if (
            not discard
            and self._network == "online"
            and self._s["blocked"] is None
            and self._may_talk()
            and self._sendable(p) > 0
        ):
            self._signing_out = {"deadline": self._now + SYNC_SIGNOUT_FLUSH_MS, "discard": discard}
            self._kick()
        else:
            self._leave("signOut", discard)
        return _OK()

    def set_network(self, state: str) -> None:
        if state == "offline" and self._in_flight is not None:
            raise RuntimeError("network: a request is in flight; respond first")
        self._network = state
        if state == "online":
            self._pull_wanted = True
            self._kick()

    def advance(self, ms: int) -> None:
        """Move the clock, firing debounce commits and the sign-out flush deadline in time order."""
        target = self._now + ms
        while True:
            nxt: Optional[int] = None
            for d in self._drafts.values():
                if d["due"] <= target and (nxt is None or d["due"] < nxt):
                    nxt = d["due"]
            so = self._signing_out
            if so is not None and so["deadline"] <= target and (nxt is None or so["deadline"] < nxt):
                nxt = so["deadline"]
            if nxt is None:
                break
            self._now = nxt
            if so is not None and so["deadline"] == nxt:
                self._in_flight = None
                self._leave("signOut", so["discard"])
                continue
            due = _sorted(k for k, d in self._drafts.items() if d["due"] == nxt)
            for k in due:
                self._commit_draft(k)
            self._kick()
        self._now = target

    def receive(self, res: Obj, opened: Optional[Obj] = None) -> None:
        """The transport's answer to the request in flight: ``{status, body?}`` or ``{error: "transport"}``."""
        req = self._in_flight
        if req is None:
            raise RuntimeError("respond: no request is in flight")
        self._in_flight = None
        proceed = False
        body = res.get("body")
        if "error" in res:
            pass  # request-level failure: nothing was processed and the journal is unchanged (rule 1)
        else:
            status = res["status"]
            if status == 503 and req["kind"] == "push" and _error_code(body) == "writes_paused":
                # R4: the operator paused writes; the journal is unchanged and the next trigger retries.
                self._paused = True
            elif status >= 500 or status in (400, 413, 429):
                pass  # request-level failure, as above
            elif status == 401:
                self._s["blocked"] = "unauthorized"
            elif status == 403:
                err: Obj = body["error"] if isinstance(body, dict) and isinstance(body.get("error"), dict) else {}
                if err.get("code") == "account_required":
                    url = err.get("signInUrl")
                    self._leave("accountRequired", False)
                    self._s["blocked"] = "account_required"
                    self._events.append(
                        {"type": "signInOffered", "signInUrl": url if isinstance(url, str) else None}
                    )
                    return
                # The journal is kept; a document refresh lifts either block.
                self._s["blocked"] = "attestation" if err.get("code") == "attestation_required" else "forbidden"
            elif status == 409:
                self._client_mismatch(req)
                proceed = True
            elif status == 410:
                p = self._s["partitions"].get(req["partition"])
                if p is not None:
                    p["cursor"] = 0
                self._need_snapshot = True
                proceed = True
            elif status == 200 and isinstance(body, dict):
                if self._accept_mode(body):
                    if req["kind"] == "push":
                        self._paused = False
                    self._ok(req, body, opened or {})
                    proceed = True
                # Otherwise the pin refused it: the body is dropped unread and the journal is unchanged.
        if self._signing_out is not None and self._s["subject"] is not None:
            p = self._active()
            if not proceed or self._sendable(p) == 0:
                self._leave("signOut", self._signing_out["discard"])
                return
        if proceed:
            self._kick()

    # ── reads ─────────────────────────────────────────────────────────────────────────────────

    def get(self, key: str) -> Obj:
        doc_value = self._document["values"].get(key)
        doc = {"value": _clone(doc_value), "from": "document"}
        r = self._route(key)
        # A lock beats the person's own choice, the ``local`` slot included.
        if self._locked(key) or (r is not None and r["route"] in ("locked", "refused")):
            return doc
        if r is not None and r["route"] == "local":
            dl = self._s["deviceLocal"]
            return {"value": _clone(dl[key]), "from": "device"} if key in dl else doc
        layer = self._layer(key)
        if layer is None or layer["value"] is _ABSENT:
            return doc
        if not value_valid(layer["value"], self._schema_of(key)):
            return doc
        return {"value": _clone(layer["value"]), "from": layer["from"]}

    def setting_state(self, key: str) -> Obj:
        r = self._route(key)
        layer = self._layer(key) if self._syncs(key) else None
        if self._s["subject"] is None or (r is not None and r["route"] == "local"):
            sync = "local"
        elif layer is not None and layer["pending"]:
            sync = "pending"
        else:
            sync = "synced"
        invalid = (
            layer is not None
            and layer["value"] is not _ABSENT
            and not value_valid(layer["value"], self._schema_of(key))
        ) or (
            self._syncs(key)
            and self._snapshot_unreadable(self._alias(key))
            and not (layer is not None and layer["pending"])
        )
        return {
            "sync": sync,
            "invalid": bool(invalid),
            "locked": bool(self._locked(key) or (r is not None and r["route"] == "locked")),
        }

    def record(self, collection: str, record_id: str) -> Optional[Obj]:
        return self._record(collection, record_id)

    def _record(self, collection: str, record_id: str) -> Optional[Obj]:
        if self._s["subject"] is None:
            return None
        p = self._active()
        rk = _record_key(collection, record_id)
        row = p["records"].get(rk)
        value = row["value"] if row is not None and not self._row_unreadable(row) else _ABSENT
        pending = False
        for op in p["pending"]:
            if "record" in op["target"] and _record_key(*op["target"]["record"]) == rk:
                value = _apply_record_op(value, op)
                pending = True
        if rk in p["held"]:
            value = _clone(p["held"][rk])
            pending = True
        if value is _ABSENT:
            return None
        return {"value": _clone(value), "from": "pending" if pending else "cloud"}

    def status(self) -> Obj:
        pending = self._pending_count()
        if self._pinned_out():
            return {"state": "unsupported", "pending": pending, "reason": "encryption", "code": SYNC_ENCRYPTION_PINNED}
        if self._s["blocked"]:
            return {"state": "blocked", "pending": pending, "reason": self._s["blocked"]}
        if self._s["subject"] is None:
            return {"state": "local", "pending": pending}
        if self._locked_out():
            return {"state": "locked", "pending": pending, "reason": "keyring"}
        parked = self._parked_reason()

        def at(state: str) -> Obj:
            if parked:
                return {"state": state, "pending": pending, "reason": parked}
            return {"state": state, "pending": pending}

        if self._network == "offline":
            return at("offline")
        if self._in_flight is not None:
            return at("syncing")
        if self._paused:
            return at("paused")
        return at("pending" if pending > 0 else "idle")

    def journal(self) -> Obj:
        """The journal, normalised: what every SDK's journal must hold, whatever its encoding."""
        out: Obj = {}
        for name in _sorted(self._s["partitions"]):
            p = self._s["partitions"][name]
            if name == LOCAL_PARTITION:
                if p["device"]:
                    out[name] = {"settings": _clone(p["device"])}
                continue
            view: Obj = {
                "clientId": p["clientId"],
                "nextMutationId": p["nextMutationId"],
                "cursor": p["cursor"],
                "pending": _clone(p["pending"]),
            }
            if p["held"]:
                view["held"] = _clone(p["held"])
            out[name] = view
        return out

    # ── internals ─────────────────────────────────────────────────────────────────────────────

    def _requires_e2e(self) -> bool:
        """The app requires E2E, or this device has accepted it before: the pin cannot be undone."""
        return self._app_encryption == "e2e" or self._s.get("e2eSeen") is True

    def _pinned_out(self) -> bool:
        """The Worker's answer contradicts the mode: nothing is sent to it and nothing it says is read."""
        if self._advertised is None:
            return False
        if self._requires_e2e():
            return self._advertised != "e2e"
        return self._advertised == "e2e"

    def _locked_out(self) -> bool:
        """E2E with no root for the ring."""
        return self._requires_e2e() and not self._root

    def _may_talk(self) -> bool:
        return not self._pinned_out() and not self._locked_out()

    def _row_unreadable(self, row: Obj) -> bool:
        if row.get("bad") is True or self._locked_out():
            return True
        if "plain" not in row or not self._requires_e2e():
            return False
        since = None if self._s["subject"] is None else self._active().get("encryptionSince")
        return not (since is not None and row["plain"] < since)

    def _snapshot_unreadable(self, server_key: str) -> bool:
        if self._s["subject"] is None:
            return False
        row = self._active()["settings"].get(server_key)
        return row is not None and self._row_unreadable(row)

    def _gate_changed(self) -> None:
        """A lock, an unlock or a discovery answer changed what may be sent."""
        if self._signing_out is not None and self._s["subject"] is not None and not self._may_talk():
            self._leave("signOut", self._signing_out["discard"])
            return
        self._kick()

    def _accept_mode(self, body: Obj) -> bool:
        """The pin on a 200 body: in E2E mode the body must say ``encryption: "e2e"``; an app in server
        mode refuses an ``e2e`` body too, since it cannot open it."""
        enc = body.get("encryption")
        said = enc if enc in ("e2e", "server") else "omitted"
        if not self._requires_e2e() and said != "e2e":
            return not self._pinned_out()
        self._advertised = said
        if self._pinned_out():
            return False
        if said == "e2e":
            self._s["e2eSeen"] = True
        return True

    def _route(self, key: str) -> Optional[Obj]:
        settings = self._catalog["settings"]
        found = next((d for d in settings if d["key"] == key), None)
        if found is not None:
            return found
        a = self._alias(key)
        return next((d for d in settings if d["key"] == a), None)

    def _syncs(self, key: str) -> bool:
        r = self._route(key)
        return r is None or r["route"] == "synced"

    def _policy_of(self, key: str) -> str:
        r = self._route(key)
        return r["policy"] if r is not None and r["route"] == "synced" else "lastWrite"

    def _schema_of(self, key: str) -> Optional[Obj]:
        r = self._route(key)
        return r.get("schema") if r is not None and r["route"] == "synced" else None

    def _target_of(self, key: str) -> Obj:
        r = self._route(key)
        return {"setting": key, "scope": r["scope"] if r is not None and r["route"] == "synced" else "user"}

    def _collection(self, name: str) -> Optional[Obj]:
        return next((c for c in self._catalog.get("collections") or [] if c["name"] == name), None)

    def _alias(self, key: str) -> str:
        return self._s["aliases"].get(key, key)

    def _locked(self, key: str) -> bool:
        return key in (self._document.get("locked") or [])

    def _active(self) -> Obj:
        subject = self._s["subject"]
        return self._partition_for(LOCAL_PARTITION if subject is None else subject)

    def _partition_for(self, name: str) -> Obj:
        p = self._s["partitions"].get(name)
        if p is None:
            p = _new_partition(None if name == LOCAL_PARTITION else self._fresh_client_id())
            self._s["partitions"][name] = p
        return p

    def _fresh_client_id(self) -> str:
        cid = self._new_client_id()
        if not _CLIENT_ID_RE.search(cid):
            raise ValueError(f"bad clientId: {cid}")
        return cid

    def _pending_count(self) -> int:
        drafts = len(self._drafts)
        if self._s["subject"] is None:
            return drafts
        p = self._active()
        return drafts + len(p["pending"]) + len(p["held"])

    def _sendable(self, p: Obj) -> int:
        """What a push can still carry: every journalled operation that is not parked, plus held."""
        return len([o for o in p["pending"] if not o.get("parked")]) + len(p["held"])

    def _parked_reason(self) -> Optional[str]:
        if self._s["subject"] is None:
            return None
        kinds = {o.get("parked") for o in self._active()["pending"]}
        if "quota" in kinds:
            return "quota"
        if "entitlement" in kinds:
            return "entitlement"
        return None

    def _tick_hlc(self) -> str:
        physical = self._now + self._s["offsetMs"]
        hlc = self._s["hlc"]
        if physical > hlc[0]:
            self._s["hlc"] = [physical, 0]
        else:
            self._s["hlc"] = [hlc[0], hlc[1] + 1]
        return format_hlc(self._s["hlc"][0], self._s["hlc"][1])

    def _layer(self, key: str) -> Optional[Obj]:
        if not self._syncs(key):
            return None
        policy = self._policy_of(key)
        target = self._alias(key)

        def matches(k: str) -> bool:
            return self._alias(k) == target

        value: Any = _ABSENT
        has = False
        pending = False
        p = self._active()
        if self._s["subject"] is not None:
            snap = p["settings"].get(target)
            if snap is not None and not self._row_unreadable(snap):
                value = _clone(snap["value"])
                has = True
            for op in p["pending"]:
                if "setting" in op["target"] and matches(op["target"]["setting"]):
                    value = apply_setting_op(policy, value, op)
                    pending = True
        else:
            for k in p["device"]:
                if matches(k):
                    d = p["device"][k]
                    value = _ABSENT if d.get("cleared") else _clone(d.get("value"))
                    has = True
        for k, d in self._drafts.items():
            if matches(k):
                if d.get("clear"):
                    value = _ABSENT
                elif policy == "merge":
                    value = _clone(d.get("value"))
                else:
                    value = apply_setting_op(policy, value, {"op": "set", "value": d.get("value")})
                pending = True
        if not has and not pending:
            return None
        if pending:
            origin = "pending"
        else:
            origin = "cloud" if self._s["subject"] is not None else "device"
        return {"value": value, "from": origin, "pending": pending}

    def _open_keys(self) -> List[str]:
        keys: Dict[str, None] = {}

        def add(k: str) -> None:
            if self._route(k) is None:
                keys[k] = None

        if self._s["subject"] is not None:
            p = self._active()
            for k in p["settings"]:
                add(k)
            for op in p["pending"]:
                if "setting" in op["target"]:
                    add(op["target"]["setting"])
        else:
            for k in self._s["partitions"][LOCAL_PARTITION]["device"]:
                add(k)
        for k in self._drafts:
            add(k)
        return list(keys)

    def _value_map(self) -> Dict[str, Any]:
        m: Dict[str, Any] = {}
        for r in self._catalog["settings"]:
            if r["route"] in ("synced", "local"):
                m[r["key"]] = self.get(r["key"])["value"]
        for k in self._open_keys():
            m[k] = self.get(k)["value"]
        return m

    def _emit_changes(self, before: Dict[str, Any], overrides: Dict[str, str], origin: str) -> None:
        after = self._value_map()
        groups: Dict[str, List[str]] = {}
        for k in list(dict.fromkeys([*before.keys(), *after.keys()])):
            # A key known on one side only read as the document's value on the other.
            was = before[k] if k in before else self._document["values"].get(k)
            is_ = after[k] if k in after else self.get(k)["value"]
            if json_equal(was, is_):
                continue
            o = overrides.get(k, origin)
            groups.setdefault(o, []).append(k)
        for o in ("local", "remote", "merge", "migration"):
            keys = groups.get(o)
            if keys:
                self._events.append({"type": "change", "keys": _sorted(keys), "origin": o})

    def _edit(self, key: str, change: Obj) -> CallResult:
        """``set`` and ``clear``, journalling nothing on a refusal: a declared ``secret`` or ``flag`` is
        ``bad_request``; a catalog lock or a lock in the current document is ``managed_by_admin``; a value
        that fails the key's schema, or is over ``SYNC_MAX_VALUE_BYTES``, is ``bad_request``. A ``local``
        key is written to ``deviceLocal``; anything else is drafted, an undeclared key as an open setting."""
        r = self._route(key)
        if r is not None and r["route"] == "refused":
            return _fail("bad_request")
        if (r is not None and r["route"] == "locked") or self._locked(key):
            return _fail("managed_by_admin")
        if not change.get("clear"):
            value = change["value"]
            if r is not None and r["route"] == "synced" and not value_valid(value, r.get("schema")):
                return _fail("bad_request")
            if json_bytes(value) > SYNC_MAX_VALUE_BYTES:
                return _fail("bad_request")
        before = self._value_map()
        if r is not None and r["route"] == "local":
            if change.get("clear"):
                self._s["deviceLocal"].pop(key, None)
            else:
                self._s["deviceLocal"][key] = _clone(change["value"])
            self._emit_changes(before, {}, "local")
            return _OK()
        draft: Obj = {**change, "editedHlc": self._tick_hlc()}
        if not self._s["contacted"]:
            draft["preContact"] = True
        draft["due"] = self._now + SYNC_DEBOUNCE_MS
        self._drafts[key] = draft
        self._emit_changes(before, {}, "local")
        return _OK()

    def _commit_all_drafts(self) -> None:
        for k in _sorted(self._drafts):
            self._commit_draft(k)

    def _commit_draft(self, key: str) -> None:
        d = self._drafts.get(key)
        if d is None:
            return
        policy = self._policy_of(key)
        marks: Obj = {"preContact": True} if d.get("preContact") else {}
        if self._s["subject"] is None:
            # The local partition keeps one value per key, its policy already applied.
            local = self._s["partitions"][LOCAL_PARTITION]
            prior = local["device"].get(key)
            del self._drafts[key]
            if d.get("clear"):
                local["device"][key] = {"cleared": True, "editedHlc": d["editedHlc"], **marks}
            else:
                base = prior.get("value") if prior is not None and not prior.get("cleared") else _ABSENT
                if policy == "merge":
                    value = _clone(d.get("value"))
                else:
                    value = apply_setting_op(policy, base, {"op": "set", "value": d.get("value")})
                local["device"][key] = {"value": value, "editedHlc": d["editedHlc"], **marks}
            return
        p = self._active()
        del self._drafts[key]
        self._drop_parked_by_local_edit(p, key)
        if d.get("clear"):
            self._enqueue(p, {"target": self._target_of(key), "op": "clear", "editedHlc": d["editedHlc"], **marks})
            return
        self._enqueue_setting(p, key, d.get("value"), d["editedHlc"], marks)

    def _enqueue_setting(self, p: Obj, key: str, value: Json, edited_hlc: str, marks: Obj) -> None:
        """Journal a whole value for ``key``: one ``set``, or, for a ``merge`` key, one member operation
        per member that differs from the current view (the view without this edit)."""
        target = self._target_of(key)
        if self._policy_of(key) != "merge" or not _is_object(value):
            self._enqueue(p, {"target": target, "op": "set", "value": _clone(value), "editedHlc": edited_hlc, **marks})
            return
        layer = None if self._s["subject"] is None else self._layer(key)
        current = layer["value"] if layer is not None else None
        cur: Obj = current if isinstance(current, dict) else {}
        for member in _sorted(value):
            if member not in cur or not json_equal(cur[member], value[member]):
                self._enqueue(
                    p,
                    {
                        "target": target,
                        "op": "setMember",
                        "member": member,
                        "value": _clone(value[member]),
                        "editedHlc": edited_hlc,
                        **marks,
                    },
                )
        for member in _sorted(cur):
            if member not in value:
                self._enqueue(
                    p, {"target": target, "op": "removeMember", "member": member, "editedHlc": edited_hlc, **marks}
                )

    def _enqueue(self, p: Obj, op: Obj) -> Obj:
        full = {"mutationId": p["nextMutationId"], **op}
        p["nextMutationId"] += 1
        p["pending"].append(full)
        return full

    def _drop_parked_by_local_edit(self, p: Obj, key: str) -> None:
        """A newer local edit of a ``lastWrite`` or ``merge`` key replaces its parked edits (R5). A
        ``max`` or ``min`` key keeps them: the server decides by value, so the older edit may still win."""
        if self._policy_of(key) not in ("lastWrite", "merge"):
            return
        target = self._alias(key)
        p["pending"] = [
            o
            for o in p["pending"]
            if not (o.get("parked") and "setting" in o["target"] and self._alias(o["target"]["setting"]) == target)
        ]

    def _unpark(self, p: Obj, which: Callable[[str], bool]) -> None:
        """Re-send parked edits as NEW mutations with their original clock (a processed mutationId is
        never resent)."""
        parked = [o for o in p["pending"] if o.get("parked") and which(o["parked"])]
        if not parked:
            return
        p["pending"] = [o for o in p["pending"] if not any(o is q for q in parked)]
        for o in parked:
            self._enqueue(p, {k: v for k, v in o.items() if k not in ("mutationId", "parked")})

    def _union_op(self, collection: str, record_id: str, element: Json, op: str) -> CallResult:
        decl = self._collection(collection)
        if decl is None or decl["policy"] != "union":
            return _fail("collection-unknown")
        if self._s["subject"] is None:
            return _fail("signed-out")
        p = self._active()
        target = {"record": [collection, record_id]}
        if op == "add":
            self._enqueue(p, {"target": target, "op": op, "element": _clone(element)})
        else:
            self._enqueue(p, {"target": target, "op": op, "element": _clone(element), "observedSeq": p["cursor"]})
        self._kick()
        return _OK()

    def _in_flight_touches(self, rk: str) -> bool:
        f = self._in_flight
        if f is None or f["kind"] != "push":
            return False
        p = self._s["partitions"].get(f["partition"])
        return p is not None and any(
            o["mutationId"] in f["mutationIds"]
            and "record" in o["target"]
            and _record_key(*o["target"]["record"]) == rk
            for o in p["pending"]
        )

    def _kick(self) -> None:
        """Send the next request, if one is due and allowed."""
        if self._in_flight is not None or self._s["subject"] is None or self._s["blocked"]:
            return
        if self._network != "online":
            return
        # Pinned out or locked: nothing is sent, pulled or read, and the journal waits.
        if not self._may_talk():
            return
        name = self._s["subject"]
        p = self._active()

        def pull_path(cursor: int) -> str:
            return f"/{self._product}/sync?cursor={cursor}&clientId={p['clientId']}"

        # E2E: a push waits for the Worker to be confirmed ``e2e`` this session, by discovery or by a
        # pull. A pull carries nothing of ours.
        unconfirmed = self._requires_e2e() and self._advertised != "e2e"
        if not self._s["contacted"] or self._need_snapshot or unconfirmed:
            cursor = 0 if self._need_snapshot else p["cursor"]
            self._in_flight = {"kind": "pull", "partition": name, "cursor": cursor, "mutationIds": []}
            self._outbox.append({"method": "GET", "path": pull_path(cursor)})
            return
        batch = [o for o in p["pending"] if not o.get("parked")][:SYNC_MAX_MUTATIONS]
        if batch:
            self._in_flight = {
                "kind": "push",
                "partition": name,
                "cursor": p["cursor"],
                "mutationIds": [o["mutationId"] for o in batch],
            }
            self._outbox.append(
                {
                    "method": "POST",
                    "path": f"/{self._product}/sync/ops",
                    "body": {
                        "clientId": p["clientId"],
                        "cursor": p["cursor"],
                        "atomic": False,
                        "mutations": [self._send_form(p, o) for o in batch],
                    },
                }
            )
            return
        if self._signing_out is not None:
            self._leave("signOut", self._signing_out["discard"])
            return
        if self._pull_wanted:
            self._in_flight = {"kind": "pull", "partition": name, "cursor": p["cursor"], "mutationIds": []}
            self._outbox.append({"method": "GET", "path": pull_path(p["cursor"])})

    def _send_form(self, p: Obj, op: Obj) -> Obj:
        """The wire form of a pending operation. In E2E mode a ``max``/``min`` setting is a
        compare-and-swap register on the server, so its ``set`` names the version it was made against."""
        wire = wire_of(op)
        if (
            self._requires_e2e()
            and wire["op"] == "set"
            and "baseVersion" not in wire
            and "setting" in wire["target"]
            and self._client_decides(self._policy_of(wire["target"]["setting"]))
        ):
            row = p["settings"].get(self._alias(wire["target"]["setting"]))
            wire["baseVersion"] = row["version"] if row is not None else "*"
        return wire

    def _client_decides(self, policy: str) -> bool:
        """``max`` and ``min`` are decided by the client in E2E mode."""
        return self._requires_e2e() and policy in ("max", "min")

    def _client_mismatch(self, req: Obj) -> None:
        # The server bound this clientId to another device. Regenerate and renumber; none of these
        # mutations was processed under the new id.
        p = self._s["partitions"].get(req["partition"])
        if p is None:
            return
        p["clientId"] = self._fresh_client_id()
        p["nextMutationId"] = 1
        ops, p["pending"] = p["pending"], []
        for o in ops:
            self._enqueue(p, {k: v for k, v in o.items() if k != "mutationId"})

    def _first_contact(self, server_now: int) -> None:
        self._s["offsetMs"] = server_now - self._now
        if self._s["contacted"]:
            return
        self._s["contacted"] = True
        offset = self._s["offsetMs"]
        restamp = abs(offset) > SYNC_MAX_CLOCK_SKEW_MS

        def shift(h: str) -> str:
            ms, c = parse_hlc(h)
            return format_hlc(ms + offset, c)

        for p in self._s["partitions"].values():
            for op in p["pending"]:
                if op.get("preContact"):
                    if restamp and op.get("editedHlc"):
                        op["editedHlc"] = shift(op["editedHlc"])
                    del op["preContact"]
            for d in p["device"].values():
                if d.get("preContact"):
                    if restamp:
                        d["editedHlc"] = shift(d["editedHlc"])
                    del d["preContact"]
        for d in self._drafts.values():
            if d.get("preContact"):
                if restamp:
                    d["editedHlc"] = shift(d["editedHlc"])
                del d["preContact"]
        if restamp and self._s["hlc"][0] > 0:
            self._s["hlc"] = [self._s["hlc"][0] + offset, self._s["hlc"][1]]

    def _ok(self, req: Obj, body: Obj, opened: Obj) -> None:
        if _is_number(body.get("serverNow")):
            self._first_contact(body["serverNow"])
        if req["partition"] != self._s["subject"]:
            return
        if isinstance(body.get("subject"), str) and body["subject"] != req["partition"]:
            self._leave("subjectChanged", False)
            return
        p = self._active()
        before = self._value_map()
        overrides: Dict[str, str] = {}
        batch = [o for o in p["pending"] if o["mutationId"] in req["mutationIds"]]
        parked_now: List[Obj] = []
        results = body["results"] if isinstance(body.get("results"), list) else []
        for r in results:
            if not _is_object(r) or not _is_number(r.get("mutationId")):
                continue
            at = next(
                (
                    i
                    for i, o in enumerate(p["pending"])
                    if o["mutationId"] == r["mutationId"] and o["mutationId"] in req["mutationIds"]
                ),
                -1,
            )
            if at < 0:
                continue
            op = p["pending"][at]
            park = (
                _PARKING.get(_js_string(r, "code"))
                if r.get("status") == "rejected" and "setting" in op["target"]
                else None
            )
            if park:
                # R5: a retryable refusal keeps the edit on the device, still read, until it can land.
                op["parked"] = park
                parked_now.append(op)
                continue
            del p["pending"][at]
            self._result(p, op, r, overrides, opened, req["cursor"])
        # A parked edit that a later edit of the same value already replaces is dropped.
        for op in parked_now:
            if any(
                q is not op and q["mutationId"] > op["mutationId"] and _same_value(op, q)
                for q in [*batch, *p["pending"]]
            ):
                p["pending"] = _without(p["pending"], op)
        # The pull members: a cursor-0 request answers with a snapshot, which replaces ours.
        if req["cursor"] == 0 and _is_number(body.get("cursor")):
            p["settings"] = {}
            p["records"] = {}
        if self._requires_e2e() and _is_number(body.get("encryptionSince")):
            self._lower_since(p, body["encryptionSince"])
        changes = body["changes"] if isinstance(body.get("changes"), list) else []
        opened_changes = opened.get("changes") or []
        for i, c in enumerate(changes):
            if not _is_object(c) or not _is_number(c.get("version")):
                continue
            # E2E guard (a): inside one partition a served change is newer than the cursor the request
            # carried, so an older one is a replay or a forgery. Only a snapshot (cursor 0) has no floor.
            if self._requires_e2e() and req["cursor"] > 0 and c["version"] <= req["cursor"]:
                continue
            open_row = opened_changes[i] if i < len(opened_changes) else None
            if isinstance(c.get("setting"), str):
                latch_key = f"s:{c['setting']}"
            elif isinstance(c.get("record"), list) and len(c["record"]) == 2:
                latch_key = "r:" + _record_key(str(c["record"][0]), str(c["record"][1]))
            else:
                latch_key = ""
            bad = self._row_bad(p, latch_key, c["version"], open_row, req["cursor"])
            if isinstance(c.get("setting"), str):
                p["settings"][c["setting"]] = {"value": _clone(c.get("value")), "version": c["version"], **bad}
                self._drop_parked_by_remote(p, c["setting"], c.get("editedHlc"))
            elif isinstance(c.get("record"), list) and len(c["record"]) == 2:
                p["records"][_record_key(str(c["record"][0]), str(c["record"][1]))] = {
                    "value": _clone(c.get("value")),
                    "version": c["version"],
                    **bad,
                }
        for t in body["tombstones"] if isinstance(body.get("tombstones"), list) else []:
            if not _is_object(t):
                continue
            if isinstance(t.get("setting"), str):
                p["settings"].pop(t["setting"], None)
                self._drop_parked_by_remote(p, t["setting"], t.get("editedHlc"))
            elif isinstance(t.get("record"), list) and len(t["record"]) == 2:
                p["records"].pop(_record_key(str(t["record"][0]), str(t["record"][1])), None)
        if _is_number(body.get("cursor")):
            p["cursor"] = body["cursor"]
        if _is_object(body.get("aliases")):
            self._s["aliases"] = {k: v for k, v in body["aliases"].items() if isinstance(v, str)}
        # R5: more room than the last response showed re-sends the quota-parked edits.
        quota: Any = body["quota"].get("bytes") if _is_object(body.get("quota")) else None
        usage: Any = body["usage"].get("bytes") if _is_object(body.get("usage")) else None
        if _is_number(quota) and _is_number(usage):
            headroom = quota - usage
            if p["headroom"] is not None and headroom > p["headroom"]:
                self._unpark(p, lambda reason: reason == "quota")
            p["headroom"] = headroom
        self._need_snapshot = False
        self._pull_wanted = body.get("more") is True
        self._emit_changes(before, overrides, "remote")

    def _row_bad(
        self, p: Obj, latch_key: str, version: Any, open_row: Optional[Obj], cursor: Optional[int] = None
    ) -> Obj:
        """E2E ``encryptionSince``: only the host's open result counts. A row it opened from a ``ct`` is
        good (and lowers the clamp); one it could not open is bad; a plaintext row is legacy data only
        while its host-mapped ``seq`` stays below the partition's ``encryptionSince``, judged on every
        read. A plaintext row with no ``seq`` is bad at once. Server mode reads every row as it always did."""
        if not self._requires_e2e():
            return {}
        open_row = open_row or {}
        if open_row.get("invalid") is True:
            return {"bad": True}
        if open_row.get("sealed") is True:
            self._note_sealed(p, version, latch_key)
            return {}
        seq: Any = open_row.get("seq")
        if not _is_number(seq) or not math.isfinite(seq):
            return {"bad": True}
        # Guard (c): a key this machine has seen sealed never reads as legacy plaintext.
        if latch_key != "" and (p.get("sealedKeys") or {}).get(latch_key) is True:
            return {"bad": True}
        # Guard (b): legacy only if the request's cursor was still below the boundary.
        since = p.get("encryptionSince")
        if cursor is not None and (since is None or cursor >= since):
            return {"bad": True}
        return {"plain": seq}

    def _copy_row(self, p: Obj, latch_key: str, server: Obj, open_row: Optional[Obj], cursor: int) -> Obj:
        """A conflict's ``server`` copy as a held row. ``cursor`` is the one the push request carried, so
        guard (b) judges the copy exactly as it judges a pulled row."""
        version = server["version"]
        bad = self._row_bad(p, latch_key, version, open_row, cursor)
        return {"value": _clone(server.get("value")), "version": version, **bad}

    def _lower_since(self, p: Obj, served: Any) -> None:
        """Take a served boundary: the least ever served, held at or below the sealed floor."""
        if not math.isfinite(served) or served < 0:
            return
        since = min(p.get("encryptionSince", served), served)
        if p.get("sealedFloor") is not None:
            since = min(since, p["sealedFloor"])
        p["encryptionSince"] = since

    def _note_sealed(self, p: Obj, version: Any, latch_key: str = "") -> None:
        """This machine pushed, or opened, a sealed row at ``version``: no plaintext at or above it is
        legacy, whatever a Worker serves."""
        if not self._requires_e2e() or not _is_number(version) or not math.isfinite(version):
            return
        if latch_key != "":
            keys = p.setdefault("sealedKeys", {})
            if keys.get(latch_key) is not True:
                keys[latch_key] = True
                for old in list(keys)[: max(0, len(keys) - SEALED_LATCH_MAX)]:
                    del keys[old]
        p["sealedFloor"] = min(p.get("sealedFloor", version), version)
        if p.get("encryptionSince") is not None:
            p["encryptionSince"] = min(p["encryptionSince"], p["sealedFloor"])

    def _drop_parked_by_remote(self, p: Obj, server_key: str, edited_hlc: Any) -> None:
        """A newer remote value of a ``lastWrite`` key replaces its parked ``set`` or ``clear`` (R5)."""
        if not isinstance(edited_hlc, str):
            return
        p["pending"] = [
            o
            for o in p["pending"]
            if not (
                o.get("parked")
                and "setting" in o["target"]
                and o["op"] in ("set", "clear")
                and self._alias(o["target"]["setting"]) == server_key
                and self._policy_of(o["target"]["setting"]) == "lastWrite"
                and o.get("editedHlc") is not None
                and _byte_order(o["editedHlc"]) < _byte_order(edited_hlc)
            )
        ]

    def _result(
        self, p: Obj, op: Obj, r: Obj, overrides: Dict[str, str], opened: Obj, cursor: int
    ) -> None:
        status = r.get("status")
        conflicts = opened.get("conflicts") or {}

        def opened_conflict() -> Optional[Obj]:
            return conflicts.get(str(op["mutationId"]), conflicts.get(op["mutationId"]))

        if "setting" in op["target"]:
            key = op["target"]["setting"]
            server_key = r["renamedTo"] if isinstance(r.get("renamedTo"), str) else self._alias(key)
            if op.get("moved"):
                overrides[key] = "merge"
            if status == "ok" and _is_number(r.get("version")):
                self._note_sealed(p, r["version"], f"s:{server_key}")
            if status == "ok":
                if r.get("dropped") is True:
                    overrides[key] = "migration"
                    for d in self._catalog["settings"]:
                        if self._alias(d["key"]) == self._alias(key):
                            overrides[d["key"]] = "migration"
                elif _is_number(r.get("version")):
                    prior = p["settings"].get(server_key)
                    value = apply_setting_op(self._policy_of(key), prior["value"] if prior else _ABSENT, op)
                    if value is _ABSENT:
                        p["settings"].pop(server_key, None)
                    else:
                        p["settings"][server_key] = {"value": value, "version": r["version"]}
            elif status == "conflict" and _is_object(r.get("server")):
                # A stale write loses to the server copy, and nothing is enqueued.
                server = r["server"]
                if _is_number(server.get("version")):
                    sbad = self._copy_row(p, f"s:{server_key}", server, opened_conflict(), cursor)
                    p["settings"][server_key] = sbad
                    # E2E max/min: keep the better value and re-push it on the server's version.
                    if (
                        op["op"] == "set"
                        and _decidable(sbad)
                        and self._client_decides(self._policy_of(key))
                        and self._better(self._policy_of(key), op.get("value"), server.get("value"))
                    ):
                        again: Obj = {"target": op["target"], "op": "set", "value": _clone(op.get("value"))}
                        if op.get("editedHlc"):
                            again["editedHlc"] = op["editedHlc"]
                        again["baseVersion"] = server["version"]
                        self._enqueue(p, again)
                        overrides[key] = "merge"
            elif status == "rejected":
                # A terminal refusal: the value reverts to the snapshot and the app is told.
                self._events.append(
                    {"type": "rejected", "mutationId": op["mutationId"], "code": _js_string(r, "code")}
                )
            return
        # A record.
        c, rid = op["target"]["record"]
        rk = _record_key(c, rid)
        decl = self._collection(c)
        rebase_on: Any = None
        has_rebase = False
        rebase_value: Any = None
        if status == "ok" and _is_number(r.get("version")):
            self._note_sealed(p, r["version"], f"r:{rk}")
            prior = p["records"].get(rk)
            value = _apply_record_op(prior["value"] if prior else _ABSENT, op)
            if value is not _ABSENT:
                p["records"][rk] = {"value": value, "version": r["version"]}
            if rk in p["held"]:
                rebase_on, has_rebase = r["version"], True
        elif status == "conflict" and _is_object(r.get("server")):
            server = r["server"]
            if _is_number(server.get("version")):
                sbad = self._copy_row(p, f"r:{rk}", server, opened_conflict(), cursor)
                p["records"][rk] = sbad
                # The resolution is a NEW mutation on the server's version; N is never resent. Only
                # ``revision`` resolves on the device; every other policy took the server's copy.
                if rk in p["held"]:
                    rebase_on, has_rebase = server["version"], True
                elif (
                    decl is not None
                    and op["op"] == "set"
                    and _decidable(sbad)
                    and self._client_decides(decl["policy"])
                    and self._better(
                        decl["policy"],
                        self._compared(op.get("value"), decl.get("field")),
                        self._compared(server.get("value"), decl.get("field")),
                    )
                ):
                    # E2E max/min record: the better value is re-pushed on the server's version.
                    rebase_on, has_rebase = server["version"], True
                    rebase_value = op.get("value")
                elif (
                    decl is not None
                    and decl["policy"] == "revision"
                    and decl.get("resolve") == "keepLocal"
                    and op["op"] == "set"
                ):
                    rebase_on, has_rebase = server["version"], True
                    rebase_value = op.get("value")
        else:
            if status == "rejected":
                self._events.append(
                    {"type": "rejected", "mutationId": op["mutationId"], "code": _js_string(r, "code")}
                )
            if rk in p["held"]:
                row = p["records"].get(rk)
                rebase_on, has_rebase = (row["version"] if row is not None else "*"), True
        if has_rebase:
            value = p["held"][rk] if rk in p["held"] else rebase_value
            p["held"].pop(rk, None)
            self._enqueue(
                p, {"target": {"record": [c, rid]}, "op": "set", "value": _clone(value), "baseVersion": rebase_on}
            )

    def _compared(self, v: Any, field: Optional[str]) -> Any:
        """The number a ``max``/``min`` record compares: the value, or its ``field`` member."""
        if field is not None and _is_object(v):
            return v.get(field)
        return v

    def _better(self, policy: str, local: Any, server: Any) -> bool:
        """Whether ``local`` beats ``server`` under a ``max`` or ``min`` policy (numbers only)."""
        if not _is_number(local) or not _is_number(server):
            return False
        return local > server if policy == "max" else local < server

    def _leave(self, reason: str, discard: bool) -> None:
        """Sign-out, and every principal change handled like it."""
        name = self._s["subject"]
        if name is None:
            return
        self._commit_all_drafts()
        before = self._value_map()
        p = self._active()
        unsynced = len(p["pending"]) + len(p["held"])
        if discard:
            p["pending"] = []
            p["held"] = {}
        if self._on_sign_out == "clear" or reason != "signOut":
            p["settings"] = {}
            p["records"] = {}
            p["cursor"] = 0
        p["signedOutAt"] = self._now
        self._s["subject"] = None
        self._signing_out = None
        self._in_flight = None
        self._need_snapshot = False
        self._pull_wanted = False
        self._events.append({"type": "signedOut", "reason": reason, "unsynced": unsynced})
        if unsynced > 0 and not discard:
            self._events.append({"type": "unsyncedData", "count": unsynced})
        self._emit_changes(before, {}, "remote")

    def _expire_partitions(self) -> None:
        for name, p in list(self._s["partitions"].items()):
            if name == LOCAL_PARTITION or name == self._s["subject"]:
                continue
            if p["signedOutAt"] is not None and self._now - p["signedOutAt"] >= SYNC_PENDING_DAYS * _DAY_MS:
                del self._s["partitions"][name]


def relaunch(machine: CloudSyncMachine, opts: Obj, journal: str = "kept") -> CloudSyncMachine:
    """Relaunch: persist, then restore with the same host options (``lost`` drops the journal; the
    device binding, ``subject``, is device state and survives, and so does the ``config.local`` store
    behind ``deviceLocal``)."""
    saved = machine.persist()
    if journal == "lost":
        return CloudSyncMachine(
            {
                **opts,
                "now": machine.now,
                "network": machine.network_state,
                "offsetMs": 0,
                "contacted": False,
                "subject": saved["subject"],
                "deviceLocal": saved["deviceLocal"],
                "imported": saved["imported"],
            }
        )
    return CloudSyncMachine({**opts, "now": machine.now, "network": machine.network_state}, saved)
