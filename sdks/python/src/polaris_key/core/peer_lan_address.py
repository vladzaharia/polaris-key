"""WIRE-CONTRACT-V5 §15.4.1: the LAN address rule. Which peer address a device may dial or accept on
the local network, and the keys of the per-address and per-/64 connection counts. Mirrors
``packages/client-core/src/peer/lanAddress.ts`` (``lanVerdict``, ``lanGroupKey``) and runs the
``lanAddresses`` rows of ``peer-matrix.json``.

Pure: text in, a verdict out. The caller passes the socket's remote address and its own local address
(the on-link tests for a ULA and a global IPv6 address need it) and applies the verdict before the first
byte on a dial and before a slot and before any read on an accept.

The parser takes literals only. It never calls a resolver, ``inet_aton``, ``getaddrinfo``, the
``ipaddress`` module or a URL parser, because those accept spellings the contract refuses (a leading
zero, a trailing newline, Unicode digits, a whole-number form, a scope on a mapped address). Every
character class below is spelt out in ASCII: ``\\d`` and ``str.isdigit`` are not used, and ``$`` is not
used where ``\\Z`` is meant.

- Spelling: a zone is ``%`` and 1 to 15 characters of U+0021 to U+007E other than ``%``; any other zone,
  a second ``%``, a zone on IPv4 and a zone on an IPv4-mapped address are malformed. The verdict ignores
  a zone; the key of a link-local address keeps it.
- An IPv4-mapped address (``::ffff:0:0/96``) is judged as its IPv4 address.
- IPv4: 10/8, 172.16/12 and 192.168/16; 127/8 only with ``allow_loopback``.
- IPv6: fe80::/10; fc00::/7 (when ``local`` is known it must be IPv6 in the same /64); ``::1`` only with
  ``allow_loopback``; an address in 2000::/3 outside 2001::/32 (Teredo) and 2002::/16 (6to4) only when the
  local address is IPv6 in the same /64.
- Everything else is refused, including text that is not an address.
"""

from __future__ import annotations

import re
from typing import List, NamedTuple, Optional, Tuple

__all__ = [
    "LanVerdict",
    "canon_ip",
    "fold_mapped",
    "in_cidr",
    "is_link_local",
    "lan_group_key",
    "lan_verdict",
    "parse_address",
    "split_zone",
    "text6",
]

_DEC = "0123456789"
_HEX = "0123456789abcdefABCDEF"
#: §15.4.1: 1 to 15 characters of U+0021 to U+007E other than ``%``. ``fullmatch``: no trailing newline.
_ZONE = re.compile(r"[\x21-\x24\x26-\x7e]{1,15}")


class LanVerdict(NamedTuple):
    #: The address may be dialled or accepted.
    dial: bool
    #: The per-address count key: dotted IPv4, or RFC 5952 lower-case IPv6 text; a link-local address
    #: keeps its zone (``fe80::1%en0``), any other drops it. ``None`` when ``dial`` is false.
    key: Optional[str]


_REFUSED = LanVerdict(False, None)

#: A parsed address: ("v4", [4 octets]) or ("v6", [8 groups]), and the zone (``None``: none).
Parsed = Tuple[str, List[int], Optional[str]]


def _parse_v4(s: str) -> Optional[List[int]]:
    parts = s.split(".")
    if len(parts) != 4:
        return None
    out: List[int] = []
    for p in parts:
        # Decimal, ASCII, no sign and no leading zero (some parsers read a leading zero as octal).
        if not 1 <= len(p) <= 3 or any(c not in _DEC for c in p) or (len(p) > 1 and p[0] == "0"):
            return None
        n = int(p)
        if n > 255:
            return None
        out.append(n)
    return out


def _groups(part: str, last: bool) -> Optional[List[int]]:
    if part == "":
        return []
    items = part.split(":")
    out: List[int] = []
    for i, it in enumerate(items):
        if "." in it:
            # Dotted IPv4 closes the address and stands for two groups.
            if not last or i != len(items) - 1:
                return None
            o = _parse_v4(it)
            if o is None:
                return None
            out.extend((o[0] * 256 + o[1], o[2] * 256 + o[3]))
        elif 1 <= len(it) <= 4 and all(c in _HEX for c in it):
            out.append(int(it, 16))
        else:
            return None
    return out


def _parse_v6(s: str) -> Optional[List[int]]:
    if not s or any(c not in _HEX + ":." for c in s):
        return None
    halves = s.split("::")
    if len(halves) > 2:
        return None
    if len(halves) == 1:
        g = _groups(s, True)
        return g if g is not None and len(g) == 8 else None
    head = _groups(halves[0], False)
    tail = _groups(halves[1], True)
    if head is None or tail is None:
        return None
    gap = 8 - len(head) - len(tail)  # ``::`` stands for one or more zero groups
    if gap < 1:
        return None
    return head + [0] * gap + tail


def split_zone(text: str) -> Tuple[str, Optional[str]]:
    """``text`` without its ``%zone``, and the zone (``None``: none). Splits at the first ``%`` only."""
    i = text.find("%")
    return (text, None) if i < 0 else (text[:i], text[i + 1 :])


def parse_address(text: str) -> Optional[Parsed]:
    """Parse an address literal (with an optional zone), or ``None``. An IPv4-mapped address stays IPv6
    here; a zone on IPv4 and a malformed zone are refused. See :func:`lan_verdict` for the fold."""
    if not isinstance(text, str):
        return None
    s, zone = split_zone(text)
    if zone is not None:
        if _ZONE.fullmatch(zone) is None:
            return None  # empty, a second ``%``, a control, a space, too long
        if ":" not in s:
            return None  # only IPv6 carries a zone
    if ":" in s:
        g = _parse_v6(s)
        return None if g is None else ("v6", g, zone)
    o = _parse_v4(s)
    return None if o is None else ("v4", o, None)


def _mapped(g: List[int]) -> bool:
    return all(x == 0 for x in g[:5]) and g[5] == 0xFFFF


def _fold(p: Parsed) -> Optional[Parsed]:
    """An IPv4-mapped address as its IPv4 address; a zone on a mapped address is malformed (``None``)."""
    kind, g, zone = p
    if kind == "v6" and _mapped(g):
        if zone is not None:
            return None
        return ("v4", [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255], None)
    return p


def text6(g: List[int]) -> str:
    """RFC 5952: lower case, no leading zeros, the first longest run of two or more zero groups as ``::``."""
    at, length, i = -1, 0, 0
    while i < 8:
        if g[i] != 0:
            i += 1
            continue
        j = i
        while j < 8 and g[j] == 0:
            j += 1
        if j - i > length:
            at, length = i, j - i
        i = j

    def join(xs: List[int]) -> str:
        return ":".join("%x" % x for x in xs)

    if length < 2:
        return join(g)
    return join(g[:at]) + "::" + join(g[at + length :])


def canon_ip(text: str) -> Optional[str]:
    """The canonical text of an address with no zone (dotted IPv4, or RFC 5952 IPv6; a mapped address
    keeps its IPv6 form), or ``None`` for text that is not an address or carries a zone."""
    if not isinstance(text, str) or "%" in text:
        return None
    p = parse_address(text)
    if p is None:
        return None
    return ".".join(str(x) for x in p[1]) if p[0] == "v4" else text6(p[1])


def fold_mapped(canon: str) -> str:
    """Canonical text of an IPv4-mapped address as dotted IPv4; anything else unchanged."""
    p = parse_address(canon)
    if p is None or p[0] != "v6" or not _mapped(p[1]) or p[2] is not None:
        return canon
    f = _fold(p)
    return canon if f is None else ".".join(str(x) for x in f[1])


def is_link_local(canon: str) -> bool:
    """Is the address (no zone needed) in fe80::/10?"""
    p = parse_address(canon)
    return p is not None and p[0] == "v6" and (p[1][0] & 0xFFC0) == 0xFE80


def _allowed4(o: List[int], allow_loopback: bool) -> bool:
    a, b = o[0], o[1]
    if a == 10:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    return a == 127 and allow_loopback


def _same64(g: List[int], local: Optional[str]) -> bool:
    """``local`` is IPv6 (not mapped) and shares the first 64 bits with ``g``."""
    if local is None:
        return False
    lp = parse_address(local)
    if lp is None or lp[0] != "v6" or _mapped(lp[1]):
        return False
    return lp[1][:4] == g[:4]


def lan_verdict(remote: str, local: Optional[str], allow_loopback: bool) -> LanVerdict:
    """Judge a peer address.

    ``remote`` is the socket's remote address, with or without a zone. ``local`` is the socket's own
    address; ``None`` when unknown (a global IPv6 address is then refused, and a ULA address is judged on
    its own). ``allow_loopback`` accepts 127/8 and ``::1``: tests and same-host peers only, production code
    never sets it and it is not public API.
    """
    p0 = parse_address(remote)
    p = None if p0 is None else _fold(p0)
    if p is None:
        return _REFUSED
    kind, g, zone = p
    if kind == "v4":
        return LanVerdict(True, ".".join(str(x) for x in g)) if _allowed4(g, allow_loopback) else _REFUSED
    accept = LanVerdict(True, text6(g))
    g0 = g[0]
    if all(x == 0 for x in g[:7]) and g[7] == 1:  # ::1
        return accept if allow_loopback else _REFUSED
    if (g0 & 0xFFC0) == 0xFE80:  # fe80::/10
        return LanVerdict(True, text6(g) if zone is None else "%s%%%s" % (text6(g), zone))
    if (g0 & 0xFE00) == 0xFC00:
        # fc00::/7 is routed, so it is on-link only when the local address says so.
        if local is None:
            return accept
        return accept if _same64(g, local) else _REFUSED
    if (g0 & 0xE000) != 0x2000:  # not 2000::/3
        return _REFUSED
    if g0 == 0x2001 and g[1] == 0:  # Teredo 2001::/32
        return _REFUSED
    if g0 == 0x2002:  # 6to4 2002::/16
        return _REFUSED
    if local is None:
        return _REFUSED
    return accept if _same64(g, local) else _REFUSED


def lan_group_key(key: Optional[str]) -> Optional[str]:
    """The key of the per-/64 count for a verdict ``key``: the /64 of an IPv6 address
    (``2001:db8:1:2::/64``; a link-local /64 keeps the zone, ``fe80::/64%en0``), ``None`` for IPv4 and
    for no key."""
    if key is None or ":" not in key:
        return None
    p0 = parse_address(key)
    p = None if p0 is None else _fold(p0)
    if p is None or p[0] != "v6":
        return None
    text = text6(p[1][:4] + [0, 0, 0, 0]) + "/64"
    return text if p[2] is None else "%s%%%s" % (text, p[2])


def _bits(p: Parsed) -> Tuple[int, int]:
    """``(value, width)`` of a parsed address."""
    if p[0] == "v4":
        return int.from_bytes(bytes(p[1]), "big"), 32
    v = 0
    for x in p[1]:
        v = (v << 16) | x
    return v, 128


def in_cidr(addr: str, cidr: str) -> bool:
    """Is ``addr`` (a zone is ignored; an IPv4-mapped address counts as its IPv4) inside the block
    ``cidr`` (``192.168.1.9/24``, ``fe80::1/64``; host bits in the base are fine)? Literals only."""
    base_text, sep, plen = cidr.rpartition("/")
    if not sep or not plen or len(plen) > 3 or any(c not in _DEC for c in plen):
        return False
    b0, a0 = parse_address(split_zone(base_text)[0]), parse_address(split_zone(addr)[0])
    base = None if b0 is None else _fold(b0)
    a = None if a0 is None else _fold(a0)
    if base is None or a is None or base[0] != a[0]:
        return False
    (x, width), (y, _) = _bits(a), _bits(base)
    n = int(plen)
    if n > width:
        return False
    shift = width - n
    return (x >> shift) == (y >> shift)
