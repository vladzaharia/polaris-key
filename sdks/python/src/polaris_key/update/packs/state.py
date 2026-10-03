"""The pack install-state machine (CONTENT §9 "Install state", §10; plans/P4-01.md §2.13), a port
of client-core's ``packs/state.ts``.

One document per product, written by atomic replace:

  active            pack id → the install the next boot (and, for ``hot`` packs, this process) uses
  previous          pack id → the install ``active`` replaced, kept for ``rollback``
  inflight          pack id → the journal of an install in progress, for resume
  observed          what a platform transport reported (P5-08); carried, never interpreted here
  confirmedBootSeq  the last boot ``confirm`` marked healthy; ``bootSeq`` counts loads

The document is NEVER trusted from storage: each install and journal carries its pack record's
compact JWS verbatim, and :func:`reload_pack_state` re-verifies every one through the caller's
verifier before anything uses it. What fails is dropped, never repaired.

Installs and journals are plain ``dict``s with the TypeScript member names (the document is the
same JSON in every SDK). Pure functions: each returns a new document and changes nothing in place.
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any, Callable, Dict, Iterable, Mapping, Optional, Set, Tuple

from ...core.pack_claims import is_pack_id, is_sha256

__all__ = [
    "PACK_STATE_VERSION",
    "PackStateStore",
    "empty_pack_state",
    "parse_pack_state",
    "serialize_pack_state",
    "reload_pack_state",
    "begin_install",
    "checkpoint",
    "abandon_install",
    "commit_install",
    "rollback_install",
    "confirm_boot",
    "gc_roots",
]

PACK_STATE_VERSION = 1

_PLAN_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
_MAX_SAFE = 2**53 - 1


class PackStateStore:
    """Where the document lives: read it whole, replace it atomically (a protocol; subclass or
    duck-type it).

    ``read`` answers ``None`` ONLY when there is no document and raises for anything else: an
    unreadable document is never the empty state. The quarantine members (``quarantine``,
    ``quarantined``, ``clear_quarantine``) are REQUIRED: a store that lacks them at run time has a
    torn document treated as unreadable. They keep a torn document (one that exists but does not
    parse) aside, as ``state.json.torn``, before the first write replaces it; while one is held the
    engine collects no garbage. ``read_hold_list``/``write_hold_list`` are optional: the torn
    hold's snapshot of the store (``state.json.torn.list``)."""

    def read(self) -> Optional[str]:  # pragma: no cover - protocol
        raise NotImplementedError

    def replace(self, text: str) -> None:  # pragma: no cover - protocol
        raise NotImplementedError


def empty_pack_state() -> Dict[str, Any]:
    return {
        "v": PACK_STATE_VERSION,
        "active": {},
        "previous": {},
        "inflight": {},
        "observed": {},
        "confirmedBootSeq": 0,
        "bootSeq": 0,
    }


def _nat(v: Any) -> bool:
    """JavaScript's ``Number.isSafeInteger(v) && v >= 0`` (an integral float counts, as JSON
    numbers are doubles there)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    if isinstance(v, float) and not v.is_integer():
        return False
    return 0 <= v <= _MAX_SAFE


def _as_install(v: Any, pack_id: str) -> Optional[Dict[str, Any]]:
    if not isinstance(v, dict):
        return None
    if v.get("packId") != pack_id or not is_pack_id(pack_id):
        return None
    for k in ("record", "version", "type", "variant", "layout", "location"):
        if not isinstance(v.get(k), str):
            return None
    if not is_sha256(v.get("recordSha256")) or not is_sha256(v.get("payloadSha256")):
        return None
    if not (_nat(v.get("seq")) and _nat(v.get("payloadSize")) and _nat(v.get("installedAt"))):
        return None
    if "embedded" in v and not isinstance(v["embedded"], bool):
        return None
    if v.get("activation") not in ("hot", "restart"):
        return None
    # plans/P4-19.md §2.7: the delegation's compact JWS, verbatim, for a delegated install.
    if "delegation" in v and not isinstance(v["delegation"], str):
        return None
    return v


def _as_journal(v: Any, pack_id: str) -> Optional[Dict[str, Any]]:
    if not isinstance(v, dict) or v.get("packId") != pack_id or not is_pack_id(pack_id):
        return None
    for k in ("planId", "record", "variant", "strategy"):
        if not isinstance(v.get(k), str):
            return None
    if not is_sha256(v.get("recordSha256")):
        return None
    if "delta" in v and not isinstance(v["delta"], str):
        return None
    if "delegation" in v and not isinstance(v["delegation"], str):
        return None
    if _PLAN_ID.fullmatch(v["planId"]) is None:
        return None
    if not _nat(v.get("startedAt")) or not isinstance(v.get("objects"), list):
        return None
    for o in v["objects"]:
        if (
            not isinstance(o, dict)
            or not is_sha256(o.get("sha256"))
            or not _nat(o.get("bytes"))
            or not _nat(o.get("done"))
            or o["done"] > o["bytes"]
        ):
            return None
    return v


def parse_pack_state(text: Optional[str]) -> Dict[str, Any]:
    """Parse the stored document's shape. Anything malformed is dropped entry by entry (a
    document that does not parse at all is the empty state). Shape only."""
    out = empty_pack_state()
    if text is None:
        return out
    try:
        doc = json.loads(text)
    except Exception:
        return out
    if not isinstance(doc, dict) or doc.get("v") != PACK_STATE_VERSION or isinstance(doc.get("v"), bool):
        return out
    for slot in ("active", "previous"):
        m = doc.get(slot)
        if not isinstance(m, dict):
            continue
        for pid, v in m.items():
            i = _as_install(v, pid)
            if i is not None:
                out[slot][pid] = i
    if isinstance(doc.get("inflight"), dict):
        for pid, v in doc["inflight"].items():
            j = _as_journal(v, pid)
            if j is not None:
                out["inflight"][pid] = j
    if isinstance(doc.get("observed"), dict):
        out["observed"] = dict(doc["observed"])
    if _nat(doc.get("confirmedBootSeq")):
        out["confirmedBootSeq"] = doc["confirmedBootSeq"]
    if _nat(doc.get("bootSeq")):
        out["bootSeq"] = doc["bootSeq"]
    if out["confirmedBootSeq"] > out["bootSeq"]:
        out["confirmedBootSeq"] = out["bootSeq"]
    # Set by the engine when it first stores a revocation in the sibling `revocations.json`
    # (plans/P4-13.md §2.5): written before the sibling file, never cleared, absent for a product
    # that has never had a revocation.
    if doc.get("revocationsStored") is True:
        out["revocationsStored"] = True
    return out


def serialize_pack_state(state: Mapping[str, Any]) -> str:
    return json.dumps(state, separators=(",", ":"), ensure_ascii=False)


def _ok(fn: Callable[[Dict[str, Any]], bool], v: Dict[str, Any]) -> bool:
    try:
        return bool(fn(v))
    except Exception:
        return False


def reload_pack_state(
    state: Mapping[str, Any],
    verify_install: Callable[[Dict[str, Any]], bool],
    verify_journal: Callable[[Dict[str, Any]], bool],
) -> Dict[str, Any]:
    """The reload path: every install and journal goes through the verifier, and only what
    passes survives. ``bootSeq`` counts this load. A ``previous`` equal to its ``active`` is
    dropped."""
    out = empty_pack_state()
    out["observed"] = state["observed"]
    out["confirmedBootSeq"] = state["confirmedBootSeq"]
    out["bootSeq"] = state["bootSeq"] + 1
    if state.get("revocationsStored") is True:
        out["revocationsStored"] = True
    for pid, i in state["active"].items():
        if _ok(verify_install, i):
            out["active"][pid] = i
    for pid, i in state["previous"].items():
        a = out["active"].get(pid)
        if a is not None and a["recordSha256"] == i["recordSha256"]:
            continue
        if _ok(verify_install, i):
            out["previous"][pid] = i
    for pid, j in state["inflight"].items():
        if _ok(verify_journal, j):
            out["inflight"][pid] = j
    return out


def _shallow(state: Mapping[str, Any]) -> Dict[str, Any]:
    out = dict(state)
    for k in ("active", "previous", "inflight"):
        out[k] = dict(state[k])
    return out


def begin_install(state: Mapping[str, Any], journal: Dict[str, Any]) -> Dict[str, Any]:
    """Start (or restart) a plan: its journal becomes the pack's ``inflight``."""
    out = _shallow(state)
    out["inflight"][journal["packId"]] = journal
    return out


def checkpoint(state: Mapping[str, Any], pack_id: str, sha256: str, done: int) -> Dict[str, Any]:
    """Record how many bytes of one staged object are done."""
    j = state["inflight"].get(pack_id)
    if j is None:
        return dict(state)
    nj = copy.copy(j)
    nj["objects"] = [
        dict(o, done=min(done, o["bytes"])) if o["sha256"] == sha256 else o for o in j["objects"]
    ]
    out = _shallow(state)
    out["inflight"][pack_id] = nj
    return out


def abandon_install(state: Mapping[str, Any], pack_id: str) -> Dict[str, Any]:
    """Abandon a plan (its staging becomes garbage)."""
    if pack_id not in state["inflight"]:
        return dict(state)
    out = _shallow(state)
    del out["inflight"][pack_id]
    return out


def commit_install(state: Mapping[str, Any], install: Dict[str, Any]) -> Dict[str, Any]:
    """Commit a verified install: the pointer swap. ``active`` becomes the new install, the one
    it replaces becomes ``previous`` (unless it is the same release), and the journal closes."""
    pid = install["packId"]
    out = _shallow(state)
    old = state["active"].get(pid)
    if old is not None and old["recordSha256"] != install["recordSha256"]:
        out["previous"][pid] = old
    out["inflight"].pop(pid, None)
    out["active"][pid] = install
    return out


def rollback_install(state: Mapping[str, Any], pack_id: str) -> Tuple[Dict[str, Any], bool]:
    """Roll a pack back to ``previous``. Unchanged (and ``False``) when there is none."""
    prev = state["previous"].get(pack_id)
    if prev is None:
        return dict(state), False
    out = _shallow(state)
    del out["previous"][pack_id]
    out["active"][pack_id] = prev
    return out, True


def confirm_boot(state: Mapping[str, Any]) -> Dict[str, Any]:
    """Mark this boot healthy (CONTENT §10 step 7)."""
    out = dict(state)
    out["confirmedBootSeq"] = state["bootSeq"]
    return out


def gc_roots(
    state: Mapping[str, Any], embedded: Iterable[Mapping[str, Any]] = ()
) -> Tuple[Set[str], Set[str]]:
    """``roots()`` (CONTENT §4.1): the locations of every active and previous install and of
    every embedded baseline, and the plan ids of every in-flight journal. Returns
    ``(locations, plans)``."""
    locations: Set[str] = set()
    for i in state["active"].values():
        locations.add(i["location"])
    for i in state["previous"].values():
        locations.add(i["location"])
    for e in embedded:
        locations.add(e["location"])
    plans = {j["planId"] for j in state["inflight"].values()}
    return locations, plans
