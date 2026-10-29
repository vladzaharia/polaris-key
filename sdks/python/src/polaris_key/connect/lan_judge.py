"""Which peer addresses the LAN adapter dials and accepts (WIRE-CONTRACT-V5 §15.4.1), around
:func:`~polaris_key.core.peer_lan_address.lan_verdict`. Mirrors ``sdk-node/src/connect/lanJudge.ts``.

- the address TEXT is judged before a socket is opened, and the connected socket again (its remote and its
  own local address) before its first byte, on a dial and on an accept;
- the pre-handshake limiter counts per address (4), per /64 (16) and in total (32); a link-local key
  carries its zone, because the same fe80 address on two links is two hosts.
"""

from __future__ import annotations

import socket
from typing import Any, Dict, Hashable, NamedTuple, Optional, Set

from ..core.peer_lan_address import LanVerdict, is_link_local, lan_group_key, lan_verdict, split_zone

__all__ = [
    "LimiterKeys",
    "PendingLimiter",
    "limiter_keys",
    "socket_text",
    "socket_verdict",
    "text_verdict",
]

_REFUSED = LanVerdict(False, None)


def text_verdict(host: str, allow_loopback: bool) -> bool:
    """Judge an address before opening a socket. A global IPv6 address (or a ULA one) passes here when it
    could be on-link: the connected socket decides, with its own local address."""
    # The address itself stands in for "some local address in the same /64".
    return lan_verdict(host, split_zone(host)[0], allow_loopback).dial


def socket_text(addr: Any) -> Optional[str]:
    """The address text of a ``getpeername`` or ``getsockname`` result (a 2-tuple or a 4-tuple). A
    link-local IPv6 address takes its interface name as the zone when the platform gave none."""
    if not addr:
        return None
    host = str(addr[0])
    base, zone = split_zone(host)
    if zone is None and len(addr) >= 4 and addr[3] and is_link_local(base):
        try:
            host = "%s%%%s" % (base, socket.if_indextoname(int(addr[3])))
        except (OSError, ValueError):
            host = "%s%%%d" % (base, int(addr[3]))
    return host


def socket_verdict(remote: Optional[str], local: Optional[str], allow_loopback: bool) -> LanVerdict:
    """Judge a connected socket's addresses: after ``connect``, and at ``accept``, before any byte."""
    if not remote:
        return _REFUSED
    return lan_verdict(remote, local, allow_loopback)


class LimiterKeys(NamedTuple):
    #: The per-address key: the verdict's key (a link-local one keeps its zone).
    address: str
    #: The /64 the address sits in (a link-local one with its zone); ``None`` for IPv4.
    net64: Optional[str]


def limiter_keys(key: str) -> LimiterKeys:
    """The keys the limiter counts under, for an address ``lan_verdict`` allowed (``key``)."""
    return LimiterKeys(key, lan_group_key(key))


class PendingLimiter:
    """Counts of sockets that have not finished the handshake: in total, per address and per /64."""

    def __init__(self, maximum: int = 32, per_address: int = 4, per_64: int = 16) -> None:
        self._max, self._per_address, self._per_64 = maximum, per_address, per_64
        self._total: Set[Hashable] = set()
        self._addr: Dict[str, int] = {}
        self._net: Dict[str, int] = {}

    @property
    def size(self) -> int:
        return len(self._total)

    @property
    def empty(self) -> bool:
        return not self._total and not self._addr and not self._net

    def take(self, who: Hashable, k: LimiterKeys) -> Optional[Any]:
        """Take a slot for ``who``; returns the release, or ``None`` when a limit is met."""
        if len(self._total) >= self._max or self._addr.get(k.address, 0) >= self._per_address:
            return None
        if k.net64 is not None and self._net.get(k.net64, 0) >= self._per_64:
            return None
        self._total.add(who)
        self._bump(self._addr, k.address, 1)
        if k.net64 is not None:
            self._bump(self._net, k.net64, 1)
        done = [False]

        def release() -> None:
            if done[0]:
                return
            done[0] = True
            self._total.discard(who)
            self._bump(self._addr, k.address, -1)
            if k.net64 is not None:
                self._bump(self._net, k.net64, -1)

        return release

    @staticmethod
    def _bump(m: Dict[str, int], key: str, by: int) -> None:
        n = m.get(key, 0) + by
        if n <= 0:
            m.pop(key, None)
        else:
            m[key] = n
