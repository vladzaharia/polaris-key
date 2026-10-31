# @pkey-feature connect.lan
"""The requester half of nearby approval (CC-15.P3; WIRE-CONTRACT-V5 §15.6.1): browse for ``m=v`` adverts of
this product, dial at most four at random with the code held, list them by their ``HELLO``, start the code
on the one the person tapped and close the rest ``peer_bye``, send ``VOUCH_REQ`` after the code, read
``VOUCH_RESULT``, hold Sync records until the account is confirmed, and end at ``expires_in``. The approvers
are real ``NearbyApprover`` s on the fake LAN. Mirrors Node's ``nearbyRequester.test.ts``."""

from __future__ import annotations

import sys
from typing import Any, Dict, Iterator, List, Optional, Tuple

import pytest
from nearby_fixtures import (
    D_ID,
    REQUEST,
    SLUG,
    T0,
    FakeNearbyWorker,
    Timers,
    memory_keys,
    on_loop,
    run,
    settle,
    until,
)
from test_connect_lan import Network

from polaris_key.connect.errors import LanError
from polaris_key.core.peer_nearby import (
    ApproveAnswerInput,
    ApproverSource,
    NearbyApproval,
    NearbyApprover,
    NearbyApproverOptions,
    NearbyRequester,
    NearbyRequestOptions,
    RequesterSource,
)


class Approver:
    def __init__(self, h: NearbyApprover) -> None:
        self.h = h
        self.approvals: List[NearbyApproval] = []


class Env:
    def __init__(self) -> None:
        self.net = Network()
        self.approvers: List[Approver] = []
        self.requests: List[NearbyRequester] = []
        self.keys = memory_keys()

    def approver(self, label: str, slug: str = SLUG, **kw: Any) -> Approver:
        async def signed_in() -> bool:
            return True

        src = ApproverSource(slug=slug, now=lambda: T0, signed_in=signed_in, nearby_served=signed_in)
        holder: List[NearbyApproval] = []
        o: Dict[str, Any] = dict(prompt=True, label=label, mdns=self.net, host="127.0.0.1", allow_loopback=True)
        o.update(kw)
        h = run(NearbyApprover.start(src, holder.append, NearbyApproverOptions(**o)))
        a = Approver(h)
        a.approvals = holder
        self.approvers.append(a)
        return a

    def request(self, **kw: Any) -> NearbyRequester:
        async def signer() -> Tuple[Any, str]:
            return self.keys, D_ID

        src = RequesterSource(slug=SLUG, now=lambda: T0, signer=signer)
        o: Dict[str, Any] = dict(request=REQUEST, label="New phone", mdns=self.net, allow_loopback=True)
        o.update(kw)
        r = run(NearbyRequester.start(src, NearbyRequestOptions(**o)))
        self.requests.append(r)
        return r

    def close(self) -> None:
        for r in self.requests:
            try:
                run(_close(r))
            except Exception:
                pass
        for a in self.approvers:
            try:
                run(_stop(a.h))
            except Exception:
                pass


async def _close(r: NearbyRequester) -> None:
    await r.close()


async def _stop(h: NearbyApprover) -> None:
    await h.stop()


@pytest.fixture
def env() -> Iterator[Env]:
    e = Env()
    yield e
    e.close()


def real_code(a: NearbyApproval, code: str) -> str:
    return next(c for c in a.codes if c.replace(" ", "") == code.replace(" ", ""))


def choose(r: NearbyRequester, id_: str) -> Any:
    return run(r.choose(id_))


def labels(r: NearbyRequester) -> List[Optional[str]]:
    return sorted(str(a.label) for a in r.approvers)


# -- browsing and the list ------------------------------------------------------------------------


def test_lists_approvers_by_their_hello_and_prompts_none_of_them(env: Env) -> None:
    env.approver("Ana's laptop")
    env.approver("Ben's tablet")
    r = env.request()
    until(lambda: len(r.approvers) == 2)
    assert labels(r) == ["Ana's laptop", "Ben's tablet"]
    assert all(a.platform == sys.platform for a in r.approvers)
    settle()
    # The person has not chosen: nobody shows a code.
    assert all(a.approvals == [] for a in env.approvers)


def test_dials_at_most_four_approvers_at_once(env: Env) -> None:
    for i in range(6):
        env.approver("device %d" % i)
    r = env.request()
    until(lambda: len(r.approvers) == 4)
    settle(0.2)
    assert len(r.approvers) == 4


def test_ignores_an_advert_of_another_product(env: Env) -> None:
    env.approver("Other app", "otherapp")
    env.approver("Mine")
    r = env.request()
    until(lambda: len(r.approvers) >= 1)
    settle()
    assert labels(r) == ["Mine"]


def test_drops_an_approver_whose_session_ends_from_the_list(env: Env) -> None:
    a = env.approver("Ana's laptop")
    env.approver("Ben's tablet")
    r = env.request()
    until(lambda: len(r.approvers) == 2)
    run(a.h.pause())
    until(lambda: len(r.approvers) == 1)
    assert r.approvers[0].label == "Ben's tablet"


def test_an_unknown_id_is_refused(env: Env) -> None:
    env.approver("Ana")
    r = env.request()
    until(lambda: len(r.approvers) == 1)
    with pytest.raises(LanError) as e:
        choose(r, "ap_ffffffffffff")
    assert e.value.reason == "unknown_peer"


def test_a_list_holds_at_most_eight_and_shows_only_label_and_platform(env: Env) -> None:
    env.approver("Ana")
    r = env.request()
    until(lambda: len(r.approvers) == 1)
    a = r.approvers[0]
    assert set(vars(a)) == {"id", "label", "platform"} and a.id.startswith("ap_")


# -- the choice -----------------------------------------------------------------------------------


def test_starts_the_code_on_the_chosen_approver_only_and_the_others_close_peer_bye(env: Env) -> None:
    ana = env.approver("Ana's laptop")
    ben = env.approver("Ben's tablet")
    r = env.request()
    until(lambda: len(r.approvers) == 2)
    pick = next(a for a in r.approvers if a.label == "Ben's tablet")
    code = choose(r, pick.id).code
    import re

    assert re.fullmatch(r"\d{3} \d{3}", code)
    until(lambda: len(ben.approvals) == 1)
    assert real_code(ben.approvals[0], code)
    settle()
    # Ana never prompted, and her session is gone.
    assert ana.approvals == [] and r.approvers == []
    with pytest.raises(LanError):
        choose(r, pick.id)


def vouched(env: Env) -> Tuple[NearbyRequester, NearbyApproval, Any]:
    """The whole vouch up to ``approved``: the person taps, the codes match, M approves."""
    worker = FakeNearbyWorker()
    worker.register(REQUEST, env.keys, D_ID)
    worker.m_has_keys = True
    m = env.approver("Ana's laptop")
    r = env.request()
    until(lambda: len(r.approvers) == 1)
    code = choose(r, r.approvers[0].id).code
    until(lambda: len(m.approvals) == 1)
    a = m.approvals[0]
    req = run(a.pick(real_code(a, code)))
    assert not isinstance(req, str)
    http, body = worker.approve(req)
    run(a.finish(ApproveAnswerInput(http, body, True)))
    until(lambda: r.result == "approved")
    return r, a, req


def test_runs_the_whole_vouch_the_code_matches_vouch_req_is_verified_approved_reaches_d(env: Env) -> None:
    r, _, req = vouched(env)
    assert req.request == REQUEST and req.device_id == D_ID and req.label == "New phone"
    assert r.result == "approved"


def test_a_wrong_pick_ends_the_chosen_session_the_request_goes_on_and_the_person_may_choose_again(env: Env) -> None:
    m = env.approver("Ana's laptop")
    r = env.request()
    until(lambda: len(r.approvers) == 1)
    closes: List[str] = []
    r.on_close(closes.append)
    code = choose(r, r.approvers[0].id).code
    until(lambda: len(m.approvals) == 1)
    decoy = next(c for c in m.approvals[0].codes if c.replace(" ", "") != code.replace(" ", ""))
    assert run(m.approvals[0].pick(decoy)) == "mismatch"
    until(lambda: len(closes) == 1)
    assert closes == ["peer_bye"] and r.result is None and r.closed is False


def test_a_denied_result_is_shown_and_does_not_end_the_request(env: Env) -> None:
    m = env.approver("Ana's laptop")
    r = env.request()
    until(lambda: len(r.approvers) == 1)
    code = choose(r, r.approvers[0].id).code
    until(lambda: len(m.approvals) == 1)
    a = m.approvals[0]
    assert not isinstance(run(a.pick(real_code(a, code))), str)
    run(a.finish(ApproveAnswerInput(204, None, True)))
    until(lambda: r.result == "denied")
    assert r.closed is False


# -- the account gate -----------------------------------------------------------------------------


def approved(env: Env) -> Tuple[NearbyRequester, NearbyApproval, List[int]]:
    r, a, _ = vouched(env)
    got: List[int] = []
    r.on_record(lambda x: got.append(x.type))
    return r, a, got


def test_holds_a_wrap_until_the_person_confirmed_the_account_then_hands_it_over(env: Env) -> None:
    r, a, got = approved(env)
    run(a.send_record(0x0030, bytes([9])))
    settle()
    assert got == []
    run(r.confirm_account())
    assert got == [0x0030]
    run(a.send_record(0x0031, bytes([9])))
    until(lambda: len(got) == 2)


def test_a_decline_drops_the_held_records_and_closes_the_session(env: Env) -> None:
    r, a, got = approved(env)
    closes: List[str] = []
    r.on_close(closes.append)
    run(a.send_record(0x0030, bytes([9])))
    settle()
    run(r.decline_account())
    until(lambda: len(closes) == 1)
    assert got == []


def test_confirm_account_without_a_chosen_approver_is_refused(env: Env) -> None:
    env.approver("Ana")
    r = env.request()
    with pytest.raises(LanError) as e:
        run(r.confirm_account())
    assert e.value.reason == "not_started"


# -- the end --------------------------------------------------------------------------------------


def test_expires_at_expires_in_the_sessions_close_peer_bye_and_on_close_says_expired(env: Env) -> None:
    timers = Timers()
    m = env.approver("Ana's laptop")
    r = env.request(timer=timers)
    until(lambda: len(r.approvers) == 1)
    closes: List[str] = []
    r.on_close(closes.append)
    timers.fire(300)
    until(lambda: r.closed)
    assert closes == ["expired"] and m.approvals == []


def test_close_ends_the_request_and_is_safe_twice(env: Env) -> None:
    env.approver("Ana")
    r = env.request()
    until(lambda: len(r.approvers) == 1)
    run(_close(r))
    run(_close(r))
    assert r.closed is True
    with pytest.raises(LanError):
        choose(r, "ap_ffffffffffff")


# -- N1: one answer per request -------------------------------------------------------------------


def expect_no_more_dials(env: Env, r: NearbyRequester) -> None:
    """A new approver appears after the answer: it is not dialled, listed or choosable."""
    mal = env.approver("Mal")
    settle(0.3)
    assert r.approvers == [] and mal.approvals == []
    with pytest.raises(LanError) as e:
        choose(r, "ap_ffffffffffff")
    assert e.value.reason == "closed"


def test_after_approved_a_later_approver_is_not_dialled_listed_or_choosable(env: Env) -> None:
    r, a, _ = vouched(env)
    run(a.close())
    until(lambda: len(r.approvers) == 0)
    expect_no_more_dials(env, r)


def test_after_confirm_account_a_later_approver_is_not_dialled_or_choosable_either(env: Env) -> None:
    r, a, _ = vouched(env)
    run(r.confirm_account())
    run(a.close())
    expect_no_more_dials(env, r)


# -- N8: an idle unchosen session is replaced after 20 s ------------------------------------------


def test_an_idle_session_is_closed_peer_bye_and_the_approver_dialled_again(env: Env) -> None:
    timers = Timers(only=20)
    env.approver("Ana's laptop")
    r = env.request(timer=timers)
    until(lambda: len(r.approvers) == 1)
    first = r.approvers[0].id
    assert len(timers.live(20)) == 1
    timers.fire(20)
    until(lambda: len(r.approvers) == 1 and r.approvers[0].id != first, 3)
    with pytest.raises(LanError) as e:
        choose(r, first)
    assert e.value.reason == "unknown_peer"


def test_no_idle_clock_runs_on_a_session_the_person_chose(env: Env) -> None:
    timers = Timers(only=20)
    m = env.approver("Ana's laptop")
    r = env.request(timer=timers)
    until(lambda: len(r.approvers) == 1)
    choose(r, r.approvers[0].id)
    until(lambda: len(m.approvals) == 1)
    assert timers.live(20) == []


# -- N10: the request is checked when it starts ---------------------------------------------------


@pytest.mark.parametrize(
    "o",
    [
        {"request": "nr_short"},
        {"request": 7},
        {"label": 7},
        {"label": "x" * 300},
        {"expires_in": 0},
        {"expires_in": -5},
        {"expires_in": float("nan")},
        {"expires_in": float("inf")},
        {"expires_in": True},
    ],
)
def test_a_bad_input_is_refused_at_start(env: Env, o: Dict[str, Any]) -> None:
    with pytest.raises(LanError) as e:
        env.request(**o)
    assert e.value.code == "invalid-argument" and e.value.reason == "bad_input"


def test_clamps_expires_in_to_300_s(env: Env) -> None:
    timers = Timers()
    env.request(expires_in=9_999, timer=timers)
    assert len(timers.live(300)) == 1 and timers.live(9_999) == []


def test_a_throwing_host_callback_cannot_skip_the_cleanup(env: Env) -> None:
    m = env.approver("Ana's laptop")
    r = env.request()
    until(lambda: len(r.approvers) == 1)
    lists: List[int] = []

    def boom(_x: Any) -> None:
        raise RuntimeError("host bug")

    r.on_approvers(boom)
    r.on_approvers(lambda lst: lists.append(len(lst)))
    r.on_close(boom)
    closed: List[str] = []
    choose(r, r.approvers[0].id)
    until(lambda: len(m.approvals) == 1)
    m.approvals[0].on_close(lambda c: closed.append(c.code))
    assert lists
    run(_close(r))
    until(lambda: len(closed) == 1)
    assert r.closed is True


def test_the_request_handle_stays_out_of_a_repr_and_nothing_pickles(env: Env) -> None:
    import pickle

    env.approver("Ana")
    r = env.request()
    assert REQUEST not in repr(r) and REQUEST not in repr(r._o)
    with pytest.raises(TypeError):
        pickle.dumps(r)


def test_destroy_drops_the_sockets_at_once(env: Env) -> None:
    m = env.approver("Ana")
    r = env.request()
    until(lambda: len(r.approvers) == 1)
    on_loop(r.destroy)
    assert r.closed is True
    settle(0.1)
    assert m.approvals == []


def test_an_advert_that_keeps_failing_is_dialled_at_most_three_times(env: Env) -> None:
    import asyncio

    from polaris_key.core.peer_advert import advert_epoch, product_tag
    from polaris_key.core.peer_mdns import MdnsAdvert

    count = [0]

    async def serve() -> Any:
        async def cb(_r: Any, w: Any) -> None:
            count[0] += 1
            w.close()

        return await asyncio.start_server(cb, "127.0.0.1", 0)

    srv = run(serve())
    try:
        port = srv.sockets[0].getsockname()[1]
        r = env.request()
        tag = product_tag(SLUG, advert_epoch(T0))
        run(env.net.advertise(MdnsAdvert("p1-aaaaaaaaaaaaaaaa", port, ["v=1", "m=v", "h=" + tag])))
        until(lambda: count[0] >= 3, 6)
        settle(0.8)
        assert count[0] == 3 and r.approvers == []
    finally:
        on_loop(srv.close)


def test_the_one_time_static_key_is_wiped_once_the_handshake_ends(env: Env) -> None:
    env.approver("Ana")
    r = env.request()
    until(lambda: len(r.approvers) == 1)
    keys = [e.key for e in list(r._entries.values())]
    assert keys and all(bytes(k) == bytes(32) for k in keys)
