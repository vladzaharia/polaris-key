# @pkey-feature ui.cli
"""The terminal kit's baselines (UI-KITS §7.1 Terminal): golden ANSI text for every fixture state in
both terminal themes, in every variant (truecolor, ANSI-16, NO_COLOR, ascii; 80 and 60 columns; and
piped), plus an SVG of the default render (truecolor, 80 columns) that the docs' component pages
show. Record with ``PKEY_GOLDEN=record``.
"""

from __future__ import annotations

import pytest

from . import svg
from .fixtures import FIXTURES, Fixture
from .golden_support import GOLDEN, THEMES, check, document, env, render, sections

CASES = [(fx, theme) for fx in FIXTURES for theme in THEMES]


def _id(case: object) -> str:
    fx, theme = case  # type: ignore[misc]
    return f"{fx.name}-{theme}"


@pytest.mark.parametrize("case", CASES, ids=[_id(c) for c in CASES])
def test_golden_ansi_and_svg(case) -> None:
    fx, theme = case
    doc = document(fx, theme)
    check(GOLDEN / "ansi" / f"{fx.name}-{theme}.ans", doc)
    default = sections(doc)["truecolor · 80"]
    title = f"{fx.component}, {fx.state}, terminal, {theme} theme"
    check(GOLDEN / f"{fx.name}-{theme}.svg", svg.render(default, theme, 80, title))


def _board(fx: Fixture, theme: str, labels) -> str:
    doc = sections(document(fx, theme))
    rows = []
    for label in labels:
        rows.append(f"\x1b[90m{label}\x1b[0m")
        rows.append(doc[label])
        rows.append("")
    return "\n".join(rows)


BOARD_FIXTURE = next(fx for fx in FIXTURES if fx.name == "device-limit-browser-mode")


@pytest.mark.parametrize("theme", THEMES)
def test_board_fallbacks(theme: str) -> None:
    """The fallbacks board (terminal.html "fallbacks"): one state in the four colour and symbol
    modes, stacked."""
    text = _board(BOARD_FIXTURE, theme, ["truecolor · 80", "ansi16 · 80", "no-color · 80", "ascii · 80"])
    check(GOLDEN / "boards" / f"fallbacks-{theme}.svg", svg.render(text, theme, 80, f"Fallbacks, {theme} theme"))


@pytest.mark.parametrize("theme", THEMES)
def test_board_narrow(theme: str) -> None:
    """The 60-column board (terminal.html "narrow"): meta wraps, keys cut in the middle, no QR."""
    names = ("device-limit-browser-mode", "activate-parsed", "sign-in-handoff-code", "offline-activation-default")
    blocks = []
    for fx in FIXTURES:
        if fx.name in names:
            blocks.append(sections(document(fx, theme))["truecolor · 60"])
    check(GOLDEN / "boards" / f"narrow-{theme}.svg", svg.render("\n\n".join(blocks), theme, 60, f"60 columns, {theme} theme"))


def test_every_golden_file_has_a_fixture() -> None:
    """A baseline whose fixture is gone is stale, not history."""
    names = {f"{fx.name}-{t}" for fx in FIXTURES for t in THEMES}
    for p in GOLDEN.glob("*.svg"):
        assert p.stem in names, f"stale baseline {p.name}"
    for p in (GOLDEN / "ansi").glob("*.ans"):
        assert p.stem in names, f"stale baseline ansi/{p.name}"


def test_the_svg_is_a_pure_function_of_the_ansi() -> None:
    fx = FIXTURES[0]
    _, text = render(fx, env("truecolor", "unicode", 80, "dark"))
    assert svg.render(text, "dark", 80) == svg.render(text, "dark", 80)
