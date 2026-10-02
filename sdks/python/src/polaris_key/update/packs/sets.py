"""``pack_set_id`` (plans/P4-01.md §2.9; WIRE-CONTRACT-V4 §8) and the content stamp
(``pkey-content/1``, §2.8): ports of client-core's ``packs/set.ts`` and ``packs/stamp.ts``.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Union

from ...constants_generated import CONTENT_STAMP_FORMAT, ErrorCode
from ...core.jws import _parse_strict_json
from ...core.pack_claims import content_claims, holds_of, is_pack_id, is_sha256

__all__ = ["pack_set_id", "parse_content_stamp", "ParseContentStampResult", "stamp_holds"]


def pack_set_id(entries: Any) -> Optional[str]:
    """The SHA-256 of the UTF-8 lines ``<packId> <releaseSha256>\\n``, sorted by pack-id bytes.
    ``None`` when a pack id is invalid, a release is not 64 lowercase hex, or a pack is listed
    twice. The empty set hashes the empty string. Entries are mappings with ``packId`` and
    ``releaseSha256``. Never raises."""
    if not isinstance(entries, (list, tuple)):
        return None
    seen = set()
    rows = []
    for e in entries:
        if not isinstance(e, dict):
            return None
        pid, rel = e.get("packId"), e.get("releaseSha256")
        if not is_pack_id(pid) or not is_sha256(rel):
            return None
        if pid in seen:
            return None
        seen.add(pid)
        rows.append((str(pid), str(rel)))
    rows.sort(key=lambda r: r[0].encode("utf-8"))
    text = "".join(f"{p} {r}\n" for p, r in rows)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ParseContentStampResult:
    ok: bool
    content: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        if self.ok:
            return {"ok": True, "content": self.content}
        return {"ok": False, "error": self.error}


_INVALID = ParseContentStampResult(ok=False, error=ErrorCode.CONTENT_STAMP_INVALID)


def parse_content_stamp(data: Union[bytes, str]) -> ParseContentStampResult:
    """Parse a content stamp file's bytes (or its text): strict JSON, ``format ==
    "pkey-content/1"`` and §2.4's ``content`` claims over ``contentApi``, ``pins`` and
    ``expects``. Unknown members are ignored. Returns the three members, or
    ``content-stamp-invalid``. Never raises."""
    try:
        if isinstance(data, str):
            raw = data.encode("utf-8", "surrogatepass")
        elif isinstance(data, (bytes, bytearray, memoryview)):
            raw = bytes(data)
        else:
            return _INVALID
        try:
            doc = _parse_strict_json(raw)
        except Exception:
            return _INVALID
        if not isinstance(doc, dict) or doc.get("format") != CONTENT_STAMP_FORMAT:
            return _INVALID
        if not content_claims(doc):
            return _INVALID
        return ParseContentStampResult(
            ok=True,
            content={
                "contentApi": doc["contentApi"],
                "pins": doc["pins"],
                "expects": doc["expects"],
            },
        )
    except Exception:
        return _INVALID



def stamp_holds(data: Union[bytes, str]) -> Optional[List[Dict[str, Any]]]:
    """The holds of a content stamp file (plans/P4-13.md §2.4): strict JSON, then ``holds_of``
    at the stamp's top level. ``parse_content_stamp``'s result is unchanged and carries no
    holds; a host that runs the content decision reads them with this. ``None`` when the stamp
    does not parse or its holds are unusable. Never raises."""
    try:
        if isinstance(data, str):
            raw = data.encode("utf-8", "surrogatepass")
        elif isinstance(data, (bytes, bytearray, memoryview)):
            raw = bytes(data)
        else:
            return None
        return holds_of(_parse_strict_json(raw))
    except Exception:
        return None
