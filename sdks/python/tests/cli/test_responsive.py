# @pkey-feature ui.cli
"""The Python terminal kit at every size a person may run it in (the owner's bar, 2026-10-08): 40,
60, 80 and 120 columns, each at 12 rows (a short "landscape" window) and 24, with long values (a
60-character product name, a 19-character code, a 110-character URL, a 60-character device label),
in German and Japanese at 40 and 60, and a terminal narrowed from 80 to 50 columns in the middle of
a live region (a real SIGWINCH). The terminal is pyte with soft-wrap marks and reflow
(``pyterm.py``), so a line wider than the screen, a cropped URL or a duplicated header fails here.

Every screen keeps: no line wider than the terminal (no soft-wrapped row); no "…" inside a URL or a
user code (each appears whole, wrapped at its own break points); no "..." crop; the code, the URL
and the key hints within the rows; one blank rail row between blocks, never two. The Node kit's
``test/cli/responsive.test.ts`` runs the same matrix through @xterm/headless.
"""

from __future__ import annotations

import signal
import threading
import time
from types import SimpleNamespace
from typing import Any, Callable, List, Optional

import pytest

from polaris_key.core.errors import PolarisError
from polaris_key.license.endpoints import ActivationDeviceLimit
from polaris_key.ui.core import Theme
from polaris_key.ui.terminal import flows
from polaris_key.ui.terminal.device import Device
from polaris_key.ui.terminal.env import layout_columns
from polaris_key.ui.terminal.flows import Terminal
from polaris_key.ui.terminal.parts import Kit
from polaris_key.ui.terminal.text import Span, break_pieces, wrap

from .fixtures import KEY, PRODUCT
from .golden_support import env
from .pyterm import Term

LONG = dict(
    name="Tidewater Studio Professional Mastering Suite for Podcasters",
    code="WDJB-MJHT-QXRP-LMNV",
    url="https://licensing.tidewater-studio-professional.example.com/activate/device?region=eu-west-2&channel=stable-26",
    device="Mara Fennick's 16-inch MacBook Pro (Studio B2, second floor)",
)
SHORT = dict(name="Tidewater Studio", code="WDJB-MJHT", url="https://key.plrs.im/device", device="Work laptop")
COLUMNS = (40, 60, 80, 120)
ROWS = (12, 24)


def shown(url: str) -> str:
    return url.split("://", 1)[-1]


class Source:
    """A presentation source with the product's name (HA-13's seam)."""

    def __init__(self, name: str) -> None:
        self.name = name

    def current(self) -> dict:
        return {"name": self.name, "developerName": "Harbor Audio", "accent": "#369186"}


class Script:
    """A scripted KeyReader: each read runs the next step (a key, or a function returning one)."""

    def __init__(self, steps: List[Any]) -> None:
        self.steps = list(steps)

    def __enter__(self) -> "Script":
        return self

    def __exit__(self, *exc: Any) -> None:
        pass

    def read(self, timeout: Optional[float] = None) -> Optional[str]:
        if not self.steps:
            if timeout is None:
                raise AssertionError("the flow waited for a key the script does not have")
            time.sleep(min(timeout, 0.01))
            return None
        step = self.steps.pop(0)
        return step() if callable(step) else step


def terminal(term: Term, values: dict, *, verb: str, keys: List[Any], locale: Optional[str] = None, device_code: bool = False, headless: bool = False) -> Terminal:
    cols, rows = term.size()
    e = env("truecolor", "unicode", 80, "dark").but(
        width=layout_columns(cols), columns=cols, height=rows, device_code=device_code, headless=headless or device_code
    )
    theme = Theme(copy={"locale": locale}) if locale else None
    k = Kit.create(e, theme=theme, product=PRODUCT, source=Source(values["name"]), prog="tidewater")
    d = Device(e, k.palette(), stdout=term, use_rich=False, size=term.size)  # type: ignore[arg-type]
    script = Script(keys)
    d.keys = lambda: script  # type: ignore[method-assign]
    d.open_url = lambda url: True  # type: ignore[method-assign]
    d.copy = lambda text: True  # type: ignore[method-assign]
    return Terminal(k, d, verb)


def joined(rows: List[str]) -> str:
    """The content column, rows joined: a URL or a code wrapped over rows reads whole."""
    return "".join(r[3:].rstrip() for r in rows)


def check(label: str, term: Term, view: List[str], *, code: Optional[str] = None, url: Optional[str] = None, hints: bool = False) -> None:
    rows = term.all()
    assert [t for t, w in rows if w] == [], f"{label}: a line wider than the terminal"
    text = "\n".join(t for t, _ in rows)
    assert "..." not in text, f'{label}: a "..." crop'
    body = joined(view)
    if code:
        assert code in body, f"{label}: the code is cut or off the screen:\n" + "\n".join(view)
    if url:
        assert shown(url) in body, f"{label}: the URL is cut or off the screen:\n" + "\n".join(view)
    if hints:
        assert any("Esc" in r for r in view), f"{label}: the key hints are off the screen:\n" + "\n".join(view)
    for i in range(1, len(rows)):
        assert not (rows[i][0] == "│" and rows[i - 1][0] == "│"), f"{label}: two blank rail rows:\n{text}"


class _Prompt:
    def __init__(self, v: dict) -> None:
        self.deviceCode = "dc"
        self.userCode = v["code"]
        self.verificationUri = v["url"]
        self.verificationUriComplete = v["url"] + ("&" if "?" in v["url"] else "?") + "code=" + v["code"]
        self.expiresIn = 600
        self.interval = 1
        self.expiresAt = int(time.time()) + 600


class _Identity:
    def __init__(self, v: dict) -> None:
        self.v = v

    def begin_sign_in(self, name: Any = None, confirm_identity: bool = False) -> _Prompt:
        return _Prompt(self.v)

    def wait_for_sign_in(self, prompt: Any, *, cancel: threading.Event, on_confirm: Any = None) -> Any:
        cancel.wait(10)
        raise PolarisError("cancelled", "cancelled")


def _client(v: dict, **extra: Any) -> Any:
    return SimpleNamespace(product=PRODUCT, identity=_Identity(v), status=lambda: SimpleNamespace(status="ok"), **extra)


def _snap(term: Term, into: List[List[str]], then: Any = "esc") -> Callable[[], Any]:
    def step() -> Any:
        into.append(term.viewport())
        return then

    return step


# ── The primitives ───────────────────────────────────────────────────────────────────────────


def test_a_url_breaks_after_slash_and_before_query_marks_and_keeps_every_character() -> None:
    url = shown(LONG["url"])
    for w in (8, 20, 37, 57):
        pieces = break_pieces(url, "url", w)
        assert "".join(pieces) == url and all(len(p) <= w for p in pieces)
    assert break_pieces("key.plrs.im/device?a=1&b=2", "url", 12) == ["key.plrs.im/", "device", "?a=1", "&b=2"]


def test_a_url_that_does_not_fit_starts_its_own_line_and_every_piece_keeps_the_link() -> None:
    link = Span(shown(LONG["url"]), ("link",), LONG["url"], "data:url", True)
    rows = wrap([Span("go to "), link, Span(" and enter this code.")], 37)
    assert "".join(s.text for s in rows[0]) == "go to"
    pieces = [s for r in rows for s in r if s.link]
    assert "".join(s.text for s in pieces) == shown(LONG["url"]) and all(s.link == LONG["url"] for s in pieces)
    assert not any("…" in s.text for r in rows for s in r)


def test_a_code_wraps_after_its_hyphens_only_where_the_line_is_too_narrow() -> None:
    code = Span(LONG["code"], ("code",), None, "data:code", True)
    assert ["".join(s.text for s in r) for r in wrap([code], 40)] == [LONG["code"]]
    assert break_pieces(LONG["code"], "code", 10) == ["WDJB-", "MJHT-", "QXRP-", "LMNV"]


def test_a_wrapped_line_never_ends_on_a_separator() -> None:
    sep = Span(" · ", ("muted",))
    spans = [Span("Enter", ("strong",)), Span(" open again", ("muted",)), sep, Span("c", ("strong",)), Span(" use a code", ("muted",)), sep, Span("Esc", ("strong",)), Span(" cancel", ("muted",))]
    assert ["".join(s.text for s in r) for r in wrap(spans, 37)] == ["Enter open again · c use a code", "Esc cancel"]


def test_the_long_values_fixture_is_the_one_the_owner_asked_for() -> None:
    assert [len(LONG[k]) for k in ("name", "code", "url", "device")] == [60, 19, 110, 60]


# ── The matrix ───────────────────────────────────────────────────────────────────────────────

MATRIX = [(c, r, v) for c in COLUMNS for r in ROWS for v in ("long", "short")]


def _values(name: str) -> dict:
    return LONG if name == "long" else SHORT


@pytest.mark.parametrize("cols,rows,values", MATRIX)
def test_login_device_code_keeps_the_code_the_url_and_the_keys_in_view(cols: int, rows: int, values: str) -> None:
    v = _values(values)
    term = Term(cols, rows)
    snaps: List[List[str]] = []
    t = terminal(term, v, verb="login", keys=[_snap(term, snaps)], device_code=True)
    out = flows.sign_in(_client(v), t)
    assert out.data == {"state": "cancelled"}
    check(f"login code {cols}x{rows} {values}", term, snaps[0], code=v["code"], url=v["url"], hints=True)
    text = "\n".join(snaps[0])
    assert "No browser" not in text, "a person who asked for a code is not told there is no browser"
    assert "Waiting for you to sign in" in text
    if rows <= 16:
        assert [r for r in snaps[0] if r == "│"] == [], "a short terminal has no blank rows"


@pytest.mark.parametrize("cols,rows,values", MATRIX)
def test_login_in_the_browser_keeps_the_fallback_url_and_the_keys_in_view(cols: int, rows: int, values: str) -> None:
    v = _values(values)
    term = Term(cols, rows)
    snaps: List[List[str]] = []
    t = terminal(term, v, verb="login", keys=[_snap(term, snaps)])
    flows.sign_in(_client(v), t)
    check(f"login {cols}x{rows} {values}", term, snaps[0], url=_Prompt(v).verificationUriComplete, hints=True)


@pytest.mark.parametrize("cols,rows,values", MATRIX)
def test_the_device_limit_keeps_the_manage_url_and_the_keys_in_view(cols: int, rows: int, values: str) -> None:
    v = _values(values)
    manage = v["url"].replace("activate/device", "portal/devices") if values == "long" else "https://key.plrs.im/portal/tidewater/devices"
    limit = ActivationDeviceLimit(limit=3, deviceCount=3, manage_url=manage)
    term = Term(cols, rows)
    snaps: List[List[str]] = []
    t = terminal(term, v, verb="activate", keys=[_snap(term, snaps)])
    client = SimpleNamespace(product=PRODUCT, license=SimpleNamespace(activate_with_key=lambda key: limit), status=lambda: None)
    flows.activate(client, t, KEY)
    check(f"device limit {cols}x{rows} {values}", term, snaps[0], url=manage, hints=True)


@pytest.mark.parametrize("cols,rows,values", MATRIX)
def test_offline_request_shows_the_qr_only_where_the_whole_screen_fits(cols: int, rows: int, values: str) -> None:
    v = _values(values)
    term = Term(cols, rows)
    t = terminal(term, v, verb="offline-request", keys=[])
    client = SimpleNamespace(product=PRODUCT, core=SimpleNamespace(device_id="dev_9fK2Lw7QmZ"))
    t.finish(flows.offline_request(client, t))
    all_rows = term.all()
    check(f"offline {cols}x{rows} {values}", term, [r for r, _ in all_rows][-rows:], code="dev_9fK2Lw7QmZ")
    qr = any("█" in r or "▀" in r for r, _ in all_rows)
    if qr:
        assert len(all_rows) < rows, "the QR pushed the header off the screen"
    if rows == 12:
        assert not qr


@pytest.mark.parametrize("cols,rows,values", MATRIX)
def test_status_devices_and_update_draw_nothing_wider_than_the_terminal(cols: int, rows: int, values: str) -> None:
    v = _values(values)
    term = Term(cols, rows)
    t = terminal(term, v, verb="status", keys=[])
    status = SimpleNamespace(
        status=lambda: SimpleNamespace(status="revoked", graceUntil=None, allowedRange=None),
        license=SimpleNamespace(get_profile=lambda: None),
        identity=SimpleNamespace(current=lambda: None),
        core=SimpleNamespace(version="2.4.1", channel="stable"),
        is_licensed=lambda: False,
    )
    t.finish(flows.status(status, t))
    t.verb = "devices"
    dev = SimpleNamespace(id="dev_9fK2Lw7QmZ", label=v["device"], platform="macOS 26", current=True)
    t.finish(flows.devices(SimpleNamespace(list_devices=lambda: [dev]), t, ["list"]))
    check(f"status/devices {cols}x{rows} {values}", term, [])
    text = "\n".join(r for r, _ in term.all())
    if cols < 50:
        assert "\n│  tidewater activate\n" in text, "below 50 columns a command stacks above its label"


@pytest.mark.parametrize("locale", ["de", "ja"])
@pytest.mark.parametrize("cols", [40, 60])
@pytest.mark.parametrize("rows", ROWS)
def test_german_and_japanese_keep_the_code_the_url_and_the_keys_in_view(locale: str, cols: int, rows: int) -> None:
    term = Term(cols, rows)
    snaps: List[List[str]] = []
    t = terminal(term, LONG, verb="login", keys=[_snap(term, snaps)], locale=locale, device_code=True)
    flows.sign_in(_client(LONG), t)
    check(f"{locale} login {cols}x{rows}", term, snaps[0], code=LONG["code"], url=LONG["url"], hints=True)


# ── A resize in the middle of a live region ──────────────────────────────────────────────────

needs_sigwinch = pytest.mark.skipif(not hasattr(signal, "SIGWINCH"), reason="no SIGWINCH on this platform")


def _resize(term: Term, cols: int, rows: int) -> None:
    """The window changes size: the terminal reflows, then the process gets SIGWINCH."""
    term.resize(cols, rows)
    signal.raise_signal(signal.SIGWINCH)


@needs_sigwinch
def test_a_resize_lays_the_sign_in_code_out_again_with_one_header() -> None:
    term = Term(80, 24)
    snaps: List[List[str]] = []

    def narrow() -> None:
        _resize(term, 50, 24)
        return None

    t = terminal(term, LONG, verb="login", keys=[narrow, _snap(term, snaps)], device_code=True)
    flows.sign_in(_client(LONG), t)
    check("resize login", term, snaps[0], code=LONG["code"], url=LONG["url"], hints=True)
    headers = [r for r in snaps[0] if "· login" in r]
    assert len(headers) == 1 and headers[0].startswith("┌") and "…" in headers[0], snaps[0]


@needs_sigwinch
def test_a_resize_redraws_the_progress_bar_in_place() -> None:
    term = Term(80, 24)
    mid: List[List[str]] = []
    decision = SimpleNamespace(action="binary", release=SimpleNamespace(version="2.5.0"), mandatory=False, to_dict=lambda: {"action": "binary"})

    def install(check: Any, on_progress: Callable[[int, int], None]) -> Any:
        on_progress(10_000_000, 61_000_000)
        _resize(term, 50, 24)
        mid.append(term.viewport())
        time.sleep(0.11)
        on_progress(40_000_000, 61_000_000)
        on_progress(61_000_000, 61_000_000)
        return SimpleNamespace(kind="restartRequired", version="2.5.0")

    update = SimpleNamespace(_configured=object(), driver=object(), decide=lambda channel=None: SimpleNamespace(decision=decision, channel="stable"), install=install)
    client = SimpleNamespace(product=PRODUCT, update=update, core=SimpleNamespace(version="2.4.1"))
    t = terminal(term, SHORT, verb="update", keys=[])
    t.finish(flows.update(client, t, ["apply"]))
    check("resize update (mid)", term, mid[0])
    assert len([r for r in mid[0] if "%" in r]) == 1, "one progress bar, never a stack"
    assert len([r for r in mid[0] if "· update" in r]) == 1, "one header"
    check("resize update (end)", term, [])
    assert len([r for r, _ in term.all() if "· update" in r]) == 1
