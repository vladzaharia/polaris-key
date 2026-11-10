"""Test clock helpers: time a test controls, and waits that end on a condition, not a duration.

``FakeClock`` is a callable for the SDK's injectable ``clock`` parameters. ``until`` waits for a
condition (its timeout is only the failure deadline). ``barrier`` lets work already queued on the
Connect loop run, so a "nothing happened" check is made after the loop had its turn.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, Callable


class FakeClock:
    """Monotonic seconds that move only when the test says so."""

    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> float:
        self.t += seconds
        return self.t


def until(cond: Callable[[], Any], timeout: float = 15.0) -> None:
    """Return once ``cond()`` is truthy; raise ``AssertionError`` after ``timeout`` (a failure bound)."""
    end = time.monotonic() + timeout
    tick = threading.Event()
    while not cond():
        if time.monotonic() > end:
            raise AssertionError("timed out waiting for the condition")
        tick.wait(0.005)


def barrier(rounds: int = 5) -> None:
    """Let everything queued on the Connect loop run, ``rounds`` turns deep."""
    from polaris_key.connect.loop import connect_loop

    async def turns() -> None:
        for _ in range(rounds):
            await asyncio.sleep(0)

    connect_loop().submit(turns()).result(10)
