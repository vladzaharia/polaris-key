"""Dialling several learned addresses for one device (WIRE-CONTRACT-V5 §15.4.1, RFC 8305). Mirrors
``sdk-node/src/connect/dial.ts``: the addresses are tried in first-seen order, at most two attempts in
flight, a new one every 250 ms (at once when one fails). The first connection that passes the verdict on
its own addresses wins; every other socket closes before a byte is sent on it.

The address text is judged before a socket exists, and the connected socket's remote and local addresses
again before it is handed back. A zone selects the interface of a link-local address through
``if_nametoindex``; the connect takes a literal sockaddr and never a resolver.
"""

from __future__ import annotations

import asyncio
import socket
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from ..core.peer_lan_address import fold_mapped, parse_address, split_zone, text6
from .lan_judge import socket_text, socket_verdict, text_verdict

__all__ = ["DIAL_MAX_IN_FLIGHT", "DIAL_STAGGER_SECONDS", "dial_race", "sockaddr_of"]

DIAL_STAGGER_SECONDS = 0.25
DIAL_MAX_IN_FLIGHT = 2

#: Replace ``loop.sock_connect`` (a test's seam).
Connector = Callable[[socket.socket, Any], Awaitable[None]]


class DialRefused(OSError):
    """An address that fails the verdict, before or after the connect."""


def sockaddr_of(host: str, port: int) -> Tuple[int, Any]:
    """``(family, sockaddr)`` for an address literal the verdict allowed. An IPv4-mapped address connects as
    its IPv4 address; a link-local one takes its zone as the scope id. Raises :class:`DialRefused` for
    anything else."""
    addr, zone = split_zone(host)
    p = parse_address(host)
    if p is None:
        raise DialRefused("address refused")
    if p[0] == "v4":
        return socket.AF_INET, (addr, port)
    mapped = fold_mapped(text6(p[1]))
    if mapped != text6(p[1]):
        return socket.AF_INET, (mapped, port)
    scope = 0
    if zone is not None:
        try:
            scope = socket.if_nametoindex(zone)
        except OSError:
            if not zone.isascii() or not zone.isdigit():
                raise DialRefused("unknown interface") from None
            scope = int(zone)
    return socket.AF_INET6, (text6(p[1]), port, 0, scope)


async def _attempt(host: str, port: int, allow_loopback: bool, connect: Optional[Connector]) -> socket.socket:
    family, sockaddr = sockaddr_of(host, port)
    s = socket.socket(family, socket.SOCK_STREAM)
    try:
        s.setblocking(False)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        loop = asyncio.get_running_loop()
        await (connect or loop.sock_connect)(s, sockaddr)
        # The connected socket is judged on its own addresses before anything is written.
        remote, local = socket_text(s.getpeername()), socket_text(s.getsockname())
        if not socket_verdict(remote, local, allow_loopback).dial:
            raise DialRefused("address refused")
        return s
    except BaseException:
        s.close()
        raise


async def dial_race(
    hosts: List[str],
    port: int,
    allow_loopback: bool,
    *,
    stagger: float = DIAL_STAGGER_SECONDS,
    max_in_flight: int = DIAL_MAX_IN_FLIGHT,
    timeout: float = 10.0,
    connect: Optional[Connector] = None,
) -> Tuple[socket.socket, str]:
    """Race ``hosts``. Returns the winning connected socket (non-blocking, no byte sent) and the host it
    reached; raises the last failure (an ``OSError``) when none connects."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    tasks: Dict["asyncio.Task[socket.socket]", Tuple[int, str]] = {}
    nxt = 0
    last: BaseException = DialRefused("no address")
    try:
        while True:
            # Start one attempt when there is room; an address that fails the text verdict costs nothing.
            while nxt < len(hosts) and len(tasks) < max_in_flight:
                host = hosts[nxt]
                nxt += 1
                if not text_verdict(host, allow_loopback):
                    last = DialRefused("address refused")
                    continue
                t = loop.create_task(_attempt(host, port, allow_loopback, connect))
                tasks[t] = (nxt, host)
                break
            if not tasks:
                raise last
            left = deadline - loop.time()
            if left <= 0:
                raise OSError("timed out")
            # More to try and room to try it: wait one stagger, then start the next. Otherwise wait for a result.
            more = nxt < len(hosts) and len(tasks) < max_in_flight
            done, _ = await asyncio.wait(
                list(tasks), timeout=min(stagger, left) if more else left, return_when=asyncio.FIRST_COMPLETED
            )
            won: Optional[Tuple[int, str, socket.socket]] = None
            for t in sorted(done, key=lambda f: tasks[f][0]):
                order, host = tasks.pop(t)
                exc = t.exception()
                if exc is not None:
                    last = exc
                elif won is None:
                    won = (order, host, t.result())
                else:
                    t.result().close()  # a second winner in the same round: closed before a byte
            if won is not None:
                return won[2], won[1]
    finally:
        # Every other attempt ends here, and a socket one of them had just connected closes unused.
        for t in tasks:
            t.cancel()
        if tasks:
            for r in await asyncio.gather(*tasks, return_exceptions=True):
                if isinstance(r, socket.socket):
                    r.close()
