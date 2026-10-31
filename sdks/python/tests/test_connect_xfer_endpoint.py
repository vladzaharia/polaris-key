# @pkey-feature connect.transfer
"""The endpoint never lets a port failure escape into the host: it closes that session only."""

from __future__ import annotations

from typing import Any, List

from polaris_key.core.peer_xfer import XFER, XferMachine, xfer_offer_body
from polaris_key.core.peer_xfer_endpoint import XferEndpoint, XferEvents

SHA = "578091f7924f577fb22f2776d28666ce51346719ec816cb87aaf09a88e26c55d"
ID = "mM6QZzGG1pHeEeIOBHXPjQ"


class Ev(XferEvents):
    def __init__(self) -> None:
        self.errors: List[BaseException] = []
        self.asks: List[Any] = []

    def ask(self, a: Any) -> None:
        self.asks.append(a)

    def error(self, err: BaseException) -> None:
        self.errors.append(err)


def _boom(_i: str, _s: str) -> str:
    raise RuntimeError("store")


def test_a_throw_while_accepting_closes_the_session_and_not_the_host() -> None:
    closes: List[str] = []
    ev = Ev()
    m = XferMachine(
        mode="a", caps=["xfer/1"], max_message=1 << 20, peer_key=bytes(32), handler=lambda a: "ask", new_ref=_boom
    )
    ep = XferEndpoint(
        m, send=lambda t, b: None, close=closes.append, read=lambda *a: b"", apply=lambda e: None, events=ev
    )
    body = xfer_offer_body({"id": ID, "size": 10, "sha256": SHA, "chunk": 10})
    ep.receive(XFER["OFFER"], body)
    assert len(ev.asks) == 1
    ep.consent(ID, "accept")  # must not raise
    assert closes == ["peer_bye"] and len(ev.errors) == 1
    ep.consent(ID, "accept")  # the endpoint is over: nothing happens
    assert closes == ["peer_bye"]
