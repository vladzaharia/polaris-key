# @pkey-feature core.backend
"""``client.backend`` (WIRE-CONTRACT-V4 §14.5, framework drop-ins §6): the headers, the origin
allowlist, the freshness pre-sync and the one retry. ``backend-matrix.json``'s ``client`` rows
are replayed on ``client_backend_action`` and then, row by row, through the httpx auth against a
scripted backend; the real client is wired in the last tests."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx
import pytest

from polaris_key.aio import AsyncClient
from polaris_key.backend import (
    BackendClient,
    client_backend_action,
    normalize_backend_origin,
)
from polaris_key.core.errors import PolarisError

from helpers import NOW, PRODUCT, TOKEN, make_client, routes, sign_license
from polaris_key.devices.store import InMemoryStore

_PATH = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "backend-matrix.json"
_CLIENT: List[Dict[str, Any]] = json.loads(_PATH.read_text(encoding="utf-8"))["client"]
ORIGIN = "https://api.test"
DEVICE = "dev_backend_0001"


def _doc(row_doc: Optional[Dict[str, int]]) -> Optional[Tuple[int, int]]:
    return (row_doc["issuedAt"], row_doc["expiresAt"]) if row_doc else None


@pytest.mark.parametrize("row", _CLIENT, ids=[r["id"] for r in _CLIENT])
def test_client_row_action(row: Dict[str, Any]) -> None:
    i = row["input"]
    resp = (i["response"]["status"], i["response"]["code"]) if i["response"] else None
    assert client_backend_action(_doc(i["document"]), i["now"], resp, i["retried"]) == row["expect"]["action"]


def _problem(status: int, code: str) -> httpx.Response:
    return httpx.Response(status, json={"code": code, "status": status},
                          headers={"content-type": "application/problem+json"})


class Rig:
    """A BackendClient over scripted answers; records every sync and request."""

    def __init__(
        self,
        answers: List[httpx.Response],
        *,
        document: Optional[Tuple[int, int]] = (1_700_000_000, 1_700_003_600),
        now: int = 1_700_001_000,
        sync_ok: bool = True,
        origins: Tuple[str, ...] = (ORIGIN,),
    ) -> None:
        self.syncs: List[bool] = []
        self.sent: List[httpx.Request] = []
        self._answers = list(answers)
        self._sync_ok = sync_ok
        self.backend = BackendClient(
            held=lambda: ("a.b.c", document[0], document[1]) if document else None,
            device_id=lambda: DEVICE,
            now=lambda: now,
            sync=self._sync,
            origins=origins,
        )

    def _sync(self, force: bool) -> bool:
        self.syncs.append(force)
        return self._sync_ok

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.sent.append(request)
        a = self._answers.pop(0) if len(self._answers) > 1 else self._answers[0]
        return httpx.Response(a.status_code, content=a.content, headers=a.headers)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler), auth=self.backend.httpx_auth())


@pytest.mark.parametrize(
    "row",
    [r for r in _CLIENT if not (r["input"]["retried"] and r["input"]["response"])],
    ids=lambda r: r["id"],
)
def test_client_rows_through_httpx_auth(row: Dict[str, Any]) -> None:
    i = row["input"]
    ok = httpx.Response(200, text="ok")
    if i["response"]:
        s, c = i["response"]["status"], i["response"]["code"]
        first = _problem(s, c) if c else httpx.Response(s)
    else:
        first = ok
    action = row["expect"]["action"]
    rig = Rig(
        [first, ok] if action == "refresh-and-retry" else [first],
        document=_doc(i["document"]),
        now=i["now"],
    )
    surfaced = i["response"] and i["response"]["status"] == 403 and i["response"]["code"] in (
        "not_entitled",
        "sign_in_required",
    )
    with rig.client() as http:
        if surfaced:
            with pytest.raises(PolarisError) as e:
                http.get(ORIGIN + "/export")
            assert e.value.code == i["response"]["code"] and e.value.status == 403
            assert len(e.value.message) > 0
            result = None
        else:
            result = http.get(ORIGIN + "/export")
    if action == "send":
        assert rig.syncs == [] and len(rig.sent) == 1
    elif action == "refresh-then-send":
        assert rig.syncs == [False] and len(rig.sent) == 1
    elif action == "refresh-and-retry":
        assert rig.syncs == [True] and len(rig.sent) == 2 and result.status_code == 200
    else:
        assert rig.syncs == [] and len(rig.sent) == 1
        if result is not None:
            assert result.status_code == (i["response"]["status"] if i["response"] else 200)


def test_a_retried_request_stops_after_its_one_retry() -> None:
    rig = Rig([_problem(401, "license_stale")])
    with rig.client() as http:
        assert http.get(ORIGIN + "/export").status_code == 401
    assert rig.syncs == [True] and len(rig.sent) == 2


def test_a_failed_sync_returns_the_backends_response() -> None:
    rig = Rig([_problem(401, "license_invalid")], sync_ok=False)
    with rig.client() as http:
        r = http.get(ORIGIN + "/export")
    assert r.status_code == 401 and r.json()["code"] == "license_invalid"
    assert len(rig.sent) == 1


def test_it_sends_the_two_headers_and_leaves_the_developers_own() -> None:
    rig = Rig([httpx.Response(200)])
    with rig.client() as http:
        http.get(ORIGIN + "/export", headers={"Authorization": "Bearer dev", "X-PKey-License": "forged"})
    h = rig.sent[0].headers
    assert h["authorization"] == "Bearer dev"
    assert h["x-pkey-license"] == "a.b.c" and h["x-pkey-device"] == DEVICE
    assert rig.backend.headers() == {"X-PKey-License": "a.b.c", "X-PKey-Device": DEVICE}


def test_without_a_licence_only_the_device_id_goes() -> None:
    rig = Rig([httpx.Response(200)], document=None)
    assert rig.backend.headers() == {"X-PKey-Device": DEVICE}


def test_origins_are_exact_and_checked_before_sending() -> None:
    rig = Rig([httpx.Response(200)])
    with rig.client() as http:
        for url in (
            "https://evil.test/export",
            "http://api.test/export",
            "https://api.test:8443/export",
            "https://sub.api.test/export",
        ):
            with pytest.raises(PolarisError) as e:
                http.get(url)
            assert e.value.code == "backend-origin-not-allowed"
        assert http.get("https://API.test:443/export").status_code == 200
    assert len(rig.sent) == 1


def test_a_redirect_is_not_followed_by_default_and_its_next_hop_is_checked() -> None:
    rig = Rig([httpx.Response(302, headers={"location": "https://evil.test/steal"})])
    with rig.client() as http:
        r = http.get(ORIGIN + "/export")
        assert r.status_code == 302 and len(rig.sent) == 1
        with pytest.raises(PolarisError) as e:
            http.send(r.next_request)  # the hop goes through the auth again
    assert e.value.code == "backend-origin-not-allowed"
    assert len(rig.sent) == 1


def test_a_followed_redirect_to_another_origin_never_returns_its_response() -> None:
    rig = Rig([httpx.Response(302, headers={"location": "https://evil.test/steal"}), httpx.Response(200, text="loot")])
    with httpx.Client(
        transport=httpx.MockTransport(rig.handler), auth=rig.backend.httpx_auth(), follow_redirects=True
    ) as http:
        with pytest.raises(PolarisError) as e:
            http.get(ORIGIN + "/export")
    assert e.value.code == "backend-origin-not-allowed"


def test_a_redirect_inside_the_allowlist_carries_the_headers() -> None:
    rig = Rig([httpx.Response(307, headers={"location": "/v2/export"}), httpx.Response(200, text="done")])
    with httpx.Client(
        transport=httpx.MockTransport(rig.handler), auth=rig.backend.httpx_auth(), follow_redirects=True
    ) as http:
        assert http.get(ORIGIN + "/export").text == "done"
    assert [str(r.url) for r in rig.sent] == [ORIGIN + "/export", ORIGIN + "/v2/export"]
    assert rig.sent[1].headers["x-pkey-license"] == "a.b.c"


def test_origin_validation() -> None:
    assert normalize_backend_origin("https://Api.Example.com:443") == "https://api.example.com"
    assert normalize_backend_origin("http://localhost:3000") == "http://localhost:3000"
    assert normalize_backend_origin("http://127.0.0.1:8080") == "http://127.0.0.1:8080"
    for bad in (
        "http://api.example.com",
        "https://api.example.com/v1",
        "https://*.example.com",
        "https://user:pw@api.example.com",
        "api.example.com",
        "https://api.example.com?x=1",
    ):
        with pytest.raises(PolarisError) as e:
            normalize_backend_origin(bad)
        assert e.value.code == "invalid-options"


def test_concurrent_callers_share_one_sync() -> None:
    gate = threading.Event()
    calls: List[bool] = []

    def slow(force: bool) -> bool:
        calls.append(force)
        gate.wait(2)
        return True

    backend = BackendClient(
        held=lambda: ("a.b.c", 1_700_000_000, 1_700_003_600),
        device_id=lambda: DEVICE,
        now=lambda: 1_700_003_000,  # inside the margin
        sync=slow,
    )
    threads = [threading.Thread(target=backend.headers) for _ in range(4)]
    for t in threads:
        t.start()
    while not calls:
        pass
    gate.set()
    for t in threads:
        t.join(5)
    assert calls == [False]


def test_async_httpx_client() -> None:
    rig = Rig([_problem(401, "license_stale"), httpx.Response(200, text="ok")])

    async def run() -> Tuple[int, List[bool]]:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(rig.handler), auth=rig.backend.httpx_auth()
        ) as http:
            r = await http.get(ORIGIN + "/export")
            return r.status_code, rig.syncs

    assert asyncio.run(run()) == (200, [True])
    rig2 = Rig([_problem(403, "not_entitled")])

    async def refused() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(rig2.handler), auth=rig2.backend.httpx_auth()
        ) as http:
            await http.get(ORIGIN + "/export")

    with pytest.raises(PolarisError) as e:
        asyncio.run(refused())
    assert e.value.code == "not_entitled" and rig2.syncs == []


def test_requests_auth() -> None:
    requests = pytest.importorskip("requests")
    from requests.adapters import BaseAdapter

    rig = Rig([_problem(401, "license_invalid"), httpx.Response(200, text="ok")])

    class Stub(BaseAdapter):
        def send(self, request: Any, **kw: Any) -> Any:
            rig.sent.append(httpx.Request(request.method, request.url, headers=dict(request.headers)))
            a = rig._answers.pop(0) if len(rig._answers) > 1 else rig._answers[0]
            resp = requests.Response()
            resp.status_code = a.status_code
            resp._content = a.content
            resp.headers.update(dict(a.headers))
            resp.url = request.url
            resp.request = request
            resp.connection = self
            return resp

        def close(self) -> None:
            pass

    s = requests.Session()
    s.mount("https://", Stub())
    r = s.get(ORIGIN + "/export", auth=rig.backend.requests_auth())
    assert r.status_code == 200 and rig.syncs == [True] and len(rig.sent) == 2
    assert rig.sent[1].headers["x-pkey-license"] == "a.b.c"
    with pytest.raises(PolarisError) as e:
        s.get("https://evil.test/x", auth=rig.backend.requests_auth())
    assert e.value.code == "backend-origin-not-allowed"
    # A refusal raises typed and does not retry.
    rig._answers[:] = [_problem(403, "sign_in_required")]
    rig.syncs.clear()
    with pytest.raises(PolarisError) as e2:
        s.get(ORIGIN + "/export", auth=rig.backend.requests_auth())
    assert e2.value.code == "sign_in_required" and rig.syncs == []


# ── Through a real client ────────────────────────────────────────────────────────────
def test_the_real_client_sends_the_cached_document_and_the_device_id() -> None:
    store = InMemoryStore(PRODUCT)
    store.set_token(TOKEN)
    probe = make_client(lambda r: httpx.Response(404), store=store, expected_services=["license"])
    device = probe.core.device_id
    license_jws = sign_license(device, issued=NOW)
    c = make_client(
        routes(license_jws=license_jws),
        store=store,
        expected_services=["license"],
        backend={"origins": [ORIGIN]},
    )
    c.sync(force=True)
    got: Dict[str, str] = {}

    def api(r: httpx.Request) -> httpx.Response:
        got.update({k: v for k, v in r.headers.items() if k.startswith("x-pkey") or k == "authorization"})
        return httpx.Response(200, json={"ok": True})

    with httpx.Client(transport=httpx.MockTransport(api), auth=c.backend.httpx_auth()) as http:
        assert http.get(ORIGIN + "/export").status_code == 200
    assert got == {"x-pkey-license": license_jws, "x-pkey-device": device}
    assert c.backend.origins == (ORIGIN,)


def test_a_bad_backend_origin_is_invalid_options_at_construction() -> None:
    with pytest.raises(PolarisError) as e:
        make_client(lambda r: httpx.Response(404), backend={"origins": ["http://api.test"]})
    assert e.value.code == "invalid-options"


def test_the_async_client_mirrors_backend() -> None:
    store = InMemoryStore(PRODUCT)
    store.set_token(TOKEN)
    sync_client = make_client(
        routes(license_jws=lambda r: sign_license(sync_client.core.device_id, issued=NOW)),
        store=store,
        expected_services=["license"],
        backend={"origins": [ORIGIN]},
    )

    async def run() -> Dict[str, str]:
        client = AsyncClient(sync_client)
        await client.sync(force=True)
        headers = await client.backend.headers()
        assert client.backend.httpx_auth() is not None  # built synchronously
        return headers

    h = asyncio.run(run())
    assert set(h) == {"X-PKey-License", "X-PKey-Device"}


# ── Fix round: the licence never reaches a disallowed origin ─────────────────────────
def _leak_rig(answers: List[httpx.Response]) -> Rig:
    return Rig(answers)


def test_followed_redirect_to_a_disallowed_origin_reaches_the_transport_zero_times() -> None:
    rig = _leak_rig([httpx.Response(302, headers={"location": "https://evil.test/steal?token=s3cret"})])
    with rig.backend.httpx_client(transport=httpx.MockTransport(rig.handler), follow_redirects=True) as http:
        with pytest.raises(PolarisError) as e:
            http.get(ORIGIN + "/export")
    assert e.value.code == "backend-origin-not-allowed"
    assert [str(r.url) for r in rig.sent] == [ORIGIN + "/export"]  # the evil hop was never sent
    assert "s3cret" not in e.value.message and "/steal" not in e.value.message


def test_the_async_client_guards_every_hop_too() -> None:
    rig = _leak_rig([httpx.Response(302, headers={"location": "https://evil.test/steal"})])

    async def run() -> None:
        async with rig.backend.httpx_async_client(
            transport=httpx.MockTransport(rig.handler), follow_redirects=True
        ) as http:
            await http.get(ORIGIN + "/export")

    with pytest.raises(PolarisError) as e:
        asyncio.run(run())
    assert e.value.code == "backend-origin-not-allowed"
    assert len(rig.sent) == 1


def test_a_redirect_on_the_retried_response_is_guarded() -> None:
    rig = _leak_rig(
        [_problem(401, "license_stale"), httpx.Response(302, headers={"location": "https://evil.test/x"})]
    )
    with rig.backend.httpx_client(transport=httpx.MockTransport(rig.handler), follow_redirects=True) as http:
        with pytest.raises(PolarisError) as e:
            http.get(ORIGIN + "/export")
    assert e.value.code == "backend-origin-not-allowed"
    assert len(rig.sent) == 2


def test_user_event_hooks_are_kept_after_the_guard() -> None:
    rig = _leak_rig([httpx.Response(200)])
    seen: List[str] = []
    with rig.backend.httpx_client(
        transport=httpx.MockTransport(rig.handler), event_hooks={"request": [lambda r: seen.append(str(r.url))]}
    ) as http:
        http.get(ORIGIN + "/export")
    assert seen == [ORIGIN + "/export"]


def test_requests_retry_that_redirects_elsewhere_is_refused_and_nothing_more_is_sent() -> None:
    requests = pytest.importorskip("requests")
    from requests.adapters import BaseAdapter

    rig = Rig(
        [_problem(401, "license_stale"), httpx.Response(302, headers={"location": "https://evil.test/x"})]
    )

    class Stub(BaseAdapter):
        def send(self, request: Any, **kw: Any) -> Any:
            rig.sent.append(httpx.Request(request.method, request.url))
            a = rig._answers.pop(0) if len(rig._answers) > 1 else rig._answers[0]
            resp = requests.Response()
            resp.status_code = a.status_code
            resp._content = a.content
            resp.headers.update(dict(a.headers))
            resp.url = request.url
            resp.request = request
            resp.connection = self
            return resp

        def close(self) -> None:
            pass

    s = requests.Session()
    s.mount("https://", Stub())
    with pytest.raises(PolarisError) as e:
        s.get(ORIGIN + "/export", auth=rig.backend.requests_auth())
    assert e.value.code == "backend-origin-not-allowed"
    assert [str(r.url) for r in rig.sent] == [ORIGIN + "/export", ORIGIN + "/export"]


def test_forced_syncs_are_rate_limited() -> None:
    clock = {"t": 100.0}
    syncs: List[bool] = []
    backend = BackendClient(
        held=lambda: ("a.b.c", 1_700_000_000, 1_700_003_600),
        device_id=lambda: DEVICE,
        now=lambda: 1_700_001_000,
        sync=lambda force: syncs.append(force) or True,
        origins=[ORIGIN],
        monotonic=lambda: clock["t"],
    )
    assert backend._shared(True) is True
    clock["t"] += 5
    assert backend._shared(True) is False  # inside the interval: no sync, the response stands
    clock["t"] += 6
    assert backend._shared(True) is True
    assert syncs == [True, True]
