"""Save compatibility on the device (P4-20, CONTENT §6.7 item 8, PARITY ``packs.provides``):
which content ids a pack release provides, read from its signed record's record-level
``provides``. A port of client-core's ``packs/provides.ts``.

``provides`` is a member WIRE-CONTRACT-V4 §2.5.1 reserves on the pack record ("ignored by v1"):
it is never a claim, so a record that carries a malformed list still verifies. This reader is the
one interpretation every SDK shares, beside the claims and never inside them:

- absent → provides nothing;
- a list of 0–``MAX_PROVIDES`` unique strings, each matching ``CONTENT_ID_PATTERN`` → those ids;
- anything else → provides nothing (an unusable list answers no id).

Content ids are opaque. The pattern (printable ASCII without the space, 1–128 characters) is the
shape the publish rules enforce, so a record that reaches a device has it; the reader re-checks it
so no SDK trusts a list another would refuse.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, FrozenSet, Optional, Set

from ...core.b64url import b64url_decode
from ...core.models import ReleasePin

__all__ = [
    "CONTENT_ID_PATTERN",
    "MAX_PROVIDES",
    "MAX_PROVIDES_MEMO",
    "PackProvider",
    "ProvidesFacts",
    "ProvidesMemo",
    "entitled",
    "provides_facts",
    "provides_of",
    "verified_payload_of",
]

#: One content id: printable ASCII without the space, 1–128 characters. Match it with
#: ``fullmatch`` (``$`` would accept a trailing newline).
CONTENT_ID_PATTERN = re.compile(r"[!-~]{1,128}")
#: The most ids one ``provides`` (or ``removes``) list may hold.
MAX_PROVIDES = 4096
#: The most record facts the engine's memo keeps before it starts over.
MAX_PROVIDES_MEMO = 1024

_NONE: FrozenSet[str] = frozenset()


def provides_of(record: Any) -> FrozenSet[str]:
    """A record payload's ``provides``, as a set (empty when absent or unusable)."""
    if not isinstance(record, dict):
        return _NONE
    ids = record.get("provides")
    if not isinstance(ids, list) or len(ids) > MAX_PROVIDES:
        return _NONE
    out: Set[str] = set()
    for i in ids:
        if not isinstance(i, str) or CONTENT_ID_PATTERN.fullmatch(i) is None or i in out:
            return _NONE
        out.add(i)
    return frozenset(out)


def verified_payload_of(jws: str) -> Any:
    """The payload of a compact JWS the engine has ALREADY verified (a stored install, an
    embedded baseline), decoded and never re-verified here; ``None`` when it does not decode."""
    if not isinstance(jws, str):
        return None
    parts = jws.split(".")
    if len(parts) != 3:
        return None
    try:
        return json.loads(b64url_decode(parts[1]).decode("utf-8"))
    except Exception:
        return None


@dataclass(frozen=True)
class ProvidesFacts:
    """What save compatibility reads from one verified pack record."""

    provides: FrozenSet[str]
    #: The record's ``entitlement``, or ``None``: a licence without it hides the pack (CONTENT
    #: §6.7 item 9), so it never answers.
    entitlement: Optional[str]


def provides_facts(record: Any) -> ProvidesFacts:
    """``provides_of`` and the entitlement of a verified record payload."""
    e = record.get("entitlement") if isinstance(record, dict) else None
    return ProvidesFacts(provides=provides_of(record), entitlement=e if isinstance(e, str) else None)


def entitled(facts: ProvidesFacts, granted: Optional[Set[str]]) -> bool:
    """Whether the licence lets a pack answer: ungated, no License service, or the flag
    granted."""
    return facts.entitlement is None or granted is None or facts.entitlement in granted


@dataclass(frozen=True)
class PackProvider:
    """What ``pack_for`` answers: the pack whose target release provides the id."""

    pack_id: str
    release: ReleasePin

    def to_dict(self) -> Dict[str, Any]:
        return {"packId": self.pack_id, "release": self.release.to_dict()}


def memo_key(pack_id: str, sha256: str) -> str:
    """A memo key: the pack id and the record hash (a hash alone would let a target that names
    another pack's record answer for it)."""
    return f"{pack_id}\0{sha256}"


class ProvidesMemo:
    """``provides_facts`` of verified records, by ``memo_key`` (bounded: cleared when full)."""

    def __init__(self, limit: int = MAX_PROVIDES_MEMO) -> None:
        self._limit = limit
        self._facts: Dict[str, ProvidesFacts] = {}

    def get(self, sha256: str) -> Optional[ProvidesFacts]:
        return self._facts.get(sha256)

    def facts_of(self, sha256: str, jws: str) -> ProvidesFacts:
        """The facts of the verified record ``jws`` whose hash is ``sha256``."""
        hit = self._facts.get(sha256)
        if hit is not None:
            return hit
        f = provides_facts(verified_payload_of(jws))
        if len(self._facts) >= self._limit:
            self._facts.clear()
        self._facts[sha256] = f
        return f
