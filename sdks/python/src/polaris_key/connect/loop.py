"""The Connect loop (CC-10.4, decision D-3): one private asyncio event loop on one daemon thread,
started on first use. The engine under it is synchronous and pure; only socket work (TCP, mDNS, the
relay WebSocket) runs here, so a host that never starts Connect pays nothing. Nothing happens at
import: no thread, no loop, no ``asyncio`` import.

``submit(coro)`` runs a coroutine on the loop and returns a ``concurrent.futures.Future``; a host
callback never runs on the host's own thread through here. ``close()`` stops the loop and joins the
thread; the next ``submit`` starts a new one."""

from __future__ import annotations

import threading
from typing import Any, Awaitable, Callable, Optional

__all__ = ["ConnectLoop", "connect_loop"]


class ConnectLoop:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._loop: Any = None
        self._thread: Optional[threading.Thread] = None

    def __repr__(self) -> str:
        return "<ConnectLoop>"

    @property
    def running(self) -> bool:
        with self._lock:
            return self._thread is not None and self._thread.is_alive()

    def _ensure(self) -> Any:
        import asyncio

        with self._lock:
            if self._loop is not None and self._thread is not None and self._thread.is_alive():
                return self._loop
            loop = asyncio.new_event_loop()
            started = threading.Event()

            def run() -> None:
                asyncio.set_event_loop(loop)
                loop.call_soon(started.set)
                try:
                    loop.run_forever()
                finally:
                    try:
                        pending = asyncio.all_tasks(loop)
                        for t in pending:
                            t.cancel()
                        if pending:
                            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                        loop.run_until_complete(loop.shutdown_asyncgens())
                    finally:
                        loop.close()

            thread = threading.Thread(target=run, name="polaris-key-connect", daemon=True)
            thread.start()
            started.wait(5)
            self._loop, self._thread = loop, thread
            return loop

    def submit(self, coro: Awaitable[Any]) -> Any:
        """Run ``coro`` on the loop; the result is a ``concurrent.futures.Future``."""
        import asyncio

        loop = self._ensure()
        return asyncio.run_coroutine_threadsafe(coro, loop)  # type: ignore[arg-type]

    def call_soon(self, fn: Callable[..., Any], *args: Any) -> None:
        """Run a plain callable on the loop's thread, from any thread."""
        self._ensure().call_soon_threadsafe(fn, *args)

    def close(self, timeout: float = 5.0) -> None:
        """Stop the loop (cancelling what still runs) and join its thread. Safe to call twice, and
        from the loop's own thread (it then only asks the loop to stop)."""
        with self._lock:
            loop, thread = self._loop, self._thread
            self._loop = self._thread = None
        if loop is None or thread is None:
            return
        loop.call_soon_threadsafe(loop.stop)
        if thread is not threading.current_thread():
            thread.join(timeout)


_SHARED = ConnectLoop()


def connect_loop() -> ConnectLoop:
    """The process-wide loop; created empty, started by its first ``submit``."""
    return _SHARED
