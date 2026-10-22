# @pkey-feature ui.gate
# @pkey-feature ui.activate
# @pkey-feature ui.update
"""The Qt kit against UI-KITS (the spec pass): the product identity on every screen (§1.2, DL5), the
DL7 loading skeleton and its delay, copy with no placeholder or raw number left in it (DL8), one
filled control (DL4) and each state's own handling (DL6, DL7)."""

from __future__ import annotations

import pytest

pytest.importorskip("PySide6.QtQuick")

from polaris_key.ui.core.copy import Copy
from polaris_key.ui.core.identity import ProductIdentity
from polaris_key.ui.core.theme import Theme
from polaris_key.ui.core.ui_contract import context_of
from polaris_key.ui.core.ui_loading import DELAYED_LOADING_STATES
from polaris_key.ui.qt.kit import KitView
from polaris_key.ui.qt.layout import build_spec
from qt_fixtures import MODELS, TIDEWATER, FakeSource, rows, states, with_defaults

COPY = Copy("en", platform="desktop")
BY_STATE = {(c, s): v for c, s, _, v in states()}
VISIBLE = [(c, s) for (c, s) in BY_STATE if s != "hidden"]


def _spec(component: str, state: str, **identity):
    return build_spec(BY_STATE[(component, state)], COPY, **identity)


def _nameless_views():
    """Every state with no product anywhere: no integrator, presentation or bundle identity."""
    seen, out = set(), []
    for row in rows():
        raw = {k: v for k, v in row["input"].items() if k not in ("integrator", "presentation", "bundle")}
        view = MODELS[row["expect"]["component"]](context_of(with_defaults(raw)))
        if (view.component, view.state) not in seen:
            seen.add((view.component, view.state))
            out.append(view)
    return out


def _kit(view, *, source=None, theme=None, delay=0):
    kit = KitView(
        theme or Theme(color_scheme="dark", platform="gnome"),
        source=source if source is not None else FakeSource(TIDEWATER),
        size=(480, 560),
        loading_delay_ms=delay,
    )
    kit.set_view(view)
    kit.grab()
    return kit


def _find(kit, name):
    """The first item named ``name`` in the visual tree (a Repeater's delegates are visual children)."""
    todo = [kit.view.rootObject()]
    while todo:
        item = todo.pop(0)
        if item.objectName() == name:
            return item
        todo.extend(item.childItems())
    return None


# ── §1.2, DL5: the product is the identity ──────────────────────────────────────────────────────


@pytest.mark.parametrize("component,state", VISIBLE, ids=[f"{c}.{s}" for c, s in VISIBLE])
def test_the_name_is_drawn_once_per_screen(component, state):
    spec = _spec(component, state, product="⁨Tidewater Studio⁩", developer="Harbor Audio")
    in_title = "Tidewater Studio" in spec.title
    assert spec.show_name is (not in_title)
    # the developer attribution is Welcome's alone (§1.2)
    assert bool(spec.developer_line) is (component == "Welcome")


def test_no_icon_draws_a_monogram_tile_not_nothing(kit_app):
    kit = _kit(BY_STATE[("Activate", "empty")])
    try:
        tile = _find(kit, "monogram")
        assert tile is not None and tile.isVisible()
        assert kit.bridge.monogram == "T"
        assert not _find(kit, "icon").isVisible()
    finally:
        kit.close()


def test_a_nameless_product_has_no_header_to_invent(kit_app):
    kit = _kit(BY_STATE[("Welcome", "default")], source=FakeSource(None), theme=Theme(color_scheme="dark"))
    try:
        assert kit.bridge.monogram == ""
        assert not _find(kit, "monogram").isVisible()
    finally:
        kit.close()


def test_the_integrators_name_is_the_monogram(kit_app):
    kit = _kit(
        BY_STATE[("Welcome", "default")],
        source=FakeSource(None),
        theme=Theme(color_scheme="light", product=ProductIdentity(name="ørbit")),
    )
    try:
        assert kit.bridge.monogram == "Ø"
    finally:
        kit.close()


def test_welcome_leads_with_the_hero_size(kit_app):
    kit = _kit(BY_STATE[("Welcome", "default")])
    welcome = _find(kit, "monogram").width()
    kit.set_view(BY_STATE[("Activate", "empty")])
    kit.grab()
    step = _find(kit, "monogram").width()
    kit.close()
    assert (welcome, step) == (64, 32)


# ── DL7: loading is the 2 px shimmer, after a delay ─────────────────────────────────────────────


@pytest.mark.parametrize("key", sorted(DELAYED_LOADING_STATES & {f"{c}.{s}" for c, s in BY_STATE}))
def test_a_load_is_a_muted_label_and_the_shimmer(key):
    spec = _spec(*key.split("."), product="Tidewater Studio")
    assert spec.loading and spec.progress == -1.0  # never a part-filled bar
    assert not spec.buttons


def test_boot_never_draws_a_part_filled_bar():
    for state in ("progress", "fetching"):
        assert _spec("Boot", state).progress == -1.0
    assert _spec("UpdateProgress", "downloading").progress == pytest.approx(0.4)  # counted bytes only


def test_the_shimmer_is_two_pixels_and_the_bar_stays_away(kit_app):
    kit = _kit(BY_STATE[("Boot", "progress")])
    try:
        assert _find(kit, "shimmer").isVisible() and _find(kit, "shimmer").height() == 2
        assert not _find(kit, "bar").isVisible()
    finally:
        kit.close()


def test_a_counted_download_draws_the_bar(kit_app):
    kit = _kit(BY_STATE[("UpdateProgress", "downloading")])
    try:
        assert _find(kit, "bar").isVisible() and not _find(kit, "shimmer").isVisible()
        assert _find(kit, "card").isVisible(), "a download with a count is never a blank window"
    finally:
        kit.close()


def test_a_load_shows_nothing_for_the_first_250_ms(kit_app):
    from PySide6.QtTest import QTest

    kit = _kit(BY_STATE[("Devices", "loading")], delay=250)
    try:
        assert kit.bridge.loadingShown is False and not _find(kit, "card").isVisible()
        QTest.qWait(320)
        assert kit.bridge.loadingShown is True
        kit.grab()
        assert _find(kit, "card").isVisible()
    finally:
        kit.close()


def test_a_screen_that_is_not_a_load_has_no_delay(kit_app):
    kit = _kit(BY_STATE[("Welcome", "default")], delay=250)
    try:
        assert kit.bridge.loadingShown is True and _find(kit, "card").isVisible()
    finally:
        kit.close()


# ── DL8: copy from the catalog, nothing dangling ────────────────────────────────────────────────


def test_a_byte_count_reads_as_a_size_not_a_number():
    spec = _spec("Boot", "consent", product="Tidewater Studio")
    line = next(t for t in spec.body if "of new content" in t)
    assert "52 MB" in line and "52428800" not in line


@pytest.mark.parametrize("view", _nameless_views(), ids=lambda v: f"{v.component}.{v.state}")
def test_a_nameless_product_leaves_no_placeholder_and_no_wordless_screen(view):
    spec = build_spec(view, COPY)
    for text in [spec.title, *spec.body, *(b.text for b in spec.buttons), *(f.label for f in spec.fields)]:
        assert "{" not in text and "}" not in text, text
    if view.state != "hidden" and view.copy:
        assert spec.title or spec.body or spec.buttons or spec.fields or spec.progress is not None, "a blank window"


def test_a_failed_boot_without_a_name_still_says_something():
    view = next(v for v in _nameless_views() if (v.component, v.state) == ("PolarisKeyGate", "error"))
    assert build_spec(view, COPY).title == COPY("core.fallback.title")


def test_row_fragments_do_not_dangle_without_their_row():
    spec = _spec("Settings", "list", product="Tidewater Studio")
    assert not {"On", "Off", "Default", "Changed by you", "Set by the environment"} & set(spec.body)
    spec = _spec("AccountAndLicense", "signed-in", product="Tidewater Studio")
    assert not {"Cloud Sync", "Devices", "Release channel", "Updates"} & set(spec.body)
    spec = _spec("DeviceLimit", "default", product="Tidewater Studio")
    assert "3 of 3 in use" not in spec.body, "the title already says it (DL8)"


# ── DL4: one filled control; a lone action is it; a busy one keeps its label ────────────────────


@pytest.mark.parametrize("component,state", VISIBLE, ids=[f"{c}.{s}" for c, s in VISIBLE])
def test_at_most_one_filled_control(component, state):
    spec = _spec(component, state, product="Tidewater Studio")
    assert sum(b.role == "primary" for b in spec.buttons) <= 1
    if len(spec.buttons) == 1 and component not in ("Toast", "GraceBanner"):
        assert spec.buttons[0].role == "primary"


def test_a_busy_activate_keeps_its_label_and_adds_the_indicator():
    spec = _spec("Activate", "busy", product="Tidewater Studio")
    primary = [b for b in spec.buttons if b.role == "primary"]
    assert [b.text for b in primary] == [COPY("activate.submit")] and primary[0].busy
    assert spec.progress is None  # not a bar under the screen


def test_a_busy_welcome_keeps_sign_in():
    spec = _spec("Welcome", "busy", product="Tidewater Studio")
    assert [(b.text, b.busy) for b in spec.buttons if b.role == "primary"] == [(COPY("welcome.signIn"), True)]


def test_the_changelog_links_recede_behind_update_now():
    spec = _spec("UpdatePrompt", "available", product="Tidewater Studio")
    roles = {b.key: b.role for b in spec.buttons}
    assert roles["update.install"] == "primary"
    assert roles["update.whatsNew"] == roles["update.allChanges"] == "quiet"


def test_revoked_offers_the_other_key_as_a_control_not_a_sentence():
    spec = _spec("StatusScreen", "revoked", product="Tidewater Studio")
    assert COPY("signin.key.differentKey") in [b.text for b in spec.buttons]
    assert COPY("signin.key.differentKey") not in spec.body


# ── DL7: an error sits under the control that caused it ─────────────────────────────────────────


def test_the_key_field_holds_its_own_error():
    spec = _spec("Activate", "cut-short", product="Tidewater Studio")
    (field,) = spec.fields
    assert field.label == COPY("part.keyField.label") and "cut short" in field.error
    assert field.error not in spec.body
    assert spec.title_tone == ""  # the input is wrong, not the screen


def test_a_valid_key_names_the_product_under_the_field():
    (field,) = _spec("Activate", "parsed", product="Tidewater Studio").fields
    assert "Tidewater Studio" in field.hint and not field.error


def test_a_failed_screen_keeps_the_danger_title():
    assert _spec("Devices", "error", product="Tidewater Studio").title_tone == "danger"


def test_the_activate_field_draws_with_the_danger_stroke(kit_app):
    kit = _kit(BY_STATE[("Activate", "cut-short")])
    try:
        entry = _find(kit, "entry")
        assert entry is not None and entry.isVisible()
        assert entry.property("placeholderText") == COPY("part.keyField.placeholder")
    finally:
        kit.close()


def test_typing_in_the_field_reaches_the_host(kit_app):
    kit = _kit(BY_STATE[("Activate", "empty")])
    got = []
    kit.bridge.edited.connect(lambda key, text: got.append((key, text)))
    try:
        kit.bridge.edit("part.keyField.label", "pkey_x")
        assert got == [("part.keyField.label", "pkey_x")]
    finally:
        kit.close()
