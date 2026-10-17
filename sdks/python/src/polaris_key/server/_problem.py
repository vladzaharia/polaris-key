"""The refusal's problem body, challenge and locale (WIRE-CONTRACT-V4 §14.3).

Mirrors ``backendLocale`` and ``backendProblem`` in ``@polaris-key/client-core``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Dict, Optional

from ._copy import COPY
from ._verdict import AUTH_SCHEME, REFUSAL_STATUS

__all__ = ["Problem", "backend_locale", "backend_problem", "PROBLEM_TYPE_BASE", "LOCALES"]

LOCALES = ("en", "de", "es", "it", "ja", "ko", "pt-BR", "zh-Hans")
PROBLEM_TYPE_BASE = "https://key.plrs.im/docs/reference/error-codes/#"
CONTENT_TYPE = "application/problem+json"

_QVALUE = re.compile(r"(0(\.[0-9]{0,3})?|1(\.0{0,3})?)")
_ASCII_UPPER = {c: c + 32 for c in range(ord("A"), ord("Z") + 1)}


def _lower(s: str) -> str:
    return s.translate(_ASCII_UPPER)


def _range_locale(rng: str) -> Optional[str]:
    if rng == "*":
        return "en"
    tag = _lower(rng)
    for loc in LOCALES:
        if _lower(loc) == tag:
            return loc
    parts = tag.split("-")
    lang = parts[0]
    second = parts[1] if len(parts) > 1 else None
    if lang == "zh":
        return None if second in ("tw", "hk", "mo", "hant") else "zh-Hans"
    if lang == "pt":
        return "pt-BR"
    return lang if lang in LOCALES else None


def backend_locale(accept_language: Optional[str]) -> str:
    """The copy locale for an ``Accept-Language`` value; English with no match."""
    if accept_language is None:
        return "en"
    ranges = []
    for at, element in enumerate(accept_language.split(",")):
        head, *params = element.split(";")
        rng = head.strip(" \t")
        q = 1.0
        valid = True
        for param in params:
            p = param.strip(" \t")
            eq = p.find("=")
            name = p if eq < 0 else p[:eq].rstrip(" \t")
            if _lower(name) != "q":
                continue
            value = "" if eq < 0 else p[eq + 1 :].lstrip(" \t")
            if not _QVALUE.fullmatch(value):
                valid = False
                break
            q = float(value)
            break
        if valid and rng and q > 0:
            ranges.append((-q, at, rng))
    ranges.sort()
    for _, _, rng in ranges:
        loc = _range_locale(rng)
        if loc:
            return loc
    return "en"


@dataclass(frozen=True)
class Problem:
    """A refusal: status, the ``WWW-Authenticate`` challenge on a 401, and the RFC 9457 body."""

    code: str
    status: int
    locale: str
    challenge: Optional[str]
    type: str
    title: str
    detail: str
    headers: Dict[str, str] = field(default_factory=dict)

    @property
    def body(self) -> Dict[str, object]:
        """The JSON body. It never names the step that refused, the header or a claim."""
        return {
            "type": self.type,
            "title": self.title,
            "status": self.status,
            "detail": self.detail,
            "code": self.code,
        }

    def body_bytes(self) -> bytes:
        return json.dumps(self.body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def backend_problem(code: str, realm: str, accept_language: Optional[str] = None) -> Problem:
    status = REFUSAL_STATUS[code]
    locale = backend_locale(accept_language)
    entry = COPY.get(locale, {}).get(code)
    if entry is None:
        locale = "en"
        entry = COPY["en"][code]
    title, detail = entry
    challenge = f'{AUTH_SCHEME} realm="{realm}", error="{code}"' if status == 401 else None
    headers = {"Content-Type": CONTENT_TYPE, "Cache-Control": "no-store"}
    if challenge:
        headers["WWW-Authenticate"] = challenge
    return Problem(code, status, locale, challenge, PROBLEM_TYPE_BASE + code, title, detail, headers)
