# @pkey-feature ui.gate
"""The optional Powered by Polaris Locker attribution (LK-16, UI-KITS §1.6) in the terminal kit and
the Qt layout: the Locker glyph and the phrase under ``status``, absent by default, the words only
when piped, and one validated ``powered_by`` value."""

from __future__ import annotations

import pytest

from polaris_key.ui._tokens import POWERED_BY
from polaris_key.ui.core.theme import Theme
from polaris_key.ui.core.models import gate_view
from polaris_key.ui.terminal import screens
from polaris_key.ui.terminal.text import plain

from .fixtures import NOW, kit
from .golden_support import env

_ACCOUNT = dict(holder="Mara Fennick", email="mara@fennick.studio", signed_in=True, tier="Pro", term="Lifetime", version="2.4.1", channel="stable")


def _status(theme: Theme, **env_kw: object) -> str:
    e = env("none", env_kw.pop("symbols", "unicode"), 80, "dark", **env_kw)  # type: ignore[arg-type]
    k = kit(e, theme)
    return plain(screens.gate(k, gate_view("ok", now=NOW, developer=k.identity.developer, **_ACCOUNT), "status"))  # type: ignore[arg-type]


def test_tokens_carry_the_locker_attribution() -> None:
    assert POWERED_BY["phrase"] == "Powered by Polaris Locker"
    assert POWERED_BY["mark_size"] == 16
    assert POWERED_BY["badge_min"] == [320, 104] or POWERED_BY["badge_min"] == (320, 104)
    for ground in ("dark", "light"):
        assert 'viewBox="0 0 128 128"' in POWERED_BY["mark_svg"][ground]
        assert 'viewBox="0 0 320 104"' in POWERED_BY["badge_svg"][ground]


@pytest.mark.parametrize("value", ["line", "badge", True])
def test_status_prints_the_glyph_and_the_phrase_once(value: object) -> None:
    text = _status(Theme(powered_by=value))  # type: ignore[arg-type]
    assert text.count("Powered by Polaris Locker") == 1
    assert "✦ Powered by Polaris Locker" in text
    assert "Polaris Key" not in text


def test_ascii_uses_the_ascii_glyph() -> None:
    assert "* Powered by Polaris Locker" in _status(Theme(powered_by="line"), symbols="ascii")


def test_absent_by_default() -> None:
    assert "Powered by" not in _status(Theme())


def test_piped_output_keeps_the_words_and_drops_the_glyph() -> None:
    text = _status(Theme(powered_by="line"), tty=False)
    assert "Powered by Polaris Locker" in text
    assert "✦" not in text


def test_the_value_is_validated() -> None:
    with pytest.raises(ValueError):
        Theme(powered_by="banner")


def test_the_qt_layout_draws_the_attribution_apart_from_the_body() -> None:
    import json
    from pathlib import Path

    from polaris_key.ui.core.copy import Copy
    from polaris_key.ui.core.ui_contract import context_of
    from polaris_key.ui.core.ui_settings import account_view
    from polaris_key.ui.qt.layout import build_spec

    root = Path(__file__).resolve().parents[4]
    matrix = json.loads((root / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8"))
    row = next(r for r in matrix["settings"] if r["name"] == "AccountAndLicense/signed-in: Powered by")
    inp = dict(row["input"])
    for key, value in matrix["vocabulary"]["defaults"].items():
        if key == "capabilities":
            inp[key] = {**value, **dict(inp.get(key) or {})}
        elif key not in inp:
            inp[key] = value
    view = account_view(context_of(inp))
    copy = Copy(None, {}, platform="desktop")
    off = build_spec(view, copy)
    assert off.powered_by == "" and "Powered by Polaris Locker" not in off.body
    for mode in ("line", "badge"):
        spec = build_spec(view, copy, powered_by=mode)
        assert spec.powered_by == mode
        assert spec.powered_by_text == "Powered by Polaris Locker"
        assert "Powered by Polaris Locker" not in spec.body
        assert spec.as_dict()["poweredBy"] == mode
