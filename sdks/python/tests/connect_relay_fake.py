"""A faithful in-process relay room for the Cloud Connect tests (CC-10.13). It re-implements the CC-07
engine's observable framing (WIRE-CONTRACT-V5 §15.7) over the SDK's own envelope codec: a ticket is single
use and names the device; ``from`` is stamped from the admission, never read from the client; SEND reaches
the sockets of ``to``; LIST answers MEMBERS; PING answers PONG; an envelope that fails its layout closes
1008. Mirrors ``packages/sdk-node/test/relayFixtures.ts``. Not a test module."""

from __future__ import annotations

import asyncio
import secrets
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from polaris_key.connect.client import RelayGrant
from polaris_key.connect.relay import SocketClosed
from polaris_key.core.b64url import b64url_decode, b64url_encode
from polaris_key.core.peer_relay_codec import decode_relay, encode_relay

_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"


class FakeSocket:
    def __init__(self, room: "FakeRoom", url: str, protocols: List[str]) -> None:
        self.room = room
        self.url = url
        self.protocols = protocols
        self.device: Optional[str] = None
        self.closed = False
        self.close_code: Optional[int] = None
        self._q: "asyncio.Queue[Any]" = asyncio.Queue()
        self._loop = asyncio.get_running_loop()

    async def send(self, data: bytes) -> None:
        if self.closed:
            raise SocketClosed(self.close_code)
        self.room.from_client(self, bytes(data))

    async def recv(self) -> Any:
        item = await self._q.get()
        if isinstance(item, tuple):
            self._q.put_nowait(item)
            raise SocketClosed(item[1])
        return item

    async def close(self, code: int = 1000) -> None:
        self.shut(code)

    def shut(self, code: Optional[int]) -> None:
        """Either side closes: the client's next ``recv`` raises with ``code``."""
        if self.closed:
            return
        self.closed = True
        self.close_code = code
        if self in self.room.sockets:
            self.room.sockets.remove(self)
        self._put(("close", code))

    def _put(self, item: Any) -> None:
        # The room is driven from the test's thread as well as the loop's.
        self._loop.call_soon_threadsafe(self._q.put_nowait, item)

    def deliver(self, m: Any) -> None:
        if self.closed:
            return
        self._put(m if isinstance(m, (bytes, str)) else encode_relay(m))


class FakeRoom:
    def __init__(self, members: Set[str]) -> None:
        self.members_set = set(members)
        self.tickets: Dict[str, str] = {}
        self.sockets: List[FakeSocket] = []
        self.ever: List[FakeSocket] = []
        #: Every message a client sent, decoded, with the device that sent it.
        self.received: List[Tuple[str, Dict[str, Any]]] = []
        #: The subprotocol lists clients offered, in order.
        self.offered: List[List[str]] = []
        #: Close the next admission with this code.
        self.reject_with: Optional[int] = None
        self.issued = 0

    def issue(self, device: str, url: str = "wss://k.test/djdl/connect/relay") -> RelayGrant:
        self.issued += 1
        t = "pkeyrt_" + "".join(secrets.choice(_B64) for _ in range(32))
        self.tickets[t] = device
        return RelayGrant(t, url, "pkey-relay.1", 2_000_000_000)

    async def opener(self, url: str, protocols: List[str]) -> FakeSocket:
        s = FakeSocket(self, url, list(protocols))
        self.ever.append(s)
        self.offered.append(list(protocols))
        proto, ticket = (protocols + [None, None])[:2]  # type: ignore[list-item]
        if self.reject_with is not None:
            c, self.reject_with = self.reject_with, None
            raise SocketClosed(c)
        device = self.tickets.get(ticket) if ticket else None
        if proto != "pkey-relay.1" or device is None:
            raise SocketClosed(4001)
        del self.tickets[ticket]  # single use
        if device not in self.members_set:
            raise SocketClosed(4003)
        s.device = device
        mine = [x for x in self.sockets if x.device == device]
        if len(mine) >= 2:  # a third socket of a device replaces the oldest
            mine[0].shut(4009)
        self.sockets.append(s)
        return s

    def from_client(self, s: FakeSocket, data: bytes) -> None:
        m = decode_relay("toRoom", data)
        if m is None:
            return s.shut(1008)
        assert s.device is not None
        self.received.append((s.device, m))
        if m["op"] == "send":
            to = b64url_encode(m["to"])
            for t in [x for x in self.sockets if x.device == to]:
                t.deliver({"op": "recv", "from": b64url_decode(s.device), "session": m["session"], "noise": m["noise"]})
        elif m["op"] == "list":
            s.deliver(self.members())
        elif m["op"] == "ping":
            s.deliver({"op": "pong", "data": m["data"]})

    def members(self) -> Dict[str, Any]:
        ids = sorted({s.device for s in self.sockets if s.device})
        return {"op": "members", "devices": [b64url_decode(d) for d in ids]}

    def drop_all(self, code: Optional[int]) -> None:
        for s in list(self.sockets):
            s.shut(code)

    def push_ring(self, epoch: int) -> None:
        for s in self.sockets:
            s.deliver({"op": "ring", "epoch": epoch})

    def push(self, device: str, m: Any) -> None:
        for s in [x for x in self.sockets if x.device == device]:
            s.deliver(m)

    def sends(self, device: str) -> List[Dict[str, Any]]:
        return [m for d, m in self.received if d == device and m["op"] == "send"]


class ManualSleep:
    """An ``asyncio.sleep`` the test drives: nothing wakes until ``fire`` picks it."""

    def __init__(self) -> None:
        self.delays: List[float] = []
        self.pending: List[Tuple[float, "asyncio.Future[None]"]] = []

    async def __call__(self, seconds: float) -> None:
        fut: "asyncio.Future[None]" = asyncio.get_running_loop().create_future()
        self.delays.append(seconds)
        self.pending.append((seconds, fut))
        try:
            await fut
        finally:
            self.pending = [p for p in self.pending if p[1] is not fut]

    def fire(self, match: Callable[[float], bool]) -> bool:
        """Run on the loop's thread. True when a pending sleep matched and was woken."""
        for s, f in self.pending:
            if match(s) and not f.done():
                f.set_result(None)
                return True
        return False
