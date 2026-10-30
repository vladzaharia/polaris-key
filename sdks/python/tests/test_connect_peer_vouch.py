# @pkey-feature connect.protocol
"""The mode-v vouch codecs (WIRE-CONTRACT-V5 §15.6.1) in ``core/peer_vouch.py``: ``VOUCH_REQ`` built by a
real device key store and verified, ``VOUCH_RESULT``, the approve-answer table, the decoys and their
positions, the advert instance, the failure budget and the order guard. The shared vectors (the
``vouch`` section of ``peer-matrix.json``) run in ``test_connect_conformance.py``; these are the
behaviours rows cannot show. Mirrors ``packages/client-core/test/peerVouch.test.ts``."""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

import pytest

from polaris_key.core.device_keys import DeviceKeyPort
from polaris_key.core.peer_display import clean_label
from polaris_key.core.peer_frame import RECORD
from polaris_key.core.peer_vouch import (
    VOUCH_HELD_BYTES,
    VOUCH_HELD_RECORDS,
    ApproveAnswer,
    BuildVouchRequestOptions,
    VouchFailureBudget,
    VouchFlow,
    VouchHello,
    VouchRecord,
    approver_instance,
    build_vouch_request,
    build_vouch_result,
    decoy_codes,
    finish_map,
    parse_vouch_result,
    verify_vouch_request,
)
from polaris_key.devices.keys import DeviceKeyStore, InMemoryDeviceKeyStorage

SLUG = "demo"
DEVICE = "yLOTkYomb4xKmDRpnlnvrvB4_ktxXwrS"
REQUEST = "nr_0IvbE7YHMGPBP0VAfZDQhg"
H = bytes(range(1, 33))
OTHER_H = bytes(200 - i for i in range(32))
HELLO = VouchHello(label="Ana's Switch", platform="linux")


def _port() -> Any:
    return DeviceKeyStore(InMemoryDeviceKeyStorage())


def _build(port: Any, hello: VouchHello = HELLO, **kw: Any) -> bytes:
    args: Dict[str, Any] = dict(port=port, slug=SLUG, h=H, request=REQUEST, device_id=DEVICE, hello=hello)
    args.update(kw)
    return build_vouch_request(BuildVouchRequestOptions(**args))


@pytest.fixture(scope="module")
def port() -> DeviceKeyPort:
    return _port()


@pytest.fixture(scope="module")
def body(port: Any) -> bytes:
    return _build(port)


def edit(body: bytes, f: Callable[[Dict[str, Any]], None]) -> bytes:
    o = json.loads(body.decode("utf-8"))
    f(o)
    return json.dumps(o, separators=(",", ":")).encode("utf-8")


def verify(b: bytes, h: bytes = H, hello: VouchHello = HELLO, **kw: Any) -> Any:
    return verify_vouch_request(slug=SLUG, h=h, hello=hello, body=b, **kw)


# -- VOUCH_REQ ----------------------------------------------------------------------------------


def test_a_built_request_verifies_and_shows_what_ds_hello_showed(port: Any, body: bytes) -> None:
    keys = port.ensure()
    got = verify(body)
    assert got is not None
    assert got.to_json() == {
        "request": REQUEST,
        "deviceId": DEVICE,
        "signKey": keys.sign_key,
        "agreeKey": keys.agree_key,
        "label": HELLO.label,
        "platform": "linux",
    }
    assert list(json.loads(body)) == ["v", "request", "deviceId", "signKey", "agreeKey", "label", "platform", "sig"]


def test_label_is_omitted_when_hello_had_none_and_then_a_label_is_refused(port: Any, body: bytes) -> None:
    none = VouchHello(platform="linux")
    b = _build(port, none)
    assert "label" not in json.loads(b)
    got = verify(b, H, none)
    assert got is not None and got.label is None
    assert verify(b, H, HELLO) is None
    assert verify(body, H, none) is None


def test_the_label_is_compared_to_a_hello_the_session_already_cleaned(port: Any) -> None:
    # A zero-width space between a base letter and a combining acute. One cleaning drops the space and
    # keeps the two marks apart; a second cleaning composes them into one letter.
    raw = "e\u200b\u0301x"
    once = clean_label(raw)
    assert once is not None and clean_label(once) != once
    b = _build(port, VouchHello(label=raw, platform="linux"))
    ok = verify(b, H, VouchHello(label=once, platform="linux"), hello_cleaned=True)
    assert ok is not None and ok.label == once
    assert verify(b, H, VouchHello(label="Other", platform="linux"), hello_cleaned=True) is None
    # A raw HELLO (the corpus rows) is still cleaned once.
    assert verify(b, H, VouchHello(label=raw, platform="linux")) is not None


def test_a_request_is_bound_to_one_session(body: bytes) -> None:
    assert verify(body, OTHER_H) is None


def test_a_changed_field_is_refused_each_is_covered_by_the_proof_or_the_checks(body: bytes) -> None:
    def setter(k: str, v: Any) -> Callable[[Dict[str, Any]], None]:
        return lambda o: o.__setitem__(k, v)

    assert verify(edit(body, setter("request", "nr_AAAAAAAAAAAAAAAAAAAAAA"))) is None
    assert verify(edit(body, setter("deviceId", DEVICE.replace("y", "z")))) is None
    assert verify(edit(body, setter("label", "Someone else"))) is None
    assert verify(edit(body, setter("platform", "windows"))) is None
    assert verify(edit(body, lambda o: o.pop("sig"))) is None
    assert verify(edit(body, setter("v", 2))) is None
    assert verify(edit(body, setter("v", True))) is None
    assert verify(edit(body, setter("signKey", _port().ensure().sign_key))) is None


def test_unknown_members_are_ignored_and_a_body_over_4_kib_is_refused(body: bytes) -> None:
    assert verify(edit(body, lambda o: o.__setitem__("extra", [1, 2]))) is not None
    assert verify(edit(body, lambda o: o.__setitem__("extra", "x" * 4096))) is None


def test_building_refuses_a_bad_input_and_names_no_value(port: Any) -> None:
    with pytest.raises(ValueError):
        _build(port, h=H[1:])
    with pytest.raises(ValueError, match="vouch request: bad input") as e:
        _build(port, request="nr_short")
    assert "nr_short" not in str(e.value)
    with pytest.raises(ValueError):
        _build(port, device_id="short")
    with pytest.raises(ValueError, match="vouch request: too large"):
        _build(port, VouchHello(platform="p", label="x" * 5000))


def test_a_request_and_its_proof_stay_out_of_a_repr(port: Any, body: bytes) -> None:
    got = verify(body)
    assert got is not None
    assert REQUEST not in repr(got)
    opts = BuildVouchRequestOptions(port=port, slug=SLUG, h=H, request=REQUEST, device_id=DEVICE, hello=HELLO)
    assert REQUEST not in repr(opts) and repr(H) not in repr(opts)


# -- VOUCH_RESULT -------------------------------------------------------------------------------


def test_results_round_trip_and_an_unknown_status_reads_as_denied() -> None:
    for s in ("approved", "denied", "expired"):
        assert parse_vouch_result(build_vouch_result(s)).status == s
    assert parse_vouch_result(b'{"status":"not_nearby"}').status == "denied"
    assert parse_vouch_result(b"[]").refuse == "peer_bad_frame"
    assert parse_vouch_result(b'{"status":1}').refuse == "peer_bad_frame"


# -- finish_map ---------------------------------------------------------------------------------


def ans(http: Optional[int], b: Optional[str] = None, **o: Any) -> Any:
    kw: Dict[str, Any] = dict(http=http, body=b, discovery_nearby=True, keys_retried=False)
    kw.update(o)
    return finish_map(ApproveAnswer(**kw))


def test_finish_map_maps_the_table() -> None:
    assert ans(200, '{"status":"approved"}').send == "approved"
    assert ans(204).send == "denied"
    assert ans(403, '{"code":"not_nearby"}').send == "denied"
    assert ans(403, '{"code":"device_limit"}').send == "denied"
    assert ans(404).send == "expired"
    assert ans(200, '{"status":"choose"}').wait == "choice"
    assert ans(409, '{"code":"device_keys_required"}').wait == "keys"
    assert ans(409, '{"code":"license_choice_required"}').wait == "choice"


@pytest.mark.parametrize(
    "http,b",
    [
        (None, None),
        (400, None),
        (403, '{"code":"account_required"}'),
        (409, '{"code":"conflict"}'),
        (429, None),
        (503, None),
        (200, None),
        (201, '{"status":"approved"}'),
    ],
)
def test_finish_map_closes_on_everything_else(http: Optional[int], b: Optional[str]) -> None:
    got = ans(http, b)
    assert got.close is True and got.stop_advert is False and got.send is None and got.wait is None


def test_the_keys_retry_happens_once_and_a_404_after_discovery_lost_nearby_stops_the_advert() -> None:
    again = ans(409, '{"code":"device_keys_required"}', keys_retried=True)
    assert again.close is True and again.stop_advert is False
    lost = ans(404, None, discovery_nearby=False)
    assert lost.close is True and lost.stop_advert is True


# -- decoys and the advert instance -------------------------------------------------------------


def draws(*n: int) -> Callable[[int], bytes]:
    """A source that hands out the given 32-bit draws, then a counter."""
    state = [0]

    def src(length: int) -> bytes:
        assert length == 4
        i = state[0]
        state[0] += 1
        v = n[i] if i < len(n) else 0xFFFF_FFF0 - i
        return v.to_bytes(4, "big")

    return src


def test_decoys_are_three_distinct_codes_in_range_with_the_real_one_at_index() -> None:
    import random

    for _ in range(200):
        real = random.randrange(1_000_000)
        d = decoy_codes(real)
        assert len(set(d.codes)) == 3 and all(0 <= c < 1_000_000 for c in d.codes)
        assert d.codes[d.index] == real


def test_a_draw_in_the_biased_tail_and_a_duplicate_draw_are_rejected() -> None:
    # 2**32 = 4294 * 10**6 + 967296, so 4_294_000_000 and above is the biased tail.
    src = draws(
        4_294_000_000,  # rejected: tail
        0xFFFF_FFFF,  # rejected: tail
        7,  # = real 7: rejected as a duplicate
        123_456,  # decoy 1
        123_456,  # duplicate of decoy 1: rejected
        999_999,  # decoy 2
        0,  # shuffle: position for slot 2
        0,  # shuffle: position for slot 1
    )
    assert set(decoy_codes(7, src).codes) == {7, 123_456, 999_999}


def test_a_source_that_cannot_produce_a_value_is_given_up_on() -> None:
    with pytest.raises(ValueError, match="vouch: random source"):
        decoy_codes(5, lambda n: b"\xff" * 4)
    with pytest.raises(ValueError, match="vouch: random source"):
        decoy_codes(5, lambda n: b"\x00" * 4)


@pytest.mark.parametrize("bad", [-1, 1_000_000, 1.5, True, "7"])
def test_a_real_code_outside_the_range_is_refused(bad: Any) -> None:
    with pytest.raises(ValueError):
        decoy_codes(bad)


def test_the_real_code_lands_at_each_position_about_equally_often() -> None:
    seen = [0, 0, 0]
    for _ in range(3000):
        seen[decoy_codes(42).index] += 1
    assert all(800 < n < 1200 for n in seen)


def test_the_shuffle_is_a_fisher_yates_over_three_slots_and_every_order_is_reachable() -> None:
    orders = set()
    for a in range(3):
        for b in range(2):
            # real=1; decoys 2 and 3 by draws 2 and 3, then the shuffle's two draws.
            orders.add(tuple(decoy_codes(1, draws(2, 3, a, b)).codes))
    assert len(orders) == 6


def test_the_approver_instance_is_p1_and_sixteen_base32_characters_of_ten_random_bytes() -> None:
    import re

    i = approver_instance()
    assert re.fullmatch(r"p1-[a-z2-7]{16}", i)
    assert approver_instance() != i
    asked: List[int] = []

    def src(n: int) -> bytes:
        asked.append(n)
        return bytes(n)

    approver_instance(src)
    assert asked == [10]
    assert approver_instance(lambda n: bytes(10)) == "p1-" + "a" * 16


# -- the failure budget -------------------------------------------------------------------------


def test_the_second_failure_within_ten_minutes_stops_the_advert_until_reopened() -> None:
    t = [0.0]
    b = VouchFailureBudget(lambda: t[0])
    assert b.fail() is False
    t[0] = 599
    assert b.fail() is True and b.stopped is True
    b.reopen()
    assert b.stopped is False and b.fail() is False


def test_a_failure_older_than_the_window_does_not_count() -> None:
    t = [0.0]
    b = VouchFailureBudget(lambda: t[0])
    b.fail()
    t[0] = 600
    assert b.fail() is False and b.stopped is False


# -- the order guard ----------------------------------------------------------------------------


def rec(type_: int, b: bytes = b"") -> VouchRecord:
    return VouchRecord(type_, b)


def result(s: str) -> VouchRecord:
    return rec(RECORD["VOUCH_RESULT"], build_vouch_result(s))


CAPS = ["app/1", "vouch/1"]


def pair() -> Any:
    d: VouchFlow[Any] = VouchFlow("requester")
    m: VouchFlow[Any] = VouchFlow("approver")
    assert d.negotiate(CAPS, CAPS).ok and m.negotiate(CAPS, CAPS).ok
    d.code_shown()
    m.code_shown()
    return d, m


def closed(v: Any, code: str) -> bool:
    return v.ok is False and v.close == code and list(v.deliver) == []


def test_negotiation_fails_closed_and_needs_vouch_1() -> None:
    m: VouchFlow[Any] = VouchFlow("approver")
    assert closed(m.receive(rec(RECORD["VOUCH_REQ"])), "peer_not_allowed")
    d: VouchFlow[Any] = VouchFlow("requester")
    assert closed(d.negotiate(["vouch/2"], ["vouch/2"]), "peer_not_allowed")
    assert closed(d.send(rec(RECORD["VOUCH_REQ"])), "peer_not_allowed")


def test_a_flow_needs_a_known_role() -> None:
    with pytest.raises(ValueError):
        VouchFlow("sideways")


def test_m_gets_the_request_only_after_the_right_pick_and_may_finish_only_then() -> None:
    _, m = pair()
    req = rec(RECORD["VOUCH_REQ"], b"{}")
    v = m.receive(req)
    assert v.ok and list(v.deliver) == []
    assert m.may_finish is False
    v = m.picked()
    assert v.ok and list(v.deliver) == [req]
    assert m.may_finish is False  # verified is the host's next step
    m.verified()
    assert m.may_finish is True
    assert m.send(result("approved")).ok
    assert m.may_finish is False  # one result


def test_m_cannot_send_a_result_before_the_request_verified() -> None:
    _, m = pair()
    m.receive(rec(RECORD["VOUCH_REQ"]))
    m.picked()
    assert closed(m.send(result("approved")), "peer_not_allowed")


@pytest.mark.parametrize(
    "why,code",
    [("wrong-pick", "peer_bye"), ("none-match", "peer_bye"), ("stop", "peer_bye"), ("timeout", "peer_timeout")],
)
def test_an_abandoned_pick_closes_and_delivers_nothing(why: str, code: str) -> None:
    _, m = pair()
    m.receive(rec(RECORD["VOUCH_REQ"]))
    assert closed(m.abandon(why), code)
    assert closed(m.picked(), code)  # dead, same code
    assert m.may_finish is False


def test_a_pick_before_the_codes_were_shown_and_on_d_is_refused() -> None:
    m: VouchFlow[Any] = VouchFlow("approver")
    m.negotiate(CAPS, CAPS)
    assert closed(m.picked(), "peer_not_allowed")
    d, _ = pair()
    assert closed(d.picked(), "peer_not_allowed")


def test_d_sends_its_request_once_and_only_after_the_code() -> None:
    d: VouchFlow[Any] = VouchFlow("requester")
    d.negotiate(CAPS, CAPS)
    assert d.send(rec(RECORD["VOUCH_REQ"])).ok is False
    d2, _ = pair()
    assert d2.send(rec(RECORD["VOUCH_REQ"])).ok
    assert closed(d2.send(rec(RECORD["VOUCH_REQ"])), "peer_bad_frame")


def test_d_reads_a_result_only_after_its_request_once_with_a_good_body() -> None:
    d, _ = pair()
    assert closed(d.receive(result("approved")), "peer_not_allowed")
    e, _ = pair()
    e.send(rec(RECORD["VOUCH_REQ"]))
    assert closed(e.receive(rec(RECORD["VOUCH_RESULT"], b"[]")), "peer_bad_frame")
    f, _ = pair()
    f.send(rec(RECORD["VOUCH_REQ"]))
    r = result("denied")
    v = f.receive(r)
    assert v.ok and list(v.deliver) == [r]
    assert closed(f.receive(result("denied")), "peer_bad_frame")


def test_directions_d_refuses_a_request_m_refuses_a_result_and_any_sync_record_from_d() -> None:
    d, m = pair()
    assert d.receive(rec(RECORD["VOUCH_REQ"])).ok is False
    assert closed(m.receive(result("approved")), "peer_not_allowed")
    _, m2 = pair()
    assert closed(m2.receive(rec(RECORD["KEYRING_WRAP"])), "peer_not_allowed")
    assert m2.send(result("approved")).ok is False
    assert closed(m2.send(rec(RECORD["KEYRING_WRAP"])), "peer_not_allowed")


def approved() -> Any:
    d, _ = pair()
    d.send(rec(RECORD["VOUCH_REQ"]))
    d.receive(result("approved"))
    return d


def test_d_holds_sync_records_until_its_person_confirms_the_account() -> None:
    d = approved()
    a, b = rec(0x0030, bytes(10)), rec(0x003F, bytes(10))
    assert list(d.receive(a).deliver) == [] and list(d.receive(b).deliver) == []
    v = d.confirm_account()
    assert v.ok and list(v.deliver) == [a, b]
    c = rec(0x0031, bytes(10))
    assert list(d.receive(c).deliver) == [c]


def test_d_keeps_16_records_and_16_kib_then_closes_peer_busy() -> None:
    d = approved()
    for _ in range(VOUCH_HELD_RECORDS):
        assert d.receive(rec(0x0030)).ok
    assert closed(d.receive(rec(0x0030)), "peer_busy")
    e = approved()
    assert e.receive(rec(0x0030, bytes(VOUCH_HELD_BYTES))).ok
    assert closed(e.receive(rec(0x0030, bytes(1))), "peer_busy")


def test_a_decline_drops_every_held_record_and_the_flow_stays_closed() -> None:
    d = approved()
    d.receive(rec(0x0030, bytes(5)))
    assert closed(d.decline_account(), "peer_bye")
    assert closed(d.confirm_account(), "peer_bye")
    assert closed(d.receive(rec(0x0031)), "peer_bye")


@pytest.mark.parametrize("s", ["denied", "expired"])
def test_a_denied_or_expired_result_lets_no_record_through(s: str) -> None:
    d, _ = pair()
    d.send(rec(RECORD["VOUCH_REQ"]))
    d.receive(result(s))
    assert closed(d.receive(rec(0x0030)), "peer_not_allowed")


def test_records_outside_the_vouch_set_pass_through_untouched() -> None:
    _, m = pair()
    ping = rec(RECORD["PING"], bytes(8))
    assert list(m.receive(ping).deliver) == [ping]


# -- the open MORE chain of modes v and p (N7) --------------------------------------------------


def _chain(mode: str, parts: List[int], last_more: bool = True) -> Any:
    from polaris_key.core.peer_frame import PeerRecord, RecordAssembler

    a = RecordAssembler(mode)
    out = None
    for n, size in enumerate(parts):
        more = n < len(parts) - 1 or last_more
        type_ = RECORD["VOUCH_REQ"] if mode == "v" else RECORD["CONTACT"]
        out = a.push(PeerRecord(type_, 1 if more else 0, bytes(size)))
        if out.kind == "close":
            return out
    return out


@pytest.mark.parametrize("mode", ["v", "p"])
def test_an_open_more_chain_is_capped_at_16_kib_in_modes_v_and_p(mode: str) -> None:
    from polaris_key.core.peer_frame import MAX_VP_CHAIN_BYTES

    assert MAX_VP_CHAIN_BYTES == 16 * 1024
    # Exactly the cap is read, the final record included; one byte more closes, mid-chain or at its end.
    assert _chain(mode, [8192, 8192], last_more=False).kind == "message"
    assert _chain(mode, [8192, 8192, 1], last_more=False).code == "peer_bad_frame"
    assert _chain(mode, [8192, 8193]).code == "peer_bad_frame"
    # A single record that is not a chain is bounded by the record size, not by this cap.
    assert _chain(mode, [60000], last_more=False).kind == "message"


def test_mode_a_chains_are_not_capped_at_16_kib() -> None:
    from polaris_key.core.peer_frame import PeerRecord, RecordAssembler

    a = RecordAssembler("a")
    assert a.push(PeerRecord(RECORD["RING"], 1, bytes(20000))).kind == "pending"
    assert a.push(PeerRecord(RECORD["RING"], 0, b"")).kind == "message"
