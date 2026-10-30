# @pkey-feature connect.lan
"""The approver half of nearby approval (CC-15.P2; WIRE-CONTRACT-V5 §15.6.1): the advert and its renewal,
the sessions that hold at HELLO, three codes and one prompt at a time, the right pick delivering a verified
``VOUCH_REQ``, the wrong pick, the failure budget, ``finish`` and its guard, the accept limits and the
rules of the red-team round (a stop stays a stop, ``stop()`` does not wait, a failed renewal halts).
D is a bare mode-v engine over a real loopback socket. Mirrors Node's ``nearbyApprover.test.ts``."""

from __future__ import annotations

import asyncio
import re
import sys
from typing import Any, Dict, Iterator, List, Optional

import pytest
from nearby_fixtures import (
    REQUEST,
    SLUG,
    T0,
    RawD,
    Timers,
    approver_adverts,
    on_loop,
    run,
    settle,
    until,
)
from test_connect_lan import Network

from polaris_key.connect.errors import LanError
from polaris_key.core.peer_advert import advert_epoch, product_tag
from polaris_key.core.peer_mdns import MdnsAdvert
from polaris_key.core.peer_nearby import (
    ApproveAnswerInput,
    ApproverSource,
    NearbyApproval,
    NearbyApprover,
    NearbyApproverOptions,
)

APPROVED = ApproveAnswerInput(200, '{"status":"approved"}', True)


class Env:
    def __init__(self) -> None:
        self.net = Network()
        self.handles: List[NearbyApprover] = []
        self.ds: List[RawD] = []
        self.approvals: List[NearbyApproval] = []
        self.notices: List[Any] = []
        self.stops: List[str] = []
        self.timers = Timers()
        self.signed_in = True
        self.served = True

        async def signed_in() -> bool:
            return self.signed_in

        async def served() -> bool:
            return self.served

        self.src = ApproverSource(slug=SLUG, now=lambda: T0, signed_in=signed_in, nearby_served=served)

    def options(self, **kw: Any) -> NearbyApproverOptions:
        o: Dict[str, Any] = dict(
            prompt=True,
            label="Ana's laptop",
            mdns=self.net,
            host="127.0.0.1",
            allow_loopback=True,
            timer=self.timers,
            on_notice=self.notices.append,
            on_stopped=self.stops.append,
        )
        o.update(kw)
        return NearbyApproverOptions(**o)

    def start(self, src: Optional[ApproverSource] = None, **kw: Any) -> NearbyApprover:
        h = run(NearbyApprover.start(src or self.src, self.approvals.append, self.options(**kw)))
        self.handles.append(h)
        return h

    def dial(self, **kw: Any) -> RawD:
        d = run(RawD.dial(self.net, **kw))
        self.ds.append(d)
        return d

    def held(self) -> RawD:
        """A D that dialled and said HELLO; the person has not chosen."""
        d = self.dial()
        d.wait_for(lambda: d.hello is not None)
        return d

    def chosen(self, wait: bool = True, **kw: Any) -> RawD:
        """A D that dialled and chose this approver; returns once the codes are on M's screen."""
        d = self.held() if not kw else self._held_with(**kw)
        d.start_sas()
        if wait:
            d.wait_for(lambda: d.code is not None)
        return d

    def _held_with(self, **kw: Any) -> RawD:
        d = self.dial(**kw)
        d.wait_for(lambda: d.hello is not None)
        return d

    def fire(self, seconds: float) -> None:
        self.timers.fire(seconds)

    def close(self) -> None:
        for d in self.ds:
            try:
                d.close()
            except Exception:
                pass
        for h in self.handles:
            try:
                run(_stop(h))
            except Exception:
                pass


async def _await(aw: Any) -> Any:
    return await aw


async def _stop(h: NearbyApprover) -> None:
    await h.stop()


@pytest.fixture
def env() -> Iterator[Env]:
    e = Env()
    yield e
    e.close()


def shown_of(a: NearbyApproval, d: RawD) -> str:
    return next(c for c in a.codes if c.replace(" ", "") == str(d.code).zfill(6))


def decline(a: NearbyApproval) -> None:
    run(a.decline())


def pick(a: NearbyApproval, code: str) -> Any:
    return run(a.pick(code))


def finish(a: NearbyApproval, answer: ApproveAnswerInput) -> Any:
    return run(a.finish(answer))


def state(h: NearbyApprover) -> Dict[str, Any]:
    s = h.status()
    return {"state": s.state, "reason": s.reason, "prompt": s.prompt}


# -- the advert -----------------------------------------------------------------------------------


def test_advertises_a_random_p1_instance_with_v1_m_v_and_the_product_tag(env: Env) -> None:
    env.start()
    (a,) = approver_adverts(env.net)
    assert re.fullmatch(r"p1-[a-z2-7]{16}", a.instance)
    assert list(a.txt) == ["v=1", "m=v", "h=" + product_tag(SLUG, advert_epoch(T0))]


def test_renews_with_a_new_instance_and_port_and_the_old_listener_accepts_nothing_more(env: Env) -> None:
    env.start()
    first = approver_adverts(env.net)[0]
    env.fire(300)
    until(lambda: approver_adverts(env.net) and approver_adverts(env.net)[0].instance != first.instance)
    second = approver_adverts(env.net)[0]
    assert len(approver_adverts(env.net)) == 1 and second.port != first.port
    with pytest.raises(OSError):
        run(RawD.dial(env.net, port=first.port))


def test_keeps_a_session_that_is_past_the_transport_across_a_renewal(env: Env) -> None:
    env.start()
    d = env.chosen()
    env.fire(300)
    until(lambda: len(approver_adverts(env.net)) == 1)
    settle(0.1)
    assert d.closed is None and len(env.approvals) == 1


def test_stops_at_a_renewal_when_the_device_signed_out_or_discovery_lost_nearby(env: Env) -> None:
    env.start()
    env.signed_in = False
    env.fire(300)
    until(lambda: len(env.stops) == 1)
    assert env.stops == ["signed-out"] and approver_adverts(env.net) == []
    env.signed_in = True
    h2 = env.start()
    env.served = False
    env.fire(300)
    until(lambda: len(env.stops) == 2)
    assert env.stops[1] == "discovery" and h2.status().state == "stopped"


def test_pause_takes_the_advert_down_and_closes_live_sessions_and_resume_starts_a_new_one(env: Env) -> None:
    h = env.start()
    before = approver_adverts(env.net)[0]
    d = env.chosen()
    run(h.pause())
    assert approver_adverts(env.net) == []
    d.wait_for(lambda: d.closed is not None)
    assert d.closed is not None and d.closed.code == "peer_bye"
    run(h.resume())
    assert approver_adverts(env.net)[0].instance != before.instance


# -- holding and the prompt -----------------------------------------------------------------------


def test_nothing_is_shown_until_ds_person_chose(env: Env) -> None:
    env.start()
    env.held()
    settle()
    assert env.approvals == [] and env.notices == []


def test_shows_three_distinct_codes_ds_among_them_with_the_hello_label_and_platform(env: Env) -> None:
    env.start()
    d = env.chosen()
    until(lambda: len(env.approvals) == 1)
    a = env.approvals[0]
    assert a.label is None and a.platform == sys.platform
    assert len(set(a.codes)) == 3
    assert str(d.code).zfill(6) in [c.replace(" ", "") for c in a.codes]
    assert all(re.fullmatch(r"\d{3} \d{3}", c) for c in a.codes)


def test_the_hello_label_is_shown_cleaned(env: Env) -> None:
    env.start()
    d = env.dial(label="  Ben's   Switch ")
    d.wait_for(lambda: d.hello is not None)
    d.start_sas()
    until(lambda: len(env.approvals) == 1)
    assert env.approvals[0].label == "Ben's Switch"


def test_with_the_prompt_closed_a_session_raises_a_notice_and_takes_no_pick(env: Env) -> None:
    h = env.start(prompt=False, background=True)
    d = env.chosen()
    until(lambda: len(env.notices) == 1)
    assert env.approvals == []
    run(h.set_prompt(True))
    until(lambda: len(env.approvals) == 1)
    assert d.closed is None


def test_shows_one_prompt_at_a_time_and_the_next_when_the_first_ends(env: Env) -> None:
    env.start(max_pending_per_address=4)
    d1 = env.chosen()
    until(lambda: len(env.approvals) == 1)
    d2 = env.chosen()
    settle()
    assert len(env.approvals) == 1 and d2.closed is None
    decline(env.approvals[0])
    d1.wait_for(lambda: d1.closed is not None)
    until(lambda: len(env.approvals) == 2)
    assert d2.closed is None


# -- the pick -------------------------------------------------------------------------------------


def test_the_right_code_delivers_a_verified_vouch_req_with_exactly_ds_keys(env: Env) -> None:
    env.start()
    d = env.chosen()
    until(lambda: len(env.approvals) == 1)
    a = env.approvals[0]
    d.show_and_request()
    r = pick(a, shown_of(a, d))
    k = d.keys.ensure()
    assert r.to_json() == {
        "request": REQUEST,
        "deviceId": d.device_id,
        "signKey": k.sign_key,
        "agreeKey": k.agree_key,
        "label": None,
        "platform": sys.platform,
    }


def test_a_pick_may_be_spelled_with_or_without_the_space_and_a_second_call_gets_the_first_answer(env: Env) -> None:
    env.start()
    d = env.chosen()
    until(lambda: len(env.approvals) == 1)
    a = env.approvals[0]
    d.show_and_request()
    first = pick(a, str(d.code).zfill(6))
    assert first.request == REQUEST
    assert pick(a, "000000") is first


def test_a_wrong_pick_closes_peer_bye_delivers_no_request_and_refuses_finish(env: Env) -> None:
    env.start()
    d = env.chosen()
    until(lambda: len(env.approvals) == 1)
    d.show_and_request()
    a = env.approvals[0]
    decoy = next(c for c in a.codes if c.replace(" ", "") != str(d.code).zfill(6))
    assert pick(a, decoy) == "mismatch"
    d.wait_for(lambda: d.closed is not None)
    assert d.closed is not None and d.closed.code == "peer_bye"
    with pytest.raises(LanError) as e:
        finish(a, APPROVED)
    assert e.value.reason == "closed"
    assert d.result() is None


@pytest.mark.parametrize("bad", [None, 7, "", "12", "abcdef", "1234567", True])
def test_a_pick_that_is_not_a_code_is_a_mismatch(env: Env, bad: Any) -> None:
    env.start()
    d = env.chosen()
    until(lambda: len(env.approvals) == 1)
    d.show_and_request()
    assert pick(env.approvals[0], bad) == "mismatch"


def test_finish_before_a_pick_is_refused(env: Env) -> None:
    env.start()
    env.chosen()
    until(lambda: len(env.approvals) == 1)
    with pytest.raises(LanError) as e:
        finish(env.approvals[0], APPROVED)
    assert e.value.reason == "not_picked"


def test_a_request_that_does_not_verify_closes_peer_bad_frame_and_answers_invalid(env: Env) -> None:
    env.start()
    d = env.chosen()
    until(lambda: len(env.approvals) == 1)

    def forged(b: bytes) -> bytes:
        import json

        o = json.loads(b)
        o["request"] = "nr_AAAAAAAAAAAAAAAAAAAAAA"
        return json.dumps(o).encode()

    d.show_and_request(forged)
    a = env.approvals[0]
    assert pick(a, shown_of(a, d)) == "invalid"
    d.wait_for(lambda: d.closed is not None)
    assert d.closed is not None and d.closed.code == "peer_bad_frame"


def test_decline_closes_peer_bye_with_no_request_delivered(env: Env) -> None:
    env.start()
    d = env.chosen()
    until(lambda: len(env.approvals) == 1)
    d.show_and_request()
    decline(env.approvals[0])
    d.wait_for(lambda: d.closed is not None)
    assert d.closed is not None and d.closed.code == "peer_bye"


# -- the failure budget ---------------------------------------------------------------------------


def test_stops_the_advert_at_the_second_prompted_failure_and_starts_again_on_reopen(env: Env) -> None:
    h = env.start(mono=lambda: 100.0)
    d1 = env.chosen()
    until(lambda: len(env.approvals) == 1)
    decline(env.approvals[0])
    d1.wait_for(lambda: d1.closed is not None)
    assert env.stops == []
    d2 = env.chosen()
    until(lambda: len(env.approvals) == 2)
    decline(env.approvals[1])
    d2.wait_for(lambda: d2.closed is not None)
    until(lambda: len(env.stops) == 1)
    assert env.stops == ["budget"] and approver_adverts(env.net) == []
    run(h.reopen())
    assert len(approver_adverts(env.net)) == 1 and h.status().state == "advertising"


def test_counts_a_120_s_timeout_of_a_shown_prompt_not_the_hosts_close(env: Env) -> None:
    now = [100.0]
    h = env.start(mono=lambda: now[0])
    d1 = env.chosen()
    until(lambda: len(env.approvals) == 1)
    run(env.approvals[0].close())
    d1.wait_for(lambda: d1.closed is not None)
    d2 = env.chosen()
    until(lambda: len(env.approvals) == 2)
    # The engine's deadline (120 s) runs out on a shown prompt: the first counted failure.
    now[0] = 100.0 + 121
    live = next(iter(h._live))  # the one session
    on_loop(live.link._tick)
    d2.wait_for(lambda: d2.closed is not None)
    assert env.stops == []


# -- finish ---------------------------------------------------------------------------------------


def picked(env: Env) -> Any:
    d = env.chosen()
    until(lambda: len(env.approvals) >= 1)
    d.show_and_request()
    a = env.approvals[-1]
    r = pick(a, shown_of(a, d))
    assert r.request == REQUEST
    return d, a


def test_approved_reaches_d_then_a_sync_record_is_carried(env: Env) -> None:
    env.start()
    d, a = picked(env)
    out = finish(a, APPROVED)
    assert out.sent == "approved" and out.wait is None and not out.closed
    d.wait_for(lambda: d.result() is not None)
    assert d.result() == "approved"
    run(a.send_record(0x0030, bytes([1, 2, 3])))
    d.wait_for(lambda: any(r.type == 0x0030 for r in list(d.records)))
    with pytest.raises(LanError) as e:
        run(a.send_record(0x0100, bytes(1)))
    assert e.value.reason == "bad_type"
    # The result is sent once.
    with pytest.raises(LanError):
        finish(a, ApproveAnswerInput(204, None, True))


@pytest.mark.parametrize(
    "http,body,status",
    [
        (204, None, "denied"),
        (403, '{"code":"not_nearby"}', "denied"),
        (403, '{"code":"device_limit"}', "denied"),
        (404, None, "expired"),
    ],
)
def test_an_answer_is_sent_and_closes_peer_bye(env: Env, http: int, body: Optional[str], status: str) -> None:
    env.start()
    d, a = picked(env)
    assert finish(a, ApproveAnswerInput(http, body, True)).sent == status
    d.wait_for(lambda: d.closed is not None)
    assert d.result() == status and d.closed is not None and d.closed.code == "peer_bye"


def test_a_404_after_discovery_lost_nearby_sends_nothing_closes_and_stops_the_advert(env: Env) -> None:
    env.start()
    d, a = picked(env)
    assert finish(a, ApproveAnswerInput(404, None, False)).closed is True
    d.wait_for(lambda: d.closed is not None)
    assert d.result() is None
    until(lambda: "discovery" in env.stops)


def test_device_keys_required_waits_once_for_the_keys_and_a_second_one_closes(env: Env) -> None:
    env.start()
    d, a = picked(env)
    need = ApproveAnswerInput(409, '{"code":"device_keys_required"}', True)
    assert finish(a, need).wait == "keys"
    assert finish(a, need).closed is True
    d.wait_for(lambda: d.closed is not None)
    assert d.result() is None


def test_choose_waits_for_the_licence_choice_as_many_times_as_it_is_asked(env: Env) -> None:
    env.start()
    _, a = picked(env)
    choose = ApproveAnswerInput(200, '{"status":"choose"}', True)
    assert finish(a, choose).wait == "choice"
    assert finish(a, choose).wait == "choice"


def test_closes_the_session_300_s_after_the_pick(env: Env) -> None:
    env.start()
    d, _ = picked(env)
    env.fire(300)
    d.wait_for(lambda: d.closed is not None)
    assert d.closed is not None and d.closed.code == "peer_bye"


def test_a_pick_that_never_gets_its_request_closes_peer_timeout_after_30_s(env: Env) -> None:
    env.start()
    d = env.chosen()
    until(lambda: len(env.approvals) == 1)
    a = env.approvals[0]
    # The pick waits for D's request, which never comes.
    import concurrent.futures

    fut: "concurrent.futures.Future[Any]" = concurrent.futures.Future()

    async def go() -> None:
        try:
            fut.set_result(await a.pick(shown_of(a, d)))
        except Exception as e:  # noqa: BLE001
            fut.set_exception(e)

    from polaris_key.connect.loop import connect_loop

    connect_loop().submit(go())
    until(lambda: len(env.timers.live(30)) == 1)
    env.fire(30)
    assert fut.result(5) == "invalid"
    d.wait_for(lambda: d.closed is not None)
    assert d.closed is not None and d.closed.code == "peer_timeout"


# -- the accept limits ----------------------------------------------------------------------------


def test_refuses_a_second_waiting_connection_from_one_source_address(env: Env) -> None:
    env.start()
    d1 = env.held()
    d2 = env.dial()
    d2.wait_for(lambda: d2.closed is not None)
    assert d2.hello is None and d1.closed is None


def test_allows_two_waiting_connections_from_one_group_not_three(env: Env) -> None:
    env.start(max_pending_per_address=4)
    d1, d2 = env.held(), env.held()
    d3 = env.dial()
    d3.wait_for(lambda: d3.closed is not None)
    assert d3.hello is None and d1.closed is None and d2.closed is None


def test_uses_the_mode_a_gate_so_a_loopback_peer_is_refused_unless_the_test_opts_in(env: Env) -> None:
    env.start(allow_loopback=False)
    d = env.dial()
    d.wait_for(lambda: d.closed is not None)
    assert d.hello is None and env.approvals == []


def test_a_connection_that_never_finishes_the_handshake_is_dropped(env: Env) -> None:
    env.start(handshake_seconds=0.3)
    import socket

    adv = approver_adverts(env.net)[0]
    s = socket.create_connection(("127.0.0.1", adv.port))
    try:
        s.settimeout(3)
        assert s.recv(10) == b""
    finally:
        s.close()


# -- a stopped advert stays stopped (B1) ----------------------------------------------------------


def spend_budget(env: Env) -> None:
    """Two declined prompts spend the failure budget (two in 10 minutes) and stop the advert."""
    for _ in range(2):
        n = len(env.approvals)
        d = env.chosen()
        until(lambda want=n + 1: len(env.approvals) == want)  # type: ignore[misc]
        decline(env.approvals[n])
        d.wait_for(d.is_closed)
    until(lambda: len(env.stops) >= 1)


def revive_all(h: NearbyApprover) -> None:
    """Every call that could bring an advert back."""
    run(h.pause())
    run(h.resume())
    run(h.reopen())
    run(h.set_prompt(False))
    run(h.set_prompt(True))


def test_pause_and_resume_do_not_revive_a_budget_stop_or_overwrite_its_reason(env: Env) -> None:
    h = env.start(mono=lambda: 100.0)
    spend_budget(env)
    assert state(h)["state"] == "stopped" and state(h)["reason"] == "budget"
    run(h.pause())
    assert state(h)["reason"] == "budget" and state(h)["state"] == "stopped"
    run(h.resume())
    assert state(h)["reason"] == "budget" and state(h)["state"] == "stopped"
    assert approver_adverts(env.net) == []


def test_reopen_and_the_screen_opening_again_still_clear_a_budget_stop(env: Env) -> None:
    h = env.start(mono=lambda: 100.0)
    spend_budget(env)
    run(h.reopen())
    assert h.status().state == "advertising"
    spend_budget(env)
    assert h.status().state == "stopped"
    run(h.set_prompt(False))
    run(h.set_prompt(True))
    assert state(h) == {"state": "advertising", "reason": None, "prompt": True}
    assert len(approver_adverts(env.net)) == 1


def test_a_sign_out_stop_is_final(env: Env) -> None:
    h = env.start()
    env.signed_in = False
    env.fire(300)
    until(lambda: len(env.stops) == 1)
    env.signed_in = True
    revive_all(h)
    assert state(h)["state"] == "stopped" and state(h)["reason"] == "signed-out"
    assert approver_adverts(env.net) == []


def test_stop_is_final(env: Env) -> None:
    h = env.start()
    run(_stop(h))
    revive_all(h)
    assert state(h)["state"] == "stopped" and state(h)["reason"] == "host"
    assert approver_adverts(env.net) == []


def test_pause_works_only_from_advertising_and_resume_only_from_the_hosts_own_pause(env: Env) -> None:
    h = env.start()
    run(h.resume())
    assert h.status().state == "advertising" and len(approver_adverts(env.net)) == 1
    run(h.pause())
    run(h.pause())
    assert state(h)["state"] == "paused" and state(h)["reason"] == "host"
    run(h.resume())
    assert h.status().state == "advertising" and len(approver_adverts(env.net)) == 1


def test_resume_reads_signed_in_and_discovery_again(env: Env) -> None:
    h = env.start()
    run(h.pause())
    env.signed_in = False
    run(h.resume())
    assert state(h)["state"] == "stopped" and state(h)["reason"] == "signed-out"
    assert env.stops == ["signed-out"] and approver_adverts(env.net) == []
    env.signed_in = True
    h2 = env.start()
    run(h2.pause())
    env.served = False
    run(h2.resume())
    assert state(h2)["state"] == "stopped" and state(h2)["reason"] == "discovery"
    assert approver_adverts(env.net) == []


# -- stopping and renewing (B2, B3) ---------------------------------------------------------------


def test_stop_does_not_wait_behind_a_renewal_whose_sign_in_check_hangs(env: Env) -> None:
    hang = [False]
    released: List[Any] = []

    async def signed_in() -> bool:
        if not hang[0]:
            return True
        fut: "asyncio.Future[bool]" = asyncio.get_running_loop().create_future()
        released.append(fut)
        return await fut

    src = ApproverSource(slug=SLUG, now=lambda: T0, signed_in=signed_in, nearby_served=env.src.nearby_served)
    h = env.start(src, on_notice=None, on_stopped=None)
    d = env.chosen()
    hang[0] = True
    env.fire(300)
    until(lambda: len(released) == 1)
    # stop() is not queued behind the renewal: its sync part is done when it is called.
    fut = on_loop(h.stop)
    assert h.status().state == "stopped"
    until(lambda: approver_adverts(env.net) == [])
    d.wait_for(lambda: d.closed is not None)
    run(_await(fut), 3)
    assert state(h)["state"] == "stopped" and state(h)["reason"] == "host"
    # The renewal answers late: it brings nothing back.
    on_loop(lambda: released[0].set_result(True))
    settle(0.15)
    assert approver_adverts(env.net) == [] and h.status().state == "stopped"


def test_a_renewal_that_fails_stops_the_advert_with_on_stopped_and_re_arms_nothing_stale(env: Env) -> None:
    base = env.net
    n = [0]

    class Failing:
        async def advertise(self, a: MdnsAdvert) -> Any:
            n[0] += 1
            if n[0] >= 2:
                raise OSError("interface down")
            return await base.advertise(a)

        async def browse(self, *a: Any, **k: Any) -> Any:
            return await base.browse(*a, **k)

    h = env.start(mdns=Failing())
    env.fire(300)
    until(lambda: len(env.stops) == 1)
    assert env.stops == ["discovery"]
    assert state(h)["state"] == "stopped" and state(h)["reason"] == "discovery"
    assert approver_adverts(env.net) == []
    assert env.timers.live(300) == []


def test_a_renewal_whose_sign_in_check_hangs_is_bounded_and_counts_as_signed_out(env: Env) -> None:
    async def never() -> bool:
        await asyncio.Event().wait()
        return True

    src = ApproverSource(slug=SLUG, now=lambda: T0, signed_in=never, nearby_served=env.src.nearby_served)
    env.start(src, check_seconds=0.2)
    env.fire(300)
    until(lambda: len(env.stops) == 1)
    assert env.stops == ["signed-out"]


def test_destroy_drops_the_listener_and_the_sessions_at_once(env: Env) -> None:
    h = env.start()
    d = env.chosen()
    on_loop(h.destroy)
    assert approver_adverts(env.net) == [] and h.status().state == "stopped"
    d.wait_for(lambda: d.closed is not None)


# -- the prompt and the budget (N4, N5, N6) -------------------------------------------------------


def test_counts_a_peer_that_closes_after_the_prompt_showed_before_the_answer(env: Env) -> None:
    env.start(mono=lambda: 100.0)
    d1 = env.chosen()
    until(lambda: len(env.approvals) == 1)
    d1.close()
    d1.wait_for(lambda: d1.closed is not None)
    assert env.stops == []
    d2 = env.chosen()
    until(lambda: len(env.approvals) == 2)
    d2.close()
    until(lambda: len(env.stops) == 1)
    assert env.stops == ["budget"]


def test_does_not_count_a_peer_that_closes_before_any_prompt_showed(env: Env) -> None:
    env.start(mono=lambda: 100.0)
    for _ in range(3):
        d = env.held()
        d.close()
        d.wait_for(d.is_closed)
        settle(0.05)
    assert env.stops == []


def test_holds_the_next_prompt_until_the_picked_session_finishes(env: Env) -> None:
    env.start(max_pending_per_address=4)
    d1 = env.chosen()
    until(lambda: len(env.approvals) == 1)
    d2 = env.chosen()
    d1.show_and_request()
    a = env.approvals[0]
    assert pick(a, shown_of(a, d1)).request == REQUEST
    # The first is picked and not finished: the second waits with no code on the screen.
    settle()
    assert len(env.approvals) == 1 and d2.closed is None
    finish(a, ApproveAnswerInput(204, None, True))
    until(lambda: len(env.approvals) == 2)


def test_holds_the_next_prompt_while_the_picked_session_is_open_and_shows_it_when_it_closes(env: Env) -> None:
    env.start(max_pending_per_address=4)
    d1 = env.chosen()
    until(lambda: len(env.approvals) == 1)
    env.chosen()
    d1.show_and_request()
    a = env.approvals[0]
    pick(a, shown_of(a, d1))
    settle()
    assert len(env.approvals) == 1
    run(a.close())
    until(lambda: len(env.approvals) == 2)


# -- background approval and host callbacks (N10) -------------------------------------------------


def test_prompt_false_needs_an_explicit_background_true(env: Env) -> None:
    with pytest.raises(LanError) as e:
        run(NearbyApprover.start(env.src, lambda a: None, env.options(prompt=False)))
    assert e.value.code == "invalid-argument" and e.value.reason == "bad_input"
    assert approver_adverts(env.net) == []


def test_a_bad_label_is_refused_at_start(env: Env) -> None:
    for bad in (7, "x" * 257):
        with pytest.raises(LanError) as e:
            run(NearbyApprover.start(env.src, lambda a: None, env.options(label=bad)))
        assert e.value.reason == "bad_input"
    assert approver_adverts(env.net) == []


def test_closing_the_screen_of_a_foreground_approver_stops_the_advert_until_it_opens_again(env: Env) -> None:
    h = env.start()
    d = env.chosen()
    until(lambda: len(env.approvals) == 1)
    run(h.set_prompt(False))
    assert state(h)["state"] == "paused" and state(h)["prompt"] is False
    assert approver_adverts(env.net) == []
    d.wait_for(lambda: d.closed is not None)
    run(h.set_prompt(True))
    assert h.status().state == "advertising" and len(approver_adverts(env.net)) == 1


def test_a_background_approver_keeps_advertising_when_the_screen_closes(env: Env) -> None:
    h = env.start(background=True)
    run(h.set_prompt(False))
    assert h.status().state == "advertising"


def test_a_throwing_on_close_cannot_keep_the_next_prompt_from_showing(env: Env) -> None:
    env.start(max_pending_per_address=4)
    d1 = env.chosen()
    until(lambda: len(env.approvals) == 1)

    def boom(_c: Any) -> None:
        raise RuntimeError("host bug")

    env.approvals[0].on_close(boom)
    env.chosen()
    d1.close()
    until(lambda: len(env.approvals) == 2)


def test_a_throwing_on_stopped_or_on_notice_cannot_keep_the_advert_up(env: Env) -> None:
    def boom(_x: Any) -> None:
        raise RuntimeError("host bug")

    h = env.start(on_stopped=boom)
    env.signed_in = False
    env.fire(300)
    until(lambda: h.status().state == "stopped" and approver_adverts(env.net) == [])
    env.signed_in = True
    env.start(prompt=False, background=True, on_notice=boom)
    d = env.chosen()
    settle()
    assert d.closed is None


def test_a_throwing_handler_closes_that_session_only(env: Env) -> None:
    h = run(NearbyApprover.start(env.src, _raise, env.options()))
    env.handles.append(h)
    d = env.chosen(wait=False)
    d.wait_for(lambda: d.closed is not None)
    assert d.closed is not None and d.closed.code == "peer_bye"
    assert h.status().state == "advertising"


def _raise(_a: Any) -> None:
    raise RuntimeError("host bug")


# -- N2: the VOUCH_REQ label against a cleaned HELLO label ----------------------------------------


def test_an_honest_d_whose_label_does_not_clean_twice_the_same_way_still_verifies(env: Env) -> None:
    env.start()
    # A zero-width space between a base letter and a combining acute: cleaning twice differs.
    d = env.dial(label="e\u200b\u0301x")
    d.wait_for(lambda: d.hello is not None)
    d.start_sas()
    d.wait_for(lambda: d.code is not None)
    until(lambda: len(env.approvals) == 1)
    d.show_and_request()
    a = env.approvals[0]
    r = pick(a, shown_of(a, d))
    assert r.request == REQUEST and r.label == "éx"


# -- secrets (G19) --------------------------------------------------------------------------------


def test_no_secret_in_a_repr_and_nothing_pickles(env: Env) -> None:
    import pickle

    h = env.start()
    d = env.chosen()
    until(lambda: len(env.approvals) == 1)
    a = env.approvals[0]
    d.show_and_request()
    r = pick(a, shown_of(a, d))
    for obj in (h, a, r):
        assert REQUEST not in repr(obj)
    for obj in (h, a):
        with pytest.raises(TypeError):
            pickle.dumps(obj)
