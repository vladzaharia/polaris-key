"""The Python UI foundations (UI-KITS.md §2.1): the generated tokens agree with the generator's
tokens.json, the Qt theme and stylesheets carry the palette and their placeholders, the fonts and
their licences ship in the package, and the ANSI tables match the terminal board."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from polaris_key import ui
from polaris_key.ui import _tokens, ansi

REPO = Path(__file__).resolve().parents[3]
TOKENS_JSON = REPO / "packages" / "brand" / "tokens.json"


def test_generated_files_carry_the_banner():
    for path in [
        Path(_tokens.__file__),
        Path(ansi.__file__),
        ui.QT_DIR / "Theme.qml",
        ui.QT_DIR / "polaris_key_dark.qss",
        ui.QT_DIR / "polaris_key_light.qss",
    ]:
        assert "GENERATED FILE" in path.read_text("utf-8")[:400], path


@pytest.mark.skipif(not TOKENS_JSON.is_file(), reason="packages/brand is not beside this package")
def test_tokens_match_the_generator():
    data = json.loads(TOKENS_JSON.read_text("utf-8"))
    for scheme in ("dark", "light"):
        theme = data["themes"][scheme]
        assert _tokens.THEMES[scheme]["surface_page"] == theme["surface"]["page"]
        assert _tokens.THEMES[scheme]["text_strong"] == theme["text"]["strong"]
        assert _tokens.THEMES[scheme]["danger"] == theme["status"]["danger"]["fg"]
        assert _tokens.THEMES[scheme]["danger_solid"] == data["kit"]["danger"][scheme]["solid"]
        assert _tokens.ACCENT_SURFACES[scheme] == data["kit"]["accentSurfaces"][scheme]
        for service, accent in data["services"][scheme].items():
            assert _tokens.SERVICE_ACCENTS[scheme][service] == accent
    for platform in ("macos", "windows", "gnome"):
        comp = data["kit"]["components"][platform]
        assert _tokens.KIT[platform]["control_height"] == comp["controlHeight"]["default"]
        assert _tokens.KIT[platform]["card_pad"] == comp["cardPad"]["default"]
        for role, spec in data["kit"]["typeScale"][platform].items():
            got = _tokens.TYPE_SCALE[platform][role]
            assert (got["size"], got["line_height"], got["weight"]) == (
                spec["size"],
                spec["lineHeight"],
                spec["weight"],
            )
    assert _tokens.FONT_WEIGHT == data["fontWeight"]


def test_type_scale_uses_three_weights():
    for scale in _tokens.TYPE_SCALE.values():
        for role in scale.values():
            assert role["weight"] in (400, 500, 600)


def test_concentric_rule():
    assert _tokens.concentric_radius(22, 6) == 16
    assert _tokens.concentric_radius(10, 6) == 8


def test_fonts_and_licences_ship_in_the_package():
    for name in ("Rubik-Variable.ttf", "JetBrainsMono-Variable.ttf"):
        data = (ui.FONTS_DIR / name).read_bytes()
        assert data[:4] == b"\x00\x01\x00\x00" and b"fvar" in data, name
    assert "SIL OPEN FONT LICENSE" in (ui.FONTS_DIR / "OFL.txt").read_text("utf-8")
    assert "JetBrains Mono" in (ui.FONTS_DIR / "OFL-JetBrainsMono.txt").read_text("utf-8")
    assert "JetBrains Mono" in (ui.FONTS_DIR / "FONT-NOTICE.txt").read_text("utf-8")


def test_qt_theme_and_stylesheets():
    qml = (ui.QT_DIR / "Theme.qml").read_text("utf-8")
    assert "pragma Singleton" in qml
    assert _tokens.THEMES["dark"]["surface_page"] in qml
    assert "singleton Theme 1.0 Theme.qml" in (ui.QT_DIR / "qmldir").read_text("utf-8")
    for scheme in ("dark", "light"):
        qss = (ui.QT_DIR / ("polaris_key_%s.qss" % scheme)).read_text("utf-8")
        assert _tokens.THEMES[scheme]["surface_page"] in qss
        assert _tokens.THEMES[scheme]["danger_solid"] in qss
        found = set(re.findall(r"@pk-([a-z-]+)@", qss))
        assert found == set(_tokens.QSS_PLACEHOLDERS), found


def test_ansi_tables():
    assert ansi.SGR["success"] == "32" and ansi.SGR["danger"] == "31" and ansi.SGR["muted"] == "90"
    assert ansi.sgr("warning") == "\x1b[33m"
    assert ansi.truecolor("#4fd8c4") == "\x1b[38;2;79;216;196m"
    assert set(ansi.SYMBOLS["unicode"]) == set(ansi.SYMBOLS["ascii"])
    assert ansi.SPINNER["frameMs"] == 80
    assert all(c.isascii() for c in "".join(ansi.SYMBOLS["ascii"].values()))
