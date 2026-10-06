"""The Python port of the accent resolver (UI-KITS.md §3.3) against the shared vectors
(tests/fixtures/accent-vectors.json, written by `pnpm gen:brand` from
packages/brand/fixtures/accent-vectors.json)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from polaris_key.ui import accent
from polaris_key.ui.accent import INK, WHITE, derive_accent, resolve_accent

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "accent-vectors.json").read_text("utf-8"))


def _expand(pixels):
    out = bytearray()
    for r, g, b, a, n in pixels:
        out += bytes([r, g, b, a]) * n
    return bytes(out)


def test_surfaces_are_the_palettes():
    assert accent.surfaces(True) == VECTORS["surfaces"]["dark"]
    assert accent.surfaces(False) == VECTORS["surfaces"]["light"]
    assert (WHITE, INK) == (VECTORS["white"], VECTORS["ink"])


@pytest.mark.parametrize("vector", VECTORS["derive"], ids=lambda v: v["name"])
def test_derive_vectors(vector):
    assert derive_accent(_expand(vector["pixels"])) == vector["expect"]


@pytest.mark.parametrize(
    "vector", VECTORS["resolve"], ids=lambda v: "%s-%s" % (v["name"], v["scheme"])
)
def test_resolve_vectors(vector):
    got = resolve_accent(vector["input"], vector["scheme"] == "dark")
    assert got is not None
    assert got._asdict() == vector["expect"]


@pytest.mark.parametrize("vector", VECTORS["danger"], ids=lambda v: v["scheme"])
def test_danger_solid_keeps_a_white_label(vector):
    solid = accent.accent_solid(vector["input"], vector["scheme"] == "dark", True)
    assert solid == vector["expect"]
    assert accent.contrast(WHITE, solid) >= 4.5


def test_on_is_the_same_in_both_schemes():
    for v in VECTORS["resolve"]:
        assert resolve_accent(v["input"], True).on == resolve_accent(v["input"], False).on, v["name"]


def test_invalid_input_resolves_to_none():
    assert resolve_accent("teal", True) is None
    assert resolve_accent("#12345", True) is None
    assert resolve_accent("#F60", True) is not None


def test_the_fallback_cube_root_agrees(monkeypatch):
    # Python < 3.11 has no math.cbrt: the pow + Newton fallback must give the same answers.
    import math

    monkeypatch.delattr(math, "cbrt", raising=False)
    for v in VECTORS["resolve"]:
        assert resolve_accent(v["input"], v["scheme"] == "dark")._asdict() == v["expect"]
    for v in VECTORS["derive"]:
        assert derive_accent(_expand(v["pixels"])) == v["expect"]
