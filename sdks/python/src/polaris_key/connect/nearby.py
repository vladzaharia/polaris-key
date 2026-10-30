"""Nearby approval for an app (CC-15; WIRE-CONTRACT-V5 §15.6.1): ``client.cloud_connect.nearby``. Mirrors the
``CloudNearby`` class of ``packages/sdk-node/src/connect/cloudConnect.ts``.

- ``request(request=..., label=...)`` on D, the device with no way to sign in: browse for approvers
  nearby and list them for the person to tap (``choose``). ``request`` is the handle ``nearby/start``
  answered;
- ``on_request(handler, prompt=True)`` on M, a signed-in device: advertise while the person has "Approve a
  nearby device" open (``prompt=True``) or has allowed background approval with the permission granted
  (``prompt=False`` with ``background=True``), and hand each session that reaches the code to ``handler``.

It is gated by the Identity service's discovery (``nearby`` and its endpoints), never by Connect: it works
with Connect off. It carries the vouch over the LAN and calls no route; the host calls ``nearby/start``,
``poll`` and ``approve`` and gives the answers to the handles.

Like the rest of Cloud Connect the services run on the Connect loop (D-3); every method here is a plain
blocking call from the host's thread, and the ``AsyncClient`` mirrors them as coroutines. The handler, the
listeners and an approval's ``on_close`` run on the Connect thread: keep them short and do not call a
blocking method from one (hand the work to a thread).

Rules this module keeps:

- a sign-out stops it: ``stop_all()`` ends every advert and request, never past the bound, and the
  ``start`` or ``on_request`` that a sign-out overtook ends what it made (the epoch is checked before and
  after each start and after the sign-in read); a handle is added to the set the sign-out stops only
  while the epoch still matches;
- ``on_request`` raises ``account-required`` while the device is signed out, and the typed N/A
  (``service-unavailable`` for a product that serves no nearby approval, ``nearby-unsupported`` for a
  runtime that cannot browse) otherwise.
"""

from __future__ import annotations

import concurrent.futures
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, List, Optional, Tuple, Union

from ..constants_generated import ErrorCode, Feature, UnsupportedReason
from ..core.caps import Unsupported, UnsupportedError
from ..core.errors import PolarisError
from .errors import LanError
from .loop import ConnectLoop, connect_loop

if TYPE_CHECKING:  # the engine imports asyncio and sockets: only when a nearby call is made
    from ..core.peer_nearby import (
        FinishOutcome,
        NearbyApprover,
        NearbyApproverInfo,
        NearbyApproverStatus,
        NearbyChoice,
        NearbyRecord,
        NearbyRequester,
    )
    from ..core.peer_nearby import (
        NearbyApproval as _CoreApproval,
    )
    from ..core.peer_session import Closed
    from ..core.peer_vouch import VouchRequest

__all__ = [
    "ApproveAnswerInput",
    "CloudNearby",
    "NearbyApproval",
    "NearbyApproverHandle",
    "NearbyDeps",
    "NearbyRequest",
    "SIGN_OUT_BOUND_SECONDS",
]

#: The most a sign-out waits on nearby approval (decision D-12).
SIGN_OUT_BOUND_SECONDS = 15.0
_BLOCKED = "a Cloud Connect callback cannot call a blocking method; hand the work to a thread"


@dataclass
class NearbyDeps:
    """What nearby approval reads of the client. Every member is a blocking call (the facade runs them off
    the Connect loop). ``identity(fresh)`` is the Identity fragment of discovery (loaded again first when
    ``fresh``), ``None`` while Identity is off; ``require_identity`` raises the typed N/A when the product
    does not run the Identity service; ``signed_in`` says whether this device is signed in on the product;
    ``signer`` is D's device keys and its ``X-PKey-Device`` value; ``now`` is epoch seconds."""

    slug: str
    now: Callable[[], int]
    require_identity: Callable[[], None]
    identity: Callable[[bool], Optional[Dict[str, Any]]]
    signed_in: Callable[[], bool]
    signer: Callable[[], Tuple[Any, str]]


@dataclass(frozen=True)
class ApproveAnswerInput:
    """The answer of ``nearby/approve`` as the host read it (§15.6.1 rule 6)."""

    #: The HTTP status, or ``None`` when there was no answer.
    http: Optional[int]
    #: The body text, or ``None``.
    body: Optional[str]
    #: The host's fresh read of discovery: does it still name ``nearby`` and ``nearbyApprove``?
    discovery_nearby: bool


def _unsupported(detail: str, reason: str) -> UnsupportedError:
    return UnsupportedError(
        Unsupported(Feature.IDENTITY_NEARBY, reason, detail),
        ErrorCode.SERVICE_UNAVAILABLE if reason == UnsupportedReason.PRODUCT else ErrorCode.NEARBY_UNSUPPORTED,
    )


class _Calls:
    """Runs coroutines and plain reads on the Connect loop for the host's thread."""

    def __init__(self) -> None:
        self.loop: ConnectLoop = connect_loop()

    def run(self, coro: Awaitable[Any], timeout: Optional[float] = None) -> Any:
        """Run a coroutine on the loop and wait. Refused from the Connect thread itself, which would wait on
        its own loop."""
        if self.loop.in_loop():
            close = getattr(coro, "close", None)
            if close is not None:
                close()
            raise RuntimeError(_BLOCKED)
        return self.loop.submit(coro).result(timeout)

    def read(self, fn: Callable[[], Any]) -> Any:
        """Run a plain function on the loop's thread (where the services' tables live)."""
        if self.loop.in_loop():
            return fn()

        async def go() -> Any:
            return fn()

        return self.loop.submit(go()).result(10)


class NearbyApproval:
    """One session asking for approval, as the host's handler sees it (the blocking form). The handler runs
    on the Connect thread; hand the approval to the thread that talks to the person."""

    def __init__(self, core: "_CoreApproval", calls: _Calls) -> None:
        self._core = core
        self._calls = calls
        #: What D's ``HELLO`` showed. Unauthenticated display data: show it as "reported by the device"
        #: beside the platform and the codes, never as proof of who is asking; the person's pick of the
        #: matching code is the only check.
        self.label: Optional[str] = core.label
        self.platform: str = core.platform
        #: The three codes, in the order to show them, each like ``123 456``.
        self.codes: List[str] = list(core.codes)

    def __repr__(self) -> str:
        return "<NearbyApproval>"

    def __reduce__(self) -> Any:
        raise TypeError("a nearby approval cannot be pickled")

    def pick(self, code: Any) -> Union["VouchRequest", str]:
        """The person picked this code. The right one delivers D's ``VOUCH_REQ``, verified here: the result
        is exactly what ``nearby/approve`` gets. A wrong code closes the session, calls no route and
        answers ``"mismatch"``; a request that does not verify closes it and answers ``"invalid"``."""
        return self._calls.run(self._core.pick(code))  # type: ignore[no-any-return]

    def decline(self) -> None:
        """"None of these match": the session closes, nothing is delivered and no route is called."""
        self._calls.run(self._core.decline())

    def finish(self, answer: "ApproveAnswerInput") -> "FinishOutcome":
        """Give the answer of ``nearby/approve`` back; sends ``VOUCH_RESULT`` (rule 6)."""
        return self._calls.run(self._core.finish(answer))  # type: ignore[no-any-return]

    def send_record(self, type_: int, body: bytes) -> None:
        """After ``approved``: a Sync record (``0x0030`` to ``0x003F``) to D."""
        self._calls.run(self._core.send_record(type_, body))

    def close(self) -> None:
        """The host leaves: the session closes ``peer_bye``. Before a pick this counts for nothing."""
        self._calls.run(self._core.close())

    def on_close(self, fn: Callable[["Closed"], None]) -> Callable[[], None]:
        """Called once when the session ends, on the Connect thread. Returns the unsubscribe."""
        return self._core.on_close(fn)


class NearbyApproverHandle:
    """The advert of one ``on_request``: stop, pause and resume it. All blocking."""

    def __init__(self, core: "NearbyApprover", calls: _Calls, owner: "CloudNearby") -> None:
        self._core = core
        self._calls = calls
        self._owner = owner

    def __repr__(self) -> str:
        return "<NearbyApproverHandle %s>" % self._core.status().state

    def __reduce__(self) -> Any:
        raise TypeError("a nearby approver cannot be pickled")

    def stop(self) -> None:
        """Stop for good: the advert, the listener and every session. Nothing brings them back."""
        self._owner._forget_approver(self._core)

        async def go() -> None:
            await self._core.stop()

        self._calls.run(go())

    def pause(self) -> None:
        """Stop advertising and close live sessions until :meth:`resume`. Works from ``advertising`` only."""
        self._calls.run(self._core.pause())

    def resume(self) -> None:
        """Start again after the host's own :meth:`pause`. It reads sign-in and discovery again first, and
        does nothing after a stop, a sign-out or a spent budget."""
        self._calls.run(self._core.resume())

    def set_prompt(self, open_: bool) -> None:
        """The "Approve a nearby device" screen opens (``True``) or closes (``False``). Opening it also
        counts the failure budget from zero and starts a stopped (budget) or paused advert again; closing
        it ends the prompt that is showing and, without ``background``, pauses the advert."""
        self._calls.run(self._core.set_prompt(open_))

    def reopen(self) -> None:
        """Count the failure budget from zero and start a budget-stopped advert again."""
        self._calls.run(self._core.reopen())

    def status(self) -> "NearbyApproverStatus":
        return self._core.status()


class NearbyRequest:
    """D's request: the approvers found nearby and the one the person chose. All blocking. Listeners run on
    the Connect thread."""

    def __init__(self, core: "NearbyRequester", calls: _Calls) -> None:
        self._core = core
        self._calls = calls

    def __repr__(self) -> str:
        return "<NearbyRequest>"

    def __reduce__(self) -> Any:
        raise TypeError("a nearby request cannot be pickled")

    @property
    def approvers(self) -> "List[NearbyApproverInfo]":
        """The approvers that said ``HELLO``, at most 8; empty once the person chose."""
        return self._calls.read(lambda: self._core.approvers)  # type: ignore[no-any-return]

    @property
    def result(self) -> Optional[str]:
        """What ``VOUCH_RESULT`` said. For display only: the host's poll is the authority."""
        return self._core.result

    @property
    def closed(self) -> bool:
        return self._core.closed

    def on_approvers(self, fn: "Callable[[List[NearbyApproverInfo]], None]") -> Callable[[], None]:
        return self._core.on_approvers(fn)

    def on_result(self, fn: Callable[[str], None]) -> Callable[[], None]:
        return self._core.on_result(fn)

    def on_record(self, fn: "Callable[[NearbyRecord], None]") -> Callable[[], None]:
        """Sync records, once the person confirmed the account."""
        return self._core.on_record(fn)

    def on_close(self, fn: Callable[[str], None]) -> Callable[[], None]:
        """The chosen session ended (or the request expired); with why."""
        return self._core.on_close(fn)

    def choose(self, approver_id: str) -> "NearbyChoice":
        """The person tapped this approver. Starts the code on that session only and closes the others
        ``peer_bye``; answers D's code to show (``.code``), and sends ``VOUCH_REQ`` once it is shown."""
        return self._calls.run(self._core.choose(approver_id))  # type: ignore[no-any-return]

    def confirm_account(self) -> None:
        """The person confirmed that the signed-in account is theirs: held records go to ``on_record``. It
        counts for the session that was chosen and answered ``approved``; it is not a standing consent."""
        self._calls.run(self._core.confirm_account())

    def decline_account(self) -> None:
        """The person declined, or the screen timed out: every held record is dropped and the session
        closes."""
        self._calls.run(self._core.decline_account())

    def close(self) -> None:
        """End the request: the browse stops and every session closes ``peer_bye``."""

        async def go() -> None:
            await self._core.close()

        self._calls.run(go())


class CloudNearby:
    """``client.cloud_connect.nearby``."""

    def __init__(self, deps: Optional[NearbyDeps] = None) -> None:
        self._deps = deps
        self._calls = _Calls()
        self._lock = threading.Lock()
        self._approvers: "set[Any]" = set()
        self._requests: "set[Any]" = set()
        #: Bumped by every ``stop_all``: a start that began before it must not outlive it.
        self._epoch = 0
        self._touched = False

    def __repr__(self) -> str:
        return "<CloudNearby>"

    def __reduce__(self) -> Any:
        raise TypeError("nearby approval cannot be pickled")

    # -- plumbing -----------------------------------------------------------------------------------

    def _begin(self) -> int:
        with self._lock:
            self._touched = True
            return self._epoch

    def _stale(self, epoch: int) -> bool:
        with self._lock:
            return epoch != self._epoch

    def _forget_approver(self, core: Any) -> None:
        with self._lock:
            self._approvers.discard(core)

    async def _blocking(self, fn: Callable[..., Any], *args: Any) -> Any:
        import asyncio

        return await asyncio.get_running_loop().run_in_executor(None, fn, *args)

    async def _fragment(self, fresh: bool, endpoints: Tuple[str, ...]) -> Dict[str, Any]:
        d = self._deps
        if d is None:
            raise _unsupported("Nearby approval is not set up on this client.", UnsupportedReason.RUNTIME)
        # Discovery first: the service table comes from it once it is loaded.
        f = await self._blocking(d.identity, fresh)
        d.require_identity()
        ep = f.get("endpoints") if isinstance(f, dict) else None
        ep = ep if isinstance(ep, dict) else {}
        if f is None or f.get("nearby") is not True or any(not ep.get(k) for k in endpoints):
            raise _unsupported("This product's discovery does not name nearby approval.", UnsupportedReason.PRODUCT)
        return f  # type: ignore[no-any-return]

    @staticmethod
    def _wrap_unavailable(e: BaseException) -> BaseException:
        """The multicast layer is optional: its absence is the typed ``nearby-unsupported``."""
        from ..core.peer_mdns import MdnsUnavailableError

        if isinstance(e, MdnsUnavailableError):
            return _unsupported(str(e), UnsupportedReason.DEPENDENCY)
        return e

    # -- D ------------------------------------------------------------------------------------------

    def request(
        self,
        request: str,
        *,
        label: Optional[str] = None,
        expires_in: Optional[float] = None,
        **options: Any,
    ) -> NearbyRequest:
        """D, the device with no sign-in: browse for approvers nearby and list them for the person to tap
        (``choose``). ``request`` is the handle ``nearby/start`` answered; ``expires_in`` its lifetime in
        seconds (at most 300). Raises the typed N/A when the product serves no nearby approval or this
        runtime cannot browse, ``invalid-argument`` for a bad ``request``, ``label`` or ``expires_in``, and
        a closed error when a sign-out (``stop_all``) landed while it was starting. ``options`` are the
        engine's remaining fields (a test seam: ``mdns``, ``allow_loopback``, ``timer``)."""
        epoch = self._begin()
        return self._calls.run(self._request(epoch, request, label, expires_in, options))  # type: ignore[no-any-return]

    async def _request(
        self, epoch: int, request: str, label: Optional[str], expires_in: Optional[float], options: Dict[str, Any]
    ) -> NearbyRequest:
        from ..core.peer_nearby import NearbyRequester, NearbyRequestOptions, RequesterSource

        await self._fragment(True, ("nearbyStart", "nearbyPoll"))
        d = self._deps
        assert d is not None
        with self._lock:
            for r in [r for r in self._requests if r.closed]:
                self._requests.discard(r)
        if self._stale(epoch):
            raise LanError("closed", "Nearby approval was stopped.")

        async def signer() -> Tuple[Any, str]:
            return await self._blocking(d.signer)  # type: ignore[no-any-return]

        try:
            r = await NearbyRequester.start(
                RequesterSource(slug=d.slug, now=d.now, signer=signer),
                NearbyRequestOptions(request=request, label=label, expires_in=expires_in, **options),
            )
        except Exception as e:
            raise self._wrap_unavailable(e) from None
        with self._lock:
            stale = epoch != self._epoch
            if not stale:
                self._requests.add(r)
        if stale:
            try:
                await r.close()
            except Exception:
                pass
            raise LanError("closed", "Nearby approval was stopped.")
        return NearbyRequest(r, self._calls)

    # -- M ------------------------------------------------------------------------------------------

    def on_request(
        self,
        handler: Callable[[NearbyApproval], None],
        *,
        prompt: bool = True,
        background: bool = False,
        label: Optional[str] = None,
        on_notice: Optional[Callable[[Any], None]] = None,
        on_stopped: Optional[Callable[[str], None]] = None,
        **options: Any,
    ) -> NearbyApproverHandle:
        """M, a signed-in device: advertise while the person has "Approve a nearby device" open
        (``prompt=True``) or has allowed background approval with the permission granted (``prompt=False``
        with ``background=True``), and hand each session that reaches the code to ``handler`` (on the
        Connect thread). Returns the handle that stops, pauses and resumes it. Raises ``account-required``
        when the device is signed out (also when the sign-out landed while this was starting), and the typed
        N/A when the product serves no nearby approval. ``options`` are the engine's remaining fields (a
        test seam: ``mdns``, ``allow_loopback``, ``timer``)."""
        epoch = self._begin()
        return self._calls.run(  # type: ignore[no-any-return]
            self._on_request(epoch, handler, prompt, background, label, on_notice, on_stopped, options)
        )

    async def _on_request(
        self,
        epoch: int,
        handler: Callable[[NearbyApproval], None],
        prompt: bool,
        background: bool,
        label: Optional[str],
        on_notice: Optional[Callable[[Any], None]],
        on_stopped: Optional[Callable[[str], None]],
        options: Dict[str, Any],
    ) -> NearbyApproverHandle:
        from ..core.peer_nearby import ApproverSource, NearbyApprover, NearbyApproverOptions

        await self._fragment(True, ("nearbyApprove",))
        d = self._deps
        assert d is not None

        def signed_out() -> PolarisError:
            return PolarisError(ErrorCode.ACCOUNT_REQUIRED, "Sign in before approving a nearby device.")

        async def signed_in() -> bool:
            return bool(await self._blocking(d.signed_in))

        async def served() -> bool:
            try:
                await self._fragment(True, ("nearbyApprove",))
                return True
            except Exception:
                return False

        if not await signed_in() or self._stale(epoch):
            raise signed_out()

        def wrapped(core: "_CoreApproval") -> None:
            handler(NearbyApproval(core, self._calls))

        try:
            h = await NearbyApprover.start(
                ApproverSource(slug=d.slug, now=d.now, signed_in=signed_in, nearby_served=served),
                wrapped,
                NearbyApproverOptions(
                    prompt=prompt,
                    background=background,
                    label=label,
                    on_notice=on_notice,
                    on_stopped=on_stopped,
                    **options,
                ),
            )
        except Exception as e:
            raise self._wrap_unavailable(e) from None
        # The sign-out may have landed while the advert was starting, before the handle was kept; and the
        # sign-in read below can itself outlast one. The handle joins the set only while the epoch still
        # matches (one step under the lock, against ``stop_all``'s bump and snapshot).
        try:
            still = await signed_in()
        except Exception:
            still = False
        with self._lock:
            stale = (not still) or epoch != self._epoch
            if not stale:
                self._approvers.add(h)
        if stale:
            try:
                await h.stop()
            except Exception:
                pass
            raise signed_out()
        return NearbyApproverHandle(h, self._calls, self)

    # -- the sign-out step --------------------------------------------------------------------------

    def stop_all(self, bound: float = SIGN_OUT_BOUND_SECONDS) -> None:
        """Stop every advert and close every request. The sign-out step (after ``cloud_connect.stop()``,
        before ``connect.leave()``), also ``client.close()``. It never waits past ``bound`` seconds: past
        it, every socket and listener is dropped at once (:meth:`force_stop`). Safe to call twice, and
        before any nearby call (it then starts no thread)."""
        with self._lock:
            self._epoch += 1
            hs, rs = list(self._approvers), list(self._requests)
        if not hs and not rs:
            return
        if self._calls.loop.in_loop():
            raise RuntimeError(_BLOCKED)

        async def go() -> None:
            for h in hs:
                try:
                    await h.stop()
                except Exception:
                    pass
            for r in rs:
                try:
                    await r.close()
                except Exception:
                    pass

        fut = self._calls.loop.submit(go())
        try:
            fut.result(bound)
        except (concurrent.futures.TimeoutError, TimeoutError):
            fut.cancel()
            self.force_stop()
            return
        with self._lock:
            for h in hs:
                self._approvers.discard(h)
            for r in rs:
                self._requests.discard(r)

    def force_stop(self) -> None:
        """The sign-out bound ran out: drop every socket and listener now, with no goodbye. Callable from
        any thread, also while a host callback holds the Connect loop (the work runs when it is free)."""
        with self._lock:
            self._epoch += 1
            hs, rs = list(self._approvers), list(self._requests)
            self._approvers.clear()
            self._requests.clear()
        if not hs and not rs:
            return

        def drop() -> None:
            for x in hs + rs:
                try:
                    x.destroy()
                except Exception:
                    pass

        try:
            self._calls.loop.call_soon(drop)
        except Exception:
            pass
