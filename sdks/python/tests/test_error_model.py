# @pkey-feature core.errors core.sync license.activate license.enroll devices.register devices.manage
# @pkey-feature identity.devicecode release.changelog release.fetch release.distribution
# @pkey-feature update.check update.decide update.feed release.record config.mint commerce.receipt
"""One error model: transport failures are ``network-error``, a 5xx is ``server-error``.

``CoreContext.request`` maps both, once, for every service, so no httpx exception reaches a
caller and no 5xx is called something else (``update.check`` and ``release.changelog`` used to
call every failure ``not_found``; the roster calls leaked ``httpx.ConnectError``).

The matrix calls every public network method with the control plane down (``ConnectError``)
and then answering 503. A method that raises gives a :class:`PolarisError` with the code (and,
offline, the httpx exception as ``__cause__``); a method that returns a typed result carries
the code on it. The best-effort calls (deactivate, report, the diagnostic catalog fetch) never
raise and keep their documented answer.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Callable, Dict, List, Tuple

import httpx
import pytest

import polaris_key
from polaris_key import (
    AsyncClient,
    DeviceManagementUnsupportedError,
    InsecureBaseUrlError,
    PolarisError,
    UpdateClientOptions,
)
from polaris_key.core.models import ReleaseRecordDoc
from polaris_key.devices.store import InMemoryStore
from polaris_key.identity import SignInPrompt

from helpers import BASE_URL, PRODUCT, TOKEN, TRUST, discovery_doc, mock_client, new_keypair

_, REL_PUB = new_keypair()
P = f"/{PRODUCT}"
UUID = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0"


def _discovery() -> Dict[str, Any]:
    doc = discovery_doc(
        license=True, config=True, release=True, distribution=True, update=True, identity=True
    )
    base = f"{BASE_URL}{P}"
    doc["services"]["update"]["endpoints"]["feed"] = f"{base}/update/{{channel}}/feed.jws"
    doc["services"]["release"]["endpoints"] = {"record": f"{base}/release/records/{{sha256}}"}
    doc["services"]["distribution"]["endpoints"] = {
        "builds": f"{base}/distribution/builds/{{selector}}/{{buildId}}"
    }
    return doc


class Plane:
    """Serves discovery while ``mode`` is ``up``; then every request fails the same way:
    ``offline`` raises ``httpx.ConnectError``, ``503`` answers 503 with the server's message."""

    def __init__(self) -> None:
        self.mode = "up"
        self.paths: List[str] = []

    def __call__(self, r: httpx.Request) -> httpx.Response:
        self.paths.append(r.url.path)
        if self.mode == "offline":
            raise httpx.ConnectError("connection refused", request=r)
        if self.mode == "503":
            # A 503 that names no code (a code is the signed-update path's to report, P3-01).
            return httpx.Response(503, json={"message": "down for maintenance"})
        if r.url.path == f"{P}/.well-known/polaris.json":
            return httpx.Response(200, json=_discovery())
        return httpx.Response(404)


def _client(plane: Plane) -> Any:
    c = polaris_key.create(
        product_slug=PRODUCT,
        version="1.2.0",
        trust=TRUST,
        base_url=BASE_URL,
        store=InMemoryStore(PRODUCT),
        client=mock_client(plane),
        update=UpdateClientOptions(
            pinned_release_keys={"rel-test": REL_PUB},
            outlet="direct",
            platform="macos",
            arch="arm64",
            format="dmg",
        ),
    )
    assert c.capabilities()["identity"]["enabled"], "discovery loaded"
    c._tokens.set(TOKEN)
    return c


def _prompt(c: Any) -> SignInPrompt:
    return SignInPrompt(
        deviceCode="dc_" + "x" * 40,
        userCode="WDJB-MJHT",
        verificationUri="https://key.example/device",
        verificationUriComplete="https://key.example/device?code=WDJB-MJHT",
        expiresIn=600,
        interval=1,
        expiresAt=c.core.now() + 600,
    )


def _record() -> ReleaseRecordDoc:
    return ReleaseRecordDoc.from_dict(
        {
            "schemaVersion": 1,
            "aud": PRODUCT,
            "deliverable": "app",
            "kind": "app",
            "version": "1.3.0",
            "seq": 1,
            "issuedAt": 1,
            "builds": [
                {
                    "id": "macos",
                    "platform": "macos",
                    "arch": "universal",
                    "format": "dmg",
                    "artifacts": [{"name": "a.dmg", "role": "payload", "sha256": "ab" * 32, "size": 8}],
                }
            ],
        }
    )


Call = Callable[[Any, str], Any]

#: Calls that RAISE the code (``tmp`` is a scratch directory).
RAISING: List[Tuple[str, Call]] = [
    ("devices.list", lambda c, t: c.devices.list()),
    ("devices.rename", lambda c, t: c.devices.rename("d" * 32, "Studio")),
    ("devices.deauthorize", lambda c, t: c.devices.deauthorize("d" * 32)),
    ("list_devices", lambda c, t: c.list_devices()),
    ("rename_device", lambda c, t: c.rename_device("d" * 32, "Studio")),
    ("deauthorize_device", lambda c, t: c.deauthorize_device("d" * 32)),
    ("update.check", lambda c, t: c.update.check()),
    ("update.decide", lambda c, t: c.update.decide()),
    ("update.feed", lambda c, t: c.update.feed()),
    ("update.release_record", lambda c, t: c.update.release_record("ab" * 32)),
    ("release.changelog", lambda c, t: c.release.changelog()),
    ("release.fetch", lambda c, t: c.release.fetch(_record(), to=os.path.join(t, "a.dmg"))),
    ("distribution.download_model", lambda c, t: c.distribution.download_model()),
    ("identity.begin_sign_in", lambda c, t: c.identity.begin_sign_in()),
    ("identity.poll_sign_in", lambda c, t: c.identity.poll_sign_in(_prompt(c))),
    ("identity.accept_sign_in", lambda c, t: c.identity.accept_sign_in(_prompt(c))),
    (
        "identity.sign_in_with_browser",
        lambda c, t: c.identity.sign_in_with_browser(open_url=lambda u: True),
    ),
    ("config.mint_token", lambda c, t: c.config.mint_token("musickit")),
    ("commerce.binding", lambda c, t: c.commerce.binding()),
    ("commerce.claim", lambda c, t: c.commerce.claim("steam", {"ticket": "ab", "dlcAppId": "1"})),
    ("commerce.claim_steam", lambda c, t: c.commerce.claim_steam("ab", 1)),
    ("commerce.claim_play", lambda c, t: c.commerce.claim_play("gold", "tok")),
    ("commerce.claim_app_store", lambda c, t: c.commerce.claim_app_store("a.b.c")),
]

#: Calls that RETURN a typed result carrying the code.
RETURNING: List[Tuple[str, Call, Callable[[Any], Tuple[Any, Any]]]] = [
    ("license.activate_with_key", lambda c, t: c.license.activate_with_key("pkey_" + "K" * 40), lambda r: (r.code, r.status)),
    ("license.enroll", lambda c, t: c.license.enroll(), lambda r: (r.code, r.status)),
    ("devices.register", lambda c, t: c.devices.register(), lambda r: (r.code, r.status)),
    ("register", lambda c, t: c.register(), lambda r: (r.code, r.status)),
    ("sync", lambda c, t: c.sync(), lambda r: (r.documents["license"].code, None)),
    ("sync.config", lambda c, t: c.sync(), lambda r: (r.documents["config"].code, None)),
    ("discover", lambda c, t: c.discover(), lambda r: (r.code, r.status or None)),
    ("ensure_activated", lambda c, t: c.ensure_activated(), lambda r: (r.sync.documents["license"].code, None)),
]

#: Best-effort calls: never raise, keep their documented answer.
BEST_EFFORT: List[Tuple[str, Call, Callable[[Any], bool]]] = [
    ("config.fetch_schema", lambda c, t: c.config.fetch_schema(), lambda r: r is None),
    ("devices.report", lambda c, t: c.devices.report(), lambda r: r is False),
    ("try_discover", lambda c, t: c.try_discover(), lambda r: r.kind == "error"),
    ("boot", lambda c, t: c.boot(auto_confirm=False), lambda r: r.outcome in ("ready", "waiting", "offline", "blocked")),
    ("license.deactivate", lambda c, t: c.license.deactivate(), lambda r: r is None),
    ("deactivate", lambda c, t: c.deactivate(), lambda r: r is None),
    ("identity.sign_out", lambda c, t: c.identity.sign_out(), lambda r: r is None),
]

MODES = [("offline", "network-error", None), ("503", "server-error", 503)]


@pytest.mark.parametrize("mode,code,status", MODES)
@pytest.mark.parametrize("name,call", RAISING, ids=[n for n, _ in RAISING])
def test_a_raising_network_method_gives_the_code_and_no_httpx_exception(
    name: str, call: Call, mode: str, code: str, status: Any, tmp_path: Any
) -> None:
    plane = Plane()
    c = _client(plane)
    plane.mode = mode
    with pytest.raises(PolarisError) as exc:
        call(c, str(tmp_path))
    assert not isinstance(exc.value, httpx.HTTPError)
    assert exc.value.code == code, (name, exc.value.code, exc.value.message)
    if mode == "offline" and name not in ("update.decide", "update.feed", "update.release_record"):
        # Cause-chained (the signed-update path reports a code from its fetch outcome instead).
        assert isinstance(exc.value.__cause__, httpx.HTTPError)
    if status is not None and name not in ("update.decide", "update.feed", "update.release_record"):
        assert exc.value.status == status
    c.close()


@pytest.mark.parametrize("mode,code,status", MODES)
@pytest.mark.parametrize("name,call,read", RETURNING, ids=[n for n, _, _ in RETURNING])
def test_a_returning_network_method_carries_the_code(
    name: str, call: Call, read: Callable[[Any], Tuple[Any, Any]], mode: str, code: str, status: Any, tmp_path: Any
) -> None:
    plane = Plane()
    c = _client(plane)
    plane.mode = mode
    got_code, got_status = read(call(c, str(tmp_path)))
    assert got_code == code, name
    if got_status is not None:
        assert got_status == status, name
    c.close()


@pytest.mark.parametrize("mode", ["offline", "503"])
@pytest.mark.parametrize("name,call,ok", BEST_EFFORT, ids=[n for n, _, _ in BEST_EFFORT])
def test_a_best_effort_network_method_never_raises(
    name: str, call: Call, ok: Callable[[Any], bool], mode: str, tmp_path: Any
) -> None:
    plane = Plane()
    c = _client(plane)
    plane.mode = mode
    assert ok(call(c, str(tmp_path))), name
    c.close()


def test_the_async_client_maps_the_same_way() -> None:
    plane = Plane()
    c = _client(plane)
    plane.mode = "offline"

    async def run() -> None:
        a = AsyncClient(c)
        r = await a.license.activate_with_key("pkey_" + "K" * 40)
        assert r.code == "network-error"
        with pytest.raises(PolarisError) as exc:
            await a.release.changelog()
        assert exc.value.code == "network-error"
        plane.mode = "503"
        with pytest.raises(PolarisError) as exc:
            await a.update.check()
        assert (exc.value.code, exc.value.status) == ("server-error", 503)

    asyncio.run(run())
    c.close()


def test_the_signed_update_path_reports_a_named_5xx_code() -> None:
    """P3-01 §2.5 step 2: the feed fetch reports the Worker's wire code when the answer names
    one (``500 feed_not_composable`` has its own copy); a 5xx that names none is
    ``server-error``."""
    plane = Plane()
    c = _client(plane)
    c.core._client = mock_client(lambda r: httpx.Response(500, json={"error": {"code": "feed_not_composable"}}))
    with pytest.raises(PolarisError) as exc:
        c.update.feed()
    assert exc.value.code == "feed_not_composable"
    c.core._client = mock_client(lambda r: httpx.Response(500))
    with pytest.raises(PolarisError) as exc:
        c.update.feed()
    assert exc.value.code == "server-error"
    c.close()


def test_the_server_message_rides_a_server_error() -> None:
    plane = Plane()
    c = _client(plane)
    plane.mode = "503"
    with pytest.raises(PolarisError) as exc:
        c.release.changelog()
    assert exc.value.message == "down for maintenance"
    c.close()


# ── refusals are named, never collapsed into not_found ──────────────────────────────────
@pytest.mark.parametrize(
    "answer,code",
    [
        (httpx.Response(404, json={"error": {"code": "not_found"}}), "not_found"),
        (httpx.Response(404), "not_found"),
        (httpx.Response(429, json={"error": "rate_limited"}), "rate_limited"),
        (httpx.Response(429), "rate_limited"),
        (httpx.Response(400, json={"error": "bad_request", "message": "no"}), "bad_request"),
        (httpx.Response(409), "http-error"),
        (httpx.Response(500), "server-error"),
        (httpx.Response(502, json={"error": "internal_error"}), "server-error"),
    ],
)
@pytest.mark.parametrize("which", ["update.check", "release.changelog"])
def test_update_check_and_changelog_name_each_refusal(which: str, answer: httpx.Response, code: str) -> None:
    plane = Plane()
    c = _client(plane)
    plane.mode = "answer"

    def handler(r: httpx.Request) -> httpx.Response:
        return httpx.Response(answer.status_code, content=answer.content, headers=answer.headers)

    c.core._client = mock_client(handler)
    with pytest.raises(PolarisError) as exc:
        c.update.check() if which == "update.check" else c.release.changelog()
    assert (exc.value.code, exc.value.status) == (code, answer.status_code)
    c.close()


# ── one error type ─────────────────────────────────────────────────────────────────────
def test_insecure_base_url_and_device_management_errors_are_polaris_errors() -> None:
    with pytest.raises(PolarisError) as exc:
        polaris_key.create(product_slug=PRODUCT, version="1.0.0", trust=TRUST, base_url="http://key.example")
    assert isinstance(exc.value, InsecureBaseUrlError)
    assert exc.value.code == "insecure-base-url"

    c = polaris_key.create(
        product_slug=PRODUCT,
        version="1.0.0",
        trust=TRUST,
        base_url=BASE_URL,
        store=InMemoryStore(PRODUCT),
        client=mock_client(Plane()),
        expected_services=["license"],
    )
    with pytest.raises(PolarisError) as exc2:
        c.devices.list()
    assert isinstance(exc2.value, DeviceManagementUnsupportedError)
    assert exc2.value.code == "device-management-unsupported"
    c.close()
    assert issubclass(InsecureBaseUrlError, PolarisError)
    assert issubclass(DeviceManagementUnsupportedError, PolarisError)
    assert not issubclass(InsecureBaseUrlError, ValueError)


# ── an empty key never reaches the server ───────────────────────────────────────────────
@pytest.mark.parametrize("key", ["", "   ", "\n"])
def test_an_empty_key_is_refused_locally(key: str) -> None:
    plane = Plane()
    c = _client(plane)
    before = list(plane.paths)
    r = c.license.activate_with_key(key)
    assert (r.kind, r.code) == ("unauthorized", "unauthorized")
    assert plane.paths == before, "no request"
    c.close()


# ── sign-in errors carry the server's message ───────────────────────────────────────────
def test_sign_in_errors_carry_the_server_message() -> None:
    plane = Plane()
    c = _client(plane)

    def refuse(r: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized", "message": "device mismatch"})

    c.core._client = mock_client(refuse)
    with pytest.raises(PolarisError) as exc:
        c.identity.begin_sign_in()
    assert (exc.value.code, exc.value.message, exc.value.status) == ("unauthorized", "device mismatch", 401)
    poll = c.identity.poll_sign_in(_prompt(c))
    assert (poll.status, poll.message) == ("error", "device mismatch")

    def nested(r: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"code": "identity_disabled", "message": "Sign-in is off."}})

    c.core._client = mock_client(nested)
    with pytest.raises(PolarisError) as exc:
        c.identity.begin_sign_in()
    assert (exc.value.code, exc.value.message) == ("identity_disabled", "Sign-in is off.")
    c.close()
