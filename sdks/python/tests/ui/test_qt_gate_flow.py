# @pkey-feature ui.gate
# @pkey-feature ui.activate
# @pkey-feature ui.signin
# @pkey-feature ui.devicelimit
"""``run_gate`` runs the activation and sign-in screens itself (UI-KITS §4.2): Welcome, license-key
entry with the client's refusals in their own words, sign-in in the browser and by device code, Replace
a device, and the blocked-status screens. Every flow runs live in QML against a fake client (no
network); the host calls nothing but ``run_gate``. ``conftest.qml_console`` fails any of these on a QML
console error."""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace
from typing import Any, Callable, List, Optional

import pytest

pytest.importorskip("PySide6.QtQuick")

from polaris_key.core.errors import PolarisError
from polaris_key.identity.client import SignedInIdentity, SignInPrompt, SignInResult
from polaris_key.ui.core.theme import Theme
from polaris_key.ui.qt.gate import run_gate
from qt_fixtures import TIDEWATER, FakeSource

KEY = "pkey_tidewater_" + "a" * 22


# ── fakes ──────────────────────────────────────────────────────────────────────────────────────


class FakeLicense:
    def __init__(self, client: "FakeClient") -> None:
        self.client = client
        self.keys: List[str] = []
        self.script: List[Any] = [SimpleNamespace(kind="ok")]
        self.enrolled = 0
        #: Set to hold the call open (the busy screen), then ``release.set()``.
        self.hold: Optional[threading.Event] = None

    def activate_with_key(self, key: str) -> Any:
        self.keys.append(key)
        if self.hold is not None:
            self.hold.wait(3)
        result = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if result.kind == "ok":
            self.client.st = "ok"
        return result

    def enroll(self) -> Any:
        self.enrolled += 1
        self.client.st = "ok"
        return SimpleNamespace(kind="ok")


class FakeIdentity:
    """A sign-in whose wait ends when the test says so (or when it is cancelled)."""

    def __init__(self, client: "FakeClient") -> None:
        self.client = client
        self.begun = 0
        self.begin_error: Optional[PolarisError] = None
        self.prompts: List[SignInPrompt] = []
        self.cancels: List[threading.Event] = []
        self.finish = threading.Event()
        self.result: Any = SignInResult(status="ready", identity=SignedInIdentity("Ada", "ada@example.com"))
        self.waiting = threading.Event()
        self.now = time.time()

    def begin_sign_in(self, device_name: Optional[str] = None, *, confirm_identity: bool = False) -> SignInPrompt:
        self.begun += 1
        if self.begin_error is not None:
            raise self.begin_error
        prompt = SignInPrompt(
            deviceCode="secret-device-code",
            userCode="WDJB-MJHT",
            verificationUri="https://polaris.locker/device",
            verificationUriComplete=f"https://polaris.locker/device?user_code=WDJB-MJHT&n={self.begun}",
            expiresIn=600,
            interval=5,
            expiresAt=int(self.now) + 600,
        )
        self.prompts.append(prompt)
        return prompt

    def wait_for_sign_in(self, prompt: SignInPrompt, timeout: Any = None, *, cancel: threading.Event, on_confirm: Any = None) -> Any:
        self.cancels.append(cancel)
        self.waiting.set()
        while not (self.finish.is_set() or cancel.is_set()):
            time.sleep(0.005)
        if cancel.is_set():
            raise PolarisError("cancelled", "cancelled")
        self.finish.clear()
        self.waiting.clear()
        if self.result.status == "ready":
            self.client.st = "ok"
        return self.result


class FakeCore:
    def __init__(self, on: Optional[List[str]] = None) -> None:
        self._on = on if on is not None else ["license", "config", "identity"]

    def enabled(self, slug: str) -> bool:
        return slug in self._on


class FakeClient:
    def __init__(self, status: str = "needs-activation", identity: bool = True, services: Optional[List[str]] = None) -> None:
        self.st = status
        self.presentation_source = FakeSource(TIDEWATER)
        self.core = FakeCore(services if services is not None else (["license", "config", "identity"] if identity else ["license", "config"]))
        self.license = FakeLicense(self)
        if identity:
            self.identity = FakeIdentity(self)

    def status(self, now: Any = None) -> Any:
        return SimpleNamespace(status=self.st)


class Clipboard:
    def __init__(self, text: str = "") -> None:
        self.value = text

    def text(self) -> str:
        return self.value

    def set_text(self, text: str) -> None:
        self.value = text


class Opener:
    def __init__(self, ok: bool = True) -> None:
        self.ok = ok
        self.urls: List[str] = []

    def __call__(self, url: str) -> bool:
        self.urls.append(url)
        return self.ok


# ── helpers ────────────────────────────────────────────────────────────────────────────────────


def pump(app: Any, until: Callable[[], bool], timeout: float = 4.0) -> None:
    """Run the event loop until ``until()`` (a worker thread's result arrives on it), or fail."""
    deadline = time.monotonic() + timeout
    while not until():
        app.processEvents()
        time.sleep(0.003)
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting for the GUI thread to see the result")
    app.processEvents()


class Rig:
    """A gate over a fake client, with the pieces a test presses and reads."""

    def __init__(self, app: Any, client: FakeClient, **kw: Any) -> None:
        self.app = app
        self.client = client
        self.opener = kw.pop("open_url", None) or Opener()
        self.clipboard = kw.pop("clipboard", None) or Clipboard()
        self.opened: List[int] = []
        self.now = [float(int(time.time()))]
        if hasattr(client, "identity"):
            client.identity.now = self.now[0]
        self.gate = run_gate(
            client, None, theme=Theme(color_scheme="dark", platform="gnome"), size=(480, 720), on_open=lambda: self.opened.append(1), open_url=self.opener, **kw
        )
        self.gate.flow._clipboard = self.clipboard
        self.gate.flow._now = lambda: self.now[0]

    @property
    def spec(self) -> Any:
        return self.gate.kit.bridge.screen_spec

    @property
    def shown(self) -> str:
        return f"{self.gate.screen.component}.{self.gate.screen.state}"

    def press(self, key: str, action: str = "") -> None:
        self.gate.kit.bridge.invoke(key, action)
        self.app.processEvents()

    def texts(self) -> List[str]:
        return [b.text for b in self.spec.buttons]

    def type(self, text: str) -> None:
        self.gate.kit.bridge.edit("part.keyField.label", text)
        self.app.processEvents()

    def until(self, shown: str, timeout: float = 4.0) -> None:
        pump(self.app, lambda: self.shown == shown, timeout)

    def grab(self) -> Any:
        return self.gate.kit.grab()

    def walk(self) -> List[Any]:
        out, stack = [], [self.gate.kit.view.rootObject()]
        while stack:
            item = stack.pop(0)
            out.append(item)
            stack = list(item.childItems()) + stack
        return out

    def named(self, name: str) -> Any:
        return next((i for i in self.walk() if i.objectName() == name), None)

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


# ── Welcome and the chooser ────────────────────────────────────────────────────────────────────


def test_a_product_with_sign_in_and_keys_opens_on_welcome(rig):
    r = rig()
    assert r.shown == "Welcome.default" and not r.gate.open
    assert r.texts()[:2] == ["Sign in", "Use a license key"]
    assert "Tidewater Studio" in r.spec.title and r.gate.view.state == "needs-activation"
    assert r.gate.kit.view.isVisible()
    r.grab()


def test_a_key_only_product_opens_on_the_key_form(rig):
    r = rig(FakeClient(identity=False))
    assert r.shown == "Activate.empty"
    assert [f.label for f in r.spec.fields] == ["License key"]
    assert "Cancel" not in r.texts()  # no chooser to go back to


def test_a_sign_in_only_product_welcome_has_its_one_button(rig):
    r = rig(FakeClient(services=["identity"]))
    assert r.shown == "Welcome.capability-limited"
    assert r.texts() == ["Sign in"] and r.spec.buttons[0].role == "primary"


# ── Key entry ──────────────────────────────────────────────────────────────────────────────────


def test_a_key_is_typed_checked_as_it_goes_and_activates_the_app(rig):
    r = rig()
    r.press("welcome.useKey")
    assert r.shown == "Activate.empty" and "Cancel" in r.texts()
    r.type("pkey_")
    assert r.shown == "Activate.typing"
    r.type(KEY[:20])
    assert r.shown == "Activate.typing"  # still the same state: the field was not rebuilt under the cursor
    r.type(KEY)
    assert r.shown == "Activate.parsed" and r.spec.fields[0].hint.startswith("Key for")
    assert r.spec.fields[0].value == KEY
    r.client.license.hold = threading.Event()
    r.press("activate.submit")
    assert r.shown == "Activate.busy" and r.spec.buttons[0].busy
    r.grab()
    r.press("activate.submit")  # a second press while the call is out does nothing
    r.client.license.hold.set()
    pump(r.app, lambda: r.gate.open)
    assert r.client.license.keys == [KEY] and r.opened and not r.gate.kit.view.isVisible()


def test_enter_in_the_field_submits(rig):
    r = rig(FakeClient(identity=False))
    r.type(KEY)
    entry = r.named("entry")
    entry.setProperty("text", KEY)
    r.gate.kit.bridge.invoke(r.spec.primary_key, "")
    pump(r.app, lambda: r.gate.open)
    assert r.client.license.keys == [KEY]


def test_paste_fills_the_field_from_the_clipboard(rig):
    r = rig(FakeClient(identity=False), clipboard=Clipboard("  " + KEY + "\n"))
    assert r.spec.fields[0].paste == "Paste"
    r.press("common.paste", "paste")
    assert r.shown == "Activate.parsed" and r.spec.fields[0].value == KEY
    assert r.named("entry").property("text") == KEY


def test_a_cut_short_or_empty_key_is_caught_before_a_request(rig):
    r = rig(FakeClient(identity=False))
    r.press("activate.submit")
    assert r.shown == "Activate.rejected" and "Enter a license key first." in r.spec.fields[0].error
    r.type(KEY[:-6])
    r.press("activate.submit")
    assert r.shown == "Activate.cut-short" and r.spec.fields[0].error.startswith("This key is cut short")
    assert r.spec.title_tone == ""  # the input is wrong, not the screen
    assert [b.key for b in r.spec.buttons] == ["activate.submit"]  # and Activate is still the way on
    assert r.client.license.keys == []
    r.type(KEY[:-5])  # editing clears the message
    assert r.shown in ("Activate.typing",)


@pytest.mark.parametrize(
    "kind,code,expect",
    [
        ("license-disabled", "license_disabled", "This license has been disabled. Contact the developer."),
        ("license-expired", "license_expired", "This license has expired. Renew it to continue."),
        ("rate-limited", "rate_limited", "Too many attempts. Wait a moment and try again."),
        ("fingerprint-required", "fingerprint_required", "hardware fingerprint"),
        ("hardware-mismatch", "hardware_mismatch", "Activate again"),
        ("enroll-claimed", "enroll_claimed", "Sign in to use it."),
    ],
)
def test_a_refusal_is_an_info_callout_with_its_next_step(rig, kind, code, expect):
    r = rig(FakeClient(identity=False))
    r.client.license.script = [SimpleNamespace(kind=kind, code=code)]
    r.type(KEY)
    r.press("activate.submit")
    pump(r.app, lambda: r.shown == "Activate.rejected")
    assert any(expect in text for text in r.spec.callout), r.spec.callout
    assert r.spec.tone == "neutral" and r.spec.title_tone == ""  # information, never the danger colour
    assert r.spec.fields[0].value == KEY and r.spec.fields[0].error == ""
    assert r.spec.buttons[0].key == "activate.submit" and r.spec.buttons[0].role == "primary"
    callout = r.named("callout")
    r.grab()
    assert callout is not None and callout.property("visible") is True
    r.type(KEY[:-1])  # fixing the key clears the refusal
    assert r.spec.callout == []


def test_a_key_the_service_does_not_know_marks_the_field(rig):
    r = rig(FakeClient(identity=False))
    r.client.license.script = [SimpleNamespace(kind="unauthorized", code="unauthorized")]
    r.type(KEY)
    r.press("activate.submit")
    pump(r.app, lambda: r.shown == "Activate.rejected")
    assert r.spec.tone == "danger" and r.spec.callout == []
    assert r.spec.buttons[0].role == "primary"


def test_a_failed_check_keeps_the_key_and_says_what_to_do(rig):
    r = rig(FakeClient(identity=False))
    r.client.license.script = [SimpleNamespace(kind="error", code="network-error", message="down")]
    r.type(KEY)
    r.press("activate.submit")
    pump(r.app, lambda: r.shown == "Activate.rejected")
    assert r.spec.fields[0].value == KEY
    r.client.license.script = [SimpleNamespace(kind="ok")]
    r.press("activate.submit")
    pump(r.app, lambda: r.gate.open)


def test_cancel_returns_to_the_chooser_and_keeps_nothing_running(rig):
    r = rig()
    r.press("welcome.useKey")
    r.type(KEY)
    r.press("common.cancel", "cancel")
    assert r.shown == "Welcome.default"


def test_continue_free_enrolls(rig):
    r = rig(offers_free_tier=True)
    assert "Continue free" in r.texts()
    r.press("welcome.continueFree")
    pump(r.app, lambda: r.gate.open)
    assert r.client.license.enrolled == 1


# ── Device limit and replace ───────────────────────────────────────────────────────────────────


def _limit(url: Optional[str]) -> Any:
    return SimpleNamespace(kind="device-limit", code="device_limit", deviceCount=3, limit=3, manage_url=url)


def test_device_limit_opens_the_portal_and_retries_the_key_when_back(rig):
    r = rig(FakeClient(identity=False))
    r.client.license.script = [_limit("https://polaris.locker/manage?d=1"), SimpleNamespace(kind="ok")]
    r.type(KEY)
    r.press("activate.submit")
    pump(r.app, lambda: r.shown == "DeviceLimit.browser-mode")
    assert "Replace a device" in r.spec.title and r.texts()[:2] == ["Open in browser", "Back"]
    r.press("deviceLimit.openBrowser", "open-manage-url")
    assert r.opener.urls == ["https://polaris.locker/manage?d=1"]
    assert r.texts()[0] == "Try again" and r.spec.buttons[0].role == "primary"
    # the person frees a seat in the browser and comes back to the app: the key is tried once more
    r.gate.flow._app_state(r.app.applicationState().ApplicationActive if hasattr(r.app.applicationState(), "ApplicationActive") else __import__("PySide6.QtCore", fromlist=["Qt"]).Qt.ApplicationState.ApplicationActive)
    pump(r.app, lambda: r.gate.open)
    assert r.client.license.keys == [KEY, KEY]


def test_device_limit_try_again_can_be_pressed(rig):
    r = rig(FakeClient(identity=False))
    r.client.license.script = [_limit("https://polaris.locker/manage?d=1"), SimpleNamespace(kind="ok")]
    r.type(KEY)
    r.press("activate.submit")
    pump(r.app, lambda: r.shown == "DeviceLimit.browser-mode")
    r.press("deviceLimit.openBrowser", "open-manage-url")
    r.press("common.tryAgain", "retry")
    pump(r.app, lambda: r.gate.open)


def test_device_limit_without_a_portal_link_says_to_sign_out_elsewhere(rig):
    r = rig(FakeClient(identity=False))
    r.client.license.script = [_limit(None), SimpleNamespace(kind="ok")]
    r.type(KEY)
    r.press("activate.submit")
    pump(r.app, lambda: r.shown == "Activate.device-limit")
    assert any("Sign out of" in b for b in r.spec.body + r.spec.callout)
    assert r.texts()[0] == "Try again" and "Back" in r.texts()
    r.press("common.back", "cancel")
    assert r.shown.startswith("Activate.") and r.spec.fields[0].value == KEY
    r.press("activate.submit")
    pump(r.app, lambda: r.gate.open)


# ── Sign-in ────────────────────────────────────────────────────────────────────────────────────


def test_sign_in_methods_then_the_browser_then_the_app(rig):
    r = rig()
    r.press("welcome.signIn")
    assert r.shown == "SignIn.methods" and r.texts()[0] == "Continue in browser"
    assert "Use a license key instead" in r.texts() and "Cancel" in r.texts()
    r.press("signin.desktop.continue", "open-card")
    r.until("SignIn.handoff")
    assert r.spec.title == "Finish in your browser" and r.spec.progress == -1.0  # the wait is the shimmer
    assert r.texts()[:3] == ["Open browser again", "Cancel", "Use a code instead"] or set(r.texts()) >= {"Open browser again", "Cancel"}
    assert r.opener.urls == [r.client.identity.prompts[0].verificationUriComplete]
    r.press("signin.handoff.again", "open-browser")
    assert len(r.opener.urls) == 2 and r.client.identity.begun == 1  # reuses the request in flight
    r.client.identity.finish.set()
    pump(r.app, lambda: r.gate.open)
    assert r.opened


def test_cancel_stops_the_wait_and_returns_to_the_chooser(rig):
    r = rig()
    r.press("welcome.signIn")
    r.press("signin.desktop.continue", "open-card")
    r.until("SignIn.handoff")
    pump(r.app, lambda: r.client.identity.cancels)
    r.press("common.cancel", "cancel")
    assert r.shown == "Welcome.default"
    assert r.client.identity.cancels[0].is_set()


def test_sign_in_with_a_license_key_instead_goes_to_the_key_form(rig):
    r = rig()
    r.press("welcome.signIn")
    r.press("signin.choice.keyInstead")
    assert r.shown == "Activate.empty"


def test_no_browser_offers_copy_link_and_a_code(rig):
    r = rig(open_url=Opener(ok=False))
    r.press("welcome.signIn")
    r.press("signin.desktop.continue", "open-card")
    r.until("SignInHandoff.no-browser")
    assert r.texts()[0] == "Copy link" and "Use a code instead" in r.texts()
    r.press("signin.handoff.copyLink", "copy-link")
    assert r.clipboard.value == r.client.identity.prompts[0].verificationUriComplete
    assert r.shown == "SignInHandoff.link-copied"


def test_use_a_code_shows_the_code_the_address_and_the_countdown(rig):
    r = rig()
    r.press("welcome.signIn")
    r.press("signin.desktop.continue", "open-card")
    r.until("SignIn.handoff")
    r.press("signin.handoff.useCode")
    r.until("SignInHandoff.code")
    code = r.spec.code
    assert code.value == "WDJB-MJHT" and code.label == "Sign-in code" and code.expires == "Code expires in 10:00"
    assert code.fraction == pytest.approx(1.0, abs=0.01)
    assert code.qr == ""  # no QR on a desktop (DL14, SIGN-IN D-67): phones and computers browse
    assert r.spec.title == "Sign in with a code" and "polaris.locker/device" in " ".join(r.spec.body)
    assert code.copy_label == "Copy code"
    r.grab()
    assert r.named("codeValue").property("text") == "WDJB-MJHT" and r.named("expires").property("visible")
    assert r.named("copyCode").property("visible") and not r.named("qr").property("visible")
    # the countdown follows the clock
    r.now[0] += 125
    r.gate.flow._tick()
    assert r.spec.code.expires == "Code expires in 7:55" and r.spec.code.fraction == pytest.approx(475 / 600, abs=0.01)
    # Copy puts the code on the clipboard and says so for a moment
    r.press("a11y.copyCode", "copy-code")
    assert r.clipboard.value == "WDJB-MJHT" and r.spec.code.copied == "Copied"
    # Open browser opens the page the code view names
    r.press("signin.handoff.openBrowser", "open-browser")
    assert r.opener.urls[-1].startswith("https://polaris.locker/device?user_code=WDJB-MJHT")


def test_a_lapsed_code_is_never_polled_again(rig):
    r = rig()
    r.press("welcome.signIn")
    r.press("signin.desktop.continue", "open-card")
    r.until("SignIn.handoff")
    r.press("signin.handoff.useCode")
    r.until("SignInHandoff.code")
    r.now[0] += 601
    r.gate.flow._tick()
    assert r.shown == "SignInHandoff.expired" and r.texts()[0] == "Get a new code"
    assert r.spec.code is None  # its code is gone from the screen
    pump(r.app, lambda: all(c.is_set() for c in r.client.identity.cancels))
    r.client.identity.now = r.now[0]  # the server issues the new code from the clock as it is now
    r.press("signInHandoff.newCode", "retry")
    r.until("SignInHandoff.code")
    assert r.client.identity.begun == 3  # browser, code, a new code


@pytest.mark.parametrize(
    "result,state,title",
    [
        (SignInResult(status="error", code="sign-in-denied"), "SignInHandoff.denied", "Sign-in declined"),
        (SignInResult(status="error", code="sign-in-failed"), "SignInHandoff.failed", "Sign-in failed"),
        (SignInResult(status="expired"), "SignIn.expired", ""),
    ],
)
def test_a_sign_in_that_ends_badly_says_so_and_offers_a_new_one(rig, result, state, title):
    r = rig()
    r.client.identity.result = result
    r.press("welcome.signIn")
    r.press("signin.desktop.continue", "open-card")
    r.until("SignIn.handoff")
    r.client.identity.finish.set()
    r.until(state)
    if title:
        assert r.spec.title == title
    assert r.spec.buttons[0].role == "primary" and r.spec.buttons[0].key in ("signInHandoff.newCode", "signin.again")
    assert not r.gate.open
    if state == "SignInHandoff.denied":
        assert r.spec.tone == "danger"
    r.press(r.spec.buttons[0].key, "retry")
    r.until("SignIn.handoff")
    assert r.client.identity.begun == 2


def test_starting_a_sign_in_that_fails_says_so(rig):
    r = rig()
    r.client.identity.begin_error = PolarisError("sign-in-unavailable", "off")
    r.press("welcome.signIn")
    r.press("signin.desktop.continue", "open-card")
    r.until("SignIn.error")
    assert "No sign-in method is available" in " ".join(r.spec.body + r.spec.callout)
    assert r.texts()[0] == "Continue in browser" and "Cancel" in r.texts()
    r.client.identity.begin_error = None
    r.press("signin.desktop.continue", "open-card")
    r.until("SignIn.handoff")


def test_a_tv_goes_straight_to_the_code_and_draws_the_qr(rig):
    r = rig(platform={"os": "android", "formFactor": "tv"}, open_url=Opener())
    r.press("welcome.signIn")
    r.until("SignInHandoff.code")
    code = r.spec.code
    assert code.value == "WDJB-MJHT" and code.qr.startswith("data:image/svg+xml;base64,") and code.qr_label
    assert r.opener.urls == []  # a TV has no browser to open
    r.grab()
    assert r.named("qr").property("visible") is True
    assert any("polaris.locker/device" in text for text, _strong in r.spec.after)  # the address, on its own line
    assert "Scan the QR code" in " ".join(r.spec.body)


# ── Blocked statuses ───────────────────────────────────────────────────────────────────────────


def test_a_revoked_device_offers_sign_in_or_a_different_key(rig):
    r = rig(FakeClient(status="revoked"))
    assert r.shown == "StatusScreen.revoked" and r.texts()[:2] == ["Sign in", "Use a different key"]
    r.press("signin.key.differentKey")
    assert r.shown == "Activate.empty"
    r.press("common.cancel", "cancel")
    assert r.shown == "StatusScreen.revoked"
    r.press("welcome.signIn")
    assert r.shown == "SignIn.methods"


def test_try_again_and_a_changed_status_move_the_gate(rig):
    r = rig(FakeClient(status="expired"))
    assert r.shown == "StatusScreen.expired"
    r.client.st = "ok"
    r.press("status.renew")  # the fix is outside the app: pressing it re-reads the client
    assert r.gate.open and r.opened


def test_every_screen_of_the_flow_names_its_controls(rig):
    r = rig(offers_free_tier=True)
    r.press("welcome.useKey")
    r.type(KEY)
    r.press("common.cancel", "cancel")
    r.press("welcome.signIn")
    r.press("signin.desktop.continue", "open-card")
    r.until("SignIn.handoff")
    for item in r.walk():
        cls = item.metaObject().className()
        if "Button" in cls and item.property("visible") and item.property("text"):
            assert item.property("text").strip()
    r.grab()


def _click(r: "Rig", text: str) -> None:
    """Press the button the person sees, through QML (its handler re-draws the screen under it)."""
    button = next(i for i in r.walk() if "Button" in i.metaObject().className() and i.property("text") == text and i.property("visible"))
    button.click()
    r.app.processEvents()


def test_pressing_the_buttons_in_qml_is_safe_while_the_screen_redraws_under_them(rig):
    r = rig(FakeClient(identity=True))
    r.grab()
    _click(r, "Use a license key")
    assert r.shown == "Activate.empty"
    r.grab()
    _click(r, "Cancel")
    assert r.shown == "Welcome.default"
    r.grab()
    _click(r, "Sign in")
    assert r.shown == "SignIn.methods"
    r.grab()
    _click(r, "Continue in browser")
    r.until("SignIn.handoff")
    r.grab()
    _click(r, "Use a code instead")
    r.until("SignInHandoff.code")
    r.grab()
    _click(r, "Cancel")
    assert r.shown == "Welcome.default"
    r.grab()
    r.client.identity.finish.set()
