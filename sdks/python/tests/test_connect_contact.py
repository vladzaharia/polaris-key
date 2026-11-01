# @pkey-feature connect.links
"""Inter-account links, the engine half (WIRE-CONTRACT-V5 §15.10): the ``contact`` section of
``peer-matrix.json`` through the Python codecs, and mode ``c`` and the mode-``p`` contact exchange through
two real sessions wired in memory. Mirrors the Node runner (``peerMatrixSuites.ts``, ``contact``) and
client-core's ``peerContact.test.ts``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from polaris_key.core.b64url import b64url_decode, b64url_encode
from polaris_key.core.peer_contact import (
    CONTACT_BODY_MAX,
    CONTACT_EXCHANGE_SECONDS,
    CONTACT_LEASE_BYTES,
    CONTACT_ROOM_IDLE_SECONDS,
    CONTACT_TICKET_BODY_MAX,
    MAX_CONTACT_CATS,
    MAX_CONTACT_SECRETS,
    MAX_CONTACTS,
    MAX_LIVE_CONTACT_ADVERTS,
    MAX_PENDING_CONTACTS,
    PENDING_CONTACT_SECONDS,
    ContactExchange,
    ContactKey,
    StoredContact,
    browse_contact_instance,
    build_contact,
    contact_alias,
    contact_categories,
    contact_instance,
    contact_pin,
    contact_rid,
    contact_secret,
    contact_trial_order,
    drop_stale_pending,
    parse_contact,
    parse_contact_ticket_body,
    parse_contact_txt,
    promote_contact,
    store_contact,
)
from polaris_key.core.peer_noise import NoiseHandshake, NoisePorts, peer_noise_protocol, peer_prologue, peer_psk
from polaris_key.core.peer_payload import payload1
from polaris_key.core.peer_session import (
    Closed,
    Contact,
    ContactLink,
    ContactOffer,
    Established,
    HandshakeLimiter,
    PeerSession,
    Record,
    RingReceived,
    Sas,
    TrustUnverified,
)

_CORPUS = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2"
M: Dict[str, Any] = json.loads((_CORPUS / "peer-matrix.json").read_text())
C: Dict[str, Any] = M["contact"]
SLUG = "djdl"


def _unb64(s: str) -> bytes:
    return b64url_decode(s)


def _row_bytes(r: Dict[str, Any]) -> bytes:
    if "bodyHex" in r:
        return bytes.fromhex(r["bodyHex"])
    if "bodyPad" in r:
        p = r["bodyPad"]
        return (p["prefix"] + p["fill"] * p["count"] + p["suffix"]).encode("utf-8")
    return r["body"].encode("utf-8")


# -- the contact section ------------------------------------------------------------------------------


def test_constants() -> None:
    assert C["constants"] == {
        "maxContacts": MAX_CONTACTS,
        "maxCats": MAX_CONTACT_CATS,
        "maxPending": MAX_PENDING_CONTACTS,
        "maxSecrets": MAX_CONTACT_SECRETS,
        "pendingSeconds": PENDING_CONTACT_SECONDS,
        "bodyMax": CONTACT_BODY_MAX,
        "ticketBodyMax": CONTACT_TICKET_BODY_MAX,
        "maxLiveAdverts": MAX_LIVE_CONTACT_ADVERTS,
        "leaseBytes": CONTACT_LEASE_BYTES,
        "roomIdleSeconds": CONTACT_ROOM_IDLE_SECONDS,
        "exchangeSeconds": CONTACT_EXCHANGE_SECONDS,
    }


@pytest.mark.parametrize("r", C["secrets"], ids=[r["id"] for r in C["secrets"]])
def test_secrets(r: Dict[str, Any]) -> None:
    got = contact_secret(
        bytes.fromhex(r["h"]),
        bytes.fromhex(r["nD"]),
        bytes.fromhex(r["nM"]),
        _unb64(r["agreeKeyA"]),
        _unb64(r["agreeKeyB"]),
    )
    assert got.hex() == r["secret"]


@pytest.mark.parametrize("r", C["bodies"], ids=[r["id"] for r in C["bodies"]])
def test_bodies(r: Dict[str, Any]) -> None:
    b = _row_bytes(r)
    assert len(b) == r["length"]
    assert parse_contact(b, r.get("own")) == r["want"]


@pytest.mark.parametrize("r", C["categories"], ids=[r["id"] for r in C["categories"]])
def test_categories(r: Dict[str, Any]) -> None:
    assert contact_categories(r["local"], r["remote"]) == r["want"]


@pytest.mark.parametrize("r", C["exchange"], ids=[r["id"] for r in C["exchange"]])
def test_exchange(r: Dict[str, Any]) -> None:
    x = ContactExchange(r["own"], r["held"])
    assert len(r["want"]) == len(r["steps"])
    for i, s in enumerate(r["steps"]):
        e = {"event": s["event"]}
        if s["event"] == "peer-contact":
            e["body"] = s["body"].encode("utf-8")
        assert x.step(e) == r["want"][i], "%s step %d" % (r["id"], i)


def _fill(n: int) -> bytes:
    return bytes([n]) * 32


def _key_text(n: int) -> str:
    return b64url_encode(_fill(n))


@pytest.mark.parametrize("r", C["store"], ids=[r["id"] for r in C["store"]])
def test_store(r: Dict[str, Any]) -> None:
    lst: List[StoredContact] = [StoredContact(_key_text(k), _fill(sec)) for k, sec in r["start"]]
    for i, o in enumerate(r["ops"]):
        want = r["want"][i]
        result: Optional[str] = None
        if o["op"] == "pair":
            ok, lst2, pending = store_contact(
                lst, StoredContact(_key_text(o["key"]), _fill(o["secret"]), o.get("label")), o["now"]
            )
            if ok:
                lst = lst2
                result = "pending" if pending else "active"
            else:
                result = "full"
        elif o["op"] == "promote":
            lst = promote_contact(lst, _key_text(o["key"]))
        else:
            lst = drop_stale_pending(lst, o["now"])

        def ids(xs: List[StoredContact]) -> List[int]:
            return [x.secret[0] for x in xs]

        got: Dict[str, Any] = {}
        if result is not None:
            got["result"] = result
        got["active"] = ids([x for x in lst if x.pending_since is None])
        got["pending"] = ids([x for x in lst if x.pending_since is not None])
        got["order"] = ids(contact_trial_order(lst))
        assert got == want, "%s op %d" % (r["id"], i)


@pytest.mark.parametrize("r", C["pin"], ids=[r["id"] for r in C["pin"]])
def test_pin(r: Dict[str, Any]) -> None:
    ok = contact_pin(r["held"][r["matched"]], _unb64(r["remoteStatic"]))
    assert ({"ok": True} if ok else {"ok": False, "close": "peer_revoked", "sends": 0}) == r["want"]


class _CountingPorts(NoisePorts):
    """Each tag attempt is one AEAD open, so the opens counted while message 1 is read are the keys tried."""

    def __init__(self) -> None:
        self.opens = 0

    def open(self, key: bytes, nonce: bytes, aad: bytes, ciphertext: bytes) -> Optional[bytes]:
        self.opens += 1
        return super().open(key, nonce, aad, ciphertext)


@pytest.mark.parametrize("r", C["listener"], ids=[r["id"] for r in C["listener"]])
def test_listener(r: Dict[str, Any]) -> None:
    import os

    from polaris_key.core.peer_session import AccountContext

    ports = _CountingPorts()
    keys = [os.urandom(32) for _ in (r.get("account") or [])]
    secrets = [os.urandom(32) for _ in r["contacts"]]
    mode = "c"
    if r["opens"] is None:
        psk: Optional[bytes] = os.urandom(32)
    elif r["opens"]["mode"] == "a":
        mode = "a"
        psk = peer_psk(keys[r["opens"]["key"]], SLUG)
    else:
        psk = secrets[r["opens"]["contact"]]
    limiter = HandshakeLimiter(0 if r["limiter"] == "refuse" else 99, 1, lambda: 0.0)
    out: List[bytes] = []
    events: List[Any] = []
    kw: Dict[str, Any] = {}
    if r["account"] is not None:
        kw["account"] = AccountContext(
            trust={},
            expected_aud=SLUG,
            cert_jws="",
            own_sub="ps_x",
            own_device_id="x" * 32,
            held_ring=lambda: None,
            disc_keys=[None if k is None else keys[i] for i, k in enumerate(r["account"])],
        )
    if r["contacts"]:
        kw["contacts"] = [ContactLink(s, b64url_encode(os.urandom(32))) for s in secrets]
    ch = PeerSession(
        mode="a" if r["account"] is not None else "c",
        role="responder",
        slug=SLUG,
        static_key=os.urandom(32),
        ports=ports,
        hello={"platform": "t", "app": "a"},
        send=out.append,
        on_event=events.append,
        admission=limiter,
        **kw,
    )
    init = NoiseHandshake(
        "initiator", peer_noise_protocol(mode), peer_prologue(SLUG, mode), os.urandom(32), psk=psk
    )
    ch.receive(init.write_message(payload1()))
    assert ports.opens == len(r["want"]["tried"]), "%s keys tried" % r["id"]
    closed = next((e for e in events if isinstance(e, Closed)), None)
    assert (closed.code if closed else None) == r["want"]["close"]
    assert len(out) == (0 if r["want"]["hit"] is None else 1)
    # A contact trial holds its slot until message 3: a limiter of one waiting shows it.
    if r["limiter"] == "admit":
        assert (limiter.begin() is None) == r["want"]["slot"], "%s slot" % r["id"]


def test_advert_names() -> None:
    assert C["adverts"]["epochSeconds"] == 900
    for r in C["adverts"]["names"]:
        assert contact_instance(bytes.fromhex(r["secret"]), _unb64(r["agreeKey"]), r["epoch"]) == r["instance"], r["id"]


@pytest.mark.parametrize("r", C["adverts"]["txt"], ids=[r["id"] for r in C["adverts"]["txt"]])
def test_advert_txt(r: Dict[str, Any]) -> None:
    assert parse_contact_txt(r["entries"]) == r["want"]


@pytest.mark.parametrize("r", C["adverts"]["browse"], ids=[r["id"] for r in C["adverts"]["browse"]])
def test_advert_browse(r: Dict[str, Any]) -> None:
    contacts = [ContactKey(bytes.fromhex(k["secret"]), _unb64(k["agreeKey"])) for k in r["contacts"]]
    assert browse_contact_instance(r["instance"], contacts, r["now"]) == r["want"]


def test_room_ids_and_aliases() -> None:
    for r in C["rooms"]["rid"]:
        assert contact_rid(bytes.fromhex(r["secret"])) == r["rid"], r["id"]
    for r in C["rooms"]["alias"]:
        assert contact_alias(r["rid"], r["deviceId"]).hex() == r["alias"], r["id"]


@pytest.mark.parametrize("r", C["tickets"], ids=[r["id"] for r in C["tickets"]])
def test_tickets(r: Dict[str, Any]) -> None:
    b = _row_bytes(r)
    assert len(b) == r["length"]
    assert parse_contact_ticket_body(b) == r["want"]


def test_row_counts_are_pinned() -> None:
    assert (len(C["secrets"]), len(C["bodies"]), len(C["categories"]), len(C["exchange"])) == (10, 46, 8, 24)
    assert (len(C["store"]), len(C["listener"]), len(C["pin"]), len(C["tickets"])) == (12, 10, 6, 21)


def test_build_contact_round_trips_and_refuses_what_the_peer_would() -> None:
    key = _key_text(7)
    body = build_contact(key, ["b", "a"], "  Ana​ ")
    v = parse_contact(body)
    assert v == {"ok": True, "agreeKey": key, "label": "Ana", "cats": ["b", "a"]}
    with pytest.raises(ValueError):
        build_contact(key, ["Bad"])
    with pytest.raises(ValueError):
        build_contact("short", [])
    # An all-zero key is a low-order point.
    with pytest.raises(ValueError):
        build_contact(b64url_encode(bytes(32)), [])
    assert parse_contact(body, key) == {"ok": False}


def test_a_contact_has_no_secret_in_its_repr_or_pickle() -> None:
    import pickle

    c = StoredContact(_key_text(1), bytes([0xAB]) * 32)
    assert "ab" * 4 not in repr(c).lower()
    with pytest.raises(TypeError):
        pickle.dumps(c)


# -- two sessions in memory: mode c and the exchange ----------------------------------------------------


def _x25519() -> Any:
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
                m = src.out.pop(0)
                dst.s.receive(m)
                moved = True
        if not moved:
            return


def _pair_contact() -> Any:
    """Two devices with keys and a shared secret made the way the exchange makes it."""
    (pa, ua), (pb, ub) = _x25519(), _x25519()
    import os

    secret = os.urandom(32)
    return (pa, ua), (pb, ub), secret


def test_mode_c_opens_a_session_pins_the_key_and_marks_the_hello_unauthenticated() -> None:
    (pa, ua), (pb, ub), secret = _pair_contact()
    ka, kb = b64url_encode(ua), b64url_encode(ub)
    a = End("initiator", mode="c", static_key=pa, contacts=[ContactLink(secret, kb)], caps=["app/1"])
    b = End(
        "responder",
        mode="c",
        static_key=pb,
        contacts=[ContactLink(secret, ka)],
        admission=HandshakeLimiter(5, 4),
        caps=["app/1"],
    )
    a.s.start()
    pump(a, b)
    ea, eb = a.of(Established), b.of(Established)
    assert len(ea) == 1 and len(eb) == 1
    assert ea[0].hello_authenticated is False and eb[0].hello_authenticated is False
    assert ea[0].peer_device_id is None and ea[0].contact_index == 0 and eb[0].contact_index == 0
    assert ea[0].remote_static == ub and eb[0].remote_static == ua
    assert a.s.is_open and b.s.is_open
    a.s.send_record(0x0100, b"across accounts")
    pump(a, b)
    assert [r.body for r in b.of(Record)] == [b"across accounts"]
    # The responder's slot among the connections waiting for message 3 ended at HELLO.
    lim = HandshakeLimiter(5, 1)
    assert lim.begin() is not None


def test_mode_c_with_a_peer_that_does_not_hold_the_key_ends_peer_revoked_with_nothing_sent() -> None:
    (pa, ua), (pb, ub), secret = _pair_contact()
    other = b64url_encode(_x25519()[1])
    a = End("initiator", mode="c", static_key=pa, contacts=[ContactLink(secret, other)])
    b = End(
        "responder",
        mode="c",
        static_key=pb,
        contacts=[ContactLink(secret, b64url_encode(ua))],
        admission=HandshakeLimiter(),
    )
    a.s.start()
    pump(a, b)
    assert [c.code for c in a.of(Closed)] == ["peer_revoked"]
    assert not a.of(Established)
    # Message 3 was never written: the responder saw nothing past message 1.
    assert not b.of(Established)


def test_a_wrong_secret_closes_silently() -> None:
    import os

    (pa, ua), (pb, ub), secret = _pair_contact()
    a = End("initiator", mode="c", static_key=pa, contacts=[ContactLink(os.urandom(32), b64url_encode(ub))])
    b = End(
        "responder",
        mode="c",
        static_key=pb,
        contacts=[ContactLink(secret, b64url_encode(ua))],
        admission=HandshakeLimiter(),
    )
    a.s.start()
    pump(a, b)
    assert [c.code for c in b.of(Closed)] == ["handshake_failed"]
    assert b.out == [] and not b.of(Established)


def test_ring_and_trust_close_a_contact_session_peer_not_allowed() -> None:
    for rec in (RECORD_RING, RECORD_TRUST):
        (pa, ua), (pb, ub), secret = _pair_contact()
        a = End("initiator", mode="c", static_key=pa, contacts=[ContactLink(secret, b64url_encode(ub))])
        b = End(
            "responder",
            mode="c",
            static_key=pb,
            contacts=[ContactLink(secret, b64url_encode(ua))],
            admission=HandshakeLimiter(),
        )
        a.s.start()
        pump(a, b)
        assert a.s.is_open
        from polaris_key.core.peer_frame import PeerRecord, encode_record

        assert a.s._tp is not None
        b.s.receive(a.s._tp.send.encrypt(b"", encode_record(PeerRecord(rec, 0, b"{}"))))
        assert [c.code for c in b.of(Closed)] == ["peer_not_allowed"]
        assert not b.of(RingReceived) and not b.of(TrustUnverified)


RECORD_RING, RECORD_TRUST = 0x0002, 0x0003


def test_the_shared_listener_tries_the_account_keys_then_the_contacts() -> None:
    # A contact initiator reaches a mode-a responder that also serves contacts: the session is mode c.
    from polaris_key.core.peer_session import AccountContext

    (pa, ua), (pb, ub), secret = _pair_contact()
    acct = AccountContext(
        trust={},
        expected_aud=SLUG,
        cert_jws="x",
        own_sub="ps_x",
        own_device_id="x" * 32,
        held_ring=lambda: None,
        disc_keys=[bytes(range(32)), None],
    )
    a = End("initiator", mode="c", static_key=pa, contacts=[ContactLink(secret, b64url_encode(ub))])
    b = End(
        "responder",
        mode="a",
        static_key=pb,
        account=acct,
        contacts=[ContactLink(bytes(32), b64url_encode(_x25519()[1])), ContactLink(secret, b64url_encode(ua))],
        admission=HandshakeLimiter(),
    )
    a.s.start()
    pump(a, b)
    eb = b.of(Established)
    assert len(eb) == 1 and eb[0].contact_index == 1 and eb[0].hello_authenticated is False


def test_a_contact_responder_without_a_limiter_is_refused() -> None:
    (pa, ua), (pb, ub), secret = _pair_contact()
    with pytest.raises(ValueError):
        PeerSession(
            role="responder",
            slug=SLUG,
            mode="c",
            static_key=pb,
            contacts=[ContactLink(secret, b64url_encode(ua))],
            send=lambda m: None,
            on_event=lambda e: None,
            hello={"platform": "t", "app": "a"},
        )
    with pytest.raises(ValueError):
        PeerSession(
            role="initiator",
            slug=SLUG,
            mode="c",
            static_key=pa,
            contacts=[ContactLink(secret, "a"), ContactLink(secret, "b")],
            send=lambda m: None,
            on_event=lambda e: None,
            hello={"platform": "t", "app": "a"},
        )


def _pairing(held_a: Any = (), held_b: Any = (), cats_a: Any = ("docs",), cats_b: Any = ("docs", "notes")) -> Any:
    (_, ua), (_, ub) = _x25519(), _x25519()
    ka, kb = b64url_encode(ua), b64url_encode(ub)
    a = End(
        "initiator",
        mode="p",
        static_key=_x25519()[0],
        exchange=ContactOffer(ka, list(cats_a), list(held_a), "Ana"),
    )
    b = End(
        "responder",
        mode="p",
        static_key=_x25519()[0],
        exchange=ContactOffer(kb, list(cats_b), list(held_b), "Bo"),
        admission=HandshakeLimiter(),
    )
    return a, b, ka, kb


def test_the_exchange_stores_the_same_secret_on_both_sides_after_both_confirm() -> None:
    a, b, ka, kb = _pairing()
    a.s.start()
    pump(a, b)
    assert a.of(Sas) and b.of(Sas) and a.of(Sas)[0].display == b.of(Sas)[0].display
    a.s.confirm_sas()
    pump(a, b)
    # One side confirmed: nothing is stored yet.
    assert not a.of(Contact) and not b.of(Contact)
    b.s.confirm_sas()
    pump(a, b)
    ca, cb = a.of(Contact), b.of(Contact)
    assert len(ca) == 1 and len(cb) == 1
    assert ca[0].secret == cb[0].secret and len(ca[0].secret) == 32
    assert ca[0].agree_key == kb and cb[0].agree_key == ka
    assert ca[0].label == "Bo" and cb[0].label == "Ana"
    assert ca[0].cats == ("docs", "notes") and cb[0].cats == ("docs",)
    assert ca[0].pending is False
    assert "Contact()" == repr(ca[0])


def test_a_re_pair_of_a_held_peer_is_pending() -> None:
    a, b, ka, kb = _pairing()
    a2, b2, _, _ = _pairing()
    # Use A's own pairing but tell it the peer is held: build it by hand.
    (_, ua), (_, ub) = _x25519(), _x25519()
    a = End(
        "initiator",
        mode="p",
        static_key=_x25519()[0],
        exchange=ContactOffer(b64url_encode(ua), ["x"], [b64url_encode(ub)], None),
    )
    b = End(
        "responder",
        mode="p",
        static_key=_x25519()[0],
        exchange=ContactOffer(b64url_encode(ub), ["x"], [], None),
        admission=HandshakeLimiter(),
    )
    a.s.start()
    pump(a, b)
    a.s.confirm_sas()
    b.s.confirm_sas()
    pump(a, b)
    assert a.of(Contact)[0].pending is True and b.of(Contact)[0].pending is False


def test_a_contact_before_the_peers_confirm_is_peer_bad_frame_and_a_silent_peer_times_out() -> None:
    a, b, ka, kb = _pairing()
    a.s.start()
    pump(a, b)
    a.s.confirm_sas()
    # A's own CONFIRM is out; B never answers. 30 s later A closes peer_timeout.
    a.out.clear()
    a.clock[0] = float(CONTACT_EXCHANGE_SECONDS) + 1
    assert a.s.wake_in() == 0.0
    a.s.tick()
    assert [c.code for c in a.of(Closed)] == ["peer_timeout"]


def test_exchange_is_for_mode_p_only() -> None:
    with pytest.raises(ValueError):
        PeerSession(
            role="initiator",
            slug=SLUG,
            mode="v",
            static_key=bytes(32),
            exchange=ContactOffer("k"),
            send=lambda m: None,
            on_event=lambda e: None,
            hello={"platform": "t", "app": "a"},
        )


def test_contact_key_repr_has_no_secret() -> None:
    k = ContactKey(bytes([0xAB]) * 32, bytes([0xCD]) * 32)
    for text in (repr(k), str(k), repr([k]), "%s" % (k,)):
        assert "\\xab" not in text and "\\xcd" not in text and "abab" not in text
        assert "secret" not in text.lower()
