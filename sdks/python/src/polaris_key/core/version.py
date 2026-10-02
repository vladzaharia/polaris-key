"""Version ordering under a product's scheme — plans/P3-01.md §2.8 "Versions" (WIRE-CONTRACT-V4 §11).

A port of ``@polaris-key/client-core``'s ``version.ts``. P2-05's rules made exact: every
comparison is on digit strings (Python's ``int`` would be exact too, but the digit-string rule
is the one every SDK shares), and every grammar matches the WHOLE string with ASCII classes
through :func:`polaris_key.core.patterns._full_match`, so ``1.2.3\\n`` and ``١.٢.٣`` do not parse.
``update-matrix.json#/versionCases`` pins it.

The version schemes are not an enum (``semver+build`` and ``4part`` are not identifiers), so
they are the hand-written :data:`VERSION_SCHEMES`, which the matrix runner asserts against
``update-matrix.json#/vocabulary/schemes``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Tuple

from .patterns import _full_match

__all__ = ["VERSION_SCHEMES", "ParsedVersion", "parse_version", "compare_versions"]

#: The feed's ``app.versionScheme`` vocabulary (``FEED_VERSION_SCHEMES``), in order.
VERSION_SCHEMES: Tuple[str, ...] = ("semver", "semver+build", "4part")

#: SemVer 2.0's own grammar, with ASCII classes: no empty identifier, no leading zero in a
#: numeric prerelease identifier.
_SEMVER_RE = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
)

#: P2-04's ``FOUR_PART_RE``.
_FOUR_PART_RE = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
)

_DIGITS_RE = re.compile(r"[0-9]+")


@dataclass(frozen=True)
class ParsedVersion:
    """A version parsed under one scheme. ``core`` holds three digit strings (four for
    ``4part``); ``prerelease`` and ``build`` are ``None`` when absent (always for ``4part``)."""

    scheme: str
    core: Tuple[str, ...]
    prerelease: Optional[Tuple[str, ...]] = None
    build: Optional[str] = None


def parse_version(scheme: str, v: object) -> Optional[ParsedVersion]:
    """Parse ``v`` under ``scheme``, or ``None`` when it does not parse (or the scheme is
    unknown). Never raises."""
    if scheme in ("semver", "semver+build"):
        m = _full_match(_SEMVER_RE, v)
        if m is None:
            return None
        pre = m.group(4)
        return ParsedVersion(
            scheme=scheme,
            core=(m.group(1), m.group(2), m.group(3)),
            prerelease=None if pre is None else tuple(pre.split(".")),
            build=m.group(5),
        )
    if scheme == "4part":
        m = _full_match(_FOUR_PART_RE, v)
        if m is None:
            return None
        return ParsedVersion(scheme=scheme, core=(m.group(1), m.group(2), m.group(3), m.group(4)))
    return None


def _compare_digits(a: str, b: str) -> int:
    """Compare two unbounded non-negative integers given as ASCII digit strings."""
    x = a.lstrip("0") or "0"
    y = b.lstrip("0") or "0"
    if len(x) != len(y):
        return -1 if len(x) < len(y) else 1
    if x == y:
        return 0
    return -1 if x < y else 1


def _compare_ascii(a: str, b: str) -> int:
    if a == b:
        return 0
    return -1 if a < b else 1


def _compare_precedence(a: ParsedVersion, b: ParsedVersion) -> int:
    """SemVer 2.0 §11 precedence over two parsed semver versions; build metadata is ignored."""
    for k in range(3):
        c = _compare_digits(a.core[k], b.core[k])
        if c != 0:
            return c
    if a.prerelease is None and b.prerelease is None:
        return 0
    if a.prerelease is None:
        return 1
    if b.prerelease is None:
        return -1
    for x, y in zip(a.prerelease, b.prerelease):
        xn = _DIGITS_RE.fullmatch(x) is not None
        yn = _DIGITS_RE.fullmatch(y) is not None
        if xn and yn:
            c = _compare_digits(x, y)
        elif xn:
            c = -1
        elif yn:
            c = 1
        else:
            c = _compare_ascii(x, y)
        if c != 0:
            return c
    # A shorter list that is a prefix of a longer one is lower.
    la, lb = len(a.prerelease), len(b.prerelease)
    return 0 if la == lb else (-1 if la < lb else 1)


def compare_versions(scheme: str, a: object, b: object) -> Optional[int]:
    """``cmp(a, b)`` under ``scheme``: -1, 0 or 1, or ``None`` when either side does not parse.

    ``semver+build`` breaks a precedence tie with build metadata that is ASCII digits only,
    compared as an unbounded integer; a version without such metadata is lower than one with
    it. Never raises.
    """
    pa = parse_version(scheme, a)
    pb = parse_version(scheme, b)
    if pa is None or pb is None:
        return None
    if pa.scheme == "4part" or pb.scheme == "4part":
        for k in range(4):
            c = _compare_digits(pa.core[k], pb.core[k])
            if c != 0:
                return c
        return 0
    c = _compare_precedence(pa, pb)
    if c != 0 or scheme != "semver+build":
        return c
    na = pa.build if pa.build is not None and _DIGITS_RE.fullmatch(pa.build) else None
    nb = pb.build if pb.build is not None and _DIGITS_RE.fullmatch(pb.build) else None
    if na is None and nb is None:
        return 0
    if na is None:
        return -1
    if nb is None:
        return 1
    return _compare_digits(na, nb)
