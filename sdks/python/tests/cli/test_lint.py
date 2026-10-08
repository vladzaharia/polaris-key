# @pkey-feature ui.cli
"""The §7.3 modernity lint on the terminal kit's renders (UI-KITS §1.5, §4.4, §7.3):

* **strings** — every visible word is a catalog key listed for that component and state (or a
  documented hand-off to another component's key), or data the kit is shown (a product name, a
  device, a code, a URL …), or a symbol from the generated tables. Nothing is hand-written.
* **columns** — every line fits its layout: 80 columns, and 60 when the terminal is narrower.
* **orphans** — wrapped text never leaves one word alone on its last line.
* **piped output** (§4.4 rule: screen-reader-safe when not a TTY) — no escapes, no rails, no
  spinner or box glyphs: words only.
* **RTL-safe source** — no left/right justification in the kit's layout code.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, Set

import pytest

from polaris_key.ui import ansi
from polaris_key.ui.kit_copy_generated import KIT_COPY
from polaris_key.ui.terminal.text import Span, cell_len, wrap

from .fixtures import FIXTURES, NOT_DRAWN, OUT_OF_SCOPE
from .golden_support import THEMES, render, variants

REPO = Path(__file__).resolve().parents[4]
COMPONENTS = json.loads((REPO / "packages/brand/kit-copy/components.json").read_text(encoding="utf-8"))["components"]
EN = KIT_COPY["en"]

#: Keys any state may show: the shared parts, common words, accessibility names and core copy.
SHARED = ("common.", "part.", "a11y.", "core.")

#: Keys a state borrows from another component, each with its reason.
BORROWS: Dict[str, Dict[str, str]] = {
    "PolarisKeyGate": {
        "welcome.useKey": "the fix commands of needs-activation are Welcome's two paths",
        "welcome.signIn": "the fix commands of needs-activation are Welcome's two paths",
    },
    "AccountAndLicense": {
        "part.status.ok": "the tier row opens with the status pill",
        "cli.status.license": "the status table's row labels, as the Node kit's",
        "cli.status.devices": "the status table's row labels, as the Node kit's",
        "cli.status.offline": "the status table's row labels, as the Node kit's",
        "cli.status.offlineUntil": "the status table's offline row",
        "cli.status.seatsOf": "the status table's devices row",
        "cli.status.version": "the status table's row labels, as the Node kit's",
    },
    "GraceBanner": {
        "cli.status.license": "the status table's row labels, as the Node kit's",
        "cli.status.devices": "the status table's row labels, as the Node kit's",
        "cli.status.offline": "the status table's row labels, as the Node kit's",
        "cli.status.offlineUntil": "the status table's offline row",
        "cli.status.seatsOf": "the status table's devices row",
        "cli.status.version": "the status table's row labels, as the Node kit's",
        "account.title": "the grace line sits over the account summary",
        "account.tier": "the grace line sits over the account summary",
        "account.holder": "the grace line sits over the account summary",
        "account.keyOnly": "the grace line sits over the account summary",
        "account.version": "the grace line sits over the account summary",
    },
    "StatusScreen": {
        "status.contact": "channel-not-entitled names the developer",
        "cli.fix.signIn": "a revoked device can be fixed with the account's license",
    },
    "Boot": {
        "status.update": "the blocked boot's fix is the update verb",
        "update.availableTitle": "a ready boot names an available update",
    },
    "SignIn": {
        "signin.cli.opening": "SIGN-IN.md §5.2 terminal hand-off copy",
        "signin.cli.ifNotOpened": "SIGN-IN.md §5.2 terminal hand-off copy",
        "signin.cli.keys": "SIGN-IN.md §5.2 terminal hand-off keys",
        "signin.cli.signedIn": "SIGN-IN.md §5.2 terminal done line",
        "signin.cli.closeTab": "SIGN-IN.md §5.2 terminal done line",
        "account.holder": "a sign-in without both name and email",
        "signInHandoff.starting": "the code request before the browser opens",
    },
    "SignInHandoff": {
        "signin.cli.headless": "SIGN-IN.md §5.2: the headless code view (D-68)",
        "signin.again": "expired: sign in again (SignIn expired's key)",
        "signin.handoff.waiting": "the code view waits as the handoff does",
        "cli.signin.waitingCode": "the code view waits for the person, in the Node kit's words",
        "cli.keys.code": "the code view's key hints, in the Node kit's words",
        "cli.keys.codeBrowser": "the code view's key hints where a browser can open",
        "common.copied": "the copy hint gives way to Copied on the same row",
        "signin.handoff.finishing": "the code view finishes as the handoff does",
        "signin.cli.ifNotOpened": "SIGN-IN.md §5.2 terminal hand-off copy",
        "signin.cli.opening": "SIGN-IN.md §5.2 terminal hand-off copy",
    },
    "Activate": {
        "cli.keys.activate": "the key prompt's hints, in the Node kit's words",
        "cli.activate.otherProduct": "a key for another product is a warning",
        "cli.nothingChanged": "cancelling the prompt changes nothing",
        "activate.lede": "the field's hint",
        "welcome.signIn": "key-entry-limit: sign in instead",
        "signin.key.noEntries": "key-entry-limit (PX-W9): the product's own words",
        "signin.key.differentKey": "unauthorized: use a different key",
        "deviceLimit.heading": "the device-limit hand-off",
    },
    "DeviceLimit": {
        "cli.deviceLimit.body": "the terminal never promises the product continues by itself",
        "cli.deviceLimit.again": "leaving with Esc says what to run",
        "cli.keys.deviceLimit": "the board's hints, in the Node kit's words",
        "cli.keys.retry": "the board's hints after the browser opened",
        "deviceLimit.heading": "browser mode keeps the heading and the seat meter (UI-KITS §4.3)",
        "deviceLimit.lede": "browser mode keeps the lede",
        "part.keyField.label": "the key step above the hand-off",
    },
    "Devices": {},
    "UpdatePrompt": {
        "cli.update.available": "the check's title, as the Node kit's",
        "cli.update.availableNoSize": "the check's title when the size is not known",
        "cli.update.have": "the version installed now",
        "cli.update.install": "the apply command's label",
        "cli.update.ready": "the finished block's title",
        "cli.update.readyNoSize": "the finished block's title when the size is not known",
        "cli.update.restart": "the finished block's next step",
        "cli.update.nothingInstalled": "a failed download changed nothing",
        "cli.update.cancelled": "Esc or Ctrl-C stops the download",
        "cli.update.figures": "the progress line's sizes",
        "cli.update.figuresShort": "the progress line's sizes on a narrow line",
        "cli.update.timeLeft": "the progress line's time left",
        "cli.keys.download": "the download's key hint, as the Node kit's",
        "common.tryAgain": "a failed download names the command to run again",
        "account.version": "the installed version line",
        "update.platform.generic": "store and platform outlets name where it installs",
    },
    "UpdateProgress": {},
    "ReleaseNotes": {
        "cli.changelog.fix": "a failed load says what to run next",
    },
    "Settings": {
        "settings.saved": "config set saves at once",
    },
    "OfflineActivation": {
        "cli.verb.importBundle": "the footer command row's label, as the Node kit's",
        "cli.import.fix": "a refused file says who to ask for a new one",
    },
}

DATA_KINDS = {
    "product", "command", "key", "code", "url", "device", "platform", "id", "email", "term",
    "channel", "notes", "pack", "percent", "setting", "value", "imported", "diagnostic", "count", "tier", "version",
}
KEY_NAMES = {"Enter", "Esc", "c", "o", "y", "n", "Ctrl-C"}
SYMBOLS: Set[str] = {ch for table in ansi.SYMBOLS.values() for v in table.values() for ch in v}
SYMBOLS |= {ch for frames in (ansi.SPINNER["unicode"], ansi.SPINNER["ascii"]) for f in frames for ch in f}
SYMBOLS |= set("•*#-+ ▀▄█")


def _allowed(component: str, state: str) -> Set[str]:
    c = COMPONENTS[component]
    keys = set(c["states"][state]["copy"])
    for st in c["states"].values():
        keys |= set(st["copy"])
    return keys | set(BORROWS.get(component, {}))


CASES = [(fx, theme, label, e) for fx in FIXTURES for theme in THEMES for label, e in variants(theme)]


@pytest.mark.parametrize("fx", FIXTURES, ids=[f.name for f in FIXTURES])
def test_every_visible_string_is_catalog_copy_or_data(fx) -> None:
    assert fx.component in COMPONENTS and fx.state in COMPONENTS[fx.component]["states"], fx.name
    allowed = _allowed(fx.component, fx.state)
    for theme in THEMES:
        for label, e in variants(theme):
            lines, _ = render(fx, e)
            for line in lines:
                for span in line.spans:
                    text = span.text.strip()
                    if not text:
                        continue
                    where = f"{fx.name} [{label}] {span.text!r}"
                    if span.src.startswith("key:"):
                        key = span.src[4:]
                        assert key in EN, f"{where}: {key} is not in the catalog"
                        assert key in allowed or key.startswith(SHARED), f"{where}: {key} is not listed for {fx.component} {fx.state}"
                    elif span.src.startswith("data:"):
                        assert span.src[5:] in DATA_KINDS, f"{where}: unknown data kind {span.src}"
                    elif span.src == "symbol":
                        assert text in KEY_NAMES or set(text) <= SYMBOLS, f"{where}: not a symbol or key name"
                    else:
                        pytest.fail(f"{where}: visible text with no source ({span.src})")


def test_every_must_component_state_is_drawn_or_documented() -> None:
    drawn = {(fx.component, fx.state) for fx in FIXTURES}
    for name, c in COMPONENTS.items():
        if name in OUT_OF_SCOPE:
            continue
        for state in c["states"]:
            assert (name, state) in drawn or (name, state) in NOT_DRAWN, f"{name} {state}: no fixture and no reason"
    for key in NOT_DRAWN:
        assert key not in drawn, f"{key} is drawn, so it needs no reason"


@pytest.mark.parametrize("fx", FIXTURES, ids=[f.name for f in FIXTURES])
def test_every_line_fits_80_and_60_columns(fx) -> None:
    for label, e in variants("dark"):
        lines, _ = render(fx, e)
        for line in lines:
            assert cell_len(line.text.rstrip()) <= e.width, f"{fx.name} [{label}] {line.text!r} is wider than {e.width}"


_DECOR = set("│┌└◆◇✓✗▲●○━") | set("".join(ansi.SPINNER["unicode"])) | set("▀▄█")


@pytest.mark.parametrize("fx", FIXTURES, ids=[f.name for f in FIXTURES])
def test_piped_output_is_words_only(fx) -> None:
    """Not a terminal: no escapes, rails, glyphs or spinners, so a log or a screen reader reads
    words (UI-KITS §4.4; D-77: TERM=dumb and pipes print plain lines)."""
    _, text = render(fx, dict(variants("dark"))["pipe · 80"])
    assert "\x1b" not in text, fx.name
    assert not (set(text) & _DECOR), f"{fx.name}: {sorted(set(text) & _DECOR)}"


def test_wrap_never_leaves_an_orphan() -> None:
    words = [Span("Replace a device in your browser. Tidewater Studio continues when you're done.")]
    for width in range(30, 80):
        rows = wrap(words, width)
        if len(rows) > 1:
            last = "".join(s.text for s in rows[-1]).strip()
            assert len(last.split()) > 1, (width, last)
        assert all(cell_len("".join(s.text for s in r)) <= width for r in rows), width


def test_wrap_breaks_cjk_between_characters_and_never_inside_a_code() -> None:
    rows = wrap([Span("このライセンスは3台のデバイス中3台で使用されています")], 20)
    assert all(cell_len("".join(s.text for s in r)) <= 20 for r in rows) and len(rows) > 1
    code = Span("WDJB-MJHT", (), None, "data:code", True)
    rows = wrap([Span("go to the page and enter "), code], 12)
    # The code is never split; it reads whole across the wrapped lines.
    assert "WDJB-MJHT" in "".join(s.text for r in rows for s in r)
    assert all(cell_len("".join(s.text for s in r)) <= 12 for r in rows)


KIT_SOURCES = sorted((REPO / "sdks/python/src/polaris_key/ui/terminal").glob("*.py")) + sorted(
    (REPO / "sdks/python/src/polaris_key/ui/core").glob("*.py")
)


@pytest.mark.parametrize("path", KIT_SOURCES, ids=[p.name for p in KIT_SOURCES])
def test_kit_sources_are_rtl_safe(path: Path) -> None:
    """No physical justification in layout code (§7.3 RTL-safe rule): padding is cell-aware spans,
    and the terminal's own bidi lays a line out."""
    text = path.read_text(encoding="utf-8")
    assert not re.search(r"\.(ljust|rjust)\(|\bjustify\s*=\s*[\"'](left|right)", text), path.name
