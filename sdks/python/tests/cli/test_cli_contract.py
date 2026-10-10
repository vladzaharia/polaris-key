# @pkey-feature ui.cli.contract
"""The Python terminal kit against the ``cli`` family of conformance/corpus/v2/ui-matrix.json
(plans/UK-51.md): every row of its ``exit``, ``capabilities``, ``stdin`` and ``outcomes`` sections.
The ``mount``, ``help`` and ``gate`` rows are the adapters' (UK-48 runs them when it mounts the
verbs into a host CLI and gates its commands).

A row the kit does not pass yet is listed in :data:`PENDING` with the work package that brings the
kit to it, and runs as a strict xfail: it still runs, and the day it passes the test fails until
the entry goes. Nothing is skipped (AGENTS.md rule 1)."""

from __future__ import annotations

import io
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional

import pytest

from polaris_key.constants_generated import UI_MATRIX_VERSION
from polaris_key.core.errors import PolarisError
from polaris_key.license.endpoints import ActivationDeviceLimit, ActivationOk, ActivationUnauthorized
from polaris_key.ui import ansi
from polaris_key.ui.core import Copy
from polaris_key.ui.terminal import flows
from polaris_key.ui.terminal.device import Device
from polaris_key.ui.terminal.env import detect
from polaris_key.ui.terminal.exit import EXIT
from polaris_key.ui.terminal.flows import Terminal

from .fixtures import kit
from .golden_support import env

ROOT = Path(__file__).resolve().parents[4]
MATRIX = json.loads((ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8"))
CLI = MATRIX["cli"]
C = Copy("en")
GLYPH = ansi.SYMBOLS["unicode"]
_ESC = re.compile(r"\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)")

#: Rows of the ``cli`` family the Python kit does not pass yet, by section and row name, each with
#: what is missing. UK-48 (the Python terminal kit as a mountable drop-in) owns every one.
PENDING: Dict[str, Dict[str, str]] = {
    "capabilities": {
        "CI=0 is not CI": "CI is truthy only for a value other than 0 and false (UK-48).",
        "CI=false is not CI": "CI is truthy only for a value other than 0 and false (UK-48).",
        "GITHUB_ACTIONS": "GITHUB_ACTIONS counts as CI (UK-48).",
        "BUILDKITE": "BUILDKITE counts as CI (UK-48).",
        "FORCE_COLOR on a pipe: colour, never links": "OSC 8 links only on a TTY stdout (UK-48).",
        "animation follows stdout, not stdin": "animation follows a TTY stdout, not stdin (UK-48).",
    },
    "stdin": {
        "a terminal that cannot prompt: no key": "activate says cli.activate.noKey, not a usage line (UK-48).",
        "a file: its first line": "activate reads a piped key without --key-stdin (UK-48).",
        "a file: the first non-empty line": "activate reads a piped key without --key-stdin (UK-48).",
        "an empty file: no key": "activate says cli.activate.noKeyPiped (UK-48).",
        "a shell pipe left open: the line, without waiting for the writer": "activate reads a piped key without --key-stdin (UK-48).",
        "a socket left open: the line, without waiting for the writer": "activate reads a piped key without --key-stdin (UK-48).",
        "a silent open pipe: no key within the bound, and the process exits": "activate says cli.activate.noKeyPiped (UK-48).",
        "a silent open socket: no key within the bound, and the process exits": "activate says cli.activate.noKeyPiped (UK-48).",
        "/dev/null: never read": "activate says cli.activate.noKeyPiped (UK-48).",
    },
    "outcomes": {
        "secret-hidden": "secret and mint take --reveal; without it they print nothing on stdout and exit 2 (UK-48).",
        "mint-hidden": "secret and mint take --reveal; without it they print nothing on stdout and exit 2 (UK-48).",
    },
}


def _rows(section: str) -> List[Any]:
    out = []
    for r in CLI[section]:
        why = PENDING.get(section, {}).get(r["name"])
        marks = [pytest.mark.xfail(strict=True, reason=why)] if why else []
        out.append(pytest.param(r, id=r["name"], marks=marks))
    return out


def plain(text: str) -> str:
    return _ESC.sub("", text)


def test_pending_names_real_rows() -> None:
    for section, names in PENDING.items():
        known = {r["name"] for r in CLI[section]}
        assert set(names) <= known, f"{section}: {set(names) - known}"


# ── version and exit ─────────────────────────────────────────────────────────────────────────


def test_the_version_is_this_sdks() -> None:
    assert MATRIX["uiMatrixVersion"] == UI_MATRIX_VERSION


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(w.title() for w in rest)


def test_the_exit_table_is_the_family_s() -> None:
    assert {_camel(k): v for k, v in EXIT._asdict().items()} == CLI["exit"]
    assert EXIT.license_required == 4


# ── capabilities ─────────────────────────────────────────────────────────────────────────────


class _Stream(io.StringIO):
    def __init__(self, tty: bool) -> None:
        super().__init__()
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


@pytest.mark.parametrize("row", _rows("capabilities"))
def test_capabilities(row: Dict[str, Any]) -> None:
    i = row["input"]
    flags = i["flags"]
    e = detect(
        env=i["env"],
        stdout=_Stream(i["stdout"] == "tty"),
        stdin=_Stream(i["stdin"] == "tty"),
        no_color=flags.get("color") is False,
        ascii=bool(flags.get("ascii")),
        json=bool(flags.get("json")),
        platform="linux",
        size=lambda: os.terminal_size((100, 30)),
        osc11=lambda: None,
    )
    got = {
        "color": e.color,
        "unicode": e.symbols == "unicode",
        "interactive": e.interactive,
        "animate": e.motion,
        "links": e.hyperlinks,
    }
    assert got == row["expect"]


# ── stdin ────────────────────────────────────────────────────────────────────────────────────

FLOW = Path(__file__).with_name("stdin_flow.py")


def _run_flow(stdin: Any, expect_key: str, feed: Optional[Callable[[], None]] = None) -> Dict[str, Any]:
    t0 = time.monotonic()
    proc = subprocess.Popen(
        [sys.executable, str(FLOW)],
        stdin=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "PKEY_EXPECT_KEY": expect_key, "NO_COLOR": "1"},
    )
    if feed:
        feed()
    try:
        out, _ = proc.communicate(timeout=15)
        killed = False
    except subprocess.TimeoutExpired:
        proc.kill()
        out, _ = proc.communicate()
        killed = True
    text = out.decode("utf-8", "replace")
    m = re.search(r"RESULT (\d+) \S+ (\S+) (\S+) (\d+)", text)
    return {
        "code": proc.returncode,
        "error": m.group(2) if m else "",
        "got": m.group(3) if m else "",
        "ms": int(m.group(4)) if m else -1,
        "wall_ms": int((time.monotonic() - t0) * 1000),
        "out": plain(text),
        "killed": killed,
    }


def _text(lines: Optional[List[str]]) -> bytes:
    return "".join(f"{ln}\n" for ln in (lines or [])).encode()


def _stdin_row(row: Dict[str, Any]) -> Dict[str, Any]:
    kind, lines = row["input"]["stdin"], row["input"]["lines"]
    key = row["expect"].get("key", "")
    if kind == "file":
        with tempfile.NamedTemporaryFile() as f:
            f.write(_text(lines))
            f.flush()
            with open(f.name, "rb") as fd:
                return _run_flow(fd, key)
    if kind == "fifo":
        # An os.pipe is a FIFO: the test holds the write end open until the process has exited.
        rd, wr = os.pipe()
        try:
            if lines is not None:
                os.write(wr, _text(lines))
            return _run_flow(rd, key)
        finally:
            os.close(wr)
            os.close(rd)
    if kind == "socket":
        parent, child = socket.socketpair()
        try:
            if lines is not None:
                parent.sendall(_text(lines))
            return _run_flow(child.fileno(), key)
        finally:
            parent.close()
            child.close()
    if kind == "char-device":
        with open(os.devnull, "rb") as fd:
            return _run_flow(fd, key)
    raise AssertionError(f"no real-process run for stdin {kind}")


class _Keys:
    """A scripted KeyReader: each read returns the next key, then raises what ``end`` is."""

    def __init__(self, keys: List[str], end: Optional[BaseException] = None) -> None:
        self.keys = list(keys)
        self.end = end

    def __enter__(self) -> "_Keys":
        return self

    def __exit__(self, *exc: Any) -> None:
        pass

    def read(self, timeout: Optional[float] = None) -> Optional[str]:
        if self.keys:
            return self.keys.pop(0)
        if self.end is not None:
            raise self.end
        if timeout is None:
            raise AssertionError("the flow waited for a key the script does not have")
        time.sleep(min(timeout, 0.01))
        return None


def _terminal(verb: str, *, json_mode: bool = False, interactive: bool = False, keys: Optional[_Keys] = None, headless: bool = False) -> Terminal:
    """The terminal of every row: a TTY 80 columns wide, Unicode, no colour (the marks are glyphs)."""
    e = env("none", "unicode", 80, "dark").but(
        json=json_mode, interactive=interactive and not json_mode, motion=False, headless=headless
    )
    k = kit(e)
    d = Device(e, k.palette(), stdout=io.StringIO(), use_rich=False)
    if keys is not None:
        d.keys = lambda: keys  # type: ignore[method-assign]
    d.open_url = lambda url: True  # type: ignore[method-assign]
    d.copy = lambda text: True  # type: ignore[method-assign]
    return Terminal(k, d, verb)


class _ActivateClient:
    product = "tidewater"

    def __init__(self, result: Any = None) -> None:
        self.license = SimpleNamespace(activate_with_key=lambda key: result or ActivationOk(token="pkeyt_secret"))

    def status(self) -> Any:
        return SimpleNamespace(status="ok")


@pytest.mark.parametrize("row", _rows("stdin"))
def test_stdin(row: Dict[str, Any]) -> None:
    kind, e = row["input"]["stdin"], row["expect"]
    if kind in ("tty", "tty-noninteractive"):
        from polaris_key.cli import verbs

        tty = _Stream(True)
        term = detect(env={"TERM": "xterm-256color", **({"CI": "true"} if kind == "tty-noninteractive" else {})}, stdout=tty, stdin=tty, size=lambda: os.terminal_size((80, 30)), osc11=lambda: None)
        t = _terminal("activate", interactive=term.interactive, keys=_Keys(["esc"]))
        verb = next(v for v in verbs.VERBS if v.name == "activate")
        ns = dict(verbs.namespace(verb, [], {}), _term=t)
        result = verb.run(_ActivateClient(), ns)
        screen = plain(t.device.out.getvalue() + "\n".join(result.lines))
        if e["read"] == "prompt":
            assert C("part.keyField.label") in screen
            assert result.code == EXIT.failed and result.data.get("kind") == "cancelled"
        else:
            assert result.code == e["exit"] and result.data.get("error") == e["error"]
            for key in e.get("copy", []):
                assert C(key, command="tidewater activate") in screen
        return
    ran = _stdin_row(row)
    assert not ran["killed"], "the process ended by itself"
    if e["read"] == "key":
        assert ran["got"] == "key" and ran["code"] == EXIT.ok
        assert ran["wall_ms"] < 10_000, "the line was read without waiting for the writer"
    else:
        assert ran["got"] == "none"
        assert ran["code"] == e["exit"] and ran["error"] == e["error"]
        for key in e.get("copy", []):
            assert C(key) in ran["out"]
        if "withinMs" in e:
            assert ran["ms"] < e["withinMs"] + 1000


# ── outcomes ─────────────────────────────────────────────────────────────────────────────────


class _StatusClient:
    product = "tidewater"

    def __init__(self, status: str) -> None:
        self._status = status
        who = SimpleNamespace(name="Mara Fennick", email="mara@fennick.studio")
        self.license = SimpleNamespace(get_profile=lambda: who, license_info=lambda: SimpleNamespace(tier="pro", tierLabel="Pro"))
        self.identity = SimpleNamespace(current=lambda: who)
        self.core = SimpleNamespace(version="2.4.1", channel="stable")

    def status(self) -> Any:
        return SimpleNamespace(status=self._status, graceUntil=None, allowedRange=None)

    def is_licensed(self) -> bool:
        return self._status in ("ok", "grace", "not-applicable")


class _Identity:
    def begin_sign_in(self, name: Any = None, confirm_identity: bool = False) -> Any:
        return SimpleNamespace(
            deviceCode="dc",
            userCode="WDJB-MJHT",
            verificationUri="https://key.plrs.im/device",
            verificationUriComplete="https://key.plrs.im/device?user_code=WDJB-MJHT",
            expiresIn=600,
            interval=1,
            expiresAt=int(time.time()) + 600,
        )

    def wait_for_sign_in(self, prompt: Any, *, cancel: Any, on_confirm: Any = None) -> Any:
        cancel.wait(5)
        raise PolarisError("cancelled", "cancelled")


def _offline() -> Any:
    raise PolarisError("network", "offline")


KEY = "pkey_tidewater_7Q2MzK8vRb1xLp4n3WPLDA"

#: Each situation (vocabulary.cli.situations): the flow, its client and its keys.
SITUATIONS: Dict[str, Callable[[Terminal], Any]] = {
    "status-revoked": lambda t: flows.status(_StatusClient("revoked"), t),
    "status-expired": lambda t: flows.status(_StatusClient("expired"), t),
    "status-version-too-old": lambda t: flows.status(_StatusClient("version-too-old"), t),
    "status-version-too-new": lambda t: flows.status(_StatusClient("version-too-new"), t),
    "network": lambda t: flows.devices(SimpleNamespace(product="tidewater", list_devices=_offline), t, ["list"]),
    "key-refused": lambda t: flows.activate(_ActivateClient(ActivationUnauthorized()), t, KEY),
    "device-limit": lambda t: flows.activate(
        _ActivateClient(ActivationDeviceLimit(limit=3, deviceCount=3, manage_url="https://key.plrs.im/portal/tidewater/devices")), t, KEY
    ),
    "secret-hidden": lambda t: flows.secret(SimpleNamespace(config=SimpleNamespace(get_secret=lambda k: "s3cr3t")), t, ["api_key"]),
    "mint-hidden": lambda t: flows.mint(
        SimpleNamespace(config=SimpleNamespace(mint_token=lambda r: SimpleNamespace(token="tok_live", expiresAt=1))), t, ["cdn"]
    ),
    "usage": lambda t: flows.devices(SimpleNamespace(product="tidewater"), t, ["rename"]),
    "interrupt": lambda t: flows.activate(_ActivateClient(), t, None),
    "sign-in-cancelled": lambda t: flows.sign_in(SimpleNamespace(product="tidewater", identity=_Identity()), t),
}

#: The keys an interactive situation is given once it waits.
KEYS: Dict[str, Callable[[], _Keys]] = {
    "interrupt": lambda: _Keys([], end=KeyboardInterrupt()),
    "sign-in-cancelled": lambda: _Keys(["esc"]),
}


def _fix_verbs(screen: str) -> List[str]:
    from polaris_key.cli.verbs import VERB_NAMES

    ids = sorted({*VERB_NAMES, "update apply", "update check", "devices list", "devices rename", "devices deauthorize"}, key=len, reverse=True)
    found = set()
    for line in screen.splitlines():
        m = re.search(r"tidewater ([a-z-]+(?: [a-z-]+)?)(?:\s{2,}|$)", line)
        if not m:
            continue
        hit = next((v for v in ids if m.group(1) == v or m.group(1).startswith(v + " ")), None)
        if hit:
            found.add(hit)
    return sorted(found)


@pytest.mark.parametrize("row", _rows("outcomes"))
def test_outcomes(row: Dict[str, Any]) -> None:
    i, e = row["input"], row["expect"]
    situation = i["situation"]
    keys = KEYS[situation]() if situation in KEYS else None
    t = _terminal(i["verb"], json_mode=i["json"], interactive=keys is not None, keys=keys)
    out = SITUATIONS[situation](t)
    t.finish(out)
    stdout = t.device.out.getvalue()
    shown = plain(stdout)
    assert out.code == e["exit"]
    if e.get("mark"):
        assert GLYPH[e["mark"]] in shown
        if e["mark"] == "warn":
            assert GLYPH["fail"] not in shown
        if e["mark"] == "fail":
            assert GLYPH["warn"] not in shown
    lines = [ln for ln in stdout.splitlines() if ln.strip()]
    fields = json.loads(lines[-1]) if i["json"] else out.data
    if "error" in e:
        assert fields.get("error") == e["error"]
    if "code" in e:
        assert fields.get("code") == e["code"]
    if e.get("stdout") == "empty":
        assert stdout == ""
    if e.get("stdout") == "screen":
        assert shown.strip() != ""
    if e.get("stdout") == "result":
        assert all(json.loads(ln)["v"] == 1 for ln in lines)
        assert fields["event"] == "result" and fields["exit"] == e["exit"] and fields["ok"] is (e["exit"] == 0)
    if "fix" in e:
        assert _fix_verbs(shown) == sorted(e["fix"])
