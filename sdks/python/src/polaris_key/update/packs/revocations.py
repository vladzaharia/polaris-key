"""The device's revocations (plans/P4-13.md §2.5 "Persistence"), a port of client-core's
``packs/revocations.ts``: a sibling document, ``revocations.json``, beside P4-06's pack state
and never inside it, so an unparseable ``state.json`` cannot lose revocations and a lost
revocation file cannot touch the install state::

    {v: 1, revoked: {[targetSha256]: {jws, pack, version, seq, record, issuedAt}}, relearn: [packId]}

Each entry holds the winning revocation's compact JWS verbatim, the pin it was verified with
(the feed entry's ``pack``, ``version``, ``seq``), its record hash and its ``issuedAt``. The
document is NEVER trusted from storage: :func:`reload_revocations` re-verifies every entry
against the currently pinned release keys and the stored pin, and a failing entry is dropped
alone. A key that is no longer pinned forgets its target (the key-rotation recovery lever for a
stolen release key); any other failure adds the entry's pack to ``relearn``, cleared only by a
fresh, network-verified feed whose ``revocations`` member is present and usable, or by
``recover_state()``.

Pure functions over the document: each returns a new document and changes nothing in place.
The engine (``engine.py``) owns the I/O, the ``revocationsStored`` flag in ``state.json`` and
the mount refusals.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from ...core.b64url import b64url_decode
from ...core.jws import TrustSet
from ...core.pack_claims import is_pack_id, is_sha256
from ...core.release_record import VerifiedRevocation, newer_revocation, verify_revocation

__all__ = [
    "REVOCATIONS_VERSION",
    "MAX_STORED_REVOCATIONS",
    "ReloadRevocationsResult",
    "empty_revocations",
    "is_empty_revocations",
    "parse_revocations",
    "serialize_revocations",
    "reload_revocations",
    "store_revocation",
    "cap_revocations",
    "clear_relearn",
]

#: The document's version.
REVOCATIONS_VERSION = 1
#: A device keeps at most this many revoked targets; beyond it the oldest by ``issuedAt`` is
#: dropped first (and its pack is NOT added to ``relearn``: dropping at the cap is deliberate).
MAX_STORED_REVOCATIONS = 256


def empty_revocations() -> Dict[str, Any]:
    return {"v": REVOCATIONS_VERSION, "revoked": {}, "relearn": []}


def is_empty_revocations(doc: Mapping[str, Any]) -> bool:
    """True when the document holds nothing (the state a product with no revocations is in)."""
    return not doc["revoked"] and not doc["relearn"]


def _nat(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 2**53 - 1


def _byte_sorted(items: Any) -> List[str]:
    return sorted(items, key=lambda s: s.encode("utf-8", "surrogatepass"))


def parse_revocations(text: str) -> Optional[Dict[str, Any]]:
    """Parse the stored text's shape. ``None`` when it does not parse as the document at all (a
    torn file, which the engine quarantines). Entries of the wrong shape are dropped with their
    pack (if it can be read) added to ``relearn``: shape only, :func:`reload_revocations`
    decides what is trusted."""
    try:
        doc = json.loads(text)
    except Exception:
        return None
    if not isinstance(doc, dict) or doc.get("v") != REVOCATIONS_VERSION or isinstance(doc.get("v"), bool):
        return None
    if not isinstance(doc.get("revoked"), dict) or not isinstance(doc.get("relearn"), list):
        return None
    out = empty_revocations()
    relearn = {p for p in doc["relearn"] if is_pack_id(p)}
    for target, e in doc["revoked"].items():
        ok = (
            is_sha256(target)
            and isinstance(e, dict)
            and isinstance(e.get("jws"), str)
            and is_pack_id(e.get("pack"))
            and isinstance(e.get("version"), str)
            and _nat(e.get("seq"))
            and e["seq"] >= 1
            and is_sha256(e.get("record"))
            and _nat(e.get("issuedAt"))
        )
        if ok:
            out["revoked"][target] = {
                "jws": e["jws"],
                "pack": e["pack"],
                "version": e["version"],
                "seq": e["seq"],
                "record": e["record"],
                "issuedAt": e["issuedAt"],
            }
        elif isinstance(e, dict) and is_pack_id(e.get("pack")):
            relearn.add(e["pack"])
    out["relearn"] = _byte_sorted(relearn)
    return out


def serialize_revocations(doc: Mapping[str, Any]) -> str:
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False)


def _kid_of(jws: str) -> Optional[str]:
    """The protected header's ``kid``, read without trusting anything else."""
    try:
        h = json.loads(b64url_decode(jws.split(".")[0]).decode("utf-8"))
    except Exception:
        return None
    return h["kid"] if isinstance(h, dict) and isinstance(h.get("kid"), str) else None


@dataclass
class ReloadRevocationsResult:
    doc: Dict[str, Any]
    #: The verified revocation of every surviving target.
    verified: Dict[str, VerifiedRevocation] = field(default_factory=dict)
    #: Whether re-verification changed the document (a drop or a ``relearn`` addition).
    changed: bool = False


def reload_revocations(
    doc: Mapping[str, Any],
    *,
    release_keys: TrustSet,
    product_trust: TrustSet,
    expected_aud: str,
) -> ReloadRevocationsResult:
    """Re-verify every entry against the currently pinned release keys and its stored pin
    (``target`` = the map key, ``record`` = the stored hash). A failing entry is dropped alone:
    a key that is no longer pinned forgets the target; any other failure adds the entry's pack
    to ``relearn``. Never raises."""
    out: Dict[str, Any] = {"v": REVOCATIONS_VERSION, "revoked": {}, "relearn": list(doc["relearn"])}
    verified: Dict[str, VerifiedRevocation] = {}
    changed = False
    relearn = set(out["relearn"])
    for target, e in doc["revoked"].items():
        try:
            r = verify_revocation(
                e["jws"],
                release_keys=release_keys,
                product_trust=product_trust,
                expected_aud=expected_aud,
                entry={
                    "record": e["record"],
                    "pack": e["pack"],
                    "target": target,
                    "version": e["version"],
                    "seq": e["seq"],
                },
            )
            ok, step = r.ok and r.revocation is not None, r.step
        except Exception:
            ok, step, r = False, "jws", None  # type: ignore[assignment]
        if ok:
            out["revoked"][target] = e
            verified[target] = r.revocation  # type: ignore[union-attr]
            continue
        changed = True
        kid = _kid_of(e["jws"])
        rotated = step == "jws" and kid is not None and kid not in release_keys
        if not rotated:
            relearn.add(e["pack"])
    out["relearn"] = _byte_sorted(relearn)
    return ReloadRevocationsResult(doc=out, verified=verified, changed=changed)


def store_revocation(
    doc: Mapping[str, Any],
    revocation: VerifiedRevocation,
    jws: str,
    stored: Optional[Callable[[str], Optional[VerifiedRevocation]]] = None,
) -> Tuple[Dict[str, Any], bool]:
    """Store a verified revocation (plans/P4-13.md §2.5 step 11): kept when its target is new,
    or when ``newer_revocation`` ranks it above the stored one (a superseding revocation). Then
    the cap. Returns the new document and whether anything changed."""
    target = revocation.target
    prev = doc["revoked"].get(target)
    if prev is not None:
        if prev["record"] == revocation.record:
            return dict(doc), False
        have: Any = stored(target) if stored is not None else None
        if have is None:
            have = _Ranked(issuedAt=prev["issuedAt"], record=prev["record"])
        if newer_revocation(revocation, have) is not revocation:
            return dict(doc), False
    nxt: Dict[str, Any] = {
        "v": REVOCATIONS_VERSION,
        "revoked": {
            **doc["revoked"],
            target: {
                "jws": jws,
                "pack": revocation.pack,
                "version": revocation.version,
                "seq": revocation.seq,
                "record": revocation.record,
                "issuedAt": revocation.issuedAt,
            },
        },
        "relearn": list(doc["relearn"]),
    }
    return cap_revocations(nxt), True


@dataclass(frozen=True)
class _Ranked:
    issuedAt: int
    record: str


def cap_revocations(doc: Mapping[str, Any]) -> Dict[str, Any]:
    """Keep at most ``MAX_STORED_REVOCATIONS`` targets: the oldest by ``issuedAt`` (then the
    lower record hash) is dropped first, without adding its pack to ``relearn``."""
    targets = list(doc["revoked"].keys())
    if len(targets) <= MAX_STORED_REVOCATIONS:
        return dict(doc)
    revoked = doc["revoked"]
    keep = sorted(
        targets,
        key=lambda t: (revoked[t]["issuedAt"], revoked[t]["record"]),
        reverse=True,
    )[:MAX_STORED_REVOCATIONS]
    return {
        "v": REVOCATIONS_VERSION,
        "revoked": {t: revoked[t] for t in keep},
        "relearn": list(doc["relearn"]),
    }


def clear_relearn(doc: Mapping[str, Any], packs: Sequence[str]) -> Tuple[Dict[str, Any], bool]:
    """Clear ``relearn`` for the given packs."""
    if not packs:
        return dict(doc), False
    drop = set(packs)
    relearn = [p for p in doc["relearn"] if p not in drop]
    if len(relearn) == len(doc["relearn"]):
        return dict(doc), False
    out = dict(doc)
    out["relearn"] = relearn
    return out, True
