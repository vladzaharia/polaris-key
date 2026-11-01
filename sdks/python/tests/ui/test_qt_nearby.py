# @pkey-feature identity.nearby
# @pkey-feature ui.signin
"""Nearby sign-in in the Qt kit (I-47.14; plans/I-47-slices.md D-5, D-6), offscreen over fake clients.

D (the gate): Sign in looks for the person's other devices first (a lone approver chosen after 3 s, several
listed, none within 2 s hands over to the regular sign-in), the code to tap is shown, the account is confirmed
after the poll signed in ("Not you?" signs out), and macOS names the Local Network prompt first. M (the
approval): a device asks, the three codes are buttons and Deny the other, the license is chosen by button,
the advert stands only while the screen is open, and the entry is in the account pane. Every label from the
other device is display data from an unverified peer, drawn as text."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional

import pytest

pytest.importorskip("PySide6.QtQuick")

from polaris_key.core.errors import PolarisError
from polaris_key.identity.sign_in import SignedInIdentity, SignInOutcome
from polaris_key.ui.core.copy import Copy
from polaris_key.ui.core.theme import Theme
from polaris_key.ui.core.ui_contract import context_of
from polaris_key.ui.core import ui_signin
from polaris_key.ui.qt.account import AccountPage
from polaris_key.ui.qt.gate import run_gate
from polaris_key.ui.qt.layout import build_spec
from polaris_key.ui.qt.nearby import Approver, ForegroundApprover, NearbyApprovalPage
from qt_fixtures import TIDEWATER, FakeSource, with_defaults

COPY = Copy("en", platform="desktop")


def pump(app: Any, until: Callable[[], bool], timeout: float = 4.0) -> None:
    """Run the event loop until ``until()`` (a worker thread's result arrives on it), or fail."""
    deadline = time.monotonic() + timeout
    while not until():
        app.processEvents()
        time.sleep(0.003)
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting for the GUI thread to see the result")
    app.processEvents()


# ── the layout (pure) ──────────────────────────────────────────────────────────────────────────


def _spec(view: Any, **kw: Any) -> Any:
    return build_spec(view, COPY, product="Tidewater Studio", **kw)


def plain(text: str) -> str:
    """``text`` without the bidi isolates the kit puts round presentation text (FSI ... PDI)."""
    return text.replace("\u2068", "").replace("\u2069", "")


def _approval(step: str, **n: Any) -> Any:
    data = with_defaults({"nearbyApproval": {"step": step, **n}})
    return ui_signin.nearby_approval_view(context_of(data))


def test_ask_draws_the_three_codes_as_buttons_and_deny_is_the_other() -> None:
    spec = _spec(_approval("ask", device="Kitchen iPad", codes=["111 111", "482 913", "777 777"]))
    assert plain(spec.title) == "Let Kitchen iPad sign in?"
    assert [b.key for b in spec.buttons] == ["nearby.code.1", "nearby.code.2", "nearby.code.3", "signin.approve.deny"]
    assert [b.text for b in spec.buttons[:3]] == ["111 111", "482 913", "777 777"]
    # Choosing the matching code is the action: none is filled. Deny is a text control apart from the codes
    # (UXR-47 N6), and the codes are in the mono face like the requester's tile.
    assert [b.role for b in spec.buttons] == ["secondary", "secondary", "secondary", "quiet"]
    assert [b.mono for b in spec.buttons] == [True, True, True, False]


def test_choose_draws_the_licenses_and_a_new_one_and_has_no_second_step() -> None:
    spec = _spec(_approval("choose", device="Kitchen iPad", choices=["Pro", "Harbor Audio team"], create=True))
    # One tap per license, then Deny: leaving the choice answers Deny, as at the codes (UXR-47 B1).
    assert [b.key for b in spec.buttons] == ["nearby.choice.1", "nearby.choice.2", "nearby.choice.create", "signin.approve.deny"]
    assert spec.buttons[2].text == COPY("signin.choice.create") and "Use this license" not in [b.text for b in spec.buttons]
    assert COPY("common.cancel") not in [b.text for b in spec.buttons]


def test_an_unnamed_device_is_the_new_device_in_a_sentence_and_at_its_start() -> None:
    assert plain(_spec(_approval("approved")).title) == "The new device is signed in"
    assert plain(_spec(_approval("not-nearby")).title) == "The new device isn't on this network"
    assert "the new device" in plain(" ".join(_spec(_approval("not-nearby")).body))


def test_the_nearby_wait_shows_its_code_in_the_code_block_with_a_code_instead() -> None:
    wait = ui_signin.sign_in_view(context_of(with_defaults({"signIn": {"presentation": "inline", "replace": "browser", "channel": "browser"}, "autoSignIn": {"step": "nearby-wait", "code": "482 913"}})))
    spec = _spec(wait)
    assert spec.code is not None and spec.code.value == "482 913" and spec.progress == -1.0
    # The person's job is on the other device: the way out of nearby is a text control, never the filled one (B4).
    assert [b.text for b in spec.buttons] == [COPY("signin.nearby.code")] and spec.buttons[0].role == "quiet"
    # No second label over the code tile (B3), and the wait says what it waits for.
    assert spec.code.label == "" and spec.progress_label == COPY("signin.cli.nearbyWaiting")


def test_several_approvers_are_buttons_before_a_code_is_chosen() -> None:
    wait = ui_signin.sign_in_view(context_of(with_defaults({"signIn": {"presentation": "inline", "replace": "browser", "channel": "browser"}, "autoSignIn": {"step": "nearby-wait", "approvers": ["Ana's laptop", "Ben's phone"]}})))
    spec = _spec(wait)
    assert [b.key for b in spec.buttons if b.key.startswith("nearby.pick.")] == ["nearby.pick.1", "nearby.pick.2"]
    assert spec.code is None and "Ana's laptop" in [plain(b.text) for b in spec.buttons]


def test_the_account_menu_entry_is_a_secondary_button() -> None:
    from polaris_key.ui.core.ui_settings import account_view

    from polaris_key.ui.qt.account import _replace_copy

    view = account_view(context_of(with_defaults({"account": {"signedIn": True, "holder": "Ada"}})))
    view = _replace_copy(view, view.copy + ("signin.nearby.menu",))
    entry = [b for b in _spec(view).buttons if b.key == "signin.nearby.menu"]
    assert [(b.text, b.role) for b in entry] == [("Approve a nearby device", "secondary")]


# ── the fakes ──────────────────────────────────────────────────────────────────────────────────


def approver(id_: str = "a1", label: Optional[str] = "Ana's laptop", platform: str = "macos") -> SimpleNamespace:
    return SimpleNamespace(id=id_, label=label, platform=platform)


class FakeNearbySession:
    """``identity.sign_in.start(channel="nearby")``'s session: ``approvers`` is what the LAN half has listed,
    ``choose`` shows the code, and ``wait`` ends when the test says so (the person tapped, or not)."""

    channel = "nearby"

    def __init__(self, client: Any, approvers: Any = ()) -> None:
        self.client = client
        self.approvers = list(approvers)
        self.code: Optional[str] = None
        self.chosen: List[str] = []
        self.confirmed = 0
        self.declined = 0
        self.cancelled = False
        self.closed = False
        #: The session ended unconfirmed (the 300 s deadline, a decline from elsewhere).
        self.ended = False
        #: ``confirm_account`` raises this (the deadline passed first).
        self.confirm_error: Optional[BaseException] = None
        self.finish = threading.Event()
        self.result: Any = SignInOutcome(kind="signed_in", identity=SignedInIdentity("Ada", "ada@example.com"))

    def choose(self, approver_id: str) -> str:
        self.chosen.append(approver_id)
        self.code = "482 913"
        return self.code

    def cancel(self) -> None:
        self.cancelled = True

    def close(self) -> None:
        self.closed = True

    def confirm_account(self) -> None:
        if self.confirm_error is not None:
            raise self.confirm_error
        self.confirmed += 1

    def decline_account(self) -> None:
        self.declined += 1

    def wait(self, timeout: Any = None, *, once: bool = False, cancel_token: Optional[threading.Event] = None) -> Any:
        cancel = cancel_token if cancel_token is not None else threading.Event()
        while not (self.finish.is_set() or cancel.is_set() or self.cancelled):
            time.sleep(0.005)
        if cancel.is_set() or self.cancelled:
            return SignInOutcome(kind="cancelled")
        if isinstance(self.result, BaseException):
            raise self.result
        if self.result.kind == "signed_in":
            self.client.st = "ok"
        return self.result


class FakeIdentity:
    def __init__(self, client: Any, *, available: bool = True, start_error: Optional[BaseException] = None) -> None:
        self.client = client
        self.session: Optional[FakeNearbySession] = None
        self.start_error = start_error
        self.device_code_begun = 0
        self.available_calls: List[str] = []
        self.nearby = SimpleNamespace(available=self._available)
        self.sign_in = SimpleNamespace(start=self._start)
        self._available_value = available

    def _available(self, *, role: str) -> bool:
        self.available_calls.append(role)
        return self._available_value

    def _start(self, channel: str = "device-code", **opts: Any) -> Any:
        if channel == "nearby":
            if self.start_error is not None:
                raise self.start_error
            self.session = FakeNearbySession(self.client)
            return self.session
        self.device_code_begun += 1
        return SimpleNamespace(
            user_code="WDJB-MJHT",
            verification_uri="https://polaris.locker/device",
            verification_uri_complete="https://polaris.locker/device?user_code=WDJB-MJHT",
            expires_in=600,
            interval=5,
            expires_at=int(time.time()) + 600,
            wait=lambda timeout=None, *, once=False, confirm=None, cancel_token=None: (cancel_token.wait(5) if cancel_token is not None else None, SignInOutcome(kind="cancelled"))[1],
        )


class FakeClient:
    def __init__(self, **kw: Any) -> None:
        self.st = "needs-activation"
        self.presentation_source = FakeSource(TIDEWATER)
        self.core = SimpleNamespace(enabled=lambda slug: slug in ("license", "config", "identity"))
        self.license = SimpleNamespace(
            activate_with_key=lambda key: SimpleNamespace(kind="ok"),
            license_info=lambda: SimpleNamespace(tier="pro", tierLabel="Pro", deviceLimit=3, entitledChannels=["stable"]),
        )
        self.identity = FakeIdentity(self, **kw)

    def status(self, now: Any = None) -> Any:
        return SimpleNamespace(status=self.st)


class Rig:
    """A gate over a fake client; the nearby windows count on a clock the test moves."""

    def __init__(self, app: Any, client: FakeClient, os_name: str = "linux") -> None:
        self.app = app
        self.client = client
        self.opened: List[int] = []
        self.clock = [1000.0]
        self.gate = run_gate(
            client, None, theme=Theme(color_scheme="dark", platform="gnome"), size=(480, 720), on_open=lambda: self.opened.append(1), open_url=lambda url: True
        )
        self.gate.flow._clock = lambda: self.clock[0]
        self.gate.flow._os = os_name
        # The 200 ms timer is not what is under test: the tests call the tick themselves.
        self.gate.flow._nearby_timer.stop()
        self.gate.flow._nearby_timer.timeout.disconnect()

    @property
    def spec(self) -> Any:
        return self.gate.kit.bridge.screen_spec

    @property
    def shown(self) -> str:
        return f"{self.gate.screen.component}.{self.gate.screen.state}"

    def press(self, key: str, action: str = "") -> None:
        self.gate.kit.bridge.invoke(key, action)
        self.app.processEvents()

    def until(self, shown: str, timeout: float = 4.0) -> None:
        pump(self.app, lambda: self.shown == shown, timeout)

    def started(self) -> Any:
        """The nearby session the gate started (its start came back on the GUI thread)."""
        pump(self.app, lambda: self.gate.flow.session is not None and self.gate.flow.session.nearby is not None)
        return self.client.identity.session

    def tick(self, seconds: float = 0.0) -> None:
        self.clock[0] += seconds
        self.gate.flow._nearby_tick()
        self.app.processEvents()

    def texts(self) -> List[str]:
        return [b.text for b in self.spec.buttons]

    def close(self) -> None:
        self.gate.close()


@pytest.fixture
def rig(kit_app):
    made: List[Rig] = []

    def make(client: Optional[FakeClient] = None, **kw: Any) -> Rig:
        r = Rig(kit_app, client or FakeClient(), **kw)
        made.append(r)
        return r

    yield make
    for r in made:
        r.close()


# ── D: the gate's sign-in ──────────────────────────────────────────────────────────────────────


def test_a_lone_approver_is_chosen_after_3_s_its_code_is_shown_and_continue_confirms_the_account(rig):
    r = rig()
    r.press("welcome.signIn")
    r.until("SignInHandoff.starting")
    session = r.started()
    assert r.client.identity.available_calls == ["requester"] and session is not None
    session.approvers = [approver()]
    r.tick()  # the approver answers: its 3 s start here, and its row shows meanwhile (UXR-47 N1)
    assert r.shown == "SignIn.nearby-wait" and [b.key for b in r.spec.buttons if b.key.startswith("nearby.pick.")] == ["nearby.pick.1"]
    r.tick(2.9)
    assert session.chosen == [] and r.shown == "SignIn.nearby-wait"  # the 3 s window has not ended
    r.tick(0.2)
    pump(r.app, lambda: session.chosen == ["a1"] and r.spec.code is not None)
    assert session.chosen == ["a1"] and r.spec.code.value == "482 913"
    assert any("on Ana's laptop." in plain(b) for b in r.spec.body)  # the code screen names the device (N1)
    assert r.texts() == [COPY("common.cancel"), COPY("signin.nearby.code")]
    session.finish.set()  # the person tapped the code on the other device
    r.until("SignIn.nearby-done")
    assert plain(r.spec.title) == "Signed in as ada@example.com" and COPY("signin.nearby.notYou") in r.texts()
    assert session.confirmed == 0 and not r.gate.open  # nothing from the other device is acted on until confirmed
    r.press("common.continue")
    pump(r.app, lambda: r.gate.open)
    assert (session.confirmed, session.declined) == (1, 0) and session.closed and r.opened


def test_none_within_2_s_cancels_nearby_and_shows_the_regular_sign_in(rig):
    r = rig()
    r.press("welcome.signIn")
    r.until("SignInHandoff.starting")
    session = r.started()
    r.tick(1.9)
    assert r.shown == "SignInHandoff.starting" and not session.cancelled
    r.tick(0.2)
    assert session.cancelled and r.shown == "SignIn.methods"
    assert COPY("signin.desktop.continue") in r.texts()


def test_several_approvers_are_listed_and_picked_by_number(rig):
    r = rig()
    r.press("welcome.signIn")
    r.until("SignInHandoff.starting")
    session = r.started()
    session.approvers = [approver("a1", "Ana's laptop"), approver("a2", "Ben's phone", "ios")]
    r.tick(5)  # no automatic choice with two to pick from
    assert r.shown == "SignIn.nearby-wait" and session.chosen == [] and r.spec.code is None
    assert [b.key for b in r.spec.buttons if b.key.startswith("nearby.pick.")] == ["nearby.pick.1", "nearby.pick.2"]
    r.press("nearby.pick.2")
    pump(r.app, lambda: r.spec.code is not None)
    assert session.chosen == ["a2"]


def test_use_a_code_instead_cancels_nearby_and_runs_the_device_code_sign_in(rig):
    r = rig()
    r.press("welcome.signIn")
    r.until("SignInHandoff.starting")
    session = r.started()
    session.approvers = [approver()]
    r.tick()
    r.tick(3.1)
    pump(r.app, lambda: r.shown == "SignIn.nearby-wait")
    r.press("signin.nearby.code")
    assert session.cancelled
    pump(r.app, lambda: r.client.identity.device_code_begun == 1)


def test_not_you_drops_the_records_and_signs_out(rig):
    r = rig()
    r.press("welcome.signIn")
    r.until("SignInHandoff.starting")
    session = r.started()
    session.approvers = [approver()]
    r.tick()
    r.tick(3.1)
    pump(r.app, lambda: r.shown == "SignIn.nearby-wait")
    session.finish.set()
    r.until("SignIn.nearby-done")
    r.press("signin.nearby.notYou")
    pump(r.app, lambda: r.shown == "Welcome.default")
    assert (session.declined, session.confirmed) == (1, 0) and not r.gate.open


def _at_the_confirm_screen(r: Any) -> Any:
    r.press("welcome.signIn")
    r.until("SignInHandoff.starting")
    session = r.started()
    session.approvers = [approver()]
    r.tick()
    r.tick(3.1)
    pump(r.app, lambda: r.shown == "SignIn.nearby-wait")
    session.finish.set()
    r.until("SignIn.nearby-done")
    return session


def test_continue_after_the_deadline_shows_expired_and_never_reports_a_sign_in(rig):
    r = rig()
    session = _at_the_confirm_screen(r)
    signed_in: List[Any] = []
    r.gate.flow.on_signed_in = signed_in.append
    session.confirm_error = PolarisError("sign-in-failed", "The sign-in ended before it was confirmed.")
    r.press("common.continue")
    pump(r.app, lambda: r.shown != "SignIn.nearby-done")
    assert signed_in == [] and not r.gate.open and not r.opened
    assert session.confirmed == 0 and r.shown != "Welcome.default"


def test_the_confirm_screen_leaves_when_the_session_ends(rig):
    r = rig()
    session = _at_the_confirm_screen(r)
    session.ended = True
    r.tick()
    assert r.shown != "SignIn.nearby-done" and not r.gate.open


def test_leaving_the_confirm_screen_by_any_route_cancels_the_session(rig):
    r = rig()
    session = _at_the_confirm_screen(r)
    r.gate.flow._stop_session()  # back, closing the window: every route ends in this
    pump(r.app, lambda: session.cancelled)
    assert session.confirmed == 0


def test_a_refused_poll_is_the_sign_in_s_own_refusal(rig):
    r = rig()
    r.press("welcome.signIn")
    r.until("SignInHandoff.starting")
    session = r.started()
    session.result = PolarisError("sign-in-denied", "refused")
    session.approvers = [approver()]
    r.tick()
    r.tick(3.1)
    pump(r.app, lambda: r.shown == "SignIn.nearby-wait")
    session.finish.set()
    r.until("SignInHandoff.denied")


@pytest.mark.parametrize("make", [lambda: FakeClient(available=False), lambda: FakeClient(start_error=PolarisError("nearby-unsupported", "no"))], ids=["not on offer", "unsupported"])
def test_where_nearby_is_not_on_offer_or_cannot_start_the_regular_sign_in_shows(rig, make):
    r = rig(make())
    r.press("welcome.signIn")
    r.until("SignIn.methods")


def test_a_client_with_no_nearby_signs_in_as_before(rig):
    client = FakeClient()
    del client.identity.nearby
    r = rig(client)
    r.press("welcome.signIn")
    assert r.shown == "SignIn.methods" and client.identity.session is None


def test_macos_explains_the_local_network_prompt_first_and_remembers_a_browse(rig, tmp_path: Path):
    client = FakeClient()
    client.core.dirs = SimpleNamespace(state=str(tmp_path))
    r = rig(client, os_name="darwin")
    r.press("welcome.signIn")
    r.until("SignIn.nearby-prompt")
    assert r.spec.title == "Sign in with your phone" and client.identity.session is None
    assert [b.text for b in r.spec.buttons][:2] == [COPY("common.continue"), COPY("common.notNow")]
    r.press("common.continue")
    r.until("SignInHandoff.starting")
    pump(r.app, lambda: (tmp_path / "nearby-browsed").exists())
    # The next sign-in starts at once.
    r.press("common.cancel")
    r.press("welcome.signIn")
    r.until("SignInHandoff.starting")


def test_not_now_goes_to_the_regular_sign_in_and_browses_nothing(rig, tmp_path: Path):
    client = FakeClient()
    client.core.dirs = SimpleNamespace(state=str(tmp_path))
    r = rig(client, os_name="darwin")
    r.press("welcome.signIn")
    r.until("SignIn.nearby-prompt")
    r.press("common.notNow")
    assert r.shown == "SignIn.methods" and client.identity.session is None and not (tmp_path / "nearby-browsed").exists()


# ── M: the approval ────────────────────────────────────────────────────────────────────────────


class FakeAsk:
    def __init__(self, step: Any = None, *, device: Optional[str] = "New phone") -> None:
        self.device = device
        self.platform = "linux"
        self.codes = ["111 111", "482 913", "777 777"]
        self.picks: List[str] = []
        self.denied = 0
        self._step = step if step is not None else SimpleNamespace(kind="approved")

    def pick(self, code: str) -> Any:
        self.picks.append(code)
        return self._step

    def deny(self) -> Any:
        self.denied += 1
        return SimpleNamespace(kind="denied")


class FakeApproverClient:
    """A signed-in client whose ``identity.nearby.on_request`` hands ``ask`` to the handler, and records the
    advert: its options, and ``stop`` / ``pause`` / ``resume`` / ``set_prompt``."""

    def __init__(self, ask: Optional[FakeAsk] = None, *, available: bool = True, error: Optional[BaseException] = None) -> None:
        self.presentation_source = FakeSource(TIDEWATER)
        self.core = SimpleNamespace(enabled=lambda slug: slug in ("license", "config", "identity"))
        self.license = SimpleNamespace(license_info=lambda: SimpleNamespace(tier="pro", tierLabel="Pro", deviceLimit=3, entitledChannels=["stable"]))
        self.calls: List[str] = []
        self.options: Dict[str, Any] = {}
        self.ask = ask
        self.error = error

        def on_request(handler: Any, **opts: Any) -> Any:
            self.calls.append("on_request")
            self.options = opts
            if self.error is not None:
                raise self.error
            self.handler = handler
            if self.ask is not None and opts.get("prompt"):
                handler(self.ask)
            return SimpleNamespace(
                stop=lambda: self.calls.append("stop"),
                pause=lambda: self.calls.append("pause"),
                resume=lambda: self.calls.append("resume"),
                set_prompt=lambda open_: self.calls.append(f"set_prompt:{open_}"),
            )

        self.identity = SimpleNamespace(
            nearby=SimpleNamespace(available=lambda *, role: available, on_request=on_request),
            current=lambda: {"name": "Ada", "email": "ada@example.com"},
            sign_out=lambda: None,
        )

    def status(self, now: Any = None) -> Any:
        return SimpleNamespace(status="ok")


@pytest.fixture
def page(kit_app):
    made: List[NearbyApprovalPage] = []

    def make(client: FakeApproverClient, **kw: Any) -> NearbyApprovalPage:
        p = NearbyApprovalPage(client, theme=Theme(color_scheme="dark", platform="gnome"), **kw)
        made.append(p)
        return p

    yield make
    for p in made:
        p.close()


def shown(p: NearbyApprovalPage) -> str:
    return f"{p.screen.component}.{p.screen.state}"


def test_a_device_asks_its_codes_are_buttons_and_a_pick_approves_and_stops_the_advert(kit_app, page):
    ask = FakeAsk()
    client = FakeApproverClient(ask)
    p = page(client)
    pump(kit_app, lambda: shown(p) == "NearbyApproval.ask")
    spec = p.kit.bridge.screen_spec
    assert plain(spec.title) == "Let New phone sign in?" and [b.text for b in spec.buttons[:3]] == ask.codes
    assert client.options["prompt"] is True and client.options.get("background") is False  # open only while the screen is
    p.kit.bridge.invoke("nearby.code.2", "")
    pump(kit_app, lambda: shown(p) == "NearbyApproval.approved")
    assert ask.picks == ["482 913"] and plain(p.kit.bridge.screen_spec.title) == "New phone is signed in"
    assert client.calls[-1] == "stop"  # an outcome stops the advert
    p.kit.bridge.invoke("common.done", "")
    kit_app.processEvents()
    assert p._closed  # Done ends the page


def test_deny_never_picks_and_cancel_stops_the_advert(kit_app, page):
    ask = FakeAsk()
    client = FakeApproverClient(ask)
    p = page(client)
    pump(kit_app, lambda: shown(p) == "NearbyApproval.ask")
    p.kit.bridge.invoke("signin.approve.deny", "")
    pump(kit_app, lambda: shown(p) == "NearbyApproval.denied")
    assert ask.picks == [] and ask.denied == 1 and client.calls[-1] == "stop"
    waiting = FakeApproverClient(None)
    q = page(waiting)
    assert shown(q) == "NearbyApproval.entry" and waiting.calls == ["on_request"]
    q.kit.bridge.invoke("common.cancel", "")
    kit_app.processEvents()
    assert waiting.calls == ["on_request", "stop"]


def test_leaving_the_codes_or_the_license_choice_answers_deny(kit_app, page):
    """UXR-47 B1: one rule for every kit. Closing the page at the codes denies (no route), and at the license
    choice it is the answer's own cancel, so the new device is not left waiting until the request expires."""
    ask = FakeAsk()
    p = page(FakeApproverClient(ask))
    pump(kit_app, lambda: shown(p) == "NearbyApproval.ask")
    p.close()
    assert ask.denied == 1 and ask.picks == []
    cancelled: List[int] = []
    view = {"choices": [{"id": "lic_1", "tierName": "Pro", "name": None, "state": "free"}], "create": None}
    step = SimpleNamespace(kind="choose", choices=view, choose=lambda c: SimpleNamespace(kind="approved"), cancel=lambda: (cancelled.append(1), SimpleNamespace(kind="denied"))[1])
    q = page(FakeApproverClient(FakeAsk(step)))
    pump(kit_app, lambda: shown(q) == "NearbyApproval.ask")
    q.kit.bridge.invoke("nearby.code.1", "")
    pump(kit_app, lambda: shown(q) == "NearbyApproval.choose")
    q.close()
    pump(kit_app, lambda: cancelled == [1])


def test_the_waiting_entry_says_what_it_waits_for_and_outcomes_carry_a_mark(kit_app, page):
    """UXR-47 N5 and N7: the entry has a waiting line and the busy indicator; an outcome has its tone."""
    q = page(FakeApproverClient(None))
    spec = q.kit.bridge.screen_spec
    assert COPY("signin.cli.approveWaiting") in spec.body and spec.progress == -1.0
    assert [b.text for b in spec.buttons] == [COPY("common.cancel")]
    for kind, mark in (("approved", "ok"), ("mismatch", "warn"), ("expired", "warn"), ("denied", "")):
        p = page(FakeApproverClient(FakeAsk(SimpleNamespace(kind=kind))))
        pump(kit_app, lambda: shown(p) == "NearbyApproval.ask")
        p.kit.bridge.invoke("nearby.code.1", "")
        pump(kit_app, lambda k=kind: shown(p) == f"NearbyApproval.{k}")
        assert p.kit.bridge.screen_spec.title_mark == mark
    mismatch = page(FakeApproverClient(FakeAsk(SimpleNamespace(kind="mismatch"))))
    pump(kit_app, lambda: shown(mismatch) == "NearbyApproval.ask")
    mismatch.kit.bridge.invoke("nearby.code.1", "")
    pump(kit_app, lambda: shown(mismatch) == "NearbyApproval.mismatch")
    assert "Start again on New phone." in [plain(b) for b in mismatch.kit.bridge.screen_spec.body]


def test_the_license_choice_is_buttons_and_the_last_row_creates_one(kit_app, page):
    chosen: List[Any] = []
    view = {
        "choices": [{"id": "lic_1", "tierName": "Pro", "name": None, "state": "free"}, {"id": "lic_2", "tierName": "Team", "name": "Harbor team", "state": "free"}, {"id": "lic_3", "tierName": "Full", "name": "Full", "state": "full"}],
        "create": {"tierName": "Pro", "access": "account"},
    }
    step = SimpleNamespace(
        kind="choose",
        choices=view,
        choose=lambda c: (chosen.append(c), SimpleNamespace(kind="approved"))[1],
        cancel=lambda: SimpleNamespace(kind="denied"),
    )
    p = page(FakeApproverClient(FakeAsk(step)))
    pump(kit_app, lambda: shown(p) == "NearbyApproval.ask")
    p.kit.bridge.invoke("nearby.code.1", "")
    pump(kit_app, lambda: shown(p) == "NearbyApproval.choose")
    labels = [plain(b.text) for b in p.kit.bridge.screen_spec.buttons]
    assert labels[:3] == ["Pro", "Harbor team", COPY("signin.choice.create")] and "Full" not in labels  # a full license cannot be given
    p.kit.bridge.invoke("nearby.choice.2", "")
    pump(kit_app, lambda: shown(p) == "NearbyApproval.approved")
    assert chosen == [{"kind": "license", "licenseId": "lic_2"}]


@pytest.mark.parametrize("kind,state", [("mismatch", "mismatch"), ("not-nearby", "not-nearby"), ("expired", "expired"), ("rate-limited", "rate-limited"), ("device-limit", "device-limit"), ("account-required", "account-required")])
def test_each_outcome_has_its_own_screen(kit_app, page, kind, state):
    p = page(FakeApproverClient(FakeAsk(SimpleNamespace(kind=kind))))
    pump(kit_app, lambda: shown(p) == "NearbyApproval.ask")
    p.kit.bridge.invoke("nearby.code.3", "")
    pump(kit_app, lambda: shown(p) == f"NearbyApproval.{state}")


def test_a_hostile_device_name_is_text_and_an_unsupported_runtime_is_said(kit_app, page):
    evil = "Evil\x1b]52;c;ZXZpbA==\x07 ‮phone\x1b[2J"
    p = page(FakeApproverClient(FakeAsk(device=evil)))
    pump(kit_app, lambda: shown(p) == "NearbyApproval.ask")
    title = plain(p.kit.bridge.screen_spec.title)
    assert "Evil" in title and "\x1b" not in title and "‮" not in title and "\x07" not in title
    q = page(FakeApproverClient(error=PolarisError("account_required", "signed out")))
    assert shown(q) == "NearbyApproval.account-required"


def test_the_foreground_advert_runs_with_the_prompt_closed_and_opens_with_the_screen(kit_app):
    notices: List[Any] = []
    client = FakeApproverClient(FakeAsk())
    fg = ForegroundApprover(client, on_notice=notices.append)
    try:
        assert fg.start() and client.options["prompt"] is False and client.options["background"] is True
        client.options["on_notice"]("a device wants to sign in")
        assert notices == ["a device wants to sign in"]
        got: List[Any] = []
        fg.prompt(got.append)
        assert client.calls[-1] == "set_prompt:True"
        client.handler("ask")
        assert got == ["ask"]
        fg.leave()  # the background advert stays up with its prompt closed
        assert client.calls[-1] == "set_prompt:False" and fg.active
        fg._state(kit_app.applicationState().__class__.ApplicationInactive)
        assert client.calls[-1] == "pause"
        fg._state(kit_app.applicationState().__class__.ApplicationActive)
        assert client.calls[-1] == "resume"
    finally:
        fg.close()
    assert client.calls[-1] == "stop"


def test_the_account_pane_offers_the_entry_and_runs_the_approval_in_place(kit_app):
    ask = FakeAsk()
    client = FakeApproverClient(ask)
    acct = AccountPage(client, theme=Theme(color_scheme="dark", platform="gnome"))
    try:
        pump(kit_app, lambda: any(b.key == "signin.nearby.menu" for b in acct.kit.bridge.screen_spec.buttons))
        acct.kit.bridge.invoke("signin.nearby.menu", "")
        pump(kit_app, lambda: acct.screen is not None and acct.screen.component == "NearbyApproval" and acct.screen.state == "ask")
        acct.kit.bridge.invoke("nearby.code.2", "")
        pump(kit_app, lambda: acct.screen.state == "approved")
        assert ask.picks == ["482 913"]
        acct.kit.bridge.invoke("common.done", "")
        pump(kit_app, lambda: acct.screen.component == "AccountAndLicense")
        assert client.calls[-1] == "stop"
    finally:
        acct.close()


def test_the_account_pane_has_no_entry_where_it_is_not_on_offer(kit_app):
    acct = AccountPage(FakeApproverClient(available=False), theme=Theme(color_scheme="dark", platform="gnome"))
    try:
        for _ in range(20):
            kit_app.processEvents()
            time.sleep(0.005)
        assert not any(b.key == "signin.nearby.menu" for b in acct.kit.bridge.screen_spec.buttons)
    finally:
        acct.close()


def test_leaving_the_approval_pane_stops_the_advert(kit_app):
    client = FakeApproverClient(None)
    acct = AccountPage(client, theme=Theme(color_scheme="dark", platform="gnome"))
    try:
        pump(kit_app, lambda: any(b.key == "signin.nearby.menu" for b in acct.kit.bridge.screen_spec.buttons))
        acct.kit.bridge.invoke("signin.nearby.menu", "")
        kit_app.processEvents()
        assert client.calls == ["on_request"]
        acct.show_section("devices")
        assert client.calls == ["on_request", "stop"]
    finally:
        acct.close()


# ── baselines of the screens the matrix cannot carry (the host's data) ─────────────────────────


def _grab(kit_app: Any, view: Any, scheme: str) -> Any:
    from polaris_key.ui.qt.kit import KitView

    kit = KitView(Theme(color_scheme=scheme, platform="gnome"), source=FakeSource(TIDEWATER), size=(480, 560), loading_delay_ms=0)
    try:
        kit.set_view(view)
        return kit.grab()
    finally:
        kit.close()


def _wait_pick() -> Any:
    sign = {"presentation": "inline", "replace": "browser", "channel": "browser"}
    auto = {"step": "nearby-wait", "approvers": ["Ana's laptop", "Ben's phone"]}
    return ui_signin.sign_in_view(context_of(with_defaults({"signIn": sign, "autoSignIn": auto})))


@pytest.mark.parametrize("scheme", ["dark", "light"])
@pytest.mark.parametrize(
    "name,make",
    [
        ("nearbyapproval-ask-codes", lambda: _approval("ask", device="Kitchen iPad", codes=["111 111", "482 913", "777 777"])),
        ("nearbyapproval-choose-licenses", lambda: _approval("choose", device="Kitchen iPad", choices=["Pro", "Harbor Audio team"], create=True)),
        ("signin-nearby-wait-pick", _wait_pick),
    ],
    ids=["ask-codes", "choose-licenses", "wait-pick"],
)
def test_screen_with_the_hosts_data_baseline(kit_app, name, make, scheme):
    from qt_fixtures import SNAPSHOTS
    from snapshots_util import check

    check(_grab(kit_app, make(), scheme), SNAPSHOTS / f"{name}.{scheme}.png")
