"""The host codec boundary of Cloud Sync's end-to-end mode (WIRE-CONTRACT-V5 §13.10, §13.10.7).

A port of ``packages/client-core/src/sync/hostCodec.ts``, with every SEC-SYNC-HOST fix.
:class:`~polaris_key.cloud_sync.machine.CloudSyncMachine` speaks plaintext; this module is the one
place a host turns the machine's requests into sealed ones (:func:`seal_push`) and the Worker's answers
into plaintext plus the typed open result the machine trusts (:func:`open_pull`).

What it guarantees:

* nothing leaves in the clear that the contract seals: a ``value`` becomes ``ct``, an open setting key
  and a merge member are blinded, a declared key stays as it is. A locked codec refuses with
  ``sync-locked`` before anything is sealed, so nothing is sent.
* the opened result comes only from this module's own open. ``sealed``, ``invalid``, ``seq`` and ``ct``
  members of a served body are removed, never read: a Worker cannot mark a plaintext row sealed.
* a blinded name is accepted only when the ``k`` inside the envelope re-blinds to it. An envelope that
  does not open is ``invalid``; its row falls through to the document.
* ``seq`` is the change's ``version`` (§13.10.7), set on plaintext rows only.
* a result list that repeats a ``mutationId`` is refused; a conflict's server copy opens only for a
  mutation of the request; served ``aliases`` are replaced by the app's, ``renamedTo`` is kept only
  when the app declares it; a name holding U+0000 is refused.

Scope: settings (the ``$settings`` collection), and records with a scalar value (D-2: saves are
``revision`` records; U-22.10). A record value is sealed under its collection with ``k = id``, its id
travels as ``blind("record", collection, id)``, and a pulled record opens only when the ``k`` inside the
envelope re-blinds to the id on the wire (§13.10.4), so a Worker cannot place a sealed value under
another record. A record mutation other than ``set`` and ``delete`` (a ``merge`` field, a ``union``
element) and a sealed ``merge`` or ``union`` change (``fields``, ``elements``) are outside this codec: a
mutation is refused with ``invalid-options`` and a change reads as ``invalid``. client-core seals every
record shape.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from ..constants_generated import ErrorCode
from ..core.b64url import b64url_decode, b64url_encode
from ..core.errors import PolarisError
from ..core.sync_crypto import is_blinded_name

__all__ = ["SETTINGS_COLLECTION", "member_envelope_name", "open_pull", "seal_push"]

#: The collection every setting is sealed under.
SETTINGS_COLLECTION = "$settings"

Json = Any
Entry = Dict[str, Any]

_STRIP = ("sealed", "invalid", "seq", "ct")
_CT = re.compile(r"[A-Za-z0-9_-]+\Z")


def _locked() -> PolarisError:
    return PolarisError(ErrorCode.SYNC_LOCKED, "Cloud Sync is locked: there is no root")


def _refuse(why: str) -> PolarisError:
    return PolarisError(ErrorCode.INVALID_OPTIONS, f"Cloud Sync host codec: {why}")


def _is_obj(v: Any) -> bool:
    return isinstance(v, dict)


def _has_nul(s: str) -> bool:
    """The blind input has no length prefix (``kind\\0ctx\\0name``), so a name with a NUL could collide
    with another (setting, member) pair; no name may hold one."""
    return "\0" in s


def _to_ct(env: bytes) -> str:
    return b64url_encode(env)


def _from_ct(ct: Any) -> Optional[bytes]:
    """The envelope of a served ``ct``, or ``None`` for anything but canonical base64url."""
    if not isinstance(ct, str) or ct == "" or _CT.match(ct) is None:
        return None
    try:
        out = b64url_decode(ct)
    except ValueError:
        return None
    return out if b64url_encode(out) == ct else None


def member_envelope_name(setting: str, member: str) -> str:
    """The envelope name of a merge member (D-2): the setting, U+0000, the member."""
    return f"{setting}\0{member}"


# ── Push ─────────────────────────────────────────────────────────────────────────────────────


def seal_push(body: Json, codec: Any, routes: Sequence[Mapping[str, Any]]) -> Json:
    """Seals a push body. ``routes`` is the catalog's setting list: a key it names is declared and
    stays in the clear; any other key is an open setting and is blinded. The body is not changed; the
    answer is a copy. Raises (and so sends nothing) when the codec is locked or a mutation cannot be
    sealed."""
    if codec.locked:
        raise _locked()
    if not _is_obj(body) or not isinstance(body.get("mutations"), list):
        return body
    declared = {r["key"] for r in routes}
    mutations = []
    for m in body["mutations"]:
        if not _is_obj(m):
            raise _refuse("mutation is not an object")
        mutations.append(_seal_mutation(m, codec, declared))
    return {**body, "mutations": mutations}


def _record_ref(v: Any) -> Optional[Tuple[str, str]]:
    """``(collection, id)`` when ``v`` is a pair of non-empty strings that can name a record: no U+0000
    (the blind input has no length prefix) and not the settings collection's namespace (``$``)."""
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        return None
    c, i = v
    if not isinstance(c, str) or not isinstance(i, str) or c == "" or i == "":
        return None
    if _has_nul(c) or _has_nul(i) or c.startswith("$"):
        return None
    return c, i


def _seal_record_mutation(m: Entry, target: Entry, codec: Any) -> Entry:
    """A record mutation (scalar value, D-2): ``set`` seals the value under the collection with
    ``k = id``; ``delete`` carries none. Either sends the id blinded. The collection travels in the
    clear (§13.10.2)."""
    ref = _record_ref(target.get("record"))
    if ref is None:
        raise _refuse("a record reference is malformed")
    if "ct" in m or "field" in m or "element" in m or "member" in m:
        raise _refuse("mutation carries a member this codec does not seal")
    collection, rid = ref
    out: Entry = dict(m)
    op = m.get("op")
    if op == "set":
        if m.get("value", _MISSING) is _MISSING:
            raise _refuse("set needs a value")
        del out["value"]
        out["ct"] = _to_ct(codec.seal(collection, rid, m["value"]))
    elif op == "delete":
        if "value" in m:
            raise _refuse("delete carries no value")
    else:
        raise _refuse("unsupported operation")
    out["target"] = {**target, "record": [collection, codec.blind("record", collection, rid)]}
    return out


def _seal_mutation(m: Entry, codec: Any, declared: "set[str]") -> Entry:
    target: Any = m.get("target")
    if _is_obj(target) and "record" in target:
        return _seal_record_mutation(m, target, codec)
    if not _is_obj(target) or not isinstance(target.get("setting"), str):
        raise _refuse("only a setting or a record mutation can be sealed")
    if "ct" in m or "field" in m or "element" in m:
        raise _refuse("mutation carries a member this codec does not seal")
    setting: str = target["setting"]
    member = m.get("member")
    if _has_nul(setting) or (isinstance(member, str) and _has_nul(member)):
        raise _refuse("a name holds U+0000")
    open_key = setting not in declared
    out: Entry = dict(m)
    if open_key:
        out["target"] = {**target, "setting": codec.blind("setting", SETTINGS_COLLECTION, setting)}
    op = m.get("op")
    if op == "set":
        if m.get("value", _MISSING) is _MISSING or "member" in m:
            raise _refuse("set needs a value and no member")
        del out["value"]
        out["ct"] = _to_ct(codec.seal(SETTINGS_COLLECTION, setting, m["value"]))
        return out
    if op == "setMember":
        if open_key or not isinstance(member, str) or m.get("value", _MISSING) is _MISSING:
            raise _refuse("setMember needs a declared setting, a member and a value")
        del out["value"]
        out["member"] = codec.blind("member", setting, member)
        out["ct"] = _to_ct(codec.seal(SETTINGS_COLLECTION, member_envelope_name(setting, member), m["value"]))
        return out
    if op == "removeMember":
        if open_key or not isinstance(member, str) or "value" in m:
            raise _refuse("removeMember needs a declared setting and a member")
        out["member"] = codec.blind("member", setting, member)
        return out
    if op == "clear":
        if "value" in m or "member" in m:
            raise _refuse("clear carries no value")
        return out
    raise _refuse("unsupported operation")


_MISSING = object()


# ── Pull ─────────────────────────────────────────────────────────────────────────────────────


def _stripped(e: Entry) -> Entry:
    out = dict(e)
    for k in _STRIP:
        out.pop(k, None)
    return out


def _id_key(v: Any) -> str:
    """A hashable identity for a served ``mutationId``, as JavaScript's ``Set`` sees it (``1`` and
    ``true`` differ; ``1`` and ``1.0`` do not)."""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return json.dumps(v, sort_keys=True, separators=(",", ":"))


def open_pull(
    body: Json,
    codec: Any,
    *,
    mutations: Optional[Sequence[Mapping[str, Any]]] = None,
    aliases: Optional[Mapping[str, str]] = None,
    open_keys: Optional[Iterable[str]] = None,
    record_keys: Optional[Iterable[Tuple[str, str]]] = None,
) -> Tuple[Json, Entry]:
    """Opens a pull or push answer; returns ``(body, opened)``. The body has plaintext ``value`` s and
    plaintext setting names where they could be proven; ``opened`` is the typed result for
    :meth:`CloudSyncMachine.receive`. Raises (and so delivers nothing to the machine) when the codec is
    locked or the answer repeats a ``mutationId``.

    ``mutations`` are the plaintext mutations of the request the answer belongs to (a conflict's
    server copy carries no name, so it opens against the mutation's own setting). ``aliases`` are the
    renames the app declares, never taken from the body. ``open_keys`` are the open-setting keys the
    machine already holds: a tombstone names a key blinded, and only these can be mapped back.
    ``record_keys`` are the ``(collection, id)`` pairs of the records it holds, which a record
    tombstone's blinded id maps back to likewise."""
    if codec.locked:
        raise _locked()
    if not _is_obj(body):
        return body, {}
    out: Entry = dict(body)
    opened: Entry = {}

    if isinstance(body.get("changes"), list):
        changes: List[Json] = []
        rows: List[Optional[Entry]] = []
        for c in body["changes"]:
            if not _is_obj(c):
                changes.append(c)
                rows.append(None)
                continue
            entry, row = _open_change(c, codec, aliases)
            changes.append(entry)
            rows.append(row)
        out["changes"] = changes
        opened["changes"] = rows

    if isinstance(body.get("tombstones"), list):
        names = _open_key_names(codec, open_keys)
        records = _record_key_names(codec, record_keys)
        out["tombstones"] = [_open_tombstone(t, names, records) for t in body["tombstones"]]

    # Renames come from the app only; a served map or `renamedTo` could swap values between keys.
    if "aliases" in body:
        out["aliases"] = dict(aliases or {})

    if isinstance(body.get("results"), list):
        results: List[Json] = []
        seen: "set[str]" = set()
        for r in body["results"]:
            if not _is_obj(r):
                results.append(r)
                continue
            # One verdict per mutation. A second result for an id would overwrite the first verdict in
            # `opened["conflicts"]` while the machine reads the first body entry: fail closed.
            key = _id_key(r.get("mutationId"))
            if key in seen:
                raise PolarisError(ErrorCode.SYNC_FAILED, "Cloud Sync answer repeats a mutationId")
            seen.add(key)
            clean = _stripped(r)
            if "renamedTo" in clean:
                frm = _conflict_setting(mutations, r.get("mutationId"))
                if frm is None or (aliases or {}).get(frm) != clean["renamedTo"]:
                    del clean["renamedTo"]
            if r.get("status") == "conflict" and _is_obj(r.get("server")):
                mid = r.get("mutationId")
                expect = _conflict_setting(mutations, mid)
                rec = _conflict_record(mutations, mid)
                # Only a conflict for a mutation of this request opens: without one there is no name
                # to open against and the copy reads as invalid.
                if rec is not None:
                    entry, row = _open_record_copy(r["server"], rec, codec)
                else:
                    entry, row = _open_copy(r["server"], expect, codec, aliases)
                clean["server"] = entry
                if isinstance(mid, int) and not isinstance(mid, bool):
                    opened.setdefault("conflicts", {})[mid] = row
            results.append(clean)
        out["results"] = results

    for k in _STRIP:
        out.pop(k, None)
    return out, opened


def _conflict_setting(ms: Optional[Sequence[Mapping[str, Any]]], mid: Any) -> Optional[str]:
    """The plaintext setting name of mutation ``mid``, or ``None`` when the host did not say."""
    if not isinstance(mid, int) or isinstance(mid, bool):
        return None
    for m in ms or ():
        mm = m.get("mutationId")
        if isinstance(mm, int) and not isinstance(mm, bool) and mm == mid:
            target = m.get("target")
            if isinstance(target, Mapping) and isinstance(target.get("setting"), str):
                return str(target["setting"])
            return None
    return None


def _conflict_record(ms: Optional[Sequence[Mapping[str, Any]]], mid: Any) -> Optional[Tuple[str, str]]:
    """The ``(collection, id)`` of record mutation ``mid``, or ``None`` when the host did not say."""
    if not isinstance(mid, int) or isinstance(mid, bool):
        return None
    for m in ms or ():
        mm = m.get("mutationId")
        if isinstance(mm, int) and not isinstance(mm, bool) and mm == mid:
            target = m.get("target")
            return _record_ref(target.get("record")) if isinstance(target, Mapping) else None
    return None


def _open_key_names(codec: Any, keys: Optional[Iterable[str]]) -> Dict[str, str]:
    return {codec.blind("setting", SETTINGS_COLLECTION, k): k for k in keys or ()}


def _record_key_names(codec: Any, keys: Optional[Iterable[Tuple[str, str]]]) -> Dict[Tuple[str, str], str]:
    """Blinded record id (with its collection) to plaintext id, for the records the machine holds."""
    out: Dict[Tuple[str, str], str] = {}
    for k in keys or ():
        ref = _record_ref(k)
        if ref is not None:
            out[(ref[0], codec.blind("record", ref[0], ref[1]))] = ref[1]
    return out


def _open_tombstone(t: Json, names: Mapping[str, str], records: Mapping[Tuple[str, str], str]) -> Json:
    if not _is_obj(t):
        return t
    s = t.get("setting")
    if isinstance(s, str) and s in names:
        return {**t, "setting": names[s]}
    r = t.get("record")
    if isinstance(r, list) and len(r) == 2 and isinstance(r[0], str) and isinstance(r[1], str):
        plain = records.get((r[0], r[1]))
        if plain is not None:
            return {**t, "record": [r[0], plain]}
    return t


def _aliases_of(name: str, aliases: Optional[Mapping[str, str]]) -> List[str]:
    return [frm for frm, to in (aliases or {}).items() if to == name]


def _invalid_row(e: Entry) -> Tuple[Entry, Entry]:
    out = _stripped(e)
    out.pop("value", None)
    out.pop("members", None)
    return out, {"invalid": True}


def _plain_row(e: Entry) -> Tuple[Entry, Entry]:
    v = e.get("version")
    return _stripped(e), ({"seq": v} if isinstance(v, (int, float)) and not isinstance(v, bool) else {})


def _open_change(c: Entry, codec: Any, aliases: Optional[Mapping[str, str]]) -> Tuple[Entry, Entry]:
    if isinstance(c.get("setting"), str):
        return _open_setting_change(c, codec, aliases)
    if "record" in c:
        return _open_record_change(c, codec)
    # Neither a setting nor a record: a sealed one cannot be placed.
    if "ct" in c:
        return _invalid_row(c)
    return _plain_row(c)


def _open_record_change(c: Entry, codec: Any) -> Tuple[Entry, Entry]:
    """A record change: ``{record: [collection, id], ct, version}``. A sealed ``merge`` or ``union``
    change (``fields``, ``elements``) is outside the scalar codec and reads as invalid; a plaintext row
    is legacy (the machine checks its ``seq`` against ``encryptionSince``). A sealed id is accepted only
    when it is blinded and the ``k`` inside the envelope re-blinds to it; it is then replaced by the id."""
    if isinstance(c.get("fields"), list) or isinstance(c.get("elements"), list):
        return _invalid_row(c)
    if "ct" not in c:
        return _plain_row(c)
    ref = _record_ref(c["record"])
    if ref is None or not is_blinded_name(ref[1]):
        return _invalid_row(c)
    env = _from_ct(c["ct"])
    if env is None:
        return _invalid_row(c)
    r = codec.open_any(ref[0], env)
    if not r.ok or r.name == "" or _has_nul(r.name):
        return _invalid_row(c)
    if codec.blind("record", ref[0], r.name) != ref[1]:
        return _invalid_row(c)
    entry = _stripped(c)
    entry["record"] = [ref[0], r.name]
    entry["value"] = r.value
    return entry, {"sealed": True}


def _open_record_copy(e: Entry, rec: Tuple[str, str], codec: Any) -> Tuple[Entry, Entry]:
    """A conflict's server copy of the record ``rec`` of the mutation: one ``ct``, opened under that id."""
    if isinstance(e.get("fields"), list) or isinstance(e.get("elements"), list):
        return _invalid_row(e)
    if "ct" not in e:
        return _plain_row(e)
    env = _from_ct(e["ct"])
    if env is None:
        return _invalid_row(e)
    r = codec.open(rec[0], rec[1], env, [])
    if not r.ok:
        return _invalid_row(e)
    entry = _stripped(e)
    entry["value"] = r.value
    return entry, {"sealed": True}


def _open_setting_change(c: Entry, codec: Any, aliases: Optional[Mapping[str, str]]) -> Tuple[Entry, Entry]:
    served: str = c["setting"]
    if _has_nul(served):
        return _invalid_row(c)
    if "ct" not in c and not isinstance(c.get("members"), list):
        return _plain_row(c)
    if is_blinded_name(served):
        # An open key: the name is inside the envelope and must re-blind to the served name.
        if "ct" not in c:
            return _invalid_row(c)
        env = _from_ct(c["ct"])
        if env is None:
            return _invalid_row(c)
        r = codec.open_any(SETTINGS_COLLECTION, env)
        if not r.ok or _has_nul(r.name):
            return _invalid_row(c)
        if codec.blind("setting", SETTINGS_COLLECTION, r.name) != served:
            return _invalid_row(c)
        entry = _stripped(c)
        entry["setting"] = r.name
        entry["value"] = r.value
        return entry, {"sealed": True}
    return _open_copy(c, served, codec, aliases)


def _open_copy(
    e: Entry, name: Optional[str], codec: Any, aliases: Optional[Mapping[str, str]]
) -> Tuple[Entry, Entry]:
    """Opens a row (or a conflict's server copy) whose setting name is ``name``: one ``ct``, or a merge
    setting's sealed ``members``. ``name`` ``None`` (a conflict the host cannot place) reads as invalid."""
    has_ct = "ct" in e
    members = e.get("members")
    if not has_ct and not isinstance(members, list):
        # Plaintext: legacy only if the machine finds its `seq` below `encryptionSince`.
        return _plain_row(e)
    if name is None or _has_nul(name):
        return _invalid_row(e)
    if has_ct:
        env = _from_ct(e["ct"])
        if env is None:
            return _invalid_row(e)
        r = codec.open(SETTINGS_COLLECTION, name, env, _aliases_of(name, aliases))
        if not r.ok:
            return _invalid_row(e)
        entry = _stripped(e)
        entry.pop("members", None)
        entry["value"] = r.value
        return entry, {"sealed": True}
    value: Dict[str, Any] = {}
    for m in members or ():
        if not _is_obj(m) or not isinstance(m.get("member"), str):
            return _invalid_row(e)
        env = _from_ct(m.get("ct"))
        if env is None or not is_blinded_name(m["member"]):
            return _invalid_row(e)
        r = codec.open_any(SETTINGS_COLLECTION, env)
        if not r.ok:
            return _invalid_row(e)
        prefix = f"{name}\0"
        if not r.name.startswith(prefix):
            return _invalid_row(e)
        member = r.name[len(prefix) :]
        if _has_nul(member):
            return _invalid_row(e)
        if codec.blind("member", name, member) != m["member"]:
            return _invalid_row(e)
        if member in value:
            return _invalid_row(e)
        value[member] = r.value
    entry = _stripped(e)
    entry.pop("members", None)
    entry["value"] = value
    return entry, {"sealed": True}
