"""``AsyncPolarisKeyClient`` — the client for asyncio hosts (SDK parity pass §2.3, SP-P05).

::

    client = await polaris_key.AsyncClient.create(**polaris_config.CONFIG)
    outcome = await client.boot()
    prompt = await client.identity.begin_sign_in()
    result = await client.identity.wait_for_sign_in(prompt)   # cancellable
    async for p in client.update.packs.progress():            # pack download progress
        ...
    async for event in client.events.stream():                # license / config / … changes
        ...

It SHARES the core with :class:`~polaris_key.PolarisKeyClient` instead of duplicating it: one
verification path, one cache, one gate, one wire implementation, and the same corpus and
transcripts prove both. Every call that can touch the disk or the network runs the shared
synchronous core on a worker thread (``asyncio.to_thread``), so the event loop never blocks;
the WAITS are native asyncio — ``wait_for_sign_in`` sleeps with ``asyncio.sleep`` and polls one
request at a time, so cancelling the task stops it at once, and the progress and event streams
are ``asyncio.Queue``-fed async iterators. A cancelled task never interrupts a request already
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
from .core.errors import PolarisError
from .identity.client import SignInPrompt, SignInResult, _poll_delay

__all__ = ["AsyncPolarisKeyClient", "AsyncClient", "GuardedCoroutine"]

#: Methods that are cheap, pure reads or registrations and stay synchronous.
_SYNC = frozenset(
    {
        "subscribe",
        "on",
        "on_change",
        "on_config_change",
        "emit",
        "setting",
        "supports",
        "caps",
        "capabilities",
        "crash_tags",
        "outlet_id",
        "url",
        "set_driver",
        "register_handler",
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


class _AsyncIdentity(_AsyncFacet):
    async def wait_for_sign_in(
        self,
        prompt: SignInPrompt,
        timeout: Optional[float] = None,
        *,
        on_confirm: Optional[Callable[[Any, bool], Optional[bool]]] = None,
    ) -> SignInResult:
        """The paced poll loop of :meth:`IdentityClient.wait_for_sign_in`, with the same rules
        (at least ``interval`` between polls, ``slow-down`` lengthens it, transient failures
        retried at the same interval, ``expired`` once the code's lifetime passes), sleeping
        with ``asyncio.sleep``: cancel the task to stop. ``timeout`` raises
        :class:`asyncio.TimeoutError`."""
        coro = self._wait(prompt, on_confirm)
        if timeout is None:
            return await coro
        return await asyncio.wait_for(coro, timeout)

    async def _wait(self, prompt: SignInPrompt, on_confirm: Any) -> SignInResult:
        identity = self._target
        interval = prompt.interval
        decision: Optional[bool] = None
        while True:
            if identity._ctx.now() >= prompt.expiresAt:
                return SignInResult(status="expired")
            await asyncio.sleep(_poll_delay(interval, prompt.expiresIn))
            if identity._ctx.now() >= prompt.expiresAt:
                return SignInResult(status="expired")
            try:
                poll = await _to_thread(identity._poll, prompt, interval, decision)
            except PolarisError as e:
                if e.code in ("network-error", "server-error"):
                    continue
                raise
            if poll.status == "pending":
                continue
            if poll.status == "slow-down":
                interval = max(interval, poll.interval or interval)
                continue
            if poll.status == "confirm":
                if decision is not None and not (decision and not poll.attachable):
                    continue
                answer = on_confirm(poll.identity, bool(poll.attachable)) if on_confirm else False
                if answer is None:
                    raise PolarisError("cancelled", "the player declined the signed-in identity.")
                decision = bool(answer) and bool(poll.attachable)
                continue
            return SignInResult(
                status=poll.status, message=poll.message, identity=poll.identity, attached=poll.attached
            )

    async def sign_in_with_browser(self, **kw: Any) -> SignInResult:
        """Begin, open ``verificationUriComplete`` in the system browser, and wait (async)."""
        on_prompt = kw.pop("on_prompt", None)
        open_url = kw.pop("open_url", None)
        timeout = kw.pop("timeout", None)
        on_confirm = kw.pop("on_confirm", None)
        prompt = await _to_thread(
            self._target.begin_sign_in, kw.pop("device_name", None),
            confirm_identity=kw.pop("confirm_identity", False),
        )
        if on_prompt is not None:
            on_prompt(prompt)
        if open_url is None:
            import webbrowser

            open_url = webbrowser.open
        try:
            open_url(prompt.verificationUriComplete)
        except Exception:
            pass
        return await self.wait_for_sign_in(prompt, timeout, on_confirm=on_confirm)


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
        self.config = _AsyncFacet(sync_client.config)
        self.devices = _AsyncFacet(sync_client.devices)
        self.identity = _AsyncIdentity(sync_client.identity)
        self.release = _AsyncFacet(sync_client.release)
        self.update = _AsyncUpdate(sync_client.update)
        self.commerce = _AsyncFacet(sync_client.commerce)
        self.distribution = _AsyncFacet(sync_client.distribution)
        self.events = _AsyncEvents(sync_client.events)

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
