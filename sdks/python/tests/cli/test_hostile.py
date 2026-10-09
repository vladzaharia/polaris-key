# @pkey-feature ui.cli
"""Server and product text never reaches the terminal as escapes, and ``TERM=dumb`` is plain lines.

A device label, a presentation name, a changelog line, a manage URL or a ``verificationUri`` may
carry ESC, BEL or C1 characters (an OSC 52 clipboard write, a screen clear, a window title). The
kit draws them as text: one sanitiser at the writer drops every control character from span text,
OSC 8 wraps only ``https`` (or loopback ``http``) targets, ``--json`` is ASCII, and the Textual app
never parses data as markup. ``TERM=dumb`` (SIGN-IN.md D-77, D-68) prints plain lines with no
escape at all, and a headless sign-in still prints its code.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, List

import pytest

from polaris_key.ui.core.models import (
    ActivateView,
    DeviceRow,
    DevicesView,
    ReleaseNotesView,
    SignInModel,
    UpdateView,
    gate_view,
)
from polaris_key.ui.terminal import screens
from polaris_key.ui.terminal.device import Device, rich_console, to_rich
from polaris_key.ui.terminal.env import detect
from polaris_key.ui.terminal.parts import Kit
from polaris_key.ui.terminal.text import Line, safe_link, to_ansi

from .golden_support import variants

ESC_LABEL = "Work\x1b]52;c;ZXZpbA==\x07\x1b[2J laptop"
ESC_NAME = "Tide\x1b]0;pwned\x07water\x9b31m [link=https://evil]x[/link]"
ESC_SUMMARY = "Fixes\x1b[2J a crash\x9d0;title\x9c"
ESC_URL = "https://evil.example/\x1b]8;;javascript:alert(1)\x1b\\"
NOT_HTTPS = "javascript:alert(1)"
ESC_VURI = "https://key.plrs.im/device\x1b[2J"

#: The escapes the kit itself writes: SGR, and OSC 8 around an https (or loopback http) target.
_KIT = re.compile(r"\x1b\[[0-9;]*m|\x1b\]8;(?:id=[^;]*)?;(?:https://|http://(?:127\.0\.0\.1|localhost|\[::1\]))[\x21-\x7e]*\x1b\\|\x1b\]8;;\x1b\\")
_BAD = re.compile("[\x00-\x09\x0b-\x1f\x7f-\x9f]")


class Hostile:
    def current(self) -> dict:
        return {"name": ESC_NAME, "developerName": "Harbor\x07 Audio", "accent": "#369186"}


class _Prompt:
    userCode = "WDJB-MJHT"
    verificationUri = ESC_VURI
    verificationUriComplete = ESC_VURI + "?user_code=WDJB-MJHT"
    expiresAt = 600


def _renders(k: Kit) -> List[List[Line]]:
    rows = (DeviceRow("dev\x1b[2J1", ESC_LABEL, "Win\x9b11", True, "today"),)
    m = SignInModel()
    return [
        screens.devices(k, DevicesView("Devices", "list", rows)),
        screens.devices(k, DevicesView("Devices", "confirming", target=rows[0])),
        screens.gate(k, gate_view("ok", now=0, holder=ESC_NAME, email="m@x\x1b[2J", signed_in=True, tier="Pro\x07", term="Life\x9btime", version="2\x1b[2J")),
        screens.release_notes(k, ReleaseNotesView("ReleaseNotes", "list", (("2.5\x07", "2026\x1b[2J", (ESC_SUMMARY,), ESC_URL),))),
        screens.update(k, UpdateView("UpdatePrompt", "available", "2.5", "2.4.1", notes=(ESC_SUMMARY,), notes_url=NOT_HTTPS)),
        screens.update(k, UpdateView("UpdatePrompt", "store", "2.5", "2.4.1", listing_url=ESC_URL)),
        screens.device_limit(k, ActivateView("DeviceLimit", "browser-mode", "device-limit", "device_limit", "pkey_x_\x1b[2Jabcdefghijklmnop", 3, 3, ESC_URL)),
        screens.sign_in(k, m.prompted(_Prompt(), 0)),
        screens.sign_in(k, SignInModel(headless=True).prompted(_Prompt(), 0)),
        screens.offline_activation(k, __import__("polaris_key.ui.core.models", fromlist=["OfflineView"]).OfflineView("OfflineActivation", "default", request_code="dev\x1b]52;c;eA==\x07")),
    ]


def _assert_clean(text: str, where: str) -> None:
    rest = _KIT.sub("", text)
    assert not _BAD.search(rest), f"{where}: {rest!r}"
    assert "\x1b" not in rest and "\x07" not in rest, where


@pytest.mark.parametrize("label,env", variants("dark"), ids=[v[0] for v in variants("dark")])
def test_no_variant_draws_a_server_escape(label: str, env: Any) -> None:
    k = Kit.create(env, product="tidewater", source=Hostile(), prog="tidewater")
    pal = k.palette()
    for lines in _renders(k):
        text = "\n".join(to_ansi(ln, pal) for ln in lines)
        _assert_clean(text, label)
        if env.color == "none":
            # NO_COLOR drops colour, not weight: only bold, reverse, their reset and links remain.
            leftover = re.sub(r"\x1b\[(?:0|1|7|1;7)m|\x1b\]8;;[^\x1b]*\x1b\\", "", text)
            assert "\x1b" not in leftover, label
        for m in re.finditer(r"\x1b\]8;;([^\x1b]+)\x1b\\", text):
            assert safe_link(m.group(1)) == m.group(1), m.group(1)
        # Lines are lines: a newline in data never starts a new terminal row.
        assert all("\n" not in ln.text for ln in lines)


@pytest.mark.parametrize("mode", ["truecolor", "ansi16", "none"])
def test_rich_draws_no_server_escape(mode: str) -> None:
    pytest.importorskip("rich")
    env = dict(variants("dark"))[f"{'no-color' if mode == 'none' else mode} · 80"]
    k = Kit.create(env, product="tidewater", source=Hostile())
    for lines in _renders(k):
        buf = io.StringIO()
        rich_console(env, buf, width=200, environ={}).print(to_rich(lines, k.palette()))
        _assert_clean(buf.getvalue(), f"rich {mode}")


def test_links_are_only_https_or_loopback() -> None:
    assert safe_link("https://key.plrs.im/portal") == "https://key.plrs.im/portal"
    assert safe_link("http://127.0.0.1:5173/x") == "http://127.0.0.1:5173/x"
    for bad in (NOT_HTTPS, "file:///etc/passwd", "http://evil.example/", ESC_URL, "https://a b", "https://u:p@x/", "https://x/\x9b", ""):
        assert safe_link(bad) is None, bad


def test_the_browser_opens_only_safe_urls(monkeypatch) -> None:
    opened: list = []
    monkeypatch.setattr("webbrowser.open", lambda url: opened.append(url) or True)
    assert Device.open_url(ESC_URL) is False and Device.open_url(NOT_HTTPS) is False
    assert Device.open_url("https://key.plrs.im/device") is True and opened == ["https://key.plrs.im/device"]


def test_json_is_ascii_with_every_control_escaped() -> None:
    env = dict(variants("dark"))["pipe · 80"].but(json=True)
    k = Kit.create(env, product="tidewater")
    out = io.StringIO()
    Device(env, k.palette(), stdout=out, use_rich=False).emit({"label": ESC_LABEL, "name": ESC_NAME})
    raw = out.getvalue()
    assert not _BAD.search(raw.rstrip("\n")) and "\x1b" not in raw and raw.isascii()
    assert json.loads(raw)["label"] == ESC_LABEL


def test_textual_draws_data_as_text() -> None:
    pytest.importorskip("textual")
    from textual.widgets import Static

    from polaris_key.ui.terminal.textual_app import PolarisKeyApp

    class Client:
        product = "tidewater"
        presentation_source = Hostile()

    data = {
        "gate": gate_view("ok", now=0, holder=ESC_NAME, signed_in=True, tier="Pro", term="Life\x1b[2Jtime", version="2.4.1"),
        "devices": DevicesView("Devices", "list", (DeviceRow("d1", ESC_LABEL, "Win\x9b11"),)),
        "update": UpdateView("UpdatePrompt", "up-to-date", current="2.4.1"),
    }

    async def run() -> None:
        app = PolarisKeyApp(Client(), scheme="dark", data=data)
        assert not _BAD.search(app.title)
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            for section in ("account", "devices", "updates"):
                app.show(section)
                await pilot.pause()
                texts = [str(w.render()) for w in app.query(Static)]
                joined = "\n".join(texts)
                assert not _BAD.search(joined.replace("\n", "")), section
            app.show("account")
            await pilot.pause()
            assert "[link=https://evil]x[/link]" in "\n".join(str(w.render()) for w in app.query(Static))

    asyncio.run(run())


# ── TERM=dumb ────────────────────────────────────────────────────────────────────────────────


class _Tty(io.StringIO):
    def isatty(self) -> bool:
        return True


def test_dumb_is_plain_and_never_interactive() -> None:
    e = detect(env={"TERM": "dumb", "COLORTERM": "truecolor"}, stdout=_Tty(), stdin=_Tty(), osc11=lambda: "light", platform="darwin", size=lambda: (100, 30))
    assert (e.dumb, e.interactive, e.color, e.motion, e.clipboard, e.hyperlinks) == (True, False, "none", False, False, False)
    assert Kit.create(e, product="tidewater").decor is False


@pytest.mark.parametrize("use_rich", [True, False])
def test_dumb_headless_sign_in_prints_its_code(use_rich: bool) -> None:
    if use_rich:
        pytest.importorskip("rich")
    from polaris_key.ui.terminal import flows

    from .test_flows import _Identity, _SignInClient

    out = _Tty()
    e = detect(env={"TERM": "dumb"}, stdout=out, stdin=_Tty(), platform="darwin", device_code=True, size=lambda: (80, 24))
    k = Kit.create(e, product="tidewater")
    t = flows.Terminal(k, Device(e, k.palette(), stdout=out, use_rich=use_rich), "login")
    res = flows.sign_in(_SignInClient(_Identity(0.05)), t)
    t.finish(res)
    text = out.getvalue()
    assert res.code == 0 and "WDJB-MJHT" in text, text
    assert "\x1b" not in text and "│" not in text, text


SAMPLE = Path(__file__).resolve().parents[4] / "examples" / "ui" / "terminal-python" / "tidewater.py"


def _pty(argv: List[str], env: dict, timeout: float = 20.0) -> str:
    pty = pytest.importorskip("pty")
    import select

    pid, fd = pty.fork()
    if pid == 0:  # pragma: no cover - the child
        os.environ.clear()
        os.environ.update(env)
        os.execv(argv[0], argv)
    out = b""
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
    else:
        os.kill(pid, 9)
    os.waitpid(pid, 0)
    return out.decode("utf-8", "replace")


@pytest.mark.skipif(sys.platform.startswith("win"), reason="pseudo-terminals are POSIX")
@pytest.mark.parametrize("use_rich", [True, False])
def test_dumb_terminal_in_a_pty_prints_the_code_and_no_escape(tmp_path: Path, use_rich: bool) -> None:
    """A real pseudo-terminal with TERM=dumb: `login --device-code` prints the code view as plain
    lines, then signs in, with no escape (no colour, cursor control or bracketed paste)."""
    if use_rich:
        pytest.importorskip("rich")
    boot = "import sys; sys.modules['rich'] = None; " if not use_rich else ""
    code = boot + f"sys.argv = ['tidewater.py'] + {['login', '--device-code', '--product', 'tidewater']!r}; import runpy; runpy.run_path({str(SAMPLE)!r}, run_name='__main__')"
    env = {
        "TERM": "dumb",
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(tmp_path),
        "TMPDIR": str(tmp_path),
        "BROWSER": "true",
        "TIDEWATER_SIGN_IN_SECONDS": "0.5",
        "PYTHONPATH": os.pathsep.join(p for p in sys.path if p),
    }
    text = _pty([sys.executable, "-c", "import sys; " + code], env)
    assert "WDJB-MJHT" in text, text
    assert "\x1b" not in text, repr(text)


# ── Text that reads differently from what it is ──────────────────────────────────────────────
# Bidi overrides and isolates, bidi marks and zero-width characters draw nothing, but a device name
# with U+202E in it reads backwards. ``clean`` strips them; U+200C and U+200D join letters and
# emoji (ja, ar, fa) and stay inside a string, going only at its edges.

SPOOF = "\u202e\u2066\u200b\u200e\u200f\ufeff\u2060\u2069\u202a\u061c"
_HIDDEN = re.compile("[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]")


class Spoof:
    def current(self) -> dict:
        return {"name": f"Tide{SPOOF}water Studio", "developerName": f"Harbor{SPOOF}", "accent": "#369186"}


def test_clean_strips_bidi_and_zero_width_and_keeps_joiners_inside_a_word() -> None:
    from polaris_key.ui.terminal.text import clean

    assert clean(f"Work{SPOOF} laptop") == "Work laptop"
    assert clean("\u200dabc\u200c") == "abc"
    assert clean("می\u200cخواهم") == "می\u200cخواهم"  # Persian: ZWNJ inside a word
    assert clean("👩\u200d💻") == "👩\u200d💻"  # an emoji sequence
    assert clean("ライセンス · Mara’s iPad") == "ライセンス · Mara’s iPad"


def test_a_url_that_hides_a_character_is_not_linked() -> None:
    assert safe_link("https://key.plrs.im/\u202eportal") is None
    assert safe_link("https://key.plrs.im/\u200bportal") is None


@pytest.mark.parametrize("locale", ["en", "ja"])
@pytest.mark.parametrize("label,env", variants("dark"), ids=[v[0] for v in variants("dark")])
def test_nothing_hidden_reaches_the_screen(label: str, env: Any, locale: str) -> None:
    from polaris_key.ui.core import Theme

    k = Kit.create(env, theme=Theme(copy={"locale": locale}), product="tidewater", source=Spoof(), prog="tidewater")
    pal = k.palette()
    rows = (DeviceRow("dev_1", f"Work{SPOOF} laptop", "macOS", True, "today"),)
    screens_ = [
        screens.devices(k, DevicesView("Devices", "list", rows)),
        screens.gate(k, gate_view("ok", now=0, holder=f"Mara{SPOOF}", email=f"m{SPOOF}@x.test", signed_in=True, tier="Pro", term="Lifetime", version="2.4.1")),
        screens.device_limit(k, ActivateView("DeviceLimit", "browser-mode", "device-limit", "device_limit", "pkey_x_abcdefghijklmnop", 3, 3, f"https://key.plrs.im/\u202eportal/devices")),
    ]
    for lines in screens_:
        text = "\n".join(to_ansi(ln, pal) for ln in lines)
        assert not _HIDDEN.search(text), (label, locale, [hex(ord(c)) for c in _HIDDEN.findall(text)])
        assert "Tidewater Studio" in text
