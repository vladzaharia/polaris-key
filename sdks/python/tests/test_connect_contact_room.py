# @pkey-feature connect.links
"""A contact room judges its peer on ``MEMBERS`` (WIRE-CONTRACT-V5 section 15.7): a first relay message that
arrives before it is held (at most 8) and never seats the sender as the peer. Mirrors Node's
``test/connect/links.test.ts`` ("holds a first message that arrives before MEMBERS")."""

from __future__ import annotations

import asyncio
from typing import Any, List

from polaris_key.connect.contact_relay import MAX_DEFERRED, ContactRelaySource, ContactRoom
from polaris_key.connect.contacts import LiveContact
from polaris_key.connect.relay import RelayOptions
from polaris_key.core.peer_relay_codec import decode_relay, encode_relay


class _Outbox:
    def __init__(self) -> None:
        self.sent: List[bytes] = []

    def put(self, data: bytes, force: bool = False) -> None:
        self.sent.append(bytes(data))


def _room() -> ContactRoom:
    c = LiveContact(
        id="c" * 16,
        agree_key="k",
        agree_key_bytes=bytes(32),
        secret=bytearray(range(32)),
        label=None,
        cats=(),
        reachable=True,
        pending=False,
    )
    r = ContactRoom(ContactRelaySource(None, lambda _rid: None), c, RelayOptions(), lambda _s: None, lambda _r: None, True)  # type: ignore[arg-type]
    r._own = bytes([1]) * 24
    r._open = True
    r._outbox = _Outbox()  # type: ignore[assignment]
    return r


def _ops(r: ContactRoom) -> List[str]:
    return [decode_relay("toRoom", b)["op"] for b in r._outbox.sent]  # type: ignore[union-attr]


def test_a_first_message_before_members_is_held_and_judged_on_members() -> None:
    async def go() -> None:
        r = _room()
        stranger, peer = bytes([7]) * 24, bytes([9]) * 24
        for i in range(MAX_DEFERRED + 4):
            await r._recv(stranger, 10 + i, b"\x01" * 48)
        # Held up to the bound, MEMBERS asked for, and nobody seated as the peer.
        assert len(r._deferred) == MAX_DEFERRED
        assert r._peer_alias is None
        assert "list" in _ops(r)
        # MEMBERS names somebody else: the held messages are judged against it and dropped.
        await r._handle(encode_relay({"op": "members", "devices": [r._own, peer]}))
        assert r._peer_alias == peer
        assert r._deferred == []
        assert r._links == {}
        assert "send" not in _ops(r)

    asyncio.run(go())
