"""The Python live-peer driver (CC-29X): polaris_key from sdks/python/src behind the JSON-lines contract in
tools/live-peer/README.md. One client, no account, local pairing on; discovery is answered by a local mock
transport, mDNS by the harness's broker; every dial is real TCP on 127.0.0.1. Run with PYTHONPATH set to
sdks/python/src (run.mjs does)."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import httpx
from polaris_key import InMemoryStore, PolarisKeyClient
from polaris_key.connect.local_links import reset_local_budgets
from polaris_key.connect.loop import connect_loop
from polaris_key.connect.transfer import Accept
from polaris_key.core.peer_mdns import MdnsAdvert, MdnsFound, MdnsHandle

# stdout is the protocol: keep the real stream and point `print` at stderr.
OUT = sys.stdout
sys.stdout = sys.stderr
OUT_LOCK = threading.Lock()

PRODUCT = "djdl"
CATEGORIES = ["notes"]
LOOP: Dict[str, Any] = {"host": "127.0.0.1", "allow_loopback": True}


def send(m: Dict[str, Any]) -> None:
    with OUT_LOCK:
        OUT.write(json.dumps(m, separators=(",", ":")) + "\n")
        OUT.flush()


class BrokerNet:
    """The mDNS adapter: local adverts go to the harness, the other device's come back from it. All the
    state lives on the connect loop's thread."""

    def __init__(self) -> None:
        self.adverts: Dict[str, MdnsAdvert] = {}
        self.browsers: List[Any] = []

    @staticmethod
    def _found(a: MdnsAdvert) -> MdnsFound:
        return MdnsFound(a.instance, "127.0.0.1", a.port, list(a.txt), ("127.0.0.1",))

    async def advertise(self, a: MdnsAdvert) -> MdnsHandle:
        self.adverts[a.instance] = a
        send({"mdns": "advertise", "advert": {"instance": a.instance, "port": a.port, "txt": list(a.txt)}})
        for up, _down in list(self.browsers):
            up(self._found(a))

        async def stop() -> None:
            if self.adverts.pop(a.instance, None) is not None:
                send({"mdns": "withdraw", "instance": a.instance})
                for _up, down in list(self.browsers):
                    if down:
                        down(a.instance)

        return MdnsHandle(stop)

    async def browse(self, on_up: Any, on_down: Any = None, accept: Any = None) -> MdnsHandle:
        b = (on_up, on_down)
        self.browsers.append(b)
        for a in list(self.adverts.values()):
            on_up(self._found(a))

        async def stop() -> None:
            if b in self.browsers:
                self.browsers.remove(b)

        return MdnsHandle(stop)

    def remote_up(self, advert: Dict[str, Any]) -> None:
        a = MdnsAdvert(advert["instance"], advert["port"], advert["txt"])

        async def go() -> None:
            self.adverts[a.instance] = a
            for up, _down in list(self.browsers):
                up(self._found(a))

        connect_loop().submit(go())

    def remote_down(self, instance: str) -> None:
        async def go() -> None:
            if self.adverts.pop(instance, None) is not None:
                for _up, down in list(self.browsers):
                    if down:
                        down(instance)

        connect_loop().submit(go())


ROOT = Path(tempfile.mkdtemp(prefix="pkey-live-python-"))
RECV = ROOT / "recv"
RECV.mkdir()
NET = BrokerNet()


def discovery(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/.well-known/polaris.json"):
        doc = {
            "product": PRODUCT,
            "protocolVersion": 5,
            "services": {"connect": {"enabled": True, "localPairing": True}},
        }
        return httpx.Response(200, json=doc)
    return httpx.Response(404)


reset_local_budgets()
KEY = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
client = PolarisKeyClient(
    product_slug=PRODUCT,
    version="1.0.0",
    pinned_keys={"live-peer-1": KEY},
    base_url="https://k.test",
    store=InMemoryStore(PRODUCT),
    client=httpx.Client(transport=httpx.MockTransport(discovery), base_url=""),
    state_dir=str(ROOT / "state"),
    trust_refresh=False,
    fingerprint=False,
)
client.init()
client.discover()
links = client.cloud_connect.local_links

EVENTS: List[Dict[str, Any]] = []
SESSIONS: Dict[str, Any] = {}
RECEIVED: List[Dict[str, Any]] = []
RECV_COND = threading.Condition()
STATE: Dict[str, Any] = {"handle": None, "code": None}


def track(s: Any, direction: str) -> None:
    link = s.local.id if s.local is not None else None
    if link is not None:
        SESSIONS[link] = s
    s.on_close(
        lambda c: EVENTS.append(
            {"kind": "session-end", "dir": direction, "id": link, "code": c.code, "byPeer": c.by_peer}
        )
    )


def inbound(s: Any) -> None:
    track(s, "in")
    EVENTS.append({"kind": "link", "id": s.local.id if s.local is not None else None})


links.on_change(lambda: EVENTS.append({"kind": "change"}))
links.on_link(inbound)

COUNT = [0]


def on_offer(o: Any) -> Accept:
    COUNT[0] += 1
    return Accept(str(RECV / f"{COUNT[0]}-{o.id}.bin"))


def on_result(r: Any) -> None:
    if r.direction != "in" or r.outcome != "delivered" or r.path is None:
        return
    data = Path(r.path).read_bytes()
    with RECV_COND:
        RECEIVED.append({"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
        RECV_COND.notify_all()


client.cloud_connect.transfer.on_offer(on_offer)
client.cloud_connect.transfer.on_result(on_result)
client.cloud_connect.start({"lan": {"mdns": NET, **LOOP}, "relay": False})


def error_of(e: BaseException) -> Dict[str, Any]:
    return {
        "code": getattr(e, "code", None),
        "reason": getattr(e, "reason", None),
        "cap": getattr(e, "cap", None),
        "message": str(e),
    }


def info_of(link: Any) -> Dict[str, Any]:
    return {
        "id": link.id,
        "label": link.label,
        "platform": link.platform,
        "categories": list(link.categories),
        "reachable": link.reachable,
    }


def pattern(n: int) -> bytes:
    return bytes((i * 7 + 13) & 0xFF for i in range(n))


def opts(**extra: Any) -> Dict[str, Any]:
    return {
        "categories": CATEGORIES,
        "mdns": NET,
        "on_confirm": lambda offer: offer.confirm(),
        **LOOP,
        **extra,
    }


class Refused(Exception):
    """A command that failed with detail to hand back as is."""

    def __init__(self, fields: Dict[str, Any]) -> None:
        super().__init__("refused")
        self.fields = fields


def cmd_show(a: Dict[str, Any]) -> Dict[str, Any]:
    h = STATE["handle"]
    if a.get("fresh"):
        for _ in range(100):
            if h is None or not h.open:
                break
            time.sleep(0.05)
    if h is None or not h.open:
        STATE["code"] = None
        h = STATE["handle"] = links.pair(label="python", on_code=lambda c: STATE.update(code=c), **opts())
    c = h.code() or STATE["code"]
    return {"code": c.code, "qr": c.qr}


def cmd_join(a: Dict[str, Any]) -> Dict[str, Any]:
    code = a.get("code")

    def dials() -> Optional[int]:
        return links.dials_left(code) if isinstance(code, str) else None

    how = {"code": code} if code is not None else {"qr": a["qr"]}
    try:
        # The joiner waits out its browse after a failed dial in case a second device answers.
        p = links.join(label="python", browse_seconds=4, **how, **opts())
    except Exception as e:
        raise Refused({"error": error_of(e), "dialsLeft": dials()}) from e
    return {"link": p.id, "dialsLeft": dials()}


def cmd_list(_a: Dict[str, Any]) -> Dict[str, Any]:
    return {"links": [info_of(x) for x in links.list()]}


def cmd_open(a: Dict[str, Any]) -> Dict[str, Any]:
    until = time.monotonic() + (0 if a.get("wait") is False else 20)
    while True:
        try:
            s = links.open(a["id"])
        except Exception as e:
            # Not seen on the network yet is not an attempt: keep looking until the hang guard.
            if getattr(e, "reason", None) != "unknown_peer" or time.monotonic() >= until:
                raise
            time.sleep(0.05)
            continue
        track(s, "out")
        return {"link": a["id"]}


def cmd_send(a: Dict[str, Any]) -> Dict[str, Any]:
    data = pattern(a["bytes"])
    sha = hashlib.sha256(data).hexdigest()
    if sha != a["sha256"]:
        raise RuntimeError("the sender's pattern hashes differently")
    peer = next(x for x in links.list() if x.id == a["id"])
    until = time.monotonic() + 20
    while True:
        try:
            handle = client.cloud_connect.transfer.send(peer, data, name="live.bin", cat=CATEGORIES[0])
            break
        except Exception as e:
            if getattr(e, "reason", None) != "unknown_peer" or time.monotonic() >= until:
                raise
            time.sleep(0.05)
    r = handle.wait(120)
    if not r.delivered:
        raise RuntimeError(f"transfer {r.outcome}: {r.reason}")
    return {"sha256": sha, "bytes": len(data)}


def cmd_recv(_a: Dict[str, Any]) -> Dict[str, Any]:
    with RECV_COND:
        while not RECEIVED:
            RECV_COND.wait()
        return RECEIVED.pop(0)


def cmd_forget(a: Dict[str, Any]) -> Dict[str, Any]:
    return {"removed": bool(links.remove(a["id"]))}


def cmd_events(_a: Dict[str, Any]) -> Dict[str, Any]:
    out = EVENTS[:]
    del EVENTS[: len(out)]
    return {"events": out}


def cmd_quit(_a: Dict[str, Any]) -> Dict[str, Any]:
    threading.Thread(target=shutdown, args=(0,), daemon=True).start()
    return {}


COMMANDS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    "show": cmd_show,
    "join": cmd_join,
    "list": cmd_list,
    "open": cmd_open,
    "send": cmd_send,
    "recv": cmd_recv,
    "forget": cmd_forget,
    "events": cmd_events,
    "quit": cmd_quit,
}


def shutdown(code: int) -> None:
    try:
        h = STATE["handle"]
        if h is not None:
            h.stop()
    except Exception:
        pass
    try:
        client.cloud_connect.stop()
        client.close()
    except Exception:
        pass
    shutil.rmtree(ROOT, ignore_errors=True)
    os._exit(code)


def run(m: Dict[str, Any]) -> None:
    seq = m.get("seq")
    fn = COMMANDS.get(m.get("cmd"))  # type: ignore[arg-type]
    if fn is None:
        send({"seq": seq, "ok": False, "error": {"message": f"unknown command {m.get('cmd')}"}})
        return
    try:
        send({"seq": seq, "ok": True, **fn(m)})
    except Refused as r:
        send({"seq": seq, "ok": False, **r.fields})
    except Exception as e:
        send({"seq": seq, "ok": False, "error": error_of(e)})


def main() -> None:
    pool = ThreadPoolExecutor(max_workers=8)
    send({"ready": True, "driver": "python"})
    for line in sys.stdin:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("mdns") == "up":
            NET.remote_up(m["advert"])
        elif m.get("mdns") == "down":
            NET.remote_down(m["instance"])
        else:
            pool.submit(run, m)
    shutdown(0)


main()
