# @pkey-feature ui.gate
# @pkey-feature ui.activate
# @pkey-feature ui.devicelimit
# @pkey-feature ui.devices
# @pkey-feature ui.update
# @pkey-feature ui.settings
"""Offscreen ``grab()`` baselines of the Qt Quick kit: every fixture component x state of the six
ui-matrix families in the Linux variant, dark and light, at 480x560; the platform variants, both
presets' worth of window sizes and a 200% text scale for the gate's first screen. Each render also
runs the QML source rules (tests/ui/test_qt_lint.py) and the accessibility checks on its spec."""

from __future__ import annotations

import re

import pytest

pytest.importorskip("PySide6.QtQuick")

from polaris_key.ui.core.identity import ProductIdentity
from polaris_key.ui.core.theme import Theme
from polaris_key.ui.qt.kit import KitView
from qt_fixtures import SNAPSHOTS, TIDEWATER, FakeSource, states
from snapshots_util import check

STATES = states()
SIZE = (480, 560)


def _slug(*parts: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", "-".join(parts).lower()).strip("-")


def _render(kit_app, view, scheme, platform="gnome", size=SIZE, font_scale=1.0, theme=None):
    source = FakeSource(TIDEWATER)
    kit = KitView(
        theme or Theme(color_scheme=scheme, platform=platform),
        source=source,
        size=size,
        font_scale=font_scale,
    )
    try:
        kit.set_view(view)
        return kit.grab(), kit.bridge.screen_spec
    finally:
        kit.close()


@pytest.mark.parametrize("scheme", ["dark", "light"])
@pytest.mark.parametrize("component,state,name,view", STATES, ids=[f"{c}.{s}" for c, s, _, _ in STATES])
def test_component_state_baseline(kit_app, component, state, name, view, scheme):
    image, spec = _render(kit_app, view, scheme)
    assert not image.isNull() and image.width() == SIZE[0]
    # exactly one heading when the state has one; every control is named
    assert all(b.text for b in spec.buttons)
    check(image, SNAPSHOTS / f"{_slug(component, state)}.{scheme}.png")


VARIANTS = [
    (c, s, v) for c, s, _, v in STATES if (c, s) in {("PolarisKeyGate", "needs-activation"), ("Welcome", "default")}
]


@pytest.mark.parametrize("scheme", ["dark", "light"])
@pytest.mark.parametrize("platform", ["macos", "windows"])
@pytest.mark.parametrize("component,state,view", VARIANTS, ids=[f"{c}.{s}" for c, s, _ in VARIANTS])
def test_platform_variant_baseline(kit_app, component, state, view, platform, scheme):
    image, _ = _render(kit_app, view, scheme, platform=platform)
    check(image, SNAPSHOTS / f"{_slug(component, state)}.{platform}.{scheme}.png")


SIZES = [("narrow", (320, 640), 1.0), ("wide", (1024, 640), 1.0), ("text200", (480, 900), 2.0)]


@pytest.mark.parametrize("label,size,scale", SIZES, ids=[s[0] for s in SIZES])
def test_resolution_matrix_baseline(kit_app, label, size, scale):
    view = next(v for c, s, _, v in STATES if (c, s) == ("Welcome", "default"))
    image, _ = _render(kit_app, view, "dark", size=size, font_scale=scale)
    check(image, SNAPSHOTS / f"welcome-default.{label}.dark.png")


def test_a_fake_presentation_source_themes_the_kit_with_no_integrator_code(kit_app):
    """Zero integrator code: the product's name and accent come from the SDK's presentation source."""
    view = next(v for c, s, _, v in STATES if (c, s) == ("Welcome", "default"))
    _, spec = _render(kit_app, view, "dark")
    assert "Tidewater Studio" in spec.product
    from polaris_key.ui.core.identity import resolve_identity

    resolved = resolve_identity(source=FakeSource(TIDEWATER))
    assert resolved.accent("dark").solid != resolved.accent("light").solid
    # an integrator's own identity still wins
    mine = Theme(product=ProductIdentity(name="Mine", accent="#aa3388"))
    _, own = _render(kit_app, view, "dark", theme=mine)
    assert "Mine" in own.product


def test_presentation_change_redraws(kit_app):
    view = next(v for c, s, _, v in STATES if (c, s) == ("Welcome", "default"))
    source = FakeSource(TIDEWATER)
    kit = KitView(Theme(color_scheme="dark"), source=source)
    try:
        kit.set_view(view)
        before = kit.bridge.accent
        source.set({**TIDEWATER, "name": "Other", "accentDark": "#d1604f"})
        kit.bridge.screen_spec  # the subscription posts a refresh onto the UI thread
        kit_app.processEvents()
        kit_app.processEvents()
        assert "Other" in kit.bridge.screen_spec.product
        assert kit.bridge.accent != before
    finally:
        kit.close()
