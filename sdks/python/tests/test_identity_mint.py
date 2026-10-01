"""Device-code sign-in pacing and the edge-mint cache — the client-side rules a transcript
cannot show, because a recorded conversation has no clock between its requests.

* no poll comes earlier than ``interval`` after the previous one (or after the prompt);
* a ``slow_down`` lengthens the interval for every later poll and never shortens it;
* a failed poll is retried at the SAME interval, never faster;
* the prompt's expiry, ``timeout`` and ``cancel`` all stop polling;
* a second ``mint_token`` inside the lifetime makes no request, and nothing minted is stored;
* a cached token is bound to the device token it was minted with: after ``deactivate()`` the
  next mint is ``unauthorized`` without a request, and a different device token re-mints;
* a disabled service refuses before any request.

The clock is ``time.time`` driven by a fake ``time.sleep``, so every wait is exact and
instant.
"""

# @pkey-feature identity.devicecode config.mint

from __future__ import annotations

import json
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Union

import httpx
import pytest

from polaris_key import PolarisError, PolarisKeyClient
from polaris_key.core.store import CacheRecord

PRODUCT = "djdl"
BASE = "https://k.test"
T0 = 1_700_000_000
START = f"/{PRODUCT}/identity/auth/device/start"
POLL = f"/{PRODUCT}/identity/auth/device/poll"
MINT = f"/{PRODUCT}/config/mint/musickit/token"
REACQUIRE = f"/{PRODUCT}/license/token"
DEVICE = "D" * 32

Answer = Union[httpx.Response, Exception]


class Store:
    def __init__(self, token: Optional[str] = None) -> None:
        self.token = token
        self.cache: Optional[CacheRecord] = None

    def get_token(self) -> Optional[str]:
        return self.token

    def set_token(self, token: str) -> None:
        self.token = token

    def clear_token(self) -> None:
        self.token = None

    def get_device_id(self) -> str:
        return DEVICE

    def read_cache(self) -> Optional[CacheRecord]:
        return self.cache

    def write_cache(self, rec: CacheRecord) -> None:
        self.cache = rec

    def clear_cache(self) -> None:
        self.cache = None


class Plane:
    """A control plane answering each path from a queue (the last answer repeats)."""

    def __init__(self, clock: Dict[str, float], answers: Dict[str, List[Answer]]) -> None:
        self.clock = clock
        self.answers = answers
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = request.content.decode() if request.content else ""
        self.calls.append(
            {
                "path": request.url.path,
                "at": self.clock["now"],
                "authorization": request.headers.get("authorization"),
                "body": json.loads(body) if body else None,
            }
        )
        queue = self.answers.get(request.url.path)
        if not queue:
            return httpx.Response(404, json={})
        nxt = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    def at(self, path: str) -> List[float]:
        return [c["at"] for c in self.calls if c["path"] == path]


def gaps(times: List[float], start: float) -> List[float]:
    return [t - (start if i == 0 else times[i - 1]) for i, t in enumerate(times)]


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Dict[str, float]:
    c = {"now": float(T0)}
    monkeypatch.setattr(time, "time", lambda: c["now"])

    def sleep(seconds: float) -> None:
        c["now"] += seconds

    monkeypatch.setattr(time, "sleep", sleep)
    return c


def make(
    plane: Plane, services: List[str], token: Optional[str] = None
) -> PolarisKeyClient:
    c = PolarisKeyClient(
        product_slug=PRODUCT,
        version="1.0.0",
        trust={},
        base_url=BASE,
        store=Store(token),
        client=httpx.Client(transport=httpx.MockTransport(plane)),
        trust_refresh=False,
        request_timeout=None,
        expected_services=services,
        fingerprint=False,
    )
    c.init()
    return c


def started(**over: Any) -> httpx.Response:
    body = {
        "status": "pending",
        "deviceCode": "device-code-1",
        "userCode": "WDJB-MJHT",
        "verificationUri": f"{BASE}/{PRODUCT}/identity/auth/device",
        "verificationUriComplete": f"{BASE}/{PRODUCT}/identity/auth/device?user_code=WDJB-MJHT",
        "expiresIn": 600,
        "interval": 2,
    }
    body.update(over)
    return httpx.Response(200, json=body)


PENDING = httpx.Response(200, json={"status": "pending"})
READY = httpx.Response(200, json={"status": "ready", "token": "pkeyt_signed_in", "schemaVersion": 1})


def slow_down(interval: Optional[int] = None) -> httpx.Response:
    body: Dict[str, Any] = {"status": "slow_down"}
    if interval is not None:
        body["interval"] = interval
    return httpx.Response(429, json=body)


# ── Device-code sign-in ───────────────────────────────────────────────────────────


def test_begin_refuses_before_any_request_when_identity_is_off(clock) -> None:
    plane = Plane(clock, {START: [started()]})
    c = make(plane, ["license", "config"])
    with pytest.raises(PolarisError) as e:
        c.identity.begin_sign_in()
    assert e.value.code == "service-unavailable"
    assert plane.calls == []


def test_begin_posts_device_id_and_name_without_a_bearer(clock) -> None:
    plane = Plane(clock, {START: [started()]})
    c = make(plane, ["identity"], token="pkeyt_anonymous")
    prompt = c.identity.begin_sign_in(device_name=" Deck ")
    assert plane.calls[0]["body"] == {"deviceId": DEVICE, "deviceName": "Deck"}
    assert plane.calls[0]["authorization"] is None
    assert prompt.userCode == "WDJB-MJHT"
    assert prompt.expiresAt == T0 + 600
    assert prompt.interval == 2


def test_never_polls_earlier_than_the_interval_and_stores_the_token(clock) -> None:
    plane = Plane(clock, {START: [started()], POLL: [PENDING, PENDING, READY]})
    c = make(plane, ["identity"])
    result = c.identity.wait_for_sign_in(c.identity.begin_sign_in())
    assert result.status == "ready"
    times = plane.at(POLL)
    assert len(times) == 3
    assert all(g >= 2 for g in gaps(times, T0))
    assert c._tokens.current == "pkeyt_signed_in"
    # The post-acquisition sync ran on the new token (Identity alone: just the report).
    reports = [x for x in plane.calls if x["path"].endswith("/devices/report")]
    assert reports and reports[0]["authorization"] == "Bearer pkeyt_signed_in"


def test_slow_down_lengthens_the_interval_for_every_later_poll(clock) -> None:
    plane = Plane(
        clock, {START: [started()], POLL: [slow_down(7), PENDING, PENDING, READY]}
    )
    c = make(plane, ["identity"])
    c.identity.wait_for_sign_in(c.identity.begin_sign_in())
    assert gaps(plane.at(POLL), T0) == [2, 7, 7, 7]


def test_slow_down_without_interval_adds_five_and_never_shortens(clock) -> None:
    plane = Plane(
        clock,
        {
            START: [started()],
            POLL: [httpx.Response(429, json={"error": "rate_limited"}), slow_down(1), READY],
        },
    )
    c = make(plane, ["identity"])
    c.identity.wait_for_sign_in(c.identity.begin_sign_in())
    assert gaps(plane.at(POLL), T0) == [2, 7, 7]


def test_a_failed_poll_is_retried_at_the_same_interval(clock) -> None:
    plane = Plane(
        clock,
        {
            START: [started()],
            POLL: [httpx.ConnectError("reset"), httpx.Response(503, json={}), READY],
        },
    )
    c = make(plane, ["identity"])
    assert c.identity.wait_for_sign_in(c.identity.begin_sign_in()).status == "ready"
    assert gaps(plane.at(POLL), T0) == [2, 2, 2]


def test_expiry_stops_polling_without_asking_again(clock) -> None:
    plane = Plane(clock, {START: [started(expiresIn=5)], POLL: [PENDING]})
    c = make(plane, ["identity"])
    assert c.identity.wait_for_sign_in(c.identity.begin_sign_in()).status == "expired"
    assert [t - T0 for t in plane.at(POLL)] == [2, 4]


def test_the_servers_timeout_is_expired(clock) -> None:
    plane = Plane(
        clock,
        {START: [started()], POLL: [PENDING, httpx.Response(200, json={"status": "timeout"})]},
    )
    c = make(plane, ["identity"])
    assert c.identity.wait_for_sign_in(c.identity.begin_sign_in()).status == "expired"


def test_timeout_stops_polling(clock) -> None:
    plane = Plane(clock, {START: [started()], POLL: [PENDING]})
    c = make(plane, ["identity"])
    with pytest.raises(TimeoutError):
        c.identity.wait_for_sign_in(c.identity.begin_sign_in(), timeout=5)
    assert [t - T0 for t in plane.at(POLL)] == [2, 4]


def test_cancel_stops_polling(clock) -> None:
    cancel = threading.Event()
    calls: List[float] = []

    def after_first_poll(request: httpx.Request) -> httpx.Response:
        calls.append(clock["now"])
        cancel.set()
        return httpx.Response(200, json={"status": "pending"})

    plane = Plane(clock, {START: [started()]})
    c = make(plane, ["identity"])
    prompt = c.identity.begin_sign_in()
    c.core._client = httpx.Client(transport=httpx.MockTransport(after_first_poll))
    with pytest.raises(PolarisError) as e:
        c.identity.wait_for_sign_in(prompt, cancel=cancel)
    assert e.value.code == "cancelled"
    assert len(calls) == 1


def test_a_device_mismatch_ends_the_wait_without_a_token(clock) -> None:
    plane = Plane(
        clock, {START: [started()], POLL: [httpx.Response(401, json={"error": "unauthorized"})]}
    )
    c = make(plane, ["identity"])
    assert c.identity.wait_for_sign_in(c.identity.begin_sign_in()).status == "error"
    assert c._tokens.current is None


def test_poll_raises_network_error_rather_than_inventing_a_status(clock) -> None:
    plane = Plane(clock, {START: [started()], POLL: [httpx.ConnectError("offline")]})
    c = make(plane, ["identity"])
    prompt = c.identity.begin_sign_in()
    with pytest.raises(PolarisError) as e:
        c.identity.poll_sign_in(prompt)
    assert e.value.code == "network-error"


# ── Edge-mint ─────────────────────────────────────────────────────────────────────


def minted(token: str, expires_at: int) -> httpx.Response:
    return httpx.Response(200, json={"token": token, "expiresAt": expires_at})


def test_a_second_mint_inside_the_lifetime_makes_no_request(clock) -> None:
    plane = Plane(clock, {MINT: [minted("m1", T0 + 600), minted("m2", T0 + 1200)]})
    c = make(plane, ["license", "config"], token="pkeyt_device")
    assert c.config.mint_token("musickit").token == "m1"
    assert plane.calls[0]["authorization"] == "Bearer pkeyt_device"
    clock["now"] = T0 + 569
    assert c.config.mint_token("musickit").token == "m1"
    assert len(plane.calls) == 1
    clock["now"] = T0 + 570
    assert c.config.mint_token("musickit").token == "m2"
    assert len(plane.calls) == 2
    # Memory only: the store never sees a minted token.
    assert c.core.store.get_token() == "pkeyt_device"
    assert "m1" not in repr(c.core.store.read_cache())


def test_deactivate_drops_the_cached_minted_token(clock) -> None:
    plane = Plane(
        clock,
        {
            MINT: [minted("m1", T0 + 600)],
            f"/{PRODUCT}/license/deauthorize": [httpx.Response(200, json={"ok": True})],
        },
    )
    c = make(plane, ["license", "config"], token="pkeyt_device")
    assert c.config.mint_token("musickit").token == "m1"
    c.license.deactivate()
    assert len(plane.at(MINT)) == 1
    with pytest.raises(PolarisError) as e:
        c.config.mint_token("musickit")
    assert e.value.code == "unauthorized"
    assert len(plane.at(MINT)) == 1


def test_a_different_device_token_re_mints(clock) -> None:
    plane = Plane(clock, {MINT: [minted("m1", T0 + 600), minted("m2", T0 + 600)]})
    c = make(plane, ["license", "config"], token="pkeyt_device")
    assert c.config.mint_token("musickit").token == "m1"
    c._tokens.set("pkeyt_other")
    assert c.config.mint_token("musickit").token == "m2"
    assert [x["authorization"] for x in plane.calls] == [
        "Bearer pkeyt_device",
        "Bearer pkeyt_other",
    ]


def test_mint_refuses_before_any_request_when_config_is_off(clock) -> None:
    plane = Plane(clock, {MINT: [minted("m", T0 + 600)]})
    c = make(plane, ["license"], token="pkeyt_device")
    with pytest.raises(PolarisError) as e:
        c.config.mint_token("musickit")
    assert e.value.code == "service-unavailable"
    assert plane.calls == []


@pytest.mark.parametrize("bad", ["../license", "Music", "a/b", "", "musickit\n", "a\n"])
def test_mint_refuses_a_recipe_id_outside_the_routers_alphabet(clock, bad: str) -> None:
    plane = Plane(clock, {})
    c = make(plane, ["config"], token="pkeyt_device")
    with pytest.raises(PolarisError) as e:
        c.config.mint_token(bad)
    assert e.value.code == "bad_request"
    assert plane.calls == []


def test_mint_without_a_token_is_unauthorized_without_a_request(clock) -> None:
    plane = Plane(clock, {})
    c = make(plane, ["config"])
    with pytest.raises(PolarisError) as e:
        c.config.mint_token("musickit")
    assert e.value.code == "unauthorized"
    assert plane.calls == []


def test_mint_reacquires_once_on_401_and_retries(clock) -> None:
    plane = Plane(
        clock,
        {
            MINT: [httpx.Response(401, json={"error": "unauthorized"}), minted("m", T0 + 600)],
            REACQUIRE: [httpx.Response(200, json={"token": "pkeyt_rotated", "schemaVersion": 1})],
        },
    )
    c = make(plane, ["license", "config"], token="pkeyt_device")
    assert c.config.mint_token("musickit").token == "m"
    assert [(x["path"], x["authorization"]) for x in plane.calls] == [
        (MINT, "Bearer pkeyt_device"),
        (REACQUIRE, "Bearer pkeyt_device"),
        (MINT, "Bearer pkeyt_rotated"),
    ]


def test_mint_fails_after_one_reacquire(clock) -> None:
    plane = Plane(
        clock,
        {
            MINT: [httpx.Response(401, json={"error": "unauthorized"})],
            REACQUIRE: [httpx.Response(401, json={"error": "unauthorized"})],
        },
    )
    c = make(plane, ["license", "config"], token="pkeyt_device")
    with pytest.raises(PolarisError) as e:
        c.config.mint_token("musickit")
    assert e.value.code == "unauthorized"
    assert [x["path"] for x in plane.calls] == [MINT, REACQUIRE]
