"""The accept gate of every LAN listener, written once (WIRE-CONTRACT-V5 §15.4.1, §15.6.1 rule 2): the
protocol that judges a transport before a byte is read, the admission of an accepted transport into the
pre-handshake limiter, and the dual-stack listening socket. Mode a (``connect/lan.py``) and the mode v
approver (``core/peer_nearby.py``) share it; it lives in core/ so the approver loads without the Connect
package, and ``connect/lan.py`` re-exports the names."""

from __future__ import annotations

import asyncio
import os
import socket
from typing import Any, Awaitable, Callable, NamedTuple, Optional

from .peer_lan_judge import PendingLimiter, limiter_keys, socket_text, socket_verdict

__all__ = ["Admitted", "GatedProtocol", "admit_transport", "listen_socket"]


class GatedProtocol(asyncio.StreamReaderProtocol):
    """``start_server``'s protocol with the address gate in ``connection_made``: a transport the gate
    refuses is aborted there, before its reader is added, so no byte is ever read from it."""

    def __init__(
        self,
        reader: asyncio.StreamReader,
        callback: Callable[[Any, Any], Awaitable[None]],
        gate: Callable[[Any], bool],
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        super().__init__(reader, callback, loop=loop)
        self._gate = gate

    def connection_made(self, transport: Any) -> None:
        if not self._gate(transport):
            transport.abort()
            return
        super().connection_made(transport)


class Admitted(NamedTuple):
    """An accepted transport that passed the gate: its slot's ``release`` and the judged source address
    (a link-local one keeps its zone)."""

    release: Callable[[], None]
    address: str


def admit_transport(
    transport: Any, limit: PendingLimiter, allow_loopback: bool, refuse: bool = False
) -> Optional[Admitted]:
    """The accept gate of every LAN listener (mode a and the mode v approver), written once (§15.4.1,
    §15.6.1 rule 2). The transport is judged on its own peer and local address, before a slot and before any
    byte is read; one that fails the verdict, or is refused for capacity (``refuse``), or meets a limit,
    gets ``None`` and the caller closes it. Otherwise it holds a slot until ``release()``."""
    v = socket_verdict(
        socket_text(transport.get_extra_info("peername")),
        socket_text(transport.get_extra_info("sockname")),
        allow_loopback,
    )
    if not v.dial or v.key is None or refuse:
        return None
    release = limit.take(transport, limiter_keys(v.key))
    if release is None:
        return None
    return Admitted(release, v.key)


def listen_socket(host: Optional[str], port: int) -> "socket.socket":
    """One dual-stack ``::`` socket (``IPV6_V6ONLY`` off) so one port serves both families, or an IPv4
    socket where IPv6 is unavailable. An explicit ``host`` binds only that."""
    if host is None or ":" in host:
        s6: Optional[socket.socket] = None
        try:
            s6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
            if os.name == "posix":
                s6.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            s6.bind((host or "::", port))
            return s6
        except OSError:
            if s6 is not None:
                s6.close()
            if host is not None:
                raise
    s4 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if os.name == "posix":
            s4.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s4.bind((host or "0.0.0.0", port))
    except OSError:
        s4.close()
        raise
    return s4
