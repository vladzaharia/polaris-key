# @pkey-feature connect.local
"""Modes ``q`` and ``l`` through two real sessions wired in memory (WIRE-CONTRACT-V5 §15.5, §15.12): the pairing
under a CPace PSK with the window's permit, the consent and ``LOCAL_LINK`` exchange, the link both sides store,
a mode-``l`` session under that link with its pin, the shared listener's trial order and padding, and the
admission of a listener with no account key. Mirrors client-core's ``peerLocalPairing.test.ts``. Clocks are
injected; nothing sleeps."""

from __future__ import annotations

import os
from typing import Any, List, Optional

import pytest

from polaris_key.core.peer_cpace import (
    cpace_generator,
    cpace_isk,
    cpace_prs_code,
    cpace_psk,
    cpace_scalar,
    cpace_share,
)
from polaris_key.core.peer_local import MAX_LOCAL_LINKS, PairingWindow, trial_padding
from polaris_key.core.peer_noise import NoiseHandshake, NoisePorts, peer_prologue
from polaris_key.core.peer_session import (
    Closed,
    ContactLink,
    Established,
    Guess,
    HandshakeLimiter,
    LocalLink,
    LocalLinkMade,
    PairingOptions,
    PeerSession,
    Record,
)

SLUG = "demo"
PORTS = NoisePorts()


def _key() -> Any:
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

    k = X25519PrivateKey.generate()
    return (
        k.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()),
        k.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw),
    )


class End:
    def __init__(self, role: str, **kw: Any) -> None:
        self.events: List[Any] = []
        self.out: List[bytes] = []
        self.clock = [0.0]
        self.s = PeerSession(
            role=role,
            slug=SLUG,
            send=self.out.append,
            on_event=self.events.append,
            hello=kw.pop("hello", {"label": role, "platform": "linux", "app": SLUG}),
            mono=lambda: self.clock[0],
            **kw,
        )

    def of(self, cls: Any) -> List[Any]:
        return [e for e in self.events if isinstance(e, cls)]


def pump(a: End, b: End, rounds: int = 200) -> None:
    for _ in range(rounds):
        moved = False
        for src, dst in ((a, b), (b, a)):
            while src.out:
                dst.s.receive(src.out.pop(0))
                moved = True
        if not moved:
            return


def _cpace(joiner_password: str = "123456", shower_password: str = "123456") -> Any:
    """The CPace exchange of one attempt: the joiner's and the shower's PSK and ISK."""
    sid = os.urandom(10)
    ci = peer_prologue(SLUG, "q")
    gj = cpace_generator(cpace_prs_code(joiner_password), ci, sid)
    gs = cpace_generator(cpace_prs_code(shower_password), ci, sid)
    ya, yb = cpace_scalar(), cpace_scalar()
    pa = cpace_share(ya, gj)
    pb = cpace_share(yb, gs)
    assert pa is not None and pb is not None
    isk_j = cpace_isk(sid, ya, pa, pb, "initiator")
    isk_s = cpace_isk(sid, yb, pa, pb, "responder")
    assert isk_j is not None and isk_s is not None
    return (bytearray(cpace_psk(isk_j, SLUG)), bytearray(isk_j)), (bytearray(cpace_psk(isk_s, SLUG)), bytearray(isk_s))


class Pairing:
    """A shower (responder) with a window and a joiner (initiator) over one CPace attempt."""

    def __init__(self, joiner_password: str = "123456", held_a: int = 0, held_b: int = 0, elapsed: float = 0.0) -> None:
        (psk_j, isk_j), (psk_s, isk_s) = _cpace(joiner_password)
        self.t = [0.0]
        self.window = PairingWindow()
        self.window.open(0.0)
        out = self.window.c1(0.0, True)
        self.id = out["id"]
        self.joiner = End(
            "initiator",
            mode="q",
            static_key=_key()[0],
            pair=PairingOptions(psk_j, isk_j, held_a, ["docs"], "Joiner", elapsed),
        )
        self.shower = End(
            "responder",
            mode="q",
            static_key=_key()[0],
            admission=HandshakeLimiter(),
            pair=PairingOptions(
                psk_s, isk_s, held_b, ["docs", "notes"], "Shower", elapsed,
                permit=lambda: self.window.begin_guess(self.id, self.t[0]),
            ),
        )

    def run(self) -> None:
        self.joiner.s.start()
        pump(self.joiner, self.shower)


def test_a_pairing_stores_the_same_secret_on_both_sides_after_both_confirm() -> None:
    p = Pairing()
    p.run()
    assert [g.opens for g in p.shower.of(Guess)] == [True]
    assert p.joiner.of(Established) and p.shower.of(Established)
    # Nothing is stored before both people confirm.
    p.joiner.s.confirm_pairing()
    pump(p.joiner, p.shower)
    assert not p.joiner.of(LocalLinkMade) and not p.shower.of(LocalLinkMade)
    p.shower.s.confirm_pairing()
    pump(p.joiner, p.shower)
    a, b = p.joiner.of(LocalLinkMade), p.shower.of(LocalLinkMade)
    assert len(a) == 1 and len(b) == 1
    assert a[0].secret == b[0].secret and len(a[0].secret) == 32
    assert a[0].own_key == b[0].peer_key and a[0].peer_key == b[0].own_key
    assert a[0].label == "Shower" and b[0].label == "Joiner"
    assert a[0].cats == ("docs",) and b[0].cats == ("docs",)
    assert repr(a[0]) == "LocalLinkMade()"
    # Both sides closed peer_bye once the link was read.
    assert [c.code for c in p.joiner.of(Closed)] and [c.code for c in p.shower.of(Closed)]
    assert p.joiner.of(Closed)[0].code == "peer_bye"


def test_the_psk_and_isk_are_overwritten_when_the_session_ends() -> None:
    p = Pairing()
    pair = p.joiner.s._pair
    assert pair is not None
    p.run()
    p.joiner.s.close()
    assert not any(pair.psk) and not any(pair.isk)


def test_a_wrong_code_is_one_failed_guess_and_the_session_closes_silently() -> None:
    p = Pairing(joiner_password="654321")
    p.run()
    assert [g.opens for g in p.shower.of(Guess)] == [False]
    assert [c.code for c in p.shower.of(Closed)] == ["handshake_failed"]
    assert not p.shower.of(Established)
    # The window counted the guess before the tag was tried and the verdict is the host's.
    assert p.window.state["failures"] == 1
    out = p.window.guess_failed(p.id, 0.0)
    assert out["rotate"] is True


def test_a_responder_without_a_permit_is_refused_and_one_that_is_denied_tries_no_tag() -> None:
    (psk_s, isk_s) = _cpace()[1]
    with pytest.raises(ValueError):
        PeerSession(
            role="responder", slug=SLUG, static_key=_key()[0], mode="q", admission=HandshakeLimiter(),
            pair=PairingOptions(psk_s, isk_s, 0, [], None, 0.0), send=lambda b: None, on_event=lambda e: None,
            hello={"platform": "t", "app": "a"},
        )
    p = Pairing()
    # A permit already used for this attempt: the next try is denied and no tag is tried.
    p.window.begin_guess(p.id, 0.0)
    p.run()
    assert not p.shower.of(Guess)
    assert [c.code for c in p.shower.of(Closed)] == ["handshake_failed"]


def test_an_attempt_that_has_used_its_30_seconds_tries_nothing() -> None:
    p = Pairing(elapsed=30.0)
    p.run()
    # The joiner starts no handshake; the shower never asked its window for a permit.
    assert [c.code for c in p.joiner.of(Closed)] == ["handshake_failed"]
    assert not p.joiner.out and not p.shower.out
    assert not p.shower.of(Guess) and p.window.state["failures"] == 0


def test_the_cap_refuses_the_link_after_both_confirm() -> None:
    p = Pairing(held_a=MAX_LOCAL_LINKS)
    p.run()
    p.joiner.s.confirm_pairing()
    p.shower.s.confirm_pairing()
    pump(p.joiner, p.shower)
    # The side at the cap refuses the peer's LOCAL_LINK and stores nothing. (The hosts check the cap before
    # they browse or advertise, so this is the backstop for a link that races the cap.)
    assert not p.joiner.of(LocalLinkMade)
    assert p.joiner.of(Closed)[0].code == "peer_not_allowed"


def test_a_decline_closes_peer_bye_and_stores_nothing() -> None:
    p = Pairing()
    p.run()
    p.joiner.s.decline_pairing()
    pump(p.joiner, p.shower)
    assert [c.code for c in p.joiner.of(Closed)] == ["peer_bye"]
    assert not p.joiner.of(LocalLinkMade) and not p.shower.of(LocalLinkMade)


def test_confirming_before_the_transport_closes_peer_not_allowed() -> None:
    p = Pairing()
    p.joiner.s.confirm_pairing()
    assert [c.code for c in p.joiner.of(Closed)] == ["peer_not_allowed"]


def test_the_120_seconds_from_the_first_byte_end_in_peer_timeout() -> None:
    p = Pairing()
    p.run()
    p.joiner.clock[0] = 121.0
    assert p.joiner.s.wake_in() == 0.0
    p.joiner.s.tick()
    assert [c.code for c in p.joiner.of(Closed)] == ["peer_timeout"]


def test_a_reflected_handshake_ends_silently() -> None:
    # The peer's static key is this side's own: the handshake ends before the transport.
    (psk_j, isk_j), (psk_s, isk_s) = _cpace()
    key = _key()[0]
    j = End("initiator", mode="q", static_key=key, pair=PairingOptions(psk_j, isk_j, 0, [], None, 0.0))
    s = End(
        "responder", mode="q", static_key=key, admission=HandshakeLimiter(),
        pair=PairingOptions(psk_s, isk_s, 0, [], None, 0.0, permit=lambda: True),
    )
    j.s.start()
    pump(j, s)
    assert not j.of(Established) and not s.of(Established)
    assert [c.code for c in j.of(Closed)] == ["handshake_failed"]


# -- mode l -----------------------------------------------------------------------------------------


def _link() -> Any:
    """Two devices' halves of one stored link."""
    (ka, pa), (kb, pb) = _key(), _key()
    secret = os.urandom(32)
    return LocalLink(secret, ka, pb), LocalLink(secret, kb, pa)


def _l_pair(**kw: Any) -> Any:
    la, lb = _link()
    a = End("initiator", mode="l", local_links=[la])
    b = End("responder", mode="l", local_links=[lb], admission=HandshakeLimiter(), **kw)
    return a, b, la, lb


def test_mode_l_opens_a_session_pins_the_key_and_marks_the_hello_unauthenticated() -> None:
    a, b, la, lb = _l_pair()
    a.s.start()
    pump(a, b)
    ea, eb = a.of(Established), b.of(Established)
    assert len(ea) == 1 and len(eb) == 1
    assert ea[0].local_index == 0 and eb[0].local_index == 0
    assert ea[0].hello_authenticated is False
    assert ea[0].remote_static == la.peer_key and eb[0].remote_static == lb.peer_key
    assert a.s.is_open and b.s.is_open
    a.s.send_record(0x0100, b"hi")
    pump(a, b)
    assert [r.body for r in b.of(Record)] == [b"hi"]


def test_mode_l_with_a_peer_that_does_not_hold_the_key_ends_peer_revoked_with_nothing_sent() -> None:
    la, _ = _link()
    other = LocalLink(la.secret, _key()[0], _key()[1])
    a = End("initiator", mode="l", local_links=[la])
    b = End("responder", mode="l", local_links=[other], admission=HandshakeLimiter())
    a.s.start()
    pump(a, b)
    assert not a.of(Established) and not b.of(Established)
    assert "peer_revoked" in [c.code for c in a.of(Closed) + b.of(Closed)]


def test_mode_l_refuses_ring_trust_and_pairing_records() -> None:
    a, b, _la, _lb = _l_pair()
    a.s.start()
    pump(a, b)
    # RING (0x0002) belongs to mode a.
    a.s._emit(0x0002, b"{}")
    pump(a, b)
    assert [c.code for c in b.of(Closed)] == ["peer_not_allowed"]


def test_a_mode_l_responder_without_a_limiter_is_refused() -> None:
    la, lb = _link()
    with pytest.raises(ValueError):
        PeerSession(
            role="responder", slug=SLUG, mode="l", local_links=[lb], send=lambda b: None,
            on_event=lambda e: None, hello={"platform": "t", "app": "a"},
        )


# -- the shared listener ----------------------------------------------------------------------------


class _Count(NoisePorts):
    """Counts the AES-GCM opens, so the trials a miss costs can be counted."""

    def __init__(self) -> None:
        self.opens = 0

    def open(self, key: bytes, nonce: bytes, aad: bytes, ciphertext: bytes) -> Optional[bytes]:
        self.opens += 1
        return super().open(key, nonce, aad, ciphertext)


def _message1(link: LocalLink) -> bytes:
    h = NoiseHandshake(
        "initiator", "Noise_XXpsk0_25519_AESGCM_SHA256", peer_prologue(SLUG, "l"), link.own_key, psk=link.secret
    )
    return h.write_message(b'{"v":1}')


def test_a_listener_with_no_account_tries_the_links_and_a_miss_costs_the_same_trials() -> None:
    held = [_link()[1] for _ in range(3)]
    stranger, _ = _link()
    ports = _Count()
    out: List[bytes] = []
    ev: List[Any] = []
    s = PeerSession(
        role="responder", slug=SLUG, mode="l", local_links=held, admission=HandshakeLimiter(), admission_group="g",
        ports=ports, send=out.append, on_event=ev.append, hello={"platform": "t", "app": "a"},
    )
    s.receive(_message1(stranger))
    assert [e.code for e in ev if isinstance(e, Closed)] == ["handshake_failed"]
    # Three real trials, and dummies on the default ports: the host's ports see only the real ones.
    assert ports.opens == 3
    assert trial_padding(3) == 2 + 72 + 32 - 3


def test_a_link_in_the_list_opens_with_the_index_of_the_one_that_matched() -> None:
    mine = [_link()[1] for _ in range(3)]
    far = _link()
    mine[2] = far[1]
    b = End("responder", mode="l", local_links=mine, admission=HandshakeLimiter(), admission_group="g")
    a = End("initiator", mode="l", local_links=[far[0]])
    a.s.start()
    pump(a, b)
    assert b.of(Established)[0].local_index == 2


def test_the_shared_listener_tries_the_account_keys_then_the_contacts_then_the_local_links() -> None:
    far = _link()
    contacts = [ContactLink(os.urandom(32), "A" * 43)]
    b = End(
        "responder", mode="l", local_links=[far[1]], contacts=contacts, admission=HandshakeLimiter(),
        admission_group="g",
    )
    a = End("initiator", mode="l", local_links=[far[0]])
    a.s.start()
    pump(a, b)
    assert b.of(Established)[0].local_index == 0


def test_the_group_budget_refuses_a_third_message_one_before_any_trial() -> None:
    held = [_link()[1]]
    stranger, _ = _link()
    lim = HandshakeLimiter()
    ports = _Count()
    closes: List[str] = []
    for _ in range(3):
        ev: List[Any] = []
        s = PeerSession(
            role="responder", slug=SLUG, mode="l", local_links=held, admission=lim, admission_group="same",
            ports=ports, send=lambda b: None, on_event=ev.append, hello={"platform": "t", "app": "a"},
        )
        before = ports.opens
        s.receive(_message1(stranger))
        closes.append([e.code for e in ev if isinstance(e, Closed)][0])
        closes.append(str(ports.opens - before))
    assert closes == ["handshake_failed", "1", "handshake_failed", "1", "peer_busy", "0"]


def test_another_group_is_not_touched_by_a_noisy_one() -> None:
    held = [_link()[1]]
    far = _link()
    held.append(far[1])
    lim = HandshakeLimiter()
    junk, _ = _link()
    for _ in range(2):
        s = PeerSession(
            role="responder", slug=SLUG, mode="l", local_links=held, admission=lim, admission_group="noisy",
            send=lambda b: None, on_event=lambda e: None, hello={"platform": "t", "app": "a"},
        )
        s.receive(_message1(junk))
    b = End("responder", mode="l", local_links=held, admission=lim, admission_group="quiet")
    a = End("initiator", mode="l", local_links=[far[0]])
    a.s.start()
    pump(a, b)
    assert b.of(Established)
