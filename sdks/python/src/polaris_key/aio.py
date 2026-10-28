"""``AsyncPolarisKeyClient`` — the client for asyncio hosts (SDK parity pass §2.3, SP-P05).

::

    client = await polaris_key.AsyncClient.create(**polaris_config.CONFIG)
    outcome = await client.boot()
    session = await client.identity.sign_in.start()
    outcome = await session.wait()   # cancellable
    async for p in client.update.packs.progress():            # pack download progress
        ...
    async for event in client.events.stream():                # license / config / … changes
        ...

It SHARES the core with :class:`~polaris_key.PolarisKeyClient` instead of duplicating it: one
verification path, one cache, one gate, one wire implementation, and the same corpus and
transcripts prove both. Every call that can touch the disk or the network runs the shared
synchronous core on a worker thread (``asyncio.to_thread``), so the event loop never blocks;
the sign-in session's ``wait`` runs on a worker thread and cancelling its task cancels the
session, and the progress and event streams are ``asyncio.Queue``-fed async iterators. A cancelled task never interrupts a request already
on the wire (it completes on its thread and its result is dropped), which keeps the token store
and cache consistent.

Every sub-client attribute of the sync client is mirrored: its methods become coroutines with
the same names and arguments (``await client.license.activate_with_key(key)``), its plain
attributes are read through. ``client.sync_client`` is the underlying sync client, for code
that wants both.

A forgotten ``await`` fails loudly. A coroutine object is truthy, so ``if client.is_licensed():``
used to pass on every device, licensed or not. Each mirrored call returns a coroutine whose
``bool()`` raises :class:`TypeError` naming the fix; awaiting it, ``asyncio.create_task``,
``gather`` and ``wait_for`` work as before.
"""

from __future__ import annotations

import asyncio
import collections.abc
import functools
import inspect
from typing import Any, AsyncIterator, Callable, Generator, Iterable, Optional

from .client import PolarisKeyClient

__all__ = ["AsyncPolarisKeyClient", "AsyncClient", "GuardedCoroutine"]

#: Methods that are cheap, pure reads or registrations and stay synchronous.
_SYNC = frozenset(
    {
        "subscribe",
        "on",
        "on_change",
        "on_config_change",
        "emit",
        # client.cloud_sync_host: the context manager and the subscription are not coroutines.
        "locked",
        "on_events",
        "setting",
        "supports",
        "caps",
        "capabilities",
        "presentation",
        "portal",
        "discovery",
        "crash_tags",
        "outlet_id",
        "url",
        "set_driver",
        "register_handler",
        # client.backend: the auth objects are built synchronously and run on the host's loop.
        "httpx_auth",
        "requests_auth",
        "origins",
    }
)


#: ``inspect.markcoroutinefunction`` (3.12+), so the mirrored methods still read as coroutine
#: functions to frameworks that check.
_mark = getattr(inspect, "markcoroutinefunction", None)


async def _to_thread(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    to_thread = getattr(asyncio, "to_thread", None)
    if to_thread is not None:
        return await to_thread(fn, *args, **kwargs)
    loop = asyncio.get_running_loop()  # pragma: no cover - 3.8
    return await loop.run_in_executor(None, functools.partial(fn, *args, **kwargs))


class GuardedCoroutine(collections.abc.Coroutine):
    """A coroutine that refuses to be used as a condition.

    ``if client.is_licensed():`` without ``await`` tests the coroutine OBJECT, which is always
    truthy: the gate passed on a device that was never activated. :meth:`__bool__` raises
    :class:`TypeError` instead (and closes the coroutine, so no "never awaited" warning follows).
    Everything else delegates to the wrapped coroutine, and :func:`asyncio.iscoroutine` is true
    for it, so ``await``, ``asyncio.create_task``, ``gather``, ``wait_for`` and ``asyncio.run``
    accept it unchanged."""

    __slots__ = ("_coro", "_name")

    def __init__(self, coro: Any, name: str) -> None:
        self._coro = coro
        self._name = name

    def __await__(self) -> Generator[Any, None, Any]:
        return self._coro.__await__()

    def send(self, value: Any) -> Any:
        return self._coro.send(value)

    def throw(self, *args: Any) -> Any:  # type: ignore[override]
        return self._coro.throw(*args)

    def close(self) -> None:
        self._coro.close()

    def __bool__(self) -> bool:
        self._coro.close()
        raise TypeError(
            f"{self._name}() is a coroutine on the async client: await it "
            f"(`if await client.{self._name}():`). A coroutine object is always true."
        )

    def __repr__(self) -> str:
        return f"<GuardedCoroutine {self._name}()>"


class _AsyncFacet:
    """A sub-client's async mirror: methods become coroutines run on a worker thread."""

    def __init__(self, target: Any) -> None:
        object.__setattr__(self, "_target", target)

    def __getattr__(self, name: str) -> Any:
        value = getattr(self._target, name)
        if name.startswith("_") or not callable(value) or name in _SYNC or isinstance(value, type):
            return value

        @functools.wraps(value)
        def call(*args: Any, **kwargs: Any) -> GuardedCoroutine:
            return GuardedCoroutine(_to_thread(value, *args, **kwargs), name)

        if _mark is not None:  # 3.12+: inspect.iscoroutinefunction(call) stays true
            _mark(call)
        return call


class _AsyncSignInSession:
    """An async view of a :class:`~polaris_key.identity.sign_in.SignInSession`: ``wait`` is a
    coroutine, and cancelling its task cancels the session."""

    def __init__(self, session: Any) -> None:
        object.__setattr__(self, "_session", session)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._session, name)

    def __repr__(self) -> str:
        return repr(self._session)

    async def wait(
        self,
        timeout: Optional[float] = None,
        *,
        once: bool = False,
        confirm: Optional[Callable[[Any, bool], bool]] = None,
    ) -> Any:
        """:meth:`SignInSession.wait` on a worker thread. Cancel the task to stop polling:
        the session is cancelled, and the thread ends within a moment."""
        try:
            return await _to_thread(self._session.wait, timeout, once=once, confirm=confirm)
        except asyncio.CancelledError:
            self._session.cancel()
            raise


class _AsyncSignInNamespace:
    def __init__(self, target: Any) -> None:
        self._target = target

    def start(self, **opts: Any) -> GuardedCoroutine:
        """``identity.sign_in.start(**opts)``, awaited; answers an async session."""

        async def run() -> _AsyncSignInSession:
            return _AsyncSignInSession(await _to_thread(self._target.start, **opts))

        return GuardedCoroutine(run(), "identity.sign_in.start")


class _AsyncIdentity(_AsyncFacet):
    @property
    def sign_in(self) -> _AsyncSignInNamespace:
        return _AsyncSignInNamespace(self._target.sign_in)


async def _queue_stream(subscribe: Callable[[Callable[[Any], None]], Callable[[], None]],
                        until: Optional[Callable[[Any], bool]] = None) -> AsyncIterator[Any]:
    loop = asyncio.get_running_loop()
    queue: "asyncio.Queue[Any]" = asyncio.Queue()
    off = subscribe(lambda item: loop.call_soon_threadsafe(queue.put_nowait, item))
    try:
        while True:
            item = await queue.get()
            yield item
            if until is not None and until(item):
                return
    finally:
        off()


class _AsyncPacks(_AsyncFacet):
    def progress(self, *, until_done: bool = False) -> AsyncIterator[Any]:
        """An async iterator of :class:`~polaris_key.update.packs.engine.PackProgress` events
        (``download``, ``apply``, ``done``) for installs started from any thread or task.
        ``until_done`` ends it after the first ``done``."""
        return _queue_stream(
            self._target.on, (lambda p: p.phase == "done") if until_done else None
        )


class _AsyncUpdate(_AsyncFacet):
    def __init__(self, target: Any) -> None:
        super().__init__(target)
        object.__setattr__(self, "packs", _AsyncPacks(target.packs))


class _AsyncEvents(_AsyncFacet):
    def stream(self, kinds: Optional[Iterable[str]] = None) -> AsyncIterator[Any]:
        """An async iterator of ``client.events`` (optionally only ``kinds``)."""
        k = tuple(kinds) if kinds is not None else None
        return _queue_stream(lambda fn: self._target.subscribe(fn, k))


class AsyncPolarisKeyClient:
    """The asyncio face of :class:`~polaris_key.PolarisKeyClient` (see the module doc)."""

    def __init__(self, sync_client: PolarisKeyClient) -> None:
        self.sync_client = sync_client
        self.license = _AsyncFacet(sync_client.license)
        self.entitlements = _AsyncFacet(sync_client.entitlements)
        self.config = _AsyncFacet(sync_client.config)
        self.devices = _AsyncFacet(sync_client.devices)
        self.identity = _AsyncIdentity(sync_client.identity)
        self.release = _AsyncFacet(sync_client.release)
        self.update = _AsyncUpdate(sync_client.update)
        self.commerce = _AsyncFacet(sync_client.commerce)
        self.distribution = _AsyncFacet(sync_client.distribution)
        self.backend = _AsyncFacet(sync_client.backend)
        self.events = _AsyncEvents(sync_client.events)
        #: The Cloud Sync host: ``touch``, ``flush``, ``purge`` and the rest run on a worker thread.
        self.cloud_sync_host = _AsyncFacet(sync_client.cloud_sync_host)

    @classmethod
    async def create(cls, *, auto_discover: Optional[bool] = None, **opts: Any) -> "AsyncPolarisKeyClient":
        """Build, ``init()`` and (unless ``expected_services`` is pinned) discover, off the
        event loop. Same options as :meth:`PolarisKeyClient.create`."""
        sync = await _to_thread(PolarisKeyClient.create, auto_discover=auto_discover, **opts)
        return cls(sync)

    def __getattr__(self, name: str) -> Any:
        return getattr(_AsyncFacet(self.sync_client), name)

    async def aclose(self) -> None:
        await _to_thread(self.sync_client.close)

    async def __aenter__(self) -> "AsyncPolarisKeyClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def run_refresh(self, interval_seconds: float) -> None:
        """A refresh loop as a task: ``sync()`` every ``interval_seconds`` until cancelled;
        a failed sync never ends it."""
        while True:
            await asyncio.sleep(interval_seconds)
            try:
                await _to_thread(self.sync_client.sync)
            except Exception:
                pass


#: ``polaris_key.AsyncClient.create(...)`` — the spec's name for the async client.
AsyncClient = AsyncPolarisKeyClient
