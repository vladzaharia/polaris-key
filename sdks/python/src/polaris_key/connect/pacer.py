"""Outgoing pacing for the relay socket (CC-10.14, decision D-9; WIRE-CONTRACT-V5 §15.7, G17). The room
allows a client 200 messages a second with a burst of 400 and answers a client that exceeds it with LIMIT 1
and, if it persists, a close; this client stays under it:

- a token bucket on every outgoing envelope: 180 a second with a burst of 360 (0.9 of the room's numbers);
- LIMIT 1 halves the rate for 10 seconds;
- the queue behind the socket holds at most 8 MiB. A host send that would go beyond it is refused with
  ``rate_limited`` before anything is encrypted, so the session's keys never advance for a message that
  was not queued.

Pure bookkeeping over an injected clock and sleep: nothing here touches a socket."""

from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Awaitable, Callable, Deque, Optional

__all__ = ["BURST", "HALVED_SECONDS", "MAX_QUEUED_BYTES", "Outbox", "Pacer", "RATE"]

RATE = 180.0
BURST = 360.0
HALVED_SECONDS = 10.0
MAX_QUEUED_BYTES = 8 * 1024 * 1024


class Pacer:
    """A token bucket. ``acquire`` waits until one token is available."""

    def __init__(
        self,
        rate: float = RATE,
        burst: float = BURST,
        clock: Callable[[], float] = time.monotonic,
        sleep: Optional[Callable[[float], Awaitable[None]]] = None,
    ) -> None:
        self._rate = rate
        self._burst = burst
        self._clock = clock
        self._sleep: Callable[[float], Awaitable[None]] = sleep or asyncio.sleep
        self._tokens = burst
        self._at = clock()
        self._halved_until = float("-inf")

    @property
    def rate(self) -> float:
        """The rate in force now: half the base rate while a LIMIT 1 is being honoured."""
        return self._rate / 2 if self._clock() < self._halved_until else self._rate

    def halve(self, seconds: float = HALVED_SECONDS) -> None:
        """LIMIT 1: send at half the rate for ``seconds``."""
        self._refill()
        self._halved_until = self._clock() + seconds
        self._tokens = min(self._tokens, self._burst / 2)

    def _refill(self) -> None:
        now = self._clock()
        if now > self._at:
            self._tokens = min(self._burst, self._tokens + (now - self._at) * self.rate)
        self._at = now

    def try_take(self) -> float:
        """0.0 when a token was taken; else how many seconds until one is available."""
        self._refill()
        if self._tokens >= 1:
            self._tokens -= 1
            return 0.0
        return (1 - self._tokens) / self.rate

    async def acquire(self) -> None:
        while True:
            wait = self.try_take()
            if wait <= 0:
                return
            await self._sleep(wait)


class Outbox:
    """The envelopes waiting for the socket, with their byte count. ``put`` refuses (False) a non-forced
    item that would take the queue past ``max_bytes``; handshake and control envelopes are forced, since
    refusing one would stall a session without telling the host."""

    def __init__(self, max_bytes: int = MAX_QUEUED_BYTES) -> None:
        self.max_bytes = max_bytes
        self._q: Deque[bytes] = deque()
        self._bytes = 0
        self._ready = asyncio.Event()
        self._inflight = False

    @property
    def queued(self) -> int:
        return self._bytes

    def __len__(self) -> int:
        return len(self._q)

    def room_for(self, n: int) -> bool:
        return self._bytes + n <= self.max_bytes

    def put(self, data: bytes, force: bool = False) -> bool:
        if not force and not self.room_for(len(data)):
            return False
        self._q.append(data)
        self._bytes += len(data)
        self._ready.set()
        return True

    async def get(self) -> bytes:
        while not self._q:
            self._ready.clear()
            await self._ready.wait()
        data = self._q.popleft()
        self._bytes -= len(data)
        self._inflight = True
        return data

    def sent(self) -> None:
        """The item ``get`` returned has been written (or given up on)."""
        self._inflight = False

    async def drained(self, timeout: float) -> bool:
        """Wait (polling) until nothing is queued, or ``timeout`` seconds."""
        end = time.monotonic() + timeout
        while self._q or self._inflight:
            if time.monotonic() >= end:
                return False
            await asyncio.sleep(0.005)
        return True
