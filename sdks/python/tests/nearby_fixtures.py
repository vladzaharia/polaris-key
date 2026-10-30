"""Fixtures for the nearby (mode v) tests (CC-15.P2 to P4): a bare device D that speaks mode v with the
engine over a real loopback socket to an approver's advert on the fake LAN, and a fake of the Worker's
``nearby/approve`` that holds the key-binding rule of WIRE-CONTRACT-V5 §12.11.5 rule 3. Mirrors Node's
``nearbyFixtures.ts``. Everything async here runs on the Connect loop."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from test_connect_lan import Network

from polaris_key.connect.dial import dial_race
from polaris_key.connect.loop import connect_loop
from polaris_key.core.peer_frame import RECORD
from polaris_key.core.peer_link import LinkHandlers, SocketLink
from polaris_key.core.peer_mdns import MdnsAdvert
from polaris_key.core.peer_session import Closed, Established, PeerHello, Record, Sas
from polaris_key.core.peer_vouch import VouchRecord, build_vouch_request
from polaris_key.devices.keys import DeviceKeyStore, InMemoryDeviceKeyStorage

SLUG = "djdl"
D_ID = "NEARBYDEVICE".ljust(31, "0") + "D"
REQUEST = "nr_0IvbE7YHMGPBP0VAfZDQhg"
T0 = 1_800_000_000


def run(coro: Any, timeout: float = 15) -> Any:
    return connect_loop().submit(coro).result(timeout)


def on_loop(fn: Callable[[], Any], timeout: float = 15) -> Any:
    """Run a plain function on the Connect loop's thread and wait for it."""

    async def go() -> Any:
        return fn()

    return run(go(), timeout)


def until(cond: Callable[[], Any], timeout: float = 8) -> None:
    end = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > end:
            raise AssertionError("timed out")
        time.sleep(0.01)


def settle(seconds: float = 0.08) -> None:
    time.sleep(seconds)


def memory_keys() -> Any:
    return DeviceKeyStore(InMemoryDeviceKeyStorage())


def approver_adverts(net: Network) -> List[MdnsAdvert]:
    """The adverts of mode v on the fake LAN: instance, port and TXT."""
    return [a for a in list(net.adverts.values()) if "m=v" in a.txt]


class Timers:
    """Fake timers handed to the code under test: ``fire(seconds)`` runs every live one set for that long.
    With ``only``, other delays run for real."""

    def __init__(self, only: Optional[float] = None) -> None:
        self.items: List[Dict[str, Any]] = []
        self.only = only

    def __call__(self, fn: Callable[[], None], seconds: float) -> Callable[[], None]:
        if self.only is not None and seconds != self.only:
            return asyncio.get_running_loop().call_later(seconds, fn).cancel
        t = {"fn": fn, "seconds": seconds, "live": True}
        self.items.append(t)

        def cancel() -> None:
            t["live"] = False

        return cancel

    def live(self, seconds: float) -> List[Dict[str, Any]]:
        return [t for t in self.items if t["live"] and t["seconds"] == seconds]

    def fire(self, seconds: float) -> None:
        todo = self.live(seconds)

        def go() -> None:
            for t in todo:
                t["live"] = False
                t["fn"]()

        on_loop(go)


class RawD:
    """A device D at the record level: the engine, a socket and what came back."""

    def __init__(self, keys: Any, request: str, device_id: str, label: Optional[str], auto: bool) -> None:
        self.events: List[Any] = []
        self.records: List[VouchRecord] = []
        self.closed: Optional[Closed] = None
        self.code: Optional[int] = None
        self.hello: Optional[PeerHello] = None
        self.keys = keys
        self.request = request
        self.device_id = device_id
        self.auto = auto
        self.label = label
        self.link: SocketLink = None  # type: ignore[assignment]
        self.task: Any = None

    @property
    def channel(self) -> Any:
        return self.link.channel

    @classmethod
    async def dial(
        cls,
        net: Network,
        *,
        keys: Any = None,
        device_id: str = D_ID,
        request: str = REQUEST,
        label: Optional[str] = None,
        hold: bool = True,
        port: Optional[int] = None,
        auto: bool = False,
    ) -> "RawD":
        adverts = approver_adverts(net)
        use = port if port is not None else adverts[0].port
        k = keys if keys is not None else memory_keys()
        k.ensure()
        sock, _host = await dial_race(["127.0.0.1"], use, True)
        reader, writer = await asyncio.open_connection(sock=sock)
        d = cls(k, request, device_id, label, auto)
        d.link = SocketLink(
            reader,
            writer,
            {
                "mode": "v",
                "role": "initiator",
                "slug": SLUG,
                "static_key": os.urandom(32),
                "hold_sas": hold,
                "hello": {"label": label, "platform": sys.platform, "app": SLUG},
            },
            LinkHandlers(on_closed=d._on_closed),
            on_event=d._on_event,
        )
        d.task = asyncio.ensure_future(d.link.run())
        d.link.start()
        return d

    def _on_closed(self, c: Closed) -> None:
        self.closed = c

    def _on_event(self, e: Any) -> None:
        self.events.append(e)
        if isinstance(e, Established):
            self.hello = e.hello
        elif isinstance(e, Sas):
            self.code = e.code
            if self.auto:
                self.show_and_request()
        elif isinstance(e, Record):
            self.records.append(VouchRecord(e.record_type, e.body))

    # -- what the test does, from its own thread ------------------------------------------------------

    def start_sas(self) -> None:
        """The person chose this approver."""
        on_loop(self.channel.start_sas)

    def show_and_request(self, over: Optional[Callable[[bytes], bytes]] = None) -> None:
        """D shows the code (its confirmation) and sends ``VOUCH_REQ``. Callable on the loop or off it."""

        def go() -> None:
            flow = self.channel.vouch
            flow.code_shown()
            self.channel.confirm_sas()
            body = build_vouch_request_for(self)
            if over is not None:
                body = over(body)
            v = flow.send(VouchRecord(RECORD["VOUCH_REQ"], body))
            if v.ok:
                self.channel.send_record(RECORD["VOUCH_REQ"], body)

        try:
            asyncio.get_running_loop()
            go()
        except RuntimeError:
            on_loop(go)

    def wait_for(self, cond: Callable[[], Any], timeout: float = 3) -> None:
        until(cond, timeout)

    def is_closed(self) -> bool:
        return self.closed is not None

    def result(self) -> Optional[str]:
        for r in list(self.records):
            if r.type == RECORD["VOUCH_RESULT"]:
                return str(json.loads(r.body.decode("utf-8"))["status"])
        return None

    def close(self) -> None:
        on_loop(lambda: self.channel.close("peer_bye"))


def build_vouch_request_for(d: RawD) -> bytes:
    from polaris_key.core.peer_vouch import BuildVouchRequestOptions, VouchHello

    return build_vouch_request(
        BuildVouchRequestOptions(
            port=d.keys,
            slug=SLUG,
            h=d.channel.handshake_hash(),
            request=d.request,
            device_id=d.device_id,
            hello=VouchHello(label=d.label, platform=sys.platform),
        )
    )


class FakeNearbyWorker:
    """What ``nearby/start`` registered for D, and the approve rules the Worker applies."""

    def __init__(self) -> None:
        self.start: Dict[str, Tuple[str, str, str]] = {}
        self.calls: List[Tuple[str, str]] = []
        #: Does M have keys registered? A first approve without them answers ``device_keys_required``.
        self.m_has_keys = False
        self.decided: set = set()  # type: ignore[type-arg]
        self.approved: List[str] = []

    def register(self, request: str, keys: Any, device_id: str) -> None:
        k = keys.ensure()
        self.start[request] = (device_id, k.sign_key, k.agree_key)

    def approve(self, r: Any) -> Tuple[int, Optional[str]]:
        """``POST nearby/approve`` as M sends it: exactly what ``pick()`` returned."""
        self.calls.append((r.request, r.device_id))
        if not self.m_has_keys:
            return 409, json.dumps({"code": "device_keys_required"})
        s = self.start.get(r.request)
        if (
            s is None
            or r.request in self.decided
            or s[0] != r.device_id
            or s[1] != r.sign_key
            or s[2] != r.agree_key
        ):
            return 404, None
        self.decided.add(r.request)
        self.approved.append(r.device_id)
        return 200, json.dumps({"status": "approved"})
