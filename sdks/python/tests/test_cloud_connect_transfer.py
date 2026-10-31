# @pkey-feature connect.transfer
"""Direct Transfer through the facade (WIRE-CONTRACT-V5 §15.11): ``cloud_connect.transfer`` over real
loopback TCP (the LAN path) and the in-process relay room, across the Connect thread and the host's."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, List

import pytest
from test_cloud_connect import FakeConnect, Rig
from test_connect_lan import until
from test_connect_peer_session import ID_A, ID_B, NOW

from polaris_key.connect.cloud_connect import CloudConnect
from polaris_key.connect.transfer import Accept, IncomingOffer
from polaris_key.core.errors import PolarisError


def _make(r: Rig, dev: Any, state: Path) -> CloudConnect:
    cc = CloudConnect(
        FakeConnect(r.world, dev, r.room),  # type: ignore[arg-type]
        lambda: r.discovery,
        now=lambda: NOW,
        state_dir=lambda: str(state),
    )
    r.all.append(cc)
    return cc


def _content(n: int) -> bytes:
    return bytes(((i * 7 + 13) & 0xFF) for i in range(n))


def test_a_transfer_over_the_lan(tmp_path: Path) -> None:
    with Rig() as r:
        (tmp_path / "a").mkdir()
        (tmp_path / "b").mkdir()
        a, b = _make(r, r.world.a, tmp_path / "a"), _make(r, r.world.b, tmp_path / "b")
        a.start(r.options())
        b.start(r.options())
        dest = tmp_path / "got.bin"
        asked: List[IncomingOffer] = []

        def handler(o: IncomingOffer) -> Accept:
            asked.append(o)
            return Accept(str(dest))

        a.transfer.on_offer(handler)
        until(lambda: any(p.device_id == ID_A and p.lan for p in b.peers()))
        data = _content(700_000)
        h = b.transfer.send(ID_A, data, name="data.bin")
        res = h.wait(20)
        assert res.outcome == "delivered", res
        assert dest.read_bytes() == data
        assert asked and asked[0].name == "data.bin" and asked[0].peer_device_id == ID_B
        # a handler that declines (and one that keeps the session open without taking offers)
        b.transfer.on_offer(lambda o: "decline")
        until(lambda: any(p.device_id == ID_B and p.lan for p in a.peers()))
        h = a.transfer.send(ID_B, b"abc")
        assert h.wait(20).reason == "declined"


def test_a_transfer_over_the_relay(tmp_path: Path) -> None:
    with Rig() as r:
        (tmp_path / "a").mkdir()
        (tmp_path / "b").mkdir()
        a, b = _make(r, r.world.a, tmp_path / "a"), _make(r, r.world.b, tmp_path / "b")
        a.start(r.options(lan=False))
        b.start(r.options(lan=False))
        until(lambda: b.status().relay == "open" and a.status().relay == "open")
        b.refresh_peers()
        until(lambda: any(p.device_id == ID_A for p in b.peers()))
        dest = tmp_path / "relay.bin"
        a.transfer.on_offer(lambda o: Accept(str(dest)))
        data = _content(300_000)
        h = b.transfer.send(ID_A, data)
        assert h.wait(30).outcome == "delivered"
        assert dest.read_bytes() == data


def test_a_peer_without_the_capability_is_a_typed_refusal(tmp_path: Path) -> None:
    with Rig() as r:
        (tmp_path / "a").mkdir()
        (tmp_path / "b").mkdir()
        a, b = _make(r, r.world.a, tmp_path / "a"), _make(r, r.world.b, tmp_path / "b")
        a.start(r.options(transfer=False))
        b.start(r.options())
        a.on_channel(lambda s: None)
        until(lambda: any(p.device_id == ID_A and p.lan for p in b.peers()))
        with pytest.raises(PolarisError) as e:
            b.transfer.send(ID_A, b"abc")
        assert getattr(e.value, "reason", "") == "not_allowed"
        assert not any(n for n in os.listdir(tmp_path / "b") if n != "transfers")
