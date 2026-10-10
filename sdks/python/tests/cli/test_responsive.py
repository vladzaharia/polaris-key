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

import re
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
COLUMNS = (24, 28, 32, 40, 60, 80, 120)
ROWS = (8, 10, 12, 16, 17, 24)


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


def terminal(
    term: Term,
    values: dict,
    *,
    verb: str,
    keys: List[Any],
    locale: Optional[str] = None,
    device_code: bool = False,
    headless: bool = False,
    cpr: bool = True,
) -> Terminal:
    cols, rows = term.size()
    e = env("truecolor", "unicode", 80, "dark").but(
        width=layout_columns(cols), columns=cols, height=rows, device_code=device_code, headless=headless or device_code
    )
    theme = Theme(copy={"locale": locale}) if locale else None
    k = Kit.create(e, theme=theme, product=PRODUCT, source=Source(values["name"]), prog="tidewater")
    # The terminal answers a cursor-position request from where its cursor is, or stays silent.
    d = Device(e, k.palette(), stdout=term, use_rich=False, size=term.size, cursor_row=(lambda: term.screen.cursor.y + 1) if cpr else None)  # type: ignore[arg-type]
    script = Script(keys)
    d.keys = lambda: script  # type: ignore[method-assign]
    d.open_url = lambda url: True  # type: ignore[method-assign]
    d.copy = lambda text: True  # type: ignore[method-assign]
    return Terminal(k, d, verb)


def joined(rows: List[str]) -> str:
    """The content column, rows joined: a URL or a code wrapped over rows reads whole."""
    return "".join((r[3:] if re.match(r"^[│┌└◆◇✓✗▲] ", r) else r).rstrip() for r in rows)


def check(label: str, term: Term, view: List[str], *, code: Optional[str] = None, url: Optional[str] = None, hints: bool = False) -> None:
    rows = term.all()
    assert [t for t, w in rows if w] == [], f"{label}: a line wider than the terminal"
    text = "\n".join(t for t, _ in rows)
    assert "..." not in text, f'{label}: a "..." crop'
    body = joined(view)
    if code:
        assert code in body, f"{label}: the code is cut or off the screen:\n" + "\n".join(view)
    m = re.search(r"(\d+)x(\d+)", label)
    # Under 32 columns a URL needs most of the screen: below 12 rows it scrolls past, by design.
    tiny = bool(m) and int(m.group(1)) <= 32 and int(m.group(2)) < 12
    if url and not tiny:
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
    def __init__(self, v: dict, result: Any = None, delay: float = 0.4) -> None:
        self.v = v
        self.result = result
        self.delay = delay

    def begin_sign_in(self, name: Any = None, confirm_identity: bool = False) -> _Prompt:
        return _Prompt(self.v)

    def wait_for_sign_in(self, prompt: Any, *, cancel: threading.Event, on_confirm: Any = None) -> Any:
        if self.result is not None:
            if cancel.wait(self.delay):
                raise PolarisError("cancelled", "cancelled")
            return self.result
        cancel.wait(10)
        raise PolarisError("cancelled", "cancelled")


def _client(v: dict, result: Any = None, **extra: Any) -> Any:
    return SimpleNamespace(product=PRODUCT, identity=_Identity(v, result), status=lambda: SimpleNamespace(status="ok"), **extra)


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


def test_a_url_that_does_not_fit_starts_its_own_line_with_its_lead_in_and_keeps_the_link() -> None:
    link = Span(shown(LONG["url"]), ("link",), LONG["url"], "data:url", True)
    rows = wrap([Span("On any phone or computer, go to "), link, Span(" and enter this code.")], 37)
    assert "".join(s.text for s in rows[0]).rstrip() == "On any phone or computer,"
    # The short lead-in "go to" moves onto the URL's line.
    assert "".join(s.text for s in rows[1]).startswith("go to ")
    pieces = [s for r in rows for s in r if s.link]
    assert "".join(s.text for s in pieces) == shown(LONG["url"]) and all(s.link == LONG["url"] for s in pieces)
    assert not any("…" in s.text for r in rows for s in r)


def test_a_keep_unit_moves_whole_and_the_separator_before_it_is_dropped() -> None:
    def t(spans, w):
        return ["".join(s.text for s in l).rstrip() for l in wrap(spans, w)]

    assert t([Span("License   "), Span("Pro license"), Span(" · ", ("muted",)), Span("mara@fennick.studio", unit=True)], 37) == [
        "License   Pro license",
        "mara@fennick.studio",
    ]
    assert t([Span("Signed in as "), Span("Mara Fennick", unit=True), Span(" · ", ("muted",)), Span("mara@fennick.studio", unit=True)], 37) == [
        "Signed in as Mara Fennick",
        "mara@fennick.studio",
    ]


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


def test_a_live_screen_taller_than_the_terminal_compacts_in_tier_order() -> None:
    from polaris_key.ui.terminal.screen import fit_screen, inline_hints
    from polaris_key.ui.terminal.text import DROP, Line

    def row(text: str, drop=None, role=None, hint_spans=None) -> Line:
        return Line([Span(text)], drop, role, hint_spans)

    lines = [
        row("header", role="header"),
        row("", DROP["blank_prose"]),
        row("go to url"),
        row("", DROP["blank_code"]),
        row("CODE"),
        row("", DROP["blank_code"]),
        row("check", DROP["check"]),
        row("expires", DROP["countdown"]),
        row("hints"),
    ]

    def fit(n: int):
        return [ln.text for ln in fit_screen(lines, n, 40, "·").lines]

    assert len(fit(9)) == 9
    assert fit(8) == ["header", "go to url", "", "CODE", "", "check", "expires", "hints"]
    assert "check" not in fit(6) and "expires" in fit(6)
    assert fit(5) == ["header", "go to url", "CODE", "expires", "hints"]
    # Never the URL line, the code or the hints; the top lines leave the view last.
    assert fit(3) == ["go to url", "CODE", "hints"]
    spinner = Line([Span("Waiting")], role="spinner")
    hints = Line([Span("Esc cancel")], role="hints", hint_spans=[Span("Esc cancel")])
    merged = inline_hints([row("a"), spinner, hints], 80, "·")
    assert [ln.text for ln in merged] == ["a", "Waiting · Esc cancel"]
    assert len(inline_hints([row("a"), spinner, hints], 12, "·")) == 3


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
    if rows >= 12 or cols > 32:  # the waiting line is the first thing to go on a tiny window
        assert "Waiting for you to sign in" in re.sub(r"\s+", " ", text)
    # The screen is laid out spaced when it fits; it compacts only when it does not.
    assert len([r for r in snaps[0] if r.strip()]) <= rows
    if rows >= 24 and cols >= 60 and values == "short":
        assert [r for r in snaps[0] if r == "│"], "a screen that fits keeps its air"
    if rows == 12 and cols >= 80 and values == "short":
        assert [r for r in snaps[0] if r == "│"], "80x12 with short values keeps the air around the code"


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
        assert re.search(r"^(│  )?tidewater activate$", text, re.M), "below 50 columns a command stacks above its label"


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
    headers = [r for r in snaps[0] if r.startswith("┌")]
    # One header: the verb suffix gave way first, then the name's end.
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


# ── Help ─────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("cols", COLUMNS)
def test_help_never_runs_past_the_terminal_and_stacks_below_50_columns(cols: int, monkeypatch: pytest.MonkeyPatch) -> None:
    import io
    import os as _os

    from polaris_key.cli.argparse_cli import build_parser
    from polaris_key.ui.terminal import env as envmod

    real = envmod.detect

    class Tty(io.StringIO):
        def isatty(self) -> bool:
            return True

    monkeypatch.setattr(envmod, "detect", lambda **kw: real(env={"NO_COLOR": "1"}, stdout=Tty(), size=lambda: _os.terminal_size((cols, 24)), **kw))
    text = build_parser().format_help()
    term = Term(cols, 24)
    term.write(text)
    assert [t for t, w in term.all() if w] == [], f"help {cols}: a line wider than the terminal"
    if cols < 50:
        import re as _re

        assert "\n  activate\n    Add a license key" in _re.sub(r"\x1b\[[0-9;]*m", "", text)


@pytest.mark.parametrize("cols", [24, 32, 40, 80])
def test_every_verbs_help_never_runs_past_the_terminal(cols: int, monkeypatch: pytest.MonkeyPatch) -> None:
    import io
    import os as _os

    from polaris_key.cli import verbs
    from polaris_key.cli.argparse_cli import build_parser
    from polaris_key.ui.terminal import env as envmod

    real = envmod.detect

    class Tty(io.StringIO):
        def isatty(self) -> bool:
            return True

    monkeypatch.setattr(envmod, "detect", lambda **kw: real(env={"NO_COLOR": "1"}, stdout=Tty(), size=lambda: _os.terminal_size((cols, 24)), **kw))
    parser = build_parser()
    sub = next(a for a in parser._actions if isinstance(a, __import__("argparse")._SubParsersAction))
    assert sub.choices, "no verbs found"
    for name, vp in sub.choices.items():
        term = Term(cols, 24)
        term.write(vp.format_help())
        assert [t for t, w in term.all() if w] == [], f"{name} --help at {cols}: a line wider than the terminal"


# ── A window dragged through several sizes, and the end states ───────────────────────────────

DRAGS = [
    ((80, 24), [(40, 12)]),
    ((120, 40), [(40, 12)]),
    ((60, 24), [(60, 10)]),
    ((80, 24), [(80, 12)]),
    ((40, 12), [(120, 40)]),
    ((80, 24), [(32, 10), (110, 30)]),
]


@needs_sigwinch
@pytest.mark.parametrize("start,steps", DRAGS, ids=lambda x: "x".join(map(str, x)) if isinstance(x, tuple) else "-".join("x".join(map(str, s)) for s in x))
@pytest.mark.parametrize("values", ["short", "long"])
def test_a_dragged_window_keeps_one_screen_the_url_and_the_code(start: Any, steps: Any, values: str) -> None:
    v = _values(values)
    term = Term(*start)
    snaps: List[List[str]] = []
    keys: List[Any] = []
    for c, r in steps:
        keys += [lambda c=c, r=r: _resize(term, c, r), lambda: None]
    keys.append(_snap(term, snaps, then=None))
    t = terminal(term, v, verb="login", keys=keys, device_code=True)
    out = flows.sign_in(_client(v, SimpleNamespace(status="expired")), t)
    t.finish(out)
    last = steps[-1]
    assert len(snaps[0]) <= last[1]
    # What is on the screen: nothing wider than the window, the URL and the code whole.
    body = joined(snaps[0])
    assert v["code"] in body and shown(v["url"]) in body, snaps[0]
    assert any("Esc" in r for r in snaps[0])
    assert len([r for r in snaps[0] if r.startswith("┌")]) <= 1
    # After the outcome: one header in all, nothing of the code view left on the screen.
    end = [t_ for t_, _ in term.all()]
    assert len([r for r in end if r.startswith("┌")]) == 1, "\n".join(end)
    assert "Waiting for you to sign in" not in "\n".join(term.viewport())


# ── A window shrunk and then grown again ─────────────────────────────────────────────────────


def _tidy(rows: List[str]) -> str:
    return re.sub(r"[\u2800-\u28ff]", "*", re.sub(r"\d+:\d\d", "m:ss", "\n".join(r.rstrip() for r in rows).rstrip()))


REGROWS = [
    [(80, 24), (60, 10), (80, 24)],
    [(80, 24), (32, 10), (110, 30)],
]


@needs_sigwinch
@pytest.mark.parametrize("sizes", REGROWS, ids=lambda x: "-".join("x".join(map(str, s)) for s in x))
@pytest.mark.parametrize("cpr", [True, False], ids=["cpr", "no-cpr"])
@pytest.mark.parametrize("values", ["short", "long"])
def test_a_window_grown_after_a_shrink_shows_a_fresh_launchs_screen_once(sizes: Any, cpr: bool, values: str) -> None:
    v = _values(values)
    term = Term(*sizes[0])
    snaps: List[List[str]] = []
    keys: List[Any] = []
    for c, r in sizes[1:]:
        keys += [lambda c=c, r=r: _resize(term, c, r), lambda: None]
    everything: List[List[str]] = []
    keys.append(lambda: everything.append([r for r, _ in term.all()]))
    keys.append(_snap(term, snaps, then=None))
    t = terminal(term, v, verb="login", keys=keys, device_code=True, cpr=cpr)
    out = flows.sign_in(_client(v, SimpleNamespace(status="expired")), t)
    fresh = Term(*sizes[-1])
    fresh_snaps: List[List[str]] = []
    tf = terminal(fresh, v, verb="login", keys=[_snap(fresh, fresh_snaps)], device_code=True)
    flows.sign_in(_client(v), tf)
    assert _tidy(snaps[0]) == _tidy(fresh_snaps[0])
    # The title of the code view is on the screen once, not once more from the rows that came back.
    assert everything[0].count("◆  Sign in with a code") == 1, "\n".join(everything[0])
    t.finish(out)
    assert len([r for r, _ in term.all() if r.startswith("┌")]) == 1, "\n".join(r for r, _ in term.all())


@needs_sigwinch
@pytest.mark.parametrize("cpr", [True, False], ids=["cpr", "no-cpr"])
def test_the_device_limit_shrunk_and_grown_again_shows_a_fresh_launchs_screen(cpr: bool) -> None:
    def run(term: Term, steps: List[Any], use_cpr: bool = True) -> List[List[str]]:
        snaps: List[List[str]] = []
        limit = ActivationDeviceLimit(limit=3, deviceCount=3, manage_url=LONG["url"].replace("activate/device", "portal/devices"))
        t = terminal(term, LONG, verb="activate", keys=[*steps, _snap(term, snaps)], cpr=use_cpr)
        client = SimpleNamespace(product=PRODUCT, license=SimpleNamespace(activate_with_key=lambda key: limit), status=lambda: None)
        t.finish(flows.activate(client, t, KEY))
        return snaps

    term = Term(80, 24)
    shrink = [lambda: _resize(term, 40, 8), lambda: None, lambda: _resize(term, 80, 24), lambda: None]
    got = run(term, shrink, cpr)
    fresh = run(Term(80, 24), [])
    assert _tidy(got[0]) == _tidy(fresh[0])
    assert len([r for r, _ in term.all() if r.startswith("┌")]) == 1


@pytest.mark.parametrize("cols,rows", [(40, 12), (32, 12), (40, 8), (80, 24)])
@pytest.mark.parametrize(
    "label,result,title",
    [
        ("expired", SimpleNamespace(status="expired"), "Code expired"),
        ("declined", SimpleNamespace(status="error", message="access_denied"), "Sign-in declined"),
        ("signed in", SimpleNamespace(status="ready", identity=SimpleNamespace(name="Mara Fennick", email="mara@fennick.studio"), attached=None), "Signed in as Mara Fennick"),
    ],
)
def test_an_end_state_leaves_one_result_block_under_one_header(cols: int, rows: int, label: str, result: Any, title: str) -> None:
    term = Term(cols, rows)
    t = terminal(term, LONG, verb="login", keys=[], device_code=True)
    out = flows.sign_in(_client(LONG, result), t)
    t.finish(out)
    text = "\n".join(r for r, _ in term.all())
    assert [r for r, w in term.all() if w] == []
    assert len([r for r, _ in term.all() if r.startswith("┌")]) <= 1
    assert title.split(" ")[0] in text.replace("\n", " ")
    assert "Check the code there" not in text and "On any phone or computer" not in text


@pytest.mark.parametrize("cols,rows,values", [(40, 12, "long"), (40, 8, "short"), (32, 12, "long")])
def test_the_device_limit_left_with_esc_keeps_its_header_title_and_closing_row(cols: int, rows: int, values: str) -> None:
    v = _values(values)
    url = v["url"].replace("activate/device", "portal/devices") if values == "long" else "https://key.plrs.im/portal/tidewater/devices"
    limit = ActivationDeviceLimit(limit=3, deviceCount=3, manage_url=url)
    term = Term(cols, rows)
    t = terminal(term, v, verb="activate", keys=["esc"])
    client = SimpleNamespace(product=PRODUCT, license=SimpleNamespace(activate_with_key=lambda key: limit), status=lambda: None)
    t.finish(flows.activate(client, t, KEY))
    all_rows = [r for r, _ in term.all()]
    text = "\n".join(all_rows)
    assert len([r for r in all_rows if r.startswith("┌")]) == 1
    assert "Your license is on 3 of" in text and all_rows[-1].startswith("└"), text
    assert "try again here" not in text and "Free a device, then run" in text
    assert [r for r, w in term.all() if w] == []


@pytest.mark.parametrize("cols", [40, 60, 80])
def test_a_signed_in_name_is_one_unit(cols: int) -> None:
    term = Term(cols, 24)
    t = terminal(term, SHORT, verb="login", keys=[], device_code=True)
    result = SimpleNamespace(status="ready", identity=SimpleNamespace(name="Mara Fennick", email="mara@fennick.studio"), attached=None)
    t.finish(flows.sign_in(_client(SHORT, result), t))
    rows = [r for r, _ in term.all()]
    assert any("Mara Fennick" in r for r in rows), "\n".join(rows)


def test_the_end_of_a_flow_draws_no_empty_closing_row() -> None:
    term = Term(80, 24)
    t = terminal(term, SHORT, verb="status", keys=[])
    t.finish(flows.status(_status_client("ok"), t))
    assert "└" not in [r for r, _ in term.all()] and term.all()[-1][0].startswith("✓")
    term = Term(80, 24)
    t = terminal(term, SHORT, verb="login", keys=[], device_code=True, headless=True)
    result = SimpleNamespace(status="ready", identity=SimpleNamespace(name=None, email="mara@fennick.studio"), attached=None)
    t.finish(flows.sign_in(_client(SHORT, result), t))
    assert term.all()[-1][0].startswith("✓") and "└" not in [r for r, _ in term.all()]


def test_an_update_cancelled_with_esc_says_so_in_a_title_and_a_body_line() -> None:
    term = Term(80, 24)
    decision = SimpleNamespace(action="binary", release=SimpleNamespace(version="2.5.0"), mandatory=False, to_dict=lambda: {"action": "binary"})

    def install(check: Any, on_progress: Callable[[int, int], None]) -> Any:
        on_progress(10_000_000, 61_000_000)
        raise PolarisError("cancelled", "cancelled")

    update = SimpleNamespace(_configured=object(), driver=object(), decide=lambda channel=None: SimpleNamespace(decision=decision, channel="stable"), install=install)
    client = SimpleNamespace(product=PRODUCT, update=update, core=SimpleNamespace(version="2.4.1"))
    t = terminal(term, SHORT, verb="update", keys=[])
    t.finish(flows.update(client, t, ["apply"]))
    rows = [r for r, _ in term.all()]
    assert rows[-2] == "✗  Update cancelled." and rows[-1] == "└  Nothing was installed.", rows


def test_a_long_url_keeps_its_first_piece_at_32_by_8() -> None:
    term = Term(32, 8)
    snaps: List[List[str]] = []
    t = terminal(term, LONG, verb="login", keys=[_snap(term, snaps)], device_code=True)
    flows.sign_in(_client(LONG), t)
    assert shown(LONG["url"]) in joined(snaps[0]), "\n".join(snaps[0])


def test_escape_cancels_with_the_result_and_the_verb_that_was_run() -> None:
    term = Term(40, 12)
    t = terminal(term, SHORT, verb="login", keys=["esc"], device_code=True)
    out = flows.sign_in(_client(SHORT), t)
    t.finish(out)
    text = "\n".join(r for r, _ in term.all())
    assert out.code == 1 and "Sign-in cancelled" in text
    assert "tidewater login" in text and "Sign in again" in text and "WDJB-MJHT" not in text


def test_ctrl_c_cancels_with_a_result_and_exit_130_never_a_blank_screen() -> None:
    def boom() -> None:
        raise KeyboardInterrupt

    term = Term(60, 24)
    t = terminal(term, SHORT, verb="login", keys=[boom], device_code=True)
    out = flows.sign_in(_client(SHORT), t)
    t.finish(out)
    text = "\n".join(r for r, _ in term.all())
    assert out.code == 130 and "Sign-in cancelled" in text and "┌" in text


# ── Both kits draw the same text (UI-KITS §1.4) ───────────────────────────────────────────────
# docs/design/ui-kits/terminal-parity.json is recorded by packages/sdk-node/test/cli/responsive.test.ts
# (PKEY_UPDATE_PARITY=1); the Node kit checks it too, so the two cannot drift apart.

import json
from pathlib import Path

PARITY = json.loads((Path(__file__).resolve().parents[4] / "docs/design/ui-kits/terminal-parity.json").read_text())


def _drawn(term: Term) -> str:
    return "\n".join(t.rstrip() for t, _ in term.all()).rstrip()


def test_status_revoked_reads_the_same_in_both_kits() -> None:
    term = Term(80, 24)
    t = terminal(term, _values("short"), verb="status", keys=[])
    status = SimpleNamespace(
        status=lambda: SimpleNamespace(status="revoked", graceUntil=None, allowedRange=None),
        license=SimpleNamespace(get_profile=lambda: None),
        identity=SimpleNamespace(current=lambda: None),
        core=SimpleNamespace(version="2.4.1", channel="stable"),
        is_licensed=lambda: False,
    )
    t.finish(flows.status(status, t))
    assert _drawn(term) == PARITY["status-revoked"]


# 2026-10-05 12:00 UTC: the Node kit's fixture clock, so the offline-until date is the same.
_PARITY_NOW = 1_791_201_600


def _status_client(status: str, *, tier: Optional[str] = "Pro") -> Any:
    info = SimpleNamespace(tier="pro", tierLabel=tier, profile=None)
    return SimpleNamespace(
        status=lambda: SimpleNamespace(status=status, graceUntil=_PARITY_NOW + 14 * 86_400, allowedRange=None),
        license=SimpleNamespace(
            get_profile=lambda: SimpleNamespace(name="Mara Fennick", email="mara@fennick.studio"),
            license_info=lambda: info,
        ),
        identity=SimpleNamespace(current=lambda: None),
        core=SimpleNamespace(version="2.4.1", channel="stable"),
        is_licensed=lambda: status == "ok",
    )


def test_an_active_status_reads_the_same_in_both_kits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(flows, "_now", lambda: _PARITY_NOW)
    term = Term(80, 24)
    t = terminal(term, _values("short"), verb="status", keys=[])
    t.finish(flows.status(_status_client("ok"), t))
    assert _drawn(term) == PARITY["status-active"]


def test_a_key_only_status_reads_the_same_in_both_kits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(flows, "_now", lambda: _PARITY_NOW)
    term = Term(80, 24)
    t = terminal(term, _values("short"), verb="status", keys=[])
    client = _status_client("ok")
    client.license.get_profile = lambda: None  # activated with a key: no account, no holder
    t.finish(flows.status(client, t))
    assert _drawn(term) == PARITY["status-key-only"]


def test_a_status_with_no_licence_reads_the_same_in_both_kits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(flows, "_now", lambda: _PARITY_NOW)
    term = Term(80, 24)
    t = terminal(term, _values("short"), verb="status", keys=[])
    client = _status_client("needs-activation")
    t.finish(flows.status(client, t))
    assert _drawn(term) == PARITY["status-none"]


def test_an_update_check_reads_the_same_in_both_kits() -> None:
    term = Term(80, 24)
    t = terminal(term, _values("short"), verb="update", keys=[])
    release = SimpleNamespace(version="2.5.0", seq=7, size=61_000_000)
    d = SimpleNamespace(action="binary", release=release, mandatory=False, critical=False, contentBlock=None, to_dict=lambda: {})
    client = SimpleNamespace(
        core=SimpleNamespace(version="2.4.1"),
        update=SimpleNamespace(_configured=object(), decide=lambda channel=None: SimpleNamespace(decision=d, channel="stable")),
    )
    t.finish(flows.update(client, t, ["check"]))
    assert _drawn(term) == PARITY["update-check"]


def test_one_device_reads_the_same_in_both_kits() -> None:
    term = Term(80, 24)
    t = terminal(term, _values("short"), verb="devices", keys=[])
    dev = SimpleNamespace(id="dev_9fK2Lw7QmZ", label="Work laptop", platform="macOS arm64", current=True)
    t.finish(flows.devices(SimpleNamespace(list_devices=lambda: [dev]), t, ["list"]))
    assert _drawn(term) == PARITY["devices-one"]


def test_the_offline_request_reads_the_same_in_both_kits() -> None:
    term = Term(80, 24)
    t = terminal(term, _values("short"), verb="offline-request", keys=[])
    t.finish(flows.offline_request(SimpleNamespace(core=SimpleNamespace(device_id="dev_9fK2Lw7QmZ"), product="tidewater"), t))
    assert _drawn(term) == PARITY["offline-request"]


def test_the_sign_in_code_reads_the_same_in_both_kits() -> None:
    v = _values("short")
    term = Term(80, 24)
    snaps: List[List[str]] = []
    t = terminal(term, v, verb="login", keys=[_snap(term, snaps)], device_code=True)
    flows.sign_in(_client(v), t)
    # The countdown is the fixture's clock, not the kit's.
    def clock(text: str) -> str:
        return re.sub(r"expires in \d+:\d\d", "expires in N", text)

    assert clock("\n".join(r.rstrip() for r in snaps[0]).rstrip()) == clock(PARITY["login-code"])


def test_the_device_limit_reads_the_same_in_both_kits() -> None:
    v = _values("short")
    limit = ActivationDeviceLimit(limit=3, deviceCount=3, manage_url="https://key.plrs.im/portal/tidewater/devices")
    term = Term(80, 24)
    snaps: List[List[str]] = []
    t = terminal(term, v, verb="activate", keys=[_snap(term, snaps)])
    client = SimpleNamespace(product=PRODUCT, license=SimpleNamespace(activate_with_key=lambda key: limit), status=lambda: None)
    flows.activate(client, t, KEY)
    assert "\n".join(r.rstrip() for r in snaps[0]).rstrip() == PARITY["device-limit"]


def test_a_cancelled_sign_in_leaves_the_same_text_in_both_kits() -> None:
    v = _values("short")
    term = Term(80, 24)
    t = terminal(term, v, verb="login", keys=["esc"], device_code=True)
    t.finish(flows.sign_in(_client(v), t))
    assert _drawn(term) == PARITY["login-cancelled"]


def test_the_landscape_offline_request_leaves_no_rail_below_the_closing_row() -> None:
    term = Term(120, 24)
    t = terminal(term, _values("short"), verb="offline-request", keys=[])
    t.finish(flows.offline_request(SimpleNamespace(core=SimpleNamespace(device_id="dev_9fK2Lw7QmZ"), product="tidewater"), t))
    rows = [r for r, _ in term.all()]
    end = next(i for i, r in enumerate(rows) if r.startswith("└"))
    assert any("█" in r or "▀" in r for r in rows), "the QR sits beside the text"
    assert [r for r in rows[end + 1 :] if r.startswith("│")] == []
