# @pkey-feature ui.cli
"""The drop-in flows (layer a) on an interactive terminal, with scripted keys: masked key entry,
the device-limit hand-off and Try again, the sign-in wait (Use a code, copy, Esc), the sign-out
confirm, and ``--json`` that never prompts. Plus the rich renderer, byte for byte against the
kit's own ANSI."""

from __future__ import annotations

import io
import json
import re
import threading
import time
from typing import Any, List, Optional

import pytest

from polaris_key.core.errors import PolarisError
from polaris_key.license.endpoints import ActivationDeviceLimit, ActivationOk
from polaris_key.ui.core import Copy
from polaris_key.ui.terminal import flows
from polaris_key.ui.terminal.device import Device, to_rich
from polaris_key.ui.terminal.flows import Terminal
from polaris_key.ui.terminal.text import to_ansi

from .fixtures import FIXTURES, KEY, Presentation, kit
from .golden_support import env

C = Copy("en")


class Keys:
    """A scripted KeyReader: each read returns the next key (``None`` once they run out)."""

    def __init__(self, keys: List[Optional[str]], delay: float = 0.0) -> None:
        self.keys = list(keys)
        self.delay = delay

    def __enter__(self) -> "Keys":
        return self

    def __exit__(self, *exc: Any) -> None:
        pass

    def read(self, timeout: Optional[float] = None) -> Optional[str]:
        if self.delay:
            time.sleep(self.delay)
        if self.keys:
            return self.keys.pop(0)
        if timeout is None:
            raise AssertionError("the flow waited for a key the script does not have")
        time.sleep(min(timeout, 0.01))
        return None


def terminal(keys: List[Optional[str]], *, json_mode: bool = False, opened: Optional[list] = None) -> Terminal:
    e = env("ansi16", "unicode", 80, "dark").but(json=json_mode, interactive=not json_mode, motion=not json_mode)
    k = kit(e)
    out = io.StringIO()
    d = Device(e, k.palette(), stdout=out, use_rich=False)
    script = Keys(keys)
    d.keys = lambda: script  # type: ignore[method-assign]
    if opened is not None:
        d.open_url = lambda url: opened.append(url) or True  # type: ignore[method-assign]
    d.copy = lambda text: True  # type: ignore[method-assign]
    return Terminal(k, d, "activate")


class _License:
    def __init__(self, results: List[Any]) -> None:
        self.results = list(results)
        self.keys: List[str] = []

    def activate_with_key(self, key: str) -> Any:
        self.keys.append(key)
        return self.results.pop(0)


class _Client:
    product = "tidewater"

    def __init__(self, results: List[Any]) -> None:
        self.license = _License(results)

    def status(self) -> Any:
        return type("S", (), {"status": "ok"})()


def test_masked_entry_types_checks_and_submits() -> None:
    client = _Client([ActivationOk(token="t")])
    typed = list(KEY[:20]) + ["enter"] + list(KEY[20:]) + ["backspace", KEY[-1], "enter"]
    t = terminal(typed)
    out = flows.activate(client, t, None)
    assert out.code == 0 and client.license.keys == [KEY]
    assert C("core.activation.ok.title") in "\n".join(out.text)
    screen = t.device.out.getvalue()
    assert C("part.keyField.cutShort", prefix="pkey_tidewater_", used=5, limit=22) in screen
    assert KEY[15:-6] not in screen, "the key's body never reaches the terminal"


def test_escape_cancels_key_entry() -> None:
    out = flows.activate(_Client([]), terminal(["pk", "esc"]), None)
    assert out.code == 1 and out.data == {"kind": "cancelled"}


def test_device_limit_opens_the_browser_then_tries_again() -> None:
    limit = ActivationDeviceLimit(limit=3, deviceCount=3, manage_url="https://key.plrs.im/portal/tidewater/devices")
    client = _Client([limit, ActivationOk(token="t")])
    opened: list = []
    t = terminal(["enter", "enter"], opened=opened)
    out = flows.activate(client, t, KEY)
    assert opened == ["https://key.plrs.im/portal/tidewater/devices"]
    assert out.code == 0 and client.license.keys == [KEY, KEY]
    screen = t.device.out.getvalue()
    assert C("deviceLimit.openBrowser") in screen and C("common.tryAgain") in screen


def test_device_limit_without_a_terminal_reports_and_stops() -> None:
    limit = ActivationDeviceLimit(limit=3, deviceCount=3, manage_url="https://k/m")
    t = terminal([], json_mode=True)
    out = flows.activate(_Client([limit]), t, KEY)
    assert out.code == 1 and out.data["manageUrl"] == "https://k/m"


class _Prompt:
    deviceCode = "dc"
    userCode = "WDJB-MJHT"
    verificationUri = "https://key.plrs.im/device"
    verificationUriComplete = "https://key.plrs.im/device?user_code=WDJB-MJHT"
    expiresIn = 600
    interval = 1

    def __init__(self) -> None:
        self.expiresAt = int(time.time()) + 600


class _Identity:
    def __init__(self, finish_after: float = 0.3) -> None:
        self.finish_after = finish_after
        self.cancelled = False

    def begin_sign_in(self, name: Any = None, confirm_identity: bool = False) -> _Prompt:
        return _Prompt()

    def wait_for_sign_in(self, prompt: Any, *, cancel: threading.Event, on_confirm: Any = None) -> Any:
        if cancel.wait(self.finish_after):
            self.cancelled = True
            raise PolarisError("cancelled", "cancelled")
        ident = type("I", (), {"name": "Mara Fennick", "email": "mara@fennick.studio"})()
        return type("R", (), {"status": "ready", "identity": ident, "attached": None})()


class _SignInClient:
    product = "tidewater"

    def __init__(self, identity: _Identity) -> None:
        self.identity = identity

    def status(self) -> Any:
        return type("S", (), {"status": "ok"})()


def test_sign_in_opens_the_browser_switches_to_a_code_and_finishes() -> None:
    opened: list = []
    t = terminal(["c", "c"], opened=opened)
    t.verb = "login"
    t.kit.env = t.kit.env.but(headless=False)
    out = flows.sign_in(_SignInClient(_Identity(0.4)), t)
    assert opened == [_Prompt.verificationUriComplete]
    assert out.code == 0 and out.data["state"] == "signedIn" and out.data["email"] == "mara@fennick.studio"
    screen = t.device.out.getvalue()
    assert C("signin.cli.opening") in screen and "WDJB-MJHT" in screen and C("common.copied") in screen
    assert C("signin.cli.signedIn", name="Mara Fennick", email="mara@fennick.studio") in "\n".join(out.text)


def test_escape_cancels_sign_in() -> None:
    ident = _Identity(5)
    t = terminal(["esc"], opened=[])
    t.kit.env = t.kit.env.but(headless=True)
    out = flows.sign_in(_SignInClient(ident), t)
    assert out.code == 1 and out.data == {"state": "cancelled"}
    assert C("core.codes.cancelled.title") in "\n".join(out.text)


def test_sign_in_json_is_pending_then_result_and_never_prompts() -> None:
    t = terminal([], json_mode=True)
    t.verb = "login"
    out = flows.sign_in(_SignInClient(_Identity(0.05)), t)
    t.finish(out)
    objs = [json.loads(ln) for ln in t.device.out.getvalue().splitlines()]
    assert objs[0]["event"] == "pending" and objs[0]["userCode"] == "WDJB-MJHT"
    assert objs[-1]["event"] == "result" and objs[-1]["state"] == "signedIn" and objs[-1]["v"] == 1


def test_sign_out_asks_on_a_terminal_and_yes_skips_it() -> None:
    class Ident:
        signed_out = 0

        def sign_out(self) -> None:
            Ident.signed_out += 1

    client = type("C", (), {"identity": Ident(), "product": "tidewater"})()
    assert flows.sign_out(client, terminal(["n"])).code == 1 and Ident.signed_out == 0
    assert flows.sign_out(client, terminal(["y"])).code == 0 and Ident.signed_out == 1
    assert flows.sign_out(client, terminal([]), yes=True).code == 0 and Ident.signed_out == 2
    screen = terminal(["n"])
    flows.sign_out(client, screen)
    assert C("signin.cli.logoutConfirm", product="Tidewater Studio") in screen.device.out.getvalue()


# ── rich renders the kit's lines to the kit's bytes ──────────────────────────────────────────

_LINK_ID = re.compile(r"\x1b\]8;id=[^;]*;")


@pytest.mark.parametrize("mode", ["truecolor", "ansi16", "none"])
@pytest.mark.parametrize("fx", FIXTURES, ids=[f.name for f in FIXTURES])
def test_rich_writes_the_same_bytes(fx, mode: str) -> None:
    pytest.importorskip("rich")
    from polaris_key.ui.terminal.device import rich_console

    e = env(mode if mode != "none" else "none", "unicode", 80, "dark")
    k = kit(e)
    lines = fx.draw(k)
    pal = k.palette()
    ours = "".join(to_ansi(ln, pal) + "\n" for ln in lines)
    buf = io.StringIO()
    console = rich_console(e, buf, width=200, environ={})
    console.print(to_rich(lines, pal))
    assert _LINK_ID.sub("\x1b]8;;", buf.getvalue()) == ours


def test_browser_flag_opens_the_browser_even_when_headless() -> None:
    opened: list = []
    t = terminal([], opened=opened)
    t.kit.env = t.kit.env.but(headless=True)
    t.verb = "login"
    out = flows.sign_in(_SignInClient(_Identity(0.2)), t, browser=True)
    assert out.code == 0 and opened == [_Prompt.verificationUriComplete]
    assert C("signin.cli.opening") in t.device.out.getvalue()


def test_json_always_ends_with_a_result_line(capsys) -> None:
    from polaris_key.cli import argparse_cli, core, verbs

    def broken(opts: core.ClientOptions) -> Any:
        raise RuntimeError("discovery blew up")

    parser = argparse_cli.GroupedHelpParser(prog="polaris-key")
    argparse_cli.register_argparse(parser.add_subparsers(dest="command", required=True), broken)
    args = parser.parse_args(["status", "--product", "tidewater", "--json"])
    assert args.func(args) == 1
    last = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert last == {"v": 1, "command": "status", "event": "result", "ok": False, "exit": 1, "error": "internal"}

    class Exploding:
        product = "tidewater"

        def status(self) -> Any:
            raise ValueError("boom")

        def close(self) -> None:
            pass

    status = next(v for v in verbs.VERBS if v.name == "status")
    res = verbs.run(lambda o: Exploding(), core.ClientOptions(product="tidewater"), status, {"json": True})
    res.emit()
    last = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert last["event"] == "result" and last["error"] == "internal" and last["exit"] == 1
    assert argparse_cli.main(["status", "--json"]) == 2
    usage = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert usage["event"] == "result" and usage["error"] == "usage" and usage["exit"] == 2


def test_a_live_region_counts_wrapped_rows_on_a_narrow_terminal() -> None:
    from polaris_key.ui.terminal.text import Line, Span

    e = env("ansi16", "unicode", 60, "dark").but(columns=40)
    k = kit(e)
    out = io.StringIO()
    d = Device(e, k.palette(), stdout=out, use_rich=False)
    with d.live() as live:
        live.update([Line([Span("x" * 55)]), Line([Span("short")])])
        live.update([Line([Span("y")])])
    # 55 cells in 40 columns take two rows, so the redraw moves up three.
    assert "\x1b[3F" in out.getvalue()
