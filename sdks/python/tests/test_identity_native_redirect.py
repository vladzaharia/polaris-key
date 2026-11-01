# @pkey-feature identity.redirect.native
"""The native redirect sign-in (I-15b.3, WIRE-CONTRACT-V5 §12.12): client-core's ``redirect.ts``
helpers ported (their vectors are the redirect-native-* recordings), then the loopback listener
rule by rule over real sockets, then the session: bind first, one callback, the pusher's device,
the typed fallbacks."""

from __future__ import annotations

import http.client
import json
import socket
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, quote, urlsplit

import httpx
import pytest
from helpers import BASE_URL, PRODUCT, make_client

from polaris_key import PolarisError
from polaris_key.constants_generated import ErrorCode
from polaris_key.devices.store import InMemoryStore
from polaris_key.identity.native_redirect import (
    LoopbackListener,
    NativePending,
    NativeSignInSession,
    authorize_url_for,
    choose_redirect_class,
    classify_native_redirect_uri,
    is_headless,
    native_redirect_uri,
    native_token_request,
    parse_native_callback,
    parse_pushed_answer,
    push_request,
)
from polaris_key.identity.redirect import SignInError

PB = f"{BASE_URL}/{PRODUCT}"
ISS = f"{PB}/identity"
STATE = "tidewater-state-0123456789"
VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
HANDLE = "rq_fxXQ7DEgqPUfZlsJYdm76w"
REQUEST_URI = "urn:ietf:params:oauth:request_uri:A1xUxaz50yGeWfx8JDSnAw"
RETURN_PAGE = f"{BASE_URL}/signin/return"
SCHEME = "com.tidewater.studio:/pkey/callback"
CODE = "nzMud_COpAeAOKaIdixAP_dJqIpwVVSjV3GCoBfT-eE"
TRANSCRIPTS = Path(__file__).resolve().parents[3] / "conformance" / "transcripts"


def recorded(name: str) -> Dict[str, Any]:
    return json.loads((TRANSCRIPTS / f"redirect-native-{name}.json").read_text())  # type: ignore[no-any-return]


# ── The pure helpers ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "uri,cls",
    [
        ("http://127.0.0.1:49152/pkey/callback", "loopback"),
        ("http://[::1]:49152/pkey/callback", "loopback"),
        (SCHEME, "scheme"),
        ("https://app.example/open/pkey", "claimed"),
        ("http://localhost:49152/pkey/callback", None),
        ("http://127.0.0.1/pkey/callback", None),
        ("http://127.0.0.1:80/pkey/callback", None),
        ("http://127.0.0.1:049152/pkey/callback", None),
        ("http://127.0.0.1:70000/pkey/callback", None),
        ("http://127.0.0.1:49152/other", None),
        ("http://127.0.0.1:49152/pkey/callback?x=1", None),
        ("http://127.0.0.1:49152/pkey/callback#f", None),
        ("http://user@127.0.0.1:49152/pkey/callback", None),
        ("com.x:/other", None),
        ("com.x:/pkey/callback?q=1", None),
        ("javascript:/pkey/callback", None),
        ("https://app.example/", None),
        ("http://127.0.0.1:49152/pkey/callback ", None),
        ("", None),
        (None, None),
    ],
)
def test_the_class_of_a_redirect_uri(uri: Any, cls: Optional[str]) -> None:
    assert classify_native_redirect_uri(uri) == cls


def test_redirect_uris_are_built_from_a_port_or_a_scheme() -> None:
    assert native_redirect_uri("loopback", port=49152) == "http://127.0.0.1:49152/pkey/callback"
    assert native_redirect_uri("scheme", scheme="com.tidewater.studio") == SCHEME
    for port in (0, 80, 65536, None):
        with pytest.raises(PolarisError):
            native_redirect_uri("loopback", port=port)
    for scheme in ("https", "", "Com.X", "1x"):
        with pytest.raises(PolarisError):
            native_redirect_uri("scheme", scheme=scheme)


def test_the_class_order_is_loopback_then_scheme_then_claimed_then_the_fallback() -> None:
    native = {"loopback": True, "schemes": [SCHEME], "claimedHttps": ["https://app.example/open/pkey"]}
    kw: Dict[str, Any] = {
        "request_endpoint": f"{PB}/identity/request",
        "registered_schemes": [SCHEME],
        "registered_claimed": ["https://app.example/open/pkey"],
    }
    assert choose_redirect_class(discovery=native, can_listen=True, **kw).kind == "loopback"
    assert choose_redirect_class(discovery=native, can_listen=False, **kw).kind == "scheme"
    only_claimed = {**kw, "registered_schemes": []}
    assert choose_redirect_class(discovery=native, can_listen=False, **only_claimed).kind == "claimed"
    # A class the host has but discovery does not list is not used.
    bare = {"loopback": False, "schemes": [], "claimedHttps": []}
    none = choose_redirect_class(discovery=bare, can_listen=True, **kw)
    assert (none.kind, none.code, none.reason) == ("unavailable", "redirect-unavailable", "no-class")
    off = choose_redirect_class(request_endpoint=None, discovery=native, can_listen=True)
    assert (off.kind, off.reason) == ("unavailable", "request-not-served")


def test_the_push_is_the_recorded_form() -> None:
    t = recorded("loopback")
    want = t["steps"][0]["exchanges"]["items"][0]["request"]["body"]["json"]
    pushed = push_request(
        request_endpoint=f"{PB}/identity/request",
        authorize_endpoint=f"{PB}/identity/authorize",
        token_endpoint=f"{PB}/identity/token",
        issuer=ISS,
        client_id="djdl",
        redirect_uri="http://127.0.0.1:49152/pkey/callback",
        device_name="Ada's Mac",
        state=STATE,
        code_verifier=VERIFIER,
    )
    got = dict(parse_qsl(pushed.body, strict_parsing=True))
    assert got == want
    assert list(got) == list(want)
    assert VERIFIER not in pushed.body and VERIFIER not in repr(pushed)
    assert pushed.pending.redirect_class == "loopback"


def test_the_push_refuses_before_building_anything() -> None:
    base: Dict[str, Any] = {
        "request_endpoint": f"{PB}/identity/request",
        "authorize_endpoint": f"{PB}/identity/authorize",
        "token_endpoint": f"{PB}/identity/token",
        "issuer": ISS,
        "client_id": "djdl",
        "redirect_uri": "http://127.0.0.1:49152/pkey/callback",
    }
    for over in (
        {"redirect_uri": "https://app.example/"},
        {"redirect_uri": "http://localhost:49152/pkey/callback"},
        {"return_uri": "http://127.0.0.1:49152/pkey/callback"},
        {"state": "short"},
        {"code_verifier": "short"},
        {"issuer": ""},
        {"request_endpoint": "relative/request"},
    ):
        with pytest.raises(PolarisError):
            push_request(**{**base, **over})
    # license_choice=app only when the choice endpoints are served; the scheme's return_uri rides along.
    body = push_request(**base, license_choice="app", return_uri=SCHEME).body
    assert "license_choice" not in body and "return_uri=" in body
    assert "license_choice=app" in push_request(**base, license_choice="app", choice_available=True).body


def test_the_pushed_answer() -> None:
    ok = parse_pushed_answer(201, {"request_uri": REQUEST_URI, "expires_in": 600})
    assert (ok.kind, ok.request_uri, ok.expires_in) == ("pushed", REQUEST_URI, 600)
    for body in (
        {"request_uri": "urn:x", "expires_in": 600},
        {"request_uri": REQUEST_URI, "expires_in": 601},
        {"request_uri": REQUEST_URI, "expires_in": 0},
        {"request_uri": REQUEST_URI},
        "x",
    ):
        assert parse_pushed_answer(201, body).kind == "malformed"
    refused = parse_pushed_answer(429, {"error": "rate_limited", "retryAfter": 2.2})
    assert (refused.kind, refused.error, refused.status, refused.retry_after_seconds) == (
        "refused",
        "rate_limited",
        429,
        3,
    )
    assert parse_pushed_answer(500, "oops").error == "server_error"


def test_the_authorize_url_carries_the_client_and_the_request_uri_only() -> None:
    url = authorize_url_for(f"{PB}/identity/authorize", "djdl", REQUEST_URI)
    assert url == (
        f"{PB}/identity/authorize?client_id=djdl&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3AA1xUxaz50yGeWfx8JDSnAw"
    )
    with pytest.raises(PolarisError):
        authorize_url_for(f"{PB}/identity/authorize", "djdl", "urn:other")


def pending(uri: str = "http://127.0.0.1:49152/pkey/callback") -> NativePending:
    return NativePending(
        redirect_class=classify_native_redirect_uri(uri) or "loopback",
        redirect_uri=uri,
        state=STATE,
        code_verifier=VERIFIER,
        client_id="djdl",
        issuer=ISS,
        authorize_endpoint=f"{PB}/identity/authorize",
        token_endpoint=f"{PB}/identity/token",
    )


def cb(uri: str = "http://127.0.0.1:49152/pkey/callback", **over: Optional[str]) -> str:
    q: Dict[str, Optional[str]] = {"code": CODE, "state": STATE, "iss": ISS, "request": HANDLE, **over}
    return uri + "?" + "&".join(f"{k}={quote(v, safe='')}" for k, v in q.items() if v is not None)


@pytest.mark.parametrize(
    "url,reason",
    [
        (cb("http://127.0.0.1:49153/pkey/callback"), "redirect-mismatch"),
        (cb(state="other-state-0123456789"), "state-mismatch"),
        (cb(state=None), "state-mismatch"),
        (cb(iss="https://evil.example/identity"), "issuer-mismatch"),
        (cb(iss=None), "issuer-mismatch"),
        (cb(code=None), "missing-code"),
        (cb() + "&extra=1", "unexpected-parameter"),
        (cb() + "&code=twice", "malformed"),
        (cb(request=None), "request-invalid"),
        (cb(request="rq_short"), "request-invalid"),
        (cb() + "#frag", "malformed"),
        ("not a url", "malformed"),
    ],
)
def test_a_loopback_callback_is_refused(url: str, reason: str) -> None:
    r = parse_native_callback(pending(), url)
    assert (r.kind, r.code, r.reason) == ("failed", None, reason)


def test_the_callback_results() -> None:
    ok = parse_native_callback(pending(), cb())
    assert (ok.kind, ok.code, ok.request) == ("code", CODE, HANDLE)
    assert CODE not in repr(ok)
    # A scheme delivery carries no handle; one that carries a handle must hold a valid one.
    s = parse_native_callback(pending(SCHEME), cb(SCHEME, request=None))
    assert (s.kind, s.code, s.request) == ("code", CODE, None)
    assert parse_native_callback(pending(SCHEME), cb(SCHEME, request="rq_x")).reason == "request-invalid"
    denied = parse_native_callback(pending(), cb(code=None, error="access_denied"))
    assert (denied.kind, denied.request) == ("cancelled", HANDLE)
    other = parse_native_callback(pending(), cb(code=None, error="server_error"))
    assert (other.kind, other.reason, other.error) == ("failed", "authorization-error", "server_error")


def test_the_token_request_names_the_pushing_device_and_no_label() -> None:
    req = native_token_request(pending(), CODE, "TRANSCRIPTDEVICE0000000000000001")
    assert req.url == f"{PB}/identity/token"
    assert req.headers["X-PKey-Device"] == "TRANSCRIPTDEVICE0000000000000001"
    want = recorded("loopback")["steps"][3]["exchanges"]["items"][0]["request"]["body"]["json"]
    assert dict(parse_qsl(req.body, strict_parsing=True)) == want
    assert VERIFIER not in repr(req) and CODE not in repr(req)
    with pytest.raises(PolarisError):
        native_token_request(pending(), CODE, "")


def test_headless_hosts() -> None:
    assert is_headless({"SSH_CONNECTION": "1"}, "darwin")
    assert is_headless({"SSH_TTY": "/dev/pts/1"}, "darwin")
    assert is_headless({"CI": "true"}, "darwin")
    assert is_headless({}, "linux")
    assert not is_headless({"DISPLAY": ":0"}, "linux")
    assert not is_headless({"WAYLAND_DISPLAY": "wayland-0"}, "linux")
    assert not is_headless({}, "darwin")
    assert not is_headless({}, "win32")


# ── The listener, rule by rule ───────────────────────────────────────────────────────


def get(port: int, target: str, host: Optional[str] = None, method: str = "GET") -> Tuple[int, Dict[str, str], bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.putrequest(method, target, skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", host if host is not None else f"127.0.0.1:{port}")
        conn.endheaders()
        res = conn.getresponse()
        return res.status, {k.lower(): v for k, v in res.getheaders()}, res.read()
    finally:
        conn.close()


def refused(port: int) -> bool:
    try:
        socket.create_connection(("127.0.0.1", port), timeout=2).close()
    except OSError:
        return True
    return False


def eventually(check: Any, seconds: float = 3.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.02)
    return False


class Recorder:
    """A listener ``accept`` that records what reached it."""

    def __init__(
        self, location: Optional[str] = "https://customer.example/signin/return?request=rq_x", final: bool = True
    ):
        self.urls: List[str] = []
        self.location = location
        self.final = final

    def __call__(self, url: str) -> Tuple[Optional[str], bool]:
        self.urls.append(url)
        # The state decides: anything but the right one is "not ours".
        if "state=right" in url:
            return self.location, self.final
        return None, False


def test_listener_rule_bind_is_loopback_only_on_an_os_assigned_port() -> None:
    listener = LoopbackListener()
    try:
        host, port = listener._server.server_address[:2]
        assert host == "127.0.0.1"
        assert port == listener.port and port > 0
        # Bound before it serves: the port is held while no thread runs.
        assert listener._thread is None
        with pytest.raises(OSError):
            other = socket.socket()
            try:
                other.bind(("127.0.0.1", listener.port))
                other.listen()
            finally:
                other.close()
    finally:
        listener.close()
    assert refused(listener.port)


def test_listener_rule_anything_but_the_callback_is_404_and_listening_continues() -> None:
    rec = Recorder()
    listener = LoopbackListener()
    listener.start(rec)
    try:
        port = listener.port
        wrong = [
            get(port, "/"),
            get(port, "/pkey/callback/"),
            get(port, "/PKEY/callback?state=right"),
            get(port, "/pkey/callbackx?state=right"),
            get(port, "/pkey/callback?state=right", host="localhost:%d" % port),
            get(port, "/pkey/callback?state=right", host="127.0.0.1"),
            get(port, "/pkey/callback?state=right", host="evil.example"),
            get(port, "/pkey/callback?state=right", method="POST"),
            get(port, "/pkey/callback?state=right", method="OPTIONS"),
            get(port, "/pkey/callback?state=right", method="HEAD"),
            get(port, "/pkey/callback?state=right", method="DELETE"),
        ]
        assert [w[0] for w in wrong] == [404] * len(wrong)
        assert rec.urls == []
        # A request at the callback with a state that is not ours is the session's call: 404, listening.
        assert get(port, "/pkey/callback?state=wrong")[0] == 404
        assert not listener.closed
        status, headers, body = get(port, "/pkey/callback?state=right")
        assert status == 303
    finally:
        listener.close()


def test_listener_rule_the_answer_is_a_bodiless_no_store_redirect_without_cors() -> None:
    rec = Recorder()
    listener = LoopbackListener()
    listener.start(rec)
    try:
        status, headers, body = get(listener.port, "/pkey/callback?state=right")
        assert status == 303
        assert headers["location"] == "https://customer.example/signin/return?request=rq_x"
        assert headers["referrer-policy"] == "no-referrer"
        assert headers["cache-control"] == "no-store"
        assert body == b"" and headers["content-length"] == "0"
        assert not [h for h in headers if h.startswith("access-control-")]
        assert "content-type" not in headers
    finally:
        listener.close()


def test_listener_rule_a_404_has_no_html_body_either() -> None:
    listener = LoopbackListener()
    listener.start(Recorder())
    try:
        for target, method in (("/nope", "GET"), ("/pkey/callback?x", "BREW"), ("/" + "a" * 70000, "GET")):
            status, headers, body = get(listener.port, target, method=method)
            assert status in (404, 414, 501) and body == b""
            assert "content-type" not in headers and "content-length" in headers
    finally:
        listener.close()


def test_listener_rule_it_closes_after_the_first_good_callback() -> None:
    rec = Recorder()
    listener = LoopbackListener()
    listener.start(rec)
    port = listener.port
    assert get(port, "/pkey/callback?state=right")[0] == 303
    assert eventually(lambda: refused(port))
    assert listener.closed
    assert len(rec.urls) == 1


def test_listener_rule_a_second_request_cannot_race_the_first() -> None:
    answers: List[int] = []
    gate = threading.Event()

    def slow(url: str) -> Tuple[Optional[str], bool]:
        gate.wait(2)
        return "https://customer.example/signin/return?request=rq_x", True

    listener = LoopbackListener()
    listener.start(slow)
    port = listener.port
    try:
        threads = [
            threading.Thread(target=lambda: answers.append(get(port, "/pkey/callback?state=right")[0]))
            for _ in range(3)
        ]
        for t in threads:
            t.start()
        time.sleep(0.2)
        gate.set()
        for t in threads:
            t.join(5)
    finally:
        listener.close()
    assert sorted(answers).count(303) == 1


def test_listener_rule_it_closes_when_the_flow_expires() -> None:
    listener = LoopbackListener(lifetime=0.3)
    listener.start(Recorder())
    port = listener.port
    assert get(port, "/nope")[0] == 404
    assert eventually(lambda: refused(port))
    assert listener.closed


def test_listener_rule_it_writes_no_log_line_and_never_the_code(capfd: pytest.CaptureFixture[str]) -> None:
    listener = LoopbackListener()
    listener.start(Recorder())
    try:
        get(listener.port, f"/pkey/callback?state=right&code={CODE}")
    finally:
        listener.close()
    out, err = capfd.readouterr()
    assert CODE not in out + err
    assert out == "" and err == ""


def test_a_slow_connection_does_not_hold_the_listener() -> None:
    listener = LoopbackListener()
    listener.start(Recorder())
    stalled = socket.create_connection(("127.0.0.1", listener.port))
    try:
        stalled.sendall(b"GET /pkey/callback?state=ri")  # never finishes the request line
        assert get(listener.port, "/pkey/callback?state=right")[0] == 303
    finally:
        stalled.close()
        listener.close()


# ── The session ──────────────────────────────────────────────────────────────────────

TOKEN_ANSWER = {
    "access_token": "pkeyt_native",
    "token_type": "Bearer",
    "scope": "profile email",
    "schemaVersion": 1,
    "device": {"id": "D"},
    "license": {"id": "lic_pro"},
    "subject": "ps_" + "C" * 22,
}


class World:
    """The Worker as far as a native sign-in sees it: discovery, ``request`` and ``token``."""

    def __init__(
        self, *, native: Optional[Dict[str, Any]] = None, with_request: bool = True, push_status: int = 201
    ) -> None:
        self.calls: List[Tuple[str, str, Dict[str, str], Dict[str, str]]] = []
        self.events: List[str] = []
        self.push_status = push_status
        self.token_answer: Tuple[int, Any] = (200, TOKEN_ANSWER)
        self.native = native if native is not None else {"loopback": True, "schemes": [SCHEME], "claimedHttps": []}
        self.with_request = with_request

    def doc(self) -> Dict[str, Any]:
        ep: Dict[str, Any] = {
            "authorize": f"{PB}/identity/authorize",
            "token": f"{PB}/identity/token",
        }
        fragment: Dict[str, Any] = {"enabled": True, "configured": True, "issuer": ISS, "endpoints": ep}
        if self.with_request:
            ep["request"] = f"{PB}/identity/request"
            ep["signinReturn"] = RETURN_PAGE
            fragment["nativeRedirect"] = self.native
        return {
            "product": PRODUCT,
            "services": {"license": {"enabled": True}, "config": {"enabled": True}, "identity": fragment},
        }

    def __call__(self, r: httpx.Request) -> httpx.Response:
        path = r.url.path
        if path.endswith("/.well-known/polaris.json"):
            return httpx.Response(200, json=self.doc())
        form = dict(parse_qsl(r.content.decode("ascii"))) if r.content else {}
        self.calls.append((r.method, path, form, dict(r.headers)))
        if path.endswith("/identity/request"):
            self.events.append("push")
            if self.push_status != 201:
                return httpx.Response(self.push_status, json={"error": "invalid_request"}, headers={"retry-after": "7"})
            return httpx.Response(201, json={"request_uri": REQUEST_URI, "expires_in": 600})
        if path.endswith("/identity/token"):
            self.events.append("token")
            status, body = self.token_answer
            return httpx.Response(status, json=body)
        return httpx.Response(404)

    def of(self, suffix: str) -> List[Tuple[str, str, Dict[str, str], Dict[str, str]]]:
        return [c for c in self.calls if c[1].endswith(suffix)]


def make(w: World, **kw: Any) -> Any:
    c = make_client(
        w,
        store=InMemoryStore(PRODUCT),
        expected_services=["license", "config", "identity"],
        device_name="Ada's Mac",
        **kw,
    )
    c.identity._deps.on_acquired = lambda: None
    c.identity._deps.headless = lambda: False
    c.identity._deps.entropy = {"state": STATE, "code_verifier": VERIFIER}
    opened: List[str] = []
    c.identity._deps.open_url = lambda url: opened.append(url) or True
    c.opened = opened
    return c


def start(c: Any, **opts: Any) -> NativeSignInSession:
    s = c.identity.sign_in.start(channel="redirect", **opts)
    assert isinstance(s, NativeSignInSession)
    return s


def callback_target(s: NativeSignInSession, **over: Optional[str]) -> str:
    path = urlsplit(s.redirect_uri).path
    q: Dict[str, Optional[str]] = {"code": CODE, "state": STATE, "iss": ISS, "request": HANDLE, **over}
    return path + "?" + "&".join(f"{k}={quote(v, safe='')}" for k, v in q.items() if v is not None)


def test_a_loopback_sign_in_binds_before_it_pushes_and_opens_the_browser_last() -> None:
    w = World()
    c = make(w)

    def factory() -> LoopbackListener:
        w.events.append("bind")
        return LoopbackListener()

    c.identity._deps.listener_factory = factory
    c.identity._deps.open_url = lambda url: w.events.append("open") or True
    s = start(c)
    try:
        assert w.events == ["bind", "push", "open"]
        # The pushed redirect URI is the bound port, and the authorize URL carries nothing else.
        form = w.of("/identity/request")[0][2]
        port = urlsplit(s.redirect_uri).port
        assert form["redirect_uri"] == s.redirect_uri == f"http://127.0.0.1:{port}/pkey/callback"
        assert s.authorize_url == authorize_url_for(f"{PB}/identity/authorize", PRODUCT, REQUEST_URI)
        assert s.redirect_class == "loopback"
    finally:
        s.cancel()


def test_a_loopback_sign_in_redeems_the_code_from_the_pushing_device() -> None:
    w = World()
    c = make(w)
    s = start(c)
    port = urlsplit(s.redirect_uri).port
    assert port is not None
    status, headers, body = get(port, callback_target(s))
    assert status == 303
    assert headers["location"] == f"{RETURN_PAGE}?request={HANDLE}"
    assert headers["referrer-policy"] == "no-referrer" and body == b""
    outcome = s.wait(timeout=5)
    assert (outcome.kind, outcome.scope, outcome.subject) == ("signed_in", "profile email", "ps_" + "C" * 22)
    assert c._tokens.current == "pkeyt_native"
    push, token = w.of("/identity/request")[0], w.of("/identity/token")[0]
    # The label rides the push; the token request names the pusher and repeats no label.
    assert push[2]["device_name"] == "Ada's Mac"
    assert token[3]["x-pkey-device"] == push[3]["x-pkey-device"] == c.core.device_id
    assert token[2]["code_verifier"] == VERIFIER and token[2]["code"] == CODE
    assert "device_name" not in token[2]
    assert eventually(lambda: refused(port))  # the listener is gone once the callback was taken
    assert c.opened == [s.authorize_url] and s.opened is True


def test_the_cancel_on_the_card_is_a_cancelled_outcome_and_a_cancelled_return() -> None:
    w = World()
    c = make(w)
    s = start(c)
    port = urlsplit(s.redirect_uri).port
    assert port is not None
    status, headers, _ = get(port, callback_target(s, code=None, error="access_denied"))
    assert status == 303 and headers["location"] == f"{RETURN_PAGE}?request={HANDLE}&cancelled=1"
    assert s.wait(timeout=5).kind == "cancelled"
    assert w.of("/identity/token") == []


def test_a_wrong_state_keeps_the_sign_in_waiting_and_a_wrong_issuer_ends_it() -> None:
    w = World()
    c = make(w)
    s = start(c)
    port = urlsplit(s.redirect_uri).port
    assert port is not None
    for over in ({"state": "another-state-0123456789"}, {"state": None}):
        assert get(port, callback_target(s, **over))[0] == 404
    assert s.wait(once=True).kind == "pending"
    status, _, body = get(port, callback_target(s, iss="https://evil.example/identity"))
    assert status == 404 and body == b""
    with pytest.raises(SignInError) as e:
        s.wait(timeout=5)
    assert e.value.code == ErrorCode.SIGN_IN_FAILED and CODE not in str(e.value)
    assert w.of("/identity/token") == []
    assert eventually(lambda: refused(port))


def test_a_refused_push_closes_the_listener_and_raises_the_workers_code() -> None:
    w = World(push_status=429)
    c = make(w)
    bound: List[LoopbackListener] = []

    def factory() -> LoopbackListener:
        bound.append(LoopbackListener())
        return bound[0]

    c.identity._deps.listener_factory = factory
    with pytest.raises(SignInError) as e:
        start(c)
    assert (e.value.code, e.value.status, e.value.retry_after_seconds) == ("invalid_request", 429, 7)
    assert bound[0].closed and refused(bound[0].port)


def test_headless_and_unserved_hosts_answer_redirect_unavailable_before_any_request() -> None:
    w = World()
    c = make(w)
    c.identity._deps.headless = lambda: True
    bound: List[Any] = []
    c.identity._deps.listener_factory = lambda: bound.append(1)  # type: ignore[func-returns-value]
    with pytest.raises(PolarisError) as e:
        start(c)
    assert e.value.code == ErrorCode.REDIRECT_UNAVAILABLE
    assert w.of("/identity/request") == [] and bound == []
    # Loopback off by the host, no scheme registered.
    c.identity._deps.headless = lambda: False
    with pytest.raises(PolarisError) as e2:
        start(c, loopback=False)
    assert e2.value.code == ErrorCode.REDIRECT_UNAVAILABLE
    # The Worker serves no request endpoint.
    w2 = World(with_request=False)
    c2 = make(w2)
    with pytest.raises(PolarisError) as e3:
        start(c2)
    assert e3.value.code == ErrorCode.REDIRECT_UNAVAILABLE and w2.of("/identity/request") == []


def test_reopen_is_the_same_url_and_never_a_new_push() -> None:
    w = World()
    c = make(w)
    s = start(c)
    try:
        assert s.reopen() is True and s.reopen() is True
        assert c.opened == [s.authorize_url] * 3
        assert len(w.of("/identity/request")) == 1
    finally:
        s.cancel()
    assert s.reopen() is False  # cancelled: nothing to reopen


def test_a_lapsed_request_cannot_be_reopened_and_waits_as_expired(monkeypatch: pytest.MonkeyPatch) -> None:
    w = World()
    c = make(w)
    s = start(c)
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + 601)
    with pytest.raises(PolarisError) as e:
        s.reopen()
    assert e.value.code == ErrorCode.SIGN_IN_EXPIRED
    port = urlsplit(s.redirect_uri).port
    assert s.wait(timeout=1).kind == "expired"
    assert port is not None and eventually(lambda: refused(port))


def test_cancel_closes_the_listener_and_drops_the_verifier() -> None:
    w = World()
    c = make(w)
    s = start(c)
    port = urlsplit(s.redirect_uri).port
    assert port is not None
    s.cancel()
    assert refused(port)
    assert s.wait(timeout=1).kind == "cancelled"
    assert s._pending is None
    with pytest.raises(SignInError):
        s.handle_redirect(f"{s.redirect_uri}?code=x")


def test_a_cancel_token_cancels_the_wait() -> None:
    w = World()
    c = make(w)
    s = start(c)
    token = threading.Event()
    threading.Timer(0.2, token.set).start()
    assert s.wait(timeout=5, cancel_token=token).kind == "cancelled"


def test_a_wait_that_times_out_raises_and_leaves_the_sign_in_alive() -> None:
    w = World()
    c = make(w)
    s = start(c)
    try:
        with pytest.raises(TimeoutError):
            s.wait(timeout=0.2)
        assert not s._closed
    finally:
        s.cancel()


def test_a_new_sign_in_replaces_the_one_waiting() -> None:
    w = World()
    c = make(w)
    first = start(c)
    port = urlsplit(first.redirect_uri).port
    second = start(c)
    try:
        assert port is not None and eventually(lambda: refused(port))
        assert first.wait(timeout=1).kind == "cancelled"
    finally:
        second.cancel()


def scheme_start(c: Any, **opts: Any) -> NativeSignInSession:
    return start(c, loopback=False, registered_schemes=[SCHEME], open_browser=False, **opts)


def test_a_scheme_delivery_is_handled_through_the_namespace() -> None:
    w = World()
    c = make(w)
    s = scheme_start(c, return_uri=SCHEME)
    assert s.redirect_class == "scheme" and s._listener is None
    push = w.of("/identity/request")[0][2]
    assert push["redirect_uri"] == SCHEME and push["return_uri"] == SCHEME
    # Not this sign-in's: refused locally, nothing sent, the sign-in keeps waiting.
    for bad in (
        f"{SCHEME}?code=x&state=nope-nope-nope-nope&iss={quote(ISS, safe='')}",
        "com.other.app:/pkey/callback?code=x",
    ):
        with pytest.raises(SignInError):
            c.identity.sign_in.handle_redirect(bad)
    assert w.of("/identity/token") == [] and not s._closed
    good = f"{SCHEME}?code={CODE}&state={STATE}&iss={quote(ISS, safe='')}"
    outcome = c.identity.sign_in.handle_redirect(good)
    assert outcome.kind == "signed_in" and s.wait(once=True).kind == "signed_in"
    assert len(w.of("/identity/token")) == 1
    # Single use: the same delivery again is refused without a request.
    with pytest.raises(SignInError):
        c.identity.sign_in.handle_redirect(good)
    assert len(w.of("/identity/token")) == 1


def test_handle_redirect_with_no_sign_in_waiting_is_sign_in_failed() -> None:
    c = make(World())
    with pytest.raises(SignInError) as e:
        c.identity.sign_in.handle_redirect(f"{SCHEME}?code=x")
    assert e.value.code == ErrorCode.SIGN_IN_FAILED


def test_the_worker_refusing_the_code_is_raised_under_its_own_code() -> None:
    w = World()
    w.token_answer = (400, {"error": "invalid_grant"})
    c = make(w)
    s = scheme_start(c)
    with pytest.raises(SignInError) as e:
        s.handle_redirect(f"{SCHEME}?code={CODE}&state={STATE}&iss={quote(ISS, safe='')}")
    assert e.value.code == "invalid_grant" and CODE not in str(e.value)
    assert c._tokens.current is None


def test_a_license_choice_comes_back_as_choose() -> None:
    w = World()
    grant = "sg_" + "A" * 43
    w.token_answer = (200, {"status": "choose", "grant": grant, "expiresIn": 300, "choices": {"state": "choose"}})
    doc = w.doc()
    ep = doc["services"]["identity"]["endpoints"]
    for k in ("choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel"):
        ep[k] = f"{PB}/identity/choice/{k}"
    w.doc = lambda: doc  # type: ignore[method-assign]
    c = make(w)
    s = scheme_start(c, license_choice="app")
    assert w.of("/identity/request")[0][2]["license_choice"] == "app"
    out = s.handle_redirect(f"{SCHEME}?code={CODE}&state={STATE}&iss={quote(ISS, safe='')}")
    assert (out.kind, out.grant, out.expires_in) == ("choose", grant, 300)
    assert grant not in repr(out) and c._tokens.current is None


def test_the_session_repr_holds_no_secret() -> None:
    c = make(World())
    s = scheme_start(c)
    text = repr(s) + repr(s._pending)
    assert VERIFIER not in text and STATE not in text
    s.cancel()


def test_a_foreign_return_page_is_refused_before_any_request() -> None:
    w = World()
    doc = w.doc()
    doc["services"]["identity"]["endpoints"]["signinReturn"] = "https://evil.example/signin/return"
    w.doc = lambda: doc  # type: ignore[method-assign]
    c = make(w)
    with pytest.raises(PolarisError) as e:
        start(c)
    assert e.value.code == ErrorCode.INVALID_OPTIONS and w.of("/identity/request") == []


def test_the_listener_logs_nothing_when_a_handler_fails(capfd: pytest.CaptureFixture[str]) -> None:
    def boom(url: str) -> Tuple[Optional[str], bool]:
        raise RuntimeError(f"secret {url}")

    listener = LoopbackListener()
    listener.start(boom)
    try:
        try:
            get(listener.port, f"/pkey/callback?state=right&code={CODE}")
        except Exception:
            pass
    finally:
        listener.close()
    out, err = capfd.readouterr()
    assert out == "" and err == "" and CODE not in out + err


def test_binding_does_not_ask_the_resolver(monkeypatch: pytest.MonkeyPatch) -> None:
    def no(*a: Any, **k: Any) -> str:
        raise AssertionError("getfqdn called")

    monkeypatch.setattr(socket, "getfqdn", no)
    listener = LoopbackListener()
    listener.close()


def test_concurrent_starts_leave_one_waiting_session() -> None:
    w = World()
    c = make(w)
    made: List[NativeSignInSession] = []
    ts = [
        threading.Thread(target=lambda: made.append(start(c, loopback=False, registered_schemes=[SCHEME])))
        for _ in range(4)
    ]
    for t in ts:
        t.start()
    for t in ts:
        t.join(5)
    live = [s for s in made if not s._closed]
    assert len(made) == 4 and len(live) == 1 and c.identity._native_active is live[0]
    live[0].cancel()
