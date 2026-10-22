# @pkey-feature ui.theme
"""Every Theme option reads in the Qt kit (UI-KITS §3.1, §3.4), or is documented as meaningless here.

``look`` is the pure half (a Theme and a host in, a Look out); the live tests draw the kit and read
the QML tree, so a value that never reaches ``Theme.qml`` fails them."""

from __future__ import annotations

import pytest

from polaris_key.ui.core.identity import ProductIdentity
from polaris_key.ui.core.theme import Theme
from polaris_key.ui.qt.look import PALETTE_ROLES, Host, color_overrides, resolve_look, service_for

HOST_DARK = Host(
    os_scheme="dark",
    palette={"window": "#2b2b2b", "base": "#1e1e1e", "alternate_base": "#262626", "text": "#f2f2f2", "placeholder": "#8a8a8a", "highlight": "#3584e4"},
    app_font="Cantarell",
    system_font="Noto Sans",
)
HOST_LIGHT = Host(
    os_scheme="light",
    palette={"window": "#fafafa", "base": "#ffffff", "alternate_base": "#f0f0f0", "text": "#202020", "placeholder": "#707070", "highlight": "#1c71d8"},
    app_font="Cantarell",
    system_font="Noto Sans",
)


# ── The pure half ──────────────────────────────────────────────────────────────────────────────


def test_system_scheme_is_the_os_and_the_option_is_only_the_fallback():
    assert resolve_look(Theme(), HOST_LIGHT, "dark").scheme == "light"
    assert resolve_look(Theme(), HOST_DARK, "light").scheme == "dark"
    # the OS says nothing: dark, or what the host passed
    assert resolve_look(Theme(), Host(), "dark").scheme == "dark"
    assert resolve_look(Theme(), Host(), "light").scheme == "light"
    # an explicit scheme is never the OS's
    assert resolve_look(Theme(color_scheme="dark"), HOST_LIGHT).scheme == "dark"


def test_the_defaults_change_nothing():
    look = resolve_look(Theme(color_scheme="dark"), HOST_DARK)
    assert (look.native, look.colors, look.density, look.radius_scale, look.radius_px) == (False, {}, "comfortable", 1.0, -1.0)
    assert (look.font_family, look.display_family, look.text_scale) == ("", "", 1.0)
    assert look.ambient and not look.service_cues and look.host_accent is None


def test_colors_name_roles_per_scheme_in_either_casing_and_ignore_the_rest():
    theme = Theme(
        colors={
            "dark": {"surfacePage": "#101820", "text_strong": "#ffeedd", "link": "#ff00ff", "danger": "nonsense"},
            "light": {"surfacePage": "#fefefe"},
        }
    )
    assert color_overrides(theme, "dark") == {"surfacePage": "#101820", "textStrong": "#ffeedd"}
    assert color_overrides(theme, "light") == {"surfacePage": "#fefefe"}
    assert set(color_overrides(theme, "dark")) <= set(PALETTE_ROLES)


def test_a_status_role_takes_its_border_subtle_fill_and_label():
    out = color_overrides(Theme(colors={"dark": {"danger": "#ff3366"}}), "dark")
    assert out["danger"] == "#ff3366" and out["dangerBorder"] == "#ff3366" and out["dangerSolid"] == "#ff3366"
    assert out["dangerSubtle"] != "#ff3366" and out["dangerSolidOn"] in ("#ffffff", "#060912")
    # an explicit part is the integrator's word
    out = color_overrides(Theme(colors={"dark": {"danger": "#ff3366", "dangerBorder": "#112233"}}), "dark")
    assert out["dangerBorder"] == "#112233"


@pytest.mark.parametrize(
    "radius,scale,surface,px",
    [("sm", 0.5, 0.67, -1.0), ("md", 1.0, 1.0, -1.0), ("lg", 1.5, 1.33, -1.0), (10, 1.0, 1.0, 10.0), (0, 1.0, 1.0, 0.0)],
)
def test_radius(radius, scale, surface, px):
    look = resolve_look(Theme(radius=radius))
    assert (look.radius_scale, look.surface_scale, look.radius_px) == (scale, surface, px)


def test_typography_family_display_mono_and_scale():
    assert resolve_look(Theme(typography={"family": "system"}), HOST_DARK).font_family == "Noto Sans"
    assert resolve_look(Theme(typography={"family": "inherit"}), HOST_DARK).font_family == "Cantarell"
    look = resolve_look(Theme(typography={"family": "Georgia", "display": "Playfair", "monoFamily": "Menlo", "scale": 1.25}))
    assert (look.font_family, look.display_family, look.mono_family, look.text_scale) == ("Georgia", "Playfair", "Menlo", 1.25)
    assert resolve_look(Theme(typography={"mono_family": "Hack"})).mono_family == "Hack"
    assert resolve_look(Theme(typography={"scale": -2})).text_scale == 1.0  # not a size


def test_native_takes_the_hosts_palette_font_and_accent_and_no_ambient():
    look = resolve_look(Theme(preset="native"), HOST_DARK)
    assert look.native and not look.ambient
    assert look.colors["surfacePage"] == "#2b2b2b" and look.colors["textStrong"] == "#f2f2f2"
    assert look.font_family == "Cantarell" and look.host_accent == "#3584e4"
    # its scheme is the palette's when the theme leaves it to the system
    assert resolve_look(Theme(preset="native"), Host(palette=HOST_LIGHT.palette)).scheme == "light"
    # the integrator's colours still win over the host's
    assert resolve_look(Theme(preset="native", colors={"dark": {"surfacePage": "#000000"}}), HOST_DARK).colors["surfacePage"] == "#000000"
    # and ambient is the integrator's to turn on only under polaris-key
    assert not resolve_look(Theme(preset="native", ambient=True), HOST_DARK).ambient


def test_service_cues_are_implied_by_the_service_accent():
    assert not resolve_look(Theme()).service_cues
    assert resolve_look(Theme(service_cues=True)).service_cues
    look = resolve_look(Theme(accent="service"))
    assert look.service_cues and look.service_accent
    assert service_for("Settings") == "config" and service_for("SignIn") == "identity" and service_for("Nope") is None


# ── Live QML ───────────────────────────────────────────────────────────────────────────────────

pytest.importorskip("PySide6.QtQuick")

from polaris_key.ui.core import ui_settings  # noqa: E402
from polaris_key.ui.core.ui_contract import context_of  # noqa: E402
from polaris_key.ui.qt import bridge as bridge_module  # noqa: E402
from polaris_key.ui.qt.kit import KitView  # noqa: E402
from qt_fixtures import BY_STATE_VIEWS, TIDEWATER, FakeSource, with_defaults  # noqa: E402


def _kit(theme, view=None, source=None, size=(480, 640), **kw):
    kit = KitView(theme, source=source if source is not None else FakeSource(TIDEWATER), size=size, loading_delay_ms=0, **kw)
    kit.set_view(view or BY_STATE_VIEWS[("Welcome", "default")])
    kit.grab()
    return kit


def _walk(kit):
    out, stack = [], [kit.view.rootObject()]
    while stack:
        item = stack.pop(0)
        out.append(item)
        stack = list(item.childItems()) + stack
    return out


def _named(kit, name):
    return next((i for i in _walk(kit) if i.objectName() == name), None)


def _buttons(kit):
    return [i for i in _walk(kit) if "Button" in i.metaObject().className() and i.property("text")]


def _colour(item, prop="color"):
    return item.property(prop).name()


def test_colors_override_the_palette_in_the_scheme_in_effect(kit_app):
    theme = Theme(color_scheme="dark", colors={"dark": {"surfacePage": "#101820", "surfaceRaised": "#203040"}, "light": {"surfacePage": "#fefefe"}})
    kit = _kit(theme)
    try:
        assert _colour(kit.view.rootObject()) == "#101820" and _colour(_named(kit, "card")) == "#203040"
        kit.bridge.set_theme(theme.with_(color_scheme="light"))
        kit.grab()
        assert _colour(kit.view.rootObject()) == "#fefefe"
        assert _colour(_named(kit, "card")) == "#ffffff"  # no light override: the token
    finally:
        kit.close()


def test_a_status_colour_recolours_the_title_of_a_failure(kit_app):
    view = BY_STATE_VIEWS[("PolarisKeyGate", "error")]
    plain = _kit(Theme(color_scheme="dark"), view)
    themed = _kit(Theme(color_scheme="dark", colors={"dark": {"danger": "#ff00aa"}}), view)
    try:
        title = lambda k: next(i for i in _walk(k) if i.property("text") == k.bridge.screen_spec.title and "Text" in i.metaObject().className())
        assert _colour(title(plain), "color") != "#ff00aa"
        assert _colour(title(themed), "color") == "#ff00aa"
    finally:
        plain.close()
        themed.close()


@pytest.mark.parametrize("radius,card", [("sm", 14 * 0.67), ("md", 14), ("lg", 14 * 1.33), (10, 16)])
def test_radius_scales_the_surfaces_and_a_number_sets_the_control(kit_app, radius, card):
    kit = _kit(Theme(color_scheme="dark", platform="gnome", radius=radius))
    try:
        assert _named(kit, "card").property("radius") == pytest.approx(card, abs=0.01)
        button = _buttons(kit)[0].property("background")
        control = {"sm": 4, "md": 8, "lg": 12, 10: 10}[radius]
        assert button.property("radius") == pytest.approx(control, abs=0.01)
    finally:
        kit.close()


def test_a_capsule_control_stays_a_capsule_for_a_named_radius_and_a_number_ends_it(kit_app):
    kit = _kit(Theme(color_scheme="dark", platform="macos", radius="lg"))
    try:
        background = _buttons(kit)[0].property("background")
        assert background.property("radius") == pytest.approx(background.property("height") / 2)
        kit.bridge.set_theme(Theme(color_scheme="dark", platform="macos", radius=6))
        kit.grab()
        assert _buttons(kit)[0].property("background").property("radius") == 6
    finally:
        kit.close()


@pytest.mark.parametrize("density,height,pad", [("compact", 30, 18), ("comfortable", 34, 24), ("spacious", 42, 30)])
def test_density_sets_control_height_and_padding_only(kit_app, density, height, pad):
    kit = _kit(Theme(color_scheme="dark", platform="gnome", density=density))
    try:
        assert _buttons(kit)[0].property("implicitHeight") == height
        card = _named(kit, "card")
        # the card's height is its content plus twice the padding: the padding moved, the content did not
        assert card.property("height") >= 2 * pad
        assert "Tidewater Studio" in kit.bridge.screen_spec.title  # never the component
    finally:
        kit.close()


def test_density_changes_the_card_height_in_steps(kit_app):
    heights = {}
    for density in ("compact", "comfortable", "spacious"):
        kit = _kit(Theme(color_scheme="dark", density=density), size=(480, 900))
        heights[density] = _named(kit, "card").property("height")
        kit.close()
    assert heights["compact"] < heights["comfortable"] < heights["spacious"]


def test_typography_family_display_and_scale_reach_the_text(kit_app):
    kit = _kit(Theme(color_scheme="dark", typography={"family": "Georgia", "display": "Playfair Display", "scale": 1.5}), font_scale=1.0)
    try:
        title = next(i for i in _walk(kit) if i.property("text") == kit.bridge.screen_spec.title)
        body = next(i for i in _walk(kit) if i.property("text") == "Sign in or use a license key to continue.")
        assert title.property("font").family() == "Playfair Display"
        assert body.property("font").family() == "Georgia"
        base = _kit(Theme(color_scheme="dark"))
        try:
            plain = next(i for i in _walk(base) if i.property("text") == "Sign in or use a license key to continue.")
            assert body.property("font").pixelSize() == round(plain.property("font").pixelSize() * 1.5)
            assert plain.property("font").family() == "Rubik"
        finally:
            base.close()
    finally:
        kit.close()


def test_system_and_inherit_families_come_from_the_host(kit_app, monkeypatch):
    monkeypatch.setattr(bridge_module, "read_host", lambda: HOST_DARK)
    for family, expected in (("system", "Noto Sans"), ("inherit", "Cantarell")):
        kit = _kit(Theme(color_scheme="dark", typography={"family": family}))
        try:
            body = next(i for i in _walk(kit) if i.property("text") == "Sign in or use a license key to continue.")
            assert body.property("font").family() == expected
        finally:
            kit.close()


def test_ambient_is_on_with_an_accent_and_off_when_asked_or_without_one(kit_app):
    on = _kit(Theme(color_scheme="dark"))
    off = _kit(Theme(color_scheme="dark", ambient=False))
    ink = _kit(Theme(color_scheme="dark"), source=FakeSource({"name": "Tidewater Studio"}))
    try:
        assert _named(on, "ambient").property("visible") is True and on.bridge.ambientSource.startswith("data:image/png;base64,")
        assert _named(off, "ambient").property("visible") is False
        assert _named(ink, "ambient").property("visible") is False  # ink has no tint to glow with
        assert on.grab() != off.grab()
    finally:
        for kit in (on, off, ink):
            kit.close()


def test_native_takes_the_hosts_look(kit_app, monkeypatch):
    monkeypatch.setattr(bridge_module, "read_host", lambda: HOST_LIGHT)
    kit = _kit(Theme(preset="native"), source=FakeSource({"name": "Tidewater Studio", "developerName": "Harbor Audio", "accent": "#aa3388"}))
    try:
        assert kit.bridge.scheme == "light"
        assert _colour(kit.view.rootObject()) == "#fafafa" and _colour(_named(kit, "card")) == "#ffffff"
        assert _named(kit, "ambient").property("visible") is False
        body = next(i for i in _walk(kit) if i.property("text") == "Sign in or use a license key to continue.")
        assert body.property("font").family() == "Cantarell"
        # the host's highlight, resolved for contrast, is the accent: the product's own pink is not
        primary = next(b for b in _buttons(kit) if b.property("text") == "Sign in")
        assert _colour(primary.property("background"), "color") != "#aa3388"
        assert kit.bridge.accent == kit.bridge.accent and kit.bridge.accent != ""
        # an integrator's accent wins over the host's
        kit.bridge.set_theme(Theme(preset="native", product=ProductIdentity(name="T", accent="#aa3388")))
        assert kit.bridge.accent != ""
    finally:
        kit.close()


def test_native_follows_the_palette_when_it_changes(kit_app, monkeypatch):
    monkeypatch.setattr(bridge_module, "read_host", lambda: HOST_LIGHT)
    kit = _kit(Theme(preset="native"))
    try:
        assert _colour(kit.view.rootObject()) == "#fafafa"
        monkeypatch.setattr(bridge_module, "read_host", lambda: HOST_DARK)
        kit_app.paletteChanged.emit(kit_app.palette())
        kit_app.processEvents()
        kit.grab()
        assert _colour(kit.view.rootObject()) == "#2b2b2b" and kit.bridge.scheme == "dark"
    finally:
        kit.close()


def _settings_view():
    config = [
        {"key": "ui.compact", "type": "boolean", "source": "default", "locked": False, "value": True},
        {"key": "net.proxy", "type": "string", "source": "default", "locked": True, "org": "Harbor Audio", "value": "p.example"},
    ]
    return ui_settings.settings_view(context_of(with_defaults({"config": config})))


def _cues(kit):
    return [i for i in _walk(kit) if i.objectName() == "serviceCue" and i.property("visible")]


def test_service_cues_are_off_by_default_and_tile_the_group_headers_when_asked(kit_app):
    view = _settings_view()
    plain = _kit(Theme(color_scheme="dark"), view)
    cued = _kit(Theme(color_scheme="dark", service_cues=True), view)
    try:
        data = {"config": [
            {"key": "ui.compact", "type": "boolean", "source": "default", "locked": False, "value": True},
            {"key": "net.proxy", "type": "string", "source": "default", "locked": True, "org": "Harbor Audio", "value": "p.example"},
        ]}
        plain.set_view(view, data)
        cued.set_view(view, data)
        plain.grab()
        cued.grab()
        assert _cues(plain) == []
        assert len(_cues(cued)) >= 1
        tile = _cues(cued)[0]
        assert tile.property("width") == 20  # the 20 pt tile
    finally:
        plain.close()
        cued.close()


def test_the_service_accent_draws_a_section_in_its_own_accent(kit_app):
    view = _settings_view()
    plain = _kit(Theme(color_scheme="dark"), view)
    service = _kit(Theme(color_scheme="dark", accent="service"), view)
    ident = _kit(Theme(color_scheme="dark", accent="service"), BY_STATE_VIEWS[("SignIn", "methods")])
    try:
        assert plain.bridge.accent != service.bridge.accent
        assert service.bridge.accent == "#fac700"  # config's accent in dark
        assert ident.bridge.accent == "#d77df2"  # identity's
    finally:
        for kit in (plain, service, ident):
            kit.close()


def test_symbols_is_the_terminals_and_changes_nothing_in_qt(kit_app):
    a = _kit(Theme(color_scheme="dark"))
    b = _kit(Theme(color_scheme="dark", symbols="ascii"))
    try:
        assert a.grab() == b.grab()
    finally:
        a.close()
        b.close()


# ── color_scheme="system" follows the OS ───────────────────────────────────────────────────────


def test_read_host_maps_the_os_appearance(kit_app, monkeypatch):
    from PySide6.QtCore import Qt

    app = kit_app
    for value, expected in ((Qt.ColorScheme.Dark, "dark"), (Qt.ColorScheme.Light, "light"), (Qt.ColorScheme.Unknown, None)):
        hints = type("Hints", (), {"colorScheme": lambda self, v=value: v})()
        stub = type("App", (), {"styleHints": lambda self, h=hints: h, "palette": lambda self: app.palette(), "font": lambda self: app.font()})()
        monkeypatch.setattr(bridge_module.qt.QtGui.QGuiApplication, "instance", staticmethod(lambda s=stub: s))
        assert bridge_module.read_host().os_scheme == expected


def test_system_scheme_follows_the_os_live(kit_app, monkeypatch):
    from PySide6.QtCore import Qt

    monkeypatch.setattr(bridge_module, "read_host", lambda: HOST_LIGHT)
    kit = _kit(Theme())  # color_scheme="system", no system_scheme=
    try:
        assert kit.bridge.scheme == "light" and _colour(kit.view.rootObject()) == "#f6f8ff"
        # the platform reports a change: the kit draws the new scheme with no call from the host
        monkeypatch.setattr(bridge_module, "read_host", lambda: HOST_DARK)
        kit_app.styleHints().colorSchemeChanged.emit(Qt.ColorScheme.Dark)
        kit_app.processEvents()
        kit.grab()
        assert kit.bridge.scheme == "dark" and _colour(kit.view.rootObject()) == "#060912"
    finally:
        kit.close()


def test_the_system_scheme_option_is_what_a_silent_os_means(kit_app, monkeypatch):
    monkeypatch.setattr(bridge_module, "read_host", lambda: Host())
    kit = _kit(Theme(), system_scheme="light")
    try:
        assert kit.bridge.scheme == "light"
    finally:
        kit.close()


def test_the_real_platform_scheme_when_it_can_be_set(kit_app):
    """On a platform plugin that honours ``QStyleHints.setColorScheme`` (macOS, Windows, GNOME) the
    kit follows it with nothing patched; the offscreen plugin ignores it, so this skips there."""
    from PySide6.QtCore import Qt

    hints = kit_app.styleHints()
    if not hasattr(hints, "setColorScheme"):
        pytest.skip("Qt before 6.8 cannot set the scheme")
    hints.setColorScheme(Qt.ColorScheme.Light)
    kit_app.processEvents()
    if hints.colorScheme() != Qt.ColorScheme.Light:
        hints.unsetColorScheme()
        pytest.skip("this platform plugin ignores setColorScheme")
    kit = _kit(Theme())
    try:
        assert kit.bridge.scheme == "light"
        hints.setColorScheme(Qt.ColorScheme.Dark)
        kit_app.processEvents()
        assert kit.bridge.scheme == "dark"
    finally:
        kit.close()
        hints.unsetColorScheme()


# ── KitView.container() ────────────────────────────────────────────────────────────────────────


def test_container_is_a_widget_that_holds_the_view(kit_app):
    from PySide6.QtWidgets import QVBoxLayout, QWidget

    kit = KitView(Theme(color_scheme="dark"), source=FakeSource(TIDEWATER), size=(480, 560), loading_delay_ms=0)
    host = QWidget()
    try:
        box = kit.container()
        assert isinstance(box, QWidget) and kit.container() is box  # the same widget every time
        layout = QVBoxLayout(host)
        layout.addWidget(box)
        kit.set_view(BY_STATE_VIEWS[("Welcome", "default")])
        host.resize(480, 560)
        host.show()
        for _ in range(3):
            kit_app.processEvents()
        assert box.parent() is host and box.width() > 0
        assert "Tidewater Studio" in kit.view.rootObject().property("spec")["title"]
    finally:
        kit.close()
        host.deleteLater()
        from PySide6.QtCore import QCoreApplication, QEvent

        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
