# @pkey-feature sync.settings
"""``account_required`` on the Python host (U-52). Mirrors ``cloudSyncAccountRequired.test.ts``: the
machine is saved as it stands and stays blocked across a relaunch (the refused subject is not signed in
again), the offered ``signInUrl`` is vetted, a key-ring or file ``account_required`` reaches the machine,
and a request in flight when that happens has its answer dropped."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterator, List, Optional

import httpx
import pytest
from helpers import PRODUCT, TOKEN
from test_cloud_sync_host import SUBJECT, Rig, World, state_file

from polaris_key.cloud_sync.files import FileRoutes, _Answer
from polaris_key.cloud_sync.sign_in_url import from_worker_origin, safe_sign_in_url, sign_in_url_of
from polaris_key.cloud_sync.state import CloudSyncStateFile
from polaris_key.cloud_sync.transfer import FileTarget
from polaris_key.core.errors import PolarisError

OTHER = "ps_bbbbbbbbbbbbbbbbbbbbbb"
ORIGIN = "https://key.example"


@pytest.fixture
def rigs(tmp_path: Path) -> Iterator[Callable[..., Rig]]:
    made: List[Rig] = []

    def build(w: World, state: Optional[Path] = None, **kw: Any) -> Rig:
        r = Rig(w, state or tmp_path / f"s{len(made)}", **kw)
        made.append(r)
        return r

    yield build
    for r in made:
        r.client.close()


def identity(r: Rig, change: str, subject: Any = None) -> None:
    extra = {"released": False} if change == "signed_out" else {"subject": subject}
    r.client.events.emit("identity", change=change, **extra)


def signed_in(rigs: Callable[..., Rig], w: World) -> Rig:
    r = rigs(w)
    r.client.keyring.create()
    r.host.start()
    identity(r, "signed_in", SUBJECT)
    r.client.cloud_sync.flush()
    return r


def refusal(url: Optional[str] = None) -> httpx.Response:
    err = {"code": "account_required", **({"signInUrl": url} if url is not None else {})}
    return httpx.Response(403, json={"error": err})


def join(r: Rig) -> None:
    r.client._cloud_sync_api._join_chain()


def refuse(r: Rig, w: World, url: Optional[str] = None) -> List[Any]:
    """The 403 a push earns once the account is gone; returns the offers the app heard."""
    offers: List[Any] = []
    r.client.events.subscribe(
        lambda e: offers.append(e["signInUrl"]) if e["type"] == "signInOffered" else None, ("cloudSync",)
    )
    w.push = lambda _b: refusal(url)
    r.client.config.set("theme", "dark")
    r.client.cloud_sync.flush()
    join(r)
    return offers


def saved(r: Rig) -> Any:
    return json.loads(Path(state_file(r.state_dir)).read_text())


def relaunch(rigs: Callable[..., Rig], w: World, r: Rig, subject: Optional[str]) -> Rig:
    r.client.identity._account.write_subject(subject)
    r.client.close()
    again = rigs(w, r.state_dir, keys=True)
    again.client.identity._account.write_subject(subject)
    again.client._cloud_sync_api.attach()
    return again


# ── the blocked machine survives a relaunch ──────────────────────────────────────────────────────


def test_is_saved_without_the_partition_and_relaunches_blocked(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    refuse(r, w)
    assert r.client.cloud_sync.status()["state"] == "blocked"
    assert r.client.cloud_sync.status()["reason"] == "account_required"
    assert not r.client.keyring.unlocked
    s = saved(r)
    assert s["persisted"]["blocked"] == "account_required"
    assert s["persisted"]["subject"] is None
    assert s["openKeys"] == []
    assert SUBJECT not in s["persisted"]["partitions"]
    assert '"dark"' not in json.dumps(s)
    assert s["refused"] == SUBJECT

    again = relaunch(rigs, w, r, SUBJECT)
    w.seen = []
    again.client.cloud_sync.flush()
    assert again.client.cloud_sync.status()["state"] == "blocked"
    assert w.sync_reqs == []
    # An edit made while blocked is the device's own and is kept for the next sign-in.
    again.client.config.set("theme", "light")
    again.client.cloud_sync.flush()
    assert w.sync_reqs == []
    assert again.client.config.get("theme", "none") == "light"


def test_a_different_subject_lifts_it(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    refuse(r, w)
    again = relaunch(rigs, w, r, OTHER)
    again.client.cloud_sync.flush()
    # Signed in as the new subject; with no ring on this launch the machine is locked, not blocked.
    assert again.client.cloud_sync.status()["state"] == "locked"


def test_a_sign_out_forgets_the_refusal(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    refuse(r, w)
    again = relaunch(rigs, w, r, SUBJECT)
    again.client.cloud_sync.flush()
    assert again.client.cloud_sync.status()["state"] == "blocked"
    identity(again, "signed_out")
    again.client._cloud_sync_api._drain_work()
    identity(again, "signed_in", SUBJECT)
    again.client._cloud_sync_api._drain_work()
    again.client.cloud_sync.flush()
    assert again.client.cloud_sync.status()["state"] == "locked"


# ── the offered signInUrl is vetted ──────────────────────────────────────────────────────────────

_VETTING = [
    ("https://key.example/signin", "https://key.example/signin"),
    ("/signin?x=1", "https://key.example/signin?x=1"),
    (None, None),
    ("https://evil.test/signin", None),
    ("http://key.example/signin", None),
    ("https://key.example.evil.test/signin", None),
    ("https://key.example:8443/signin", None),
    ("https://key.example@evil.test/signin", None),
    ("https://user:pw@key.example/signin", None),
    ("//evil.test/signin", None),
    ("/\\evil.test/signin", None),
    ("https:\\\\evil.test/signin", None),
    ("javascript:alert(1)", None),
    ("https://key.example/sign in", None),
    ("https://key.example/sign\nin", None),
    ("https://key.example/sign\tin", None),
]


@pytest.mark.parametrize("given,offered", _VETTING)
def test_the_offer_is_vetted(rigs: Callable[..., Rig], given: Optional[str], offered: Optional[str]) -> None:
    w = World()
    r = signed_in(rigs, w)
    assert refuse(r, w, given) == [offered]


def test_vetting_resolves_against_the_origin_and_never_raises() -> None:
    assert safe_sign_in_url("https://KEY.example:443/x", ORIGIN) == "https://key.example/x"
    assert safe_sign_in_url("https://[::1/x", ORIGIN) is None
    assert safe_sign_in_url("/x", "http://key.example") is None
    assert safe_sign_in_url("/x", ORIGIN) == "https://key.example/x"
    assert sign_in_url_of({"error": {"signInUrl": "/a"}}) == "/a"
    assert sign_in_url_of({"signInUrl": "/b"}) == "/b"
    assert sign_in_url_of({"error": {"signInUrl": 3}}) is None
    assert sign_in_url_of("nope") is None


# ── a key-ring or file account_required reaches the machine ──────────────────────────────────────


def test_a_key_ring_route_does_and_the_call_still_raises(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    offers: List[Any] = []
    r.client.events.subscribe(
        lambda e: offers.append(e["signInUrl"]) if e["type"] == "signInOffered" else None, ("cloudSync",)
    )
    r.client.config.set("theme", "dark")
    base = w.__call__

    def ring_refused(req: httpx.Request) -> httpx.Response:
        if req.url.path == f"/{PRODUCT}/devices/keyring" and req.method == "GET":
            w.seen.append(req)
            return refusal(ORIGIN + "/signin")
        return base(req)

    _swap(r, ring_refused)
    with pytest.raises(PolarisError) as e:
        r.client.keyring.read()
    assert e.value.code == "account_required"
    join(r)
    assert r.client.cloud_sync.status()["state"] == "blocked"
    assert not r.client.keyring.unlocked
    assert offers == [ORIGIN + "/signin"]


def _swap(r: Rig, handler: Callable[[httpx.Request], httpx.Response]) -> None:
    r.client.core.http().close()
    r.client.core._client = httpx.Client(transport=httpx.MockTransport(handler))  # noqa: SLF001


def _routes(status: int, body: Any, told: List[Optional[str]]) -> FileRoutes:
    class Ctx:
        product = PRODUCT
        base_url = ORIGIN
        timeout = 15.0

        @staticmethod
        def headers(extra: Any = None) -> Any:
            return dict(extra or {})

        @staticmethod
        def http() -> httpx.Client:
            return httpx.Client(
                transport=httpx.MockTransport(lambda _r: httpx.Response(status, content=json.dumps(body)))
            )

    return FileRoutes(Ctx(), lambda: TOKEN, lambda url, _who: told.append(url))  # type: ignore[arg-type]


def test_a_file_route_tells_its_owner_with_the_answers_url() -> None:
    told: List[Optional[str]] = []
    routes = _routes(403, {"error": {"code": "account_required", "signInUrl": ORIGIN + "/in"}}, told)
    reply = routes.revisions(FileTarget("saves", "slot-1"))
    assert reply.ok is False and reply.status == 403 and reply.code == "account_required"
    assert told == [ORIGIN + "/in"]


def test_other_refusals_are_not_account_required() -> None:
    told: List[Optional[str]] = []
    routes = _routes(403, {"error": {"code": "forbidden"}}, told)
    routes.revisions(FileTarget("saves", "slot-1"))
    assert told == []


def test_a_file_refusal_blocks_the_machine_and_clears_the_transfers(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    r.client.config.set("theme", "dark")
    purged: List[int] = []
    r.client._cloud_sync_api._purge_saves = lambda: purged.append(1)  # noqa: SLF001
    r.client._cloud_sync_api.account_required(ORIGIN + "/in", SUBJECT)
    join(r)
    assert r.client.cloud_sync.status()["state"] == "blocked"
    assert purged == [1]
    assert saved(r)["persisted"]["blocked"] == "account_required"
    # Idempotent: a second report neither throws nor forgets twice.
    r.client._cloud_sync_api.account_required(None, SUBJECT)
    join(r)
    assert purged == [1]


# ── a request in flight when account_required arrives ────────────────────────────────────────────


def test_an_answer_for_an_abandoned_request_is_dropped(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    in_flight = threading.Event()
    release = threading.Event()

    def slow_push(_b: Any) -> Any:
        in_flight.set()
        assert release.wait(5)
        return w.body(results=[])

    w.push = slow_push
    r.client.config.set("theme", "dark")
    flushing = threading.Thread(target=r.client.cloud_sync.flush, daemon=True)
    flushing.start()
    assert in_flight.wait(5)
    r.client._cloud_sync_api.account_required(None, SUBJECT)  # noqa: SLF001
    join(r)
    assert r.client.cloud_sync.status()["state"] == "blocked"
    release.set()
    flushing.join(5)
    assert not flushing.is_alive()
    # Nothing it carried reached the journal: still blocked, no partition.
    assert r.client.cloud_sync.status()["state"] == "blocked"
    assert SUBJECT not in saved(r)["persisted"]["partitions"]


def test_the_host_drops_an_answer_the_machine_has_no_request_for(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    with r.host.locked() as m:
        # No request is in flight: the machine refuses the answer, the host says it was dropped.
        assert r.host._receive(m, {"status": 200, "body": w.body()}) is False  # noqa: SLF001


# ── a sign-in the person completes lifts the refusal ─────────────────────────────────────────────


def test_a_completed_sign_in_lifts_the_refusal_and_the_replayed_session_does_not(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    refuse(r, w)
    again = relaunch(rigs, w, r, SUBJECT)
    again.client.cloud_sync.flush()
    assert again.client.cloud_sync.status()["state"] == "blocked"
    identity(again, "signed_in", SUBJECT)
    again.client._cloud_sync_api._drain_work()  # noqa: SLF001
    again.client.cloud_sync.flush()
    assert again.client.cloud_sync.status()["state"] != "blocked"


def test_a_subject_changed_event_naming_the_refused_subject_is_not_a_completed_sign_in(
    rigs: Callable[..., Rig],
) -> None:
    w = World()
    r = signed_in(rigs, w)
    refuse(r, w)
    again = relaunch(rigs, w, r, SUBJECT)
    identity(again, "subject_changed", SUBJECT)
    again.client._cloud_sync_api._drain_work()  # noqa: SLF001
    assert again.client.cloud_sync.status()["state"] == "blocked"


# ── a pin that could not be removed is retried ───────────────────────────────────────────────────


class _Stuck:
    """The key ring's `forget`, failing while `on`."""

    def __init__(self, r: Rig) -> None:
        self.on = True
        self.tries = 0
        self._real = r.client.keyring.forget
        r.client.keyring.forget = self  # type: ignore[method-assign]

    def __call__(self) -> Any:
        self.tries += 1
        if self.on:
            raise OSError("the pin is stuck")
        return self._real()


def test_a_stuck_pin_is_saved_retried_at_start_and_holds_the_sign_in(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    logs: List[str] = []
    r.client._cloud_sync_api._log = logs.append  # noqa: SLF001
    _Stuck(r)
    refuse(r, w)
    assert r.client.cloud_sync.status()["state"] == "blocked"
    assert saved(r)["forgetPending"] is True and saved(r)["refused"] == SUBJECT
    assert logs.count("cloud sync: the key ring pin could not be removed") == 1
    r.client.identity._account.write_subject(SUBJECT)  # noqa: SLF001
    r.client.close()

    # A relaunch with the pin still stuck: start retries and fails; the person's sign-in waits.
    again = rigs(w, r.state_dir, keys=True)
    again.client.identity._account.write_subject(SUBJECT)  # noqa: SLF001
    stuck = _Stuck(again)
    again.client._cloud_sync_api.attach()  # noqa: SLF001
    assert stuck.tries > 0
    w.seen = []
    identity(again, "signed_in", SUBJECT)
    again.client._cloud_sync_api._drain_work()  # noqa: SLF001
    assert again.client.cloud_sync.status()["state"] == "blocked"
    assert w.sync_reqs == []
    assert saved(again)["forgetPending"] is True

    # The pin goes: the next sign-in is accepted and the flag is cleared.
    stuck.on = False
    identity(again, "signed_in", SUBJECT)
    again.client._cloud_sync_api._drain_work()  # noqa: SLF001
    assert again.client.cloud_sync.status()["state"] != "blocked"
    assert saved(again)["forgetPending"] is False


def test_a_pin_that_goes_at_once_leaves_no_pending_flag(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    refuse(r, w)
    assert saved(r)["forgetPending"] is False


# ── a state that cannot be rewritten is removed ──────────────────────────────────────────────────


def test_a_state_that_cannot_be_rewritten_is_removed_and_the_refusal_is_held_in_memory(
    rigs: Callable[..., Rig], monkeypatch: pytest.MonkeyPatch
) -> None:
    w = World()
    r = signed_in(rigs, w)
    assert state_file(r.state_dir) != ""

    def full(_self: Any, _file: Any) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(CloudSyncStateFile, "save", full)
    refuse(r, w)
    assert r.client.cloud_sync.status()["state"] == "blocked"
    assert state_file(r.state_dir) == ""
    assert r.host.refused == SUBJECT


# ── a late answer says nothing about the person signed in now ────────────────────────────────────


def test_a_late_answer_for_the_person_who_has_gone_does_not_block_the_new_one(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    identity(r, "signed_out")
    r.client._cloud_sync_api._drain_work()  # noqa: SLF001
    identity(r, "signed_in", OTHER)
    r.client._cloud_sync_api._drain_work()  # noqa: SLF001
    r.client._cloud_sync_api.account_required(ORIGIN + "/in", SUBJECT)  # noqa: SLF001
    join(r)
    assert r.client.cloud_sync.status()["state"] != "blocked"


def test_a_key_ring_call_reports_the_person_signed_in_when_it_started(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    base = w.__call__
    api = r.client._cloud_sync_api  # noqa: SLF001

    def ring_refused(req: httpx.Request) -> httpx.Response:
        if req.url.path == f"/{PRODUCT}/devices/keyring" and req.method == "GET":
            api._subject_value = OTHER  # noqa: SLF001 - the person changes while the call is out
            return refusal(ORIGIN + "/signin")
        return base(req)

    _swap(r, ring_refused)
    with pytest.raises(PolarisError) as e:
        r.client.keyring.read()
    assert e.value.code == "account_required"
    join(r)
    assert r.client.cloud_sync.status()["state"] != "blocked"


def test_a_file_route_reports_the_person_signed_in_when_its_call_started() -> None:
    told: List[Any] = []
    who: List[Optional[str]] = [SUBJECT]

    class Ctx:
        product = PRODUCT
        base_url = ORIGIN
        timeout = 15.0

        @staticmethod
        def headers(extra: Any = None) -> Any:
            return dict(extra or {})

        @staticmethod
        def http() -> httpx.Client:
            def handler(_r: httpx.Request) -> httpx.Response:
                who[0] = OTHER
                return refusal(ORIGIN + "/in")

            return httpx.Client(transport=httpx.MockTransport(handler))

    routes = FileRoutes(Ctx(), lambda: TOKEN, lambda u, s: told.append((u, s)), lambda: who[0])  # type: ignore[arg-type]
    routes.revisions(FileTarget("saves", "slot-1"))
    assert told == [(ORIGIN + "/in", SUBJECT)]


# ── account_required counts only from the Worker's own origin ────────────────────────────────────


def _res(url: str, history: Optional[List[Any]] = None) -> Any:
    return SimpleNamespace(url=httpx.URL(url), history=history or [])


def test_from_worker_origin() -> None:
    assert from_worker_origin(_res(ORIGIN + "/x"), ORIGIN)
    assert from_worker_origin(_res("https://KEY.example:443/x"), ORIGIN)
    assert not from_worker_origin(_res("https://evil.test/x"), ORIGIN)
    assert not from_worker_origin(_res("http://key.example/x"), ORIGIN)
    assert not from_worker_origin(_res("https://key.example:8443/x"), ORIGIN)
    assert not from_worker_origin(_res(ORIGIN + "/x", history=[object()]), ORIGIN)
    assert from_worker_origin(_res("https://key.example/x"), ORIGIN + "/prefix")


def test_a_key_ring_403_that_ended_on_another_origin_is_an_ordinary_403(rigs: Callable[..., Rig]) -> None:
    w = World()
    r = signed_in(rigs, w)
    base = w.__call__

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "key.example" and req.url.path == f"/{PRODUCT}/devices/keyring":
            return httpx.Response(302, headers={"location": "https://evil.test/r"})
        if req.url.host == "evil.test":
            return refusal(ORIGIN + "/signin")
        return base(req)

    r.client.core.http().close()
    r.client.core._client = httpx.Client(  # noqa: SLF001
        transport=httpx.MockTransport(handler), follow_redirects=True
    )
    with pytest.raises(PolarisError) as e:
        r.client.keyring.read()
    assert e.value.code == "forbidden"
    join(r)
    assert r.client.cloud_sync.status()["state"] != "blocked"


def test_a_file_403_from_another_origin_is_not_reported_and_answers_forbidden() -> None:
    told: List[Any] = []
    routes = _routes(403, {"error": {"code": "account_required", "signInUrl": ORIGIN + "/in"}}, told)
    answer = _Answer(
        status=403,
        headers={},
        data=json.dumps({"error": {"code": "account_required"}}),
        for_subject=SUBJECT,
        trusted=False,
    )
    reply = routes._refusal(answer)  # noqa: SLF001
    assert reply.ok is False and reply.status == 403 and reply.code == "forbidden"
    assert told == []
