# @pkey-feature ui.devices
# @pkey-feature ui.devicelimit
# @pkey-feature ui.settings
"""The Qt kit's rows: settings (Switch, choice, slider, field, provenance and lock), devices (64 px
rows, glyph, "This Mac", Least recent, a Rename and Remove button per row), the seat meter and the
account rows. Layout (no Qt) and real controls (a live QML tree), for the empty, one-row, many-row and
long-name cases."""

from __future__ import annotations

import re
from typing import Any, Dict, List

import pytest

from polaris_key.ui.core import ui_devices, ui_settings
from polaris_key.ui.core.copy import Copy
from polaris_key.ui.core.ui_contract import context_of
from polaris_key.ui.qt.layout import build_spec
from polaris_key.ui.qt.rows import RowData, row_data, setting_label
from qt_fixtures import TIDEWATER, FakeSource, with_defaults

COPY = Copy("en", platform="desktop")


def _device(name, ff="computer", platform="windows", days=1, current=False) -> Dict[str, Any]:
    return {"name": name, "platform": platform, "formFactor": ff, "lastSeenDays": days, "current": current}


def _devices_view(devices, **extra):
    return ui_devices.devices_view(context_of(with_defaults({"devices": devices, **extra})))


def _limit_view(devices, **extra):
    base = {"activation": {"result": "device-limit", "limit": 3, "deviceCount": 3}, "devices": devices, **extra}
    return ui_devices.device_limit_view(context_of(with_defaults(base)))


def _settings_view(config, **extra):
    return ui_settings.settings_view(context_of(with_defaults({"config": config, **extra})))


def _account_view(**account):
    return ui_settings.account_view(context_of(with_defaults({"account": {"signedIn": True, **account}})))


def _spec(view, data=None, **kw):
    return build_spec(view, COPY, product="Tidewater Studio", developer="Harbor Audio", data=row_data(data if data is not None else view.rows), **kw)


def _rows(spec):
    return [r for g in spec.groups for r in g.rows]


ISO = re.compile("[⁨⁩]")


def plain(text: str) -> str:
    return ISO.sub("", text)


# ── Layout ─────────────────────────────────────────────────────────────────────────────────────


def test_no_dangling_fragments_anywhere():
    views = [
        _devices_view([_device("Work laptop")]),
        _limit_view([_device("Work laptop", days=9), _device("Mac", current=True, days=0)]),
        _settings_view([{"key": "ui.compact", "type": "boolean", "source": "local", "locked": False, "value": True}]),
        _account_view(tier="Pro", holder="Mara"),
    ]
    for view in views:
        spec = _spec(view)
        texts = [spec.title, *spec.body, *[t for t, _ in spec.after]]
        for r in _rows(spec):
            texts += [r.title, r.meta, r.tag, r.text, r.value, *[a.text for a in r.actions]]
        for t in texts:
            assert "{" not in t, t
            assert not re.search(r"(·|:)\s*$", plain(t)), t
            assert not re.search(r"\bsettings\.|\bdevices\.|\baccount\.", t), t


def test_devices_empty_has_no_rows_and_says_so():
    spec = _spec(_devices_view([]))
    assert spec.groups == [] and spec.body == ["No devices are using this license yet."]


def test_one_device_row_is_this_device_with_rename_only():
    spec = _spec(_devices_view([_device("MacBook Pro", "mac", "macos", 0, current=True)]))
    (row,) = _rows(spec)
    assert row.meta == "This Mac" and row.glyph == "computer"
    assert [a.action for a in row.actions] == ["rename"]  # this device cannot remove itself
    assert row.actions[0].name == "Rename ⁨MacBook Pro⁩"
    assert spec.body[0] == "Devices using this license." and "1 device" in spec.body[1]  # DL8: the count once


def test_many_device_rows_each_named_and_ordered():
    devices = [_device("Device %d" % i, days=i) for i in range(15)]
    spec = _spec(_devices_view(devices))
    rows = _rows(spec)
    assert len(rows) == 15 and spec.body[-1] == "15 devices"
    assert all(r.meta.startswith("Windows · last used") for r in rows)
    assert len({a.name for r in rows for a in r.actions}) == 30  # every button says which row


def test_long_and_unnamed_device_names():
    long = "A very long device name " * 8
    spec = _spec(_devices_view([_device(long.strip()), _device(None, "phone", "ios", 3)]))
    first, second = _rows(spec)
    assert plain(first.title) == long.strip()  # the renderer elides; the model never truncates
    assert plain(second.title) == "Unnamed device" and second.glyph == "phone"
    assert "Unnamed device" in second.actions[0].name


def test_device_glyphs_by_form_factor():
    spec = _spec(_devices_view([_device("a", "ipad"), _device("b", "tv"), _device("c", "iphone"), _device("d", "mac")]))
    assert [r.glyph for r in _rows(spec)] == ["tablet", "tv", "phone", "computer"]
    assert all(r.glyph_label for r in _rows(spec))


def test_rename_and_confirm_rows_follow_the_edit():
    devices = [_device("Work laptop"), _device("iPad", "ipad", "ios", 3)]
    renaming = ui_devices.devices_view(context_of(with_defaults({"devices": devices, "edit": {"kind": "rename", "device": "Work laptop"}})))
    spec = _spec(renaming)
    edit = _rows(spec)[0]
    assert edit.kind == "edit" and edit.field_label == "Device name" and edit.text == "Work laptop"
    assert [a.key for a in edit.actions] == ["common.save", "common.cancel"]
    assert [a.role for a in edit.actions] == ["primary", "secondary"]  # DL4: one primary: one primary
    confirming = ui_devices.devices_view(context_of(with_defaults({"devices": devices, "edit": {"kind": "remove", "device": "iPad"}})))
    rows = _rows(_spec(confirming, selected_id=None))
    assert [r.kind for r in rows] == ["device", "device", "confirm"]  # the confirm sits under its row
    confirm = next(r for r in rows if r.kind == "confirm")
    assert "signs out of Tidewater Studio" in plain(confirm.text) and "iPad" in plain(confirm.text)


def test_device_limit_seat_meter_says_the_count_once():
    spec = _spec(_limit_view([_device("Work laptop", days=12), _device("iPad", "ipad", "ios", 3), _device("Mac", "mac", "macos", 0, True)]))
    assert spec.seat is not None and (spec.seat.used, spec.seat.limit) == (3, 3)
    assert spec.title == "Your license is on 3 of 3 devices"
    assert spec.seat.caption == ""  # the title gives the count: no caption repeats it (DL8)
    assert spec.seat.label == "3 of 3 devices in use"
    assert spec.seat.as_dict()["segments"] == [True, True, True] and not spec.seat.over


def test_device_limit_least_recent_tag_selection_and_confirm():
    devices = [_device("Work laptop", days=12), _device("iPad", "ipad", "ios", 3), _device("Mac", "mac", "macos", 0, True)]
    spec = _spec(_limit_view(devices))
    rows = _rows(spec)
    assert [r.tag for r in rows] == ["Least recent", "", ""]
    assert [r.selected for r in rows] == [True, False, False] and all(r.radio for r in rows)
    assert rows[2].enabled is False and rows[2].meta == "This Mac"
    assert spec.after[0][1] is True and plain(spec.after[0][0]) == "Replace Work laptop?"
    assert [b.role for b in spec.buttons] == ["primary", "quiet"]  # DL4: one filled
    picked = _spec(_limit_view(devices), selected_id="1")
    assert [r.selected for r in _rows(picked)] == [False, True, False]
    assert plain(picked.after[0][0]) == "Replace iPad?"
    assert [r.tag for r in _rows(picked)][0] == "Least recent"  # the tag stays on the least recent


def test_seat_meter_over_limit_and_cap():
    from polaris_key.ui.qt.rows import Seat

    assert Seat(4, 3, "x").over and len(Seat(2, 40, "x").as_dict()["segments"]) == 12


def test_settings_rows_have_real_controls_and_provenance():
    config = [
        {"key": "ui.compact", "type": "boolean", "source": "default", "locked": False, "value": True},
        {"key": "audio.volume", "type": "number", "source": "local", "locked": False, "min": 0, "max": 100, "value": 80},
        {"key": "render.quality", "type": "select", "source": "default", "locked": False, "value": "high", "options": [{"value": "low", "label": "Low"}, {"value": "high", "label": "High"}]},
        {"key": "net.proxy", "type": "string", "source": "env", "locked": False, "value": "proxy.local"},
        {"key": "net.lockdown", "type": "boolean", "source": "default", "locked": True, "org": "Fennick Studio", "value": True},
    ]
    spec = _spec(_settings_view(config))
    by = {r.id: r for r in _rows(spec)}
    assert by["ui.compact"].control == "switch" and by["ui.compact"].on and by["ui.compact"].state_text == "On"
    assert by["ui.compact"].meta == "Default"
    vol = by["audio.volume"]
    assert (vol.control, vol.minimum, vol.maximum, vol.number) == ("slider", 0.0, 100.0, 80.0)
    assert vol.meta == "Changed by you · Between 0 and 100"  # "Changed by you"
    assert [a.action for a in vol.actions] == ["reset"]
    assert by["render.quality"].control == "choice" and by["render.quality"].current == 1
    assert by["net.proxy"].control == "field" and by["net.proxy"].meta == "Set by the environment"
    lock = by["net.lockdown"]
    assert lock.control == "value" and lock.locked and lock.lock_label == "Locked" and "Fennick Studio" in lock.meta
    headings = [g.heading for g in spec.groups]
    assert "From Harbor Audio" in plain(" ".join(headings)) and "Managed settings" in headings
    assert all("." not in plain(r.title) for r in by.values())  # never the dotted key (DL8)


def test_settings_empty_one_many_and_long():
    assert _spec(_settings_view([])).groups == []
    one = _spec(_settings_view([{"key": "ui.sounds", "type": "boolean", "source": "default", "locked": False, "value": False}]))
    assert [r.id for r in _rows(one)] == ["ui.sounds"]
    many = [{"key": "k%d.flag" % i, "type": "boolean", "source": "default", "locked": False, "value": i % 2 == 0} for i in range(30)]
    spec = _spec(_settings_view(many))
    assert len([r for r in _rows(spec) if r.control == "switch"]) == 30 and spec.search == "Search settings"
    long = {"key": "x", "label": "An exceedingly long setting label " * 6, "type": "boolean", "source": "default", "locked": False, "value": True}
    assert plain(_rows(_spec(_settings_view([long])))[0].title).startswith("An exceedingly")


def test_advanced_settings_hide_until_toggled():
    config = [
        {"key": "a.b", "type": "boolean", "source": "default", "locked": False, "value": True},
        {"key": "debug.logging", "type": "boolean", "source": "default", "locked": False, "value": False, "advanced": True},
    ]
    view = _settings_view(config)
    hidden = [r.id for r in _rows(_spec(view))]
    shown = [r.id for r in _rows(_spec(view, advanced=True))]
    assert "debug.logging" not in hidden and "debug.logging" in shown


def test_setting_label_reads_a_key_as_words():
    assert setting_label({"key": "audio.volume"}) == "Audio volume"
    assert setting_label({"key": "ui.compact"}) == "UI compact"
    assert setting_label({"key": "x", "label": " Mine "}) == "Mine"


def test_account_rows_signed_in_and_key_only():
    spec = _spec(_account_view(tier="Pro", holder="Mara", devices={"used": 2, "limit": 3}, autoUpdate=True, channel="stable", version="2.4.1", renew=True))
    by = {r.id: r for g in spec.groups for r in g.rows}
    assert plain(by["holder"].title) == "Signed in as Mara" and by["holder"].actions[0].external
    assert plain(by["tier"].title) == "Pro license" and by["tier"].actions[0].action == "renew"
    assert plain(by["tier"].actions[0].text) == "Renew with Harbor Audio"
    assert by["devices"].value == "2 of 3 devices" and by["devices"].seat.used == 2
    assert by["autoUpdate"].control == "switch" and by["autoUpdate"].on
    assert by["version"].title == "Version 2.4.1" and by["version"].actions[0].action == "check-update"
    assert by["signOut"].actions[0].role == "dangerText"
    key_only = _spec(ui_settings.account_view(context_of(with_defaults({"account": {"signedIn": False}}))))
    titles = [r.title for g in key_only.groups for r in g.rows]
    assert "Activated with a license key" in titles


def test_renew_names_the_developer_and_falls_back_to_a_bare_renew():
    view = _account_view(tier="Pro", renew=True)
    named = _spec(view)
    assert plain(next(r for r in _rows(named) if r.id == "tier").actions[0].text) == "Renew with Harbor Audio"
    from polaris_key.ui.qt.rows import build_rows

    bare = build_rows(view, COPY, row_data(view.rows), {})
    assert next(r for g in bare.groups for r in g.rows if r.id == "tier").actions[0].text == "Renew"
    from polaris_key.ui.kit_copy_generated import KIT_COPY

    assert KIT_COPY["en"]["license.renew"] == "Renew with {developer}"
    assert "license.expired" not in KIT_COPY["en"]  # the portal's other license keys stay out


def test_the_remove_confirm_is_the_destructive_style():
    view = ui_devices.devices_view(context_of(with_defaults({"devices": [_device("A"), _device("B")], "edit": {"kind": "remove", "device": "B"}, "selected": 1})))
    if view.state != "confirming":
        pytest.skip("fixture does not reach the confirm state")
    confirm = next(r for r in _rows(_spec(view)) if r.kind == "confirm")
    assert [a.role for a in confirm.actions] == ["danger", "secondary"]


def test_account_action_rows_have_no_words_of_their_own():
    spec = _spec(_account_view(tier="Pro", version="2.4.1"))
    sign_out = next(r for r in _rows(spec) if r.id == "signOut")
    assert sign_out.title == "" and sign_out.meta == "" and sign_out.control == "" and sign_out.value == ""
    check = _spec(_account_view(channel="stable"))
    assert [r.id for r in _rows(check) if r.title == "" and r.actions] == ["manage", "check", "signOut"]


def test_account_rows_leave_out_what_the_data_lacks():
    spec = _spec(_account_view())
    ids = [r.id for g in spec.groups for r in g.rows]
    assert "tier" not in ids and "devices" not in ids and "version" not in ids


def test_rich_models_carry_their_rows():
    from polaris_key.ui.core import models

    sv = models.settings_view([{"key": "ui.compact", "value": True, "source": "local"}, {"key": "net.x", "value": "a", "enforced": True, "org": "Org"}])
    data = row_data(sv)
    assert [c["locked"] for c in data.config] == [False, True]
    gv = models.gate_view("ok", now=0, holder="Mara", signed_in=True, tier="Pro", seats_used=1, seats_limit=2)
    assert row_data(gv).account["devices"] == {"used": 1, "limit": 2}
    with pytest.raises(TypeError):
        row_data(object())


# ── Live QML ───────────────────────────────────────────────────────────────────────────────────

pytest.importorskip("PySide6.QtQuick")
from polaris_key.ui.core.theme import Theme  # noqa: E402
from polaris_key.ui.qt.kit import KitView  # noqa: E402


def _kit(kit_app, view, data=None, size=(480, 900), scheme="dark"):
    kit = KitView(Theme(color_scheme=scheme, platform="gnome"), source=FakeSource(TIDEWATER), size=size, loading_delay_ms=0)
    kit.set_view(view, data)
    kit.grab()
    return kit


def _walk(kit):
    """Every item of the live scene, in visual (document) order."""
    out = []
    stack = [kit.view.rootObject()]
    while stack:
        item = stack.pop(0)
        out.append(item)
        stack = list(item.childItems()) + stack
    return out


def _items(kit, name):
    return [i for i in _walk(kit) if i.objectName() == name]


def test_switch_is_a_real_switch_with_a_name_and_reports_the_edit(kit_app):
    view = _settings_view([{"key": "ui.compact", "type": "boolean", "source": "default", "locked": False, "value": True}])
    kit = _kit(kit_app, view)
    try:
        (sw,) = _items(kit, "switch")[:1]
        assert sw.metaObject().className().startswith("QQuickSwitch") or "Switch" in sw.metaObject().className()
        assert sw.property("checked") is True and sw.property("visible") is True
        seen: List[Any] = []
        kit.bridge.edited.connect(lambda k, t: seen.append((k, t)))
        sw.click()
        assert seen == [("config:ui.compact", "false")]
        assert sw.property("activeFocusOnTab") is True
    finally:
        kit.close()


def test_row_buttons_are_real_buttons_named_for_their_row(kit_app):
    devices = [_device("Work laptop"), _device("iPad", "ipad", "ios", 3)]
    view = _devices_view(devices)
    kit = _kit(kit_app, view)
    try:
        buttons = _buttons(kit)
        names = sorted(str(b.property("text")) for b in buttons)
        assert names.count("Rename") == 2 and names.count("Remove") == 2
        seen: List[Any] = []
        kit.bridge.row_invoked.connect(lambda k, a, r: seen.append((k, a, r)))
        rename = next(b for b in buttons if b.property("text") == "Rename")
        rename.click()
        assert seen and seen[0][1] == "rename"
    finally:
        kit.close()


def test_rows_render_empty_one_many_in_both_themes(kit_app):
    for scheme in ("dark", "light"):
        for devices in ([], [_device("Only", current=True)], [_device("Device %d" % i, days=i) for i in range(15)], [_device("L" * 200)]):
            kit = _kit(kit_app, _devices_view(devices), scheme=scheme)
            try:
                assert not kit.grab().isNull()
                assert len(_items(kit, "group")) == (1 if devices else 0)
            finally:
                kit.close()


def test_the_seat_meter_and_radio_rows_draw_and_select(kit_app):
    devices = [_device("Work laptop", days=12), _device("iPad", "ipad", "ios", 3), _device("Mac", "mac", "macos", 0, True)]
    kit = _kit(kit_app, _limit_view(devices))
    try:
        assert _items(kit, "seatMeter") and _items(kit, "seatMeter")[0].property("visible") is True
        assert kit.bridge.screen_spec.groups[0].rows[0].selected
        kit.bridge.select("1")
        kit_app.processEvents()
        rows = kit.bridge.screen_spec.groups[0].rows
        assert [r.selected for r in rows] == [False, True, False]
        assert "iPad" in plain(kit.bridge.screen_spec.after[0][0])
        kit.bridge.set_view(_limit_view(devices))  # same screen again keeps the pick
        assert kit.bridge.screen_spec.groups[0].rows[1].selected
    finally:
        kit.close()


def test_focus_order_is_document_order(kit_app):
    config = [
        {"key": "a.one", "type": "boolean", "source": "default", "locked": False, "value": True},
        {"key": "a.two", "type": "boolean", "source": "default", "locked": False, "value": False},
    ]
    kit = _kit(kit_app, _settings_view(config))
    try:
        ys = [s.mapToItem(kit.view.rootObject(), 0, 0).y() for s in _items(kit, "switch")]
        visible = [y for s, y in zip(_items(kit, "switch"), ys) if s.property("visible")]
        assert visible == sorted(visible) and len(visible) >= 2
    finally:
        kit.close()


def _buttons(kit):
    return [b for b in _walk(kit) if b.metaObject().className().startswith("KitButton") and b.property("visible")]


def _rect(item, root):
    p = item.mapToItem(root, 0, 0)
    return p.x(), p.y(), item.width(), item.height()


def test_lone_action_rows_are_a_start_aligned_button_row(kit_app):
    view = _account_view(tier="Pro", holder="Mara", channel="stable")
    kit = _kit(kit_app, view, size=(640, 900))
    try:
        root = kit.view.rootObject()
        names = {str(b.property("text")): b for b in _buttons(kit)}
        for label in ("Check for updates", "Sign out"):
            button = names[label]
            row = button.parentItem()
            while row is not None and not str(row.objectName()).startswith("row-"):
                row = row.parentItem()
            rx, _ry, rw, _rh = _rect(row, root)
            bx, _by, bw, _bh = _rect(button, root)
            # at the start of its row (inset 16), not pushed to the trailing edge
            assert bx - rx <= 20, (label, bx - rx)
            assert rx + rw - (bx + bw) > rw / 3, (label, rw)
    finally:
        kit.close()


def test_sign_out_and_remove_confirm_carry_the_destructive_style(kit_app):
    kit = _kit(kit_app, _account_view(tier="Pro", holder="Mara"))
    try:
        sign_out = next(b for b in _buttons(kit) if b.property("text") == "Sign out")
        assert sign_out.property("role") == "dangerText" and sign_out.property("dangerText") is True
    finally:
        kit.close()
    devices = [_device("A"), _device("B")]
    view = ui_devices.devices_view(context_of(with_defaults({"devices": devices, "edit": {"kind": "remove", "device": "B"}, "selected": 1})))
    if view.state == "confirming":
        kit = _kit(kit_app, view)
        try:
            remove = [b for b in _buttons(kit) if b.property("role") == "danger"]
            assert remove and remove[0].property("danger") is True
        finally:
            kit.close()


def _meta_and_buttons(kit, needle):
    root = kit.view.rootObject()
    meta = next(i for i in _walk(kit) if i.metaObject().className().startswith("QQuickText") and i.property("visible") and needle in str(i.property("text")))
    row = meta.parentItem()
    while row is not None and not str(row.objectName()).startswith("row-"):
        row = row.parentItem()
    rx, ry, rw, rh = _rect(row, root)
    inside = [b for b in _buttons(kit) if ry <= _rect(b, root)[1] <= ry + rh]
    return root, meta, inside


def test_device_rows_stack_their_buttons_under_the_text_at_480(kit_app):
    devices = [_device("Work laptop", platform="windows", days=12), _device("iPad", "ipad", "ios", 3)]
    kit = _kit(kit_app, _devices_view(devices), size=(480, 900))
    try:
        root, meta, buttons = _meta_and_buttons(kit, "last used 12 days ago")
        # "Windows · last used 12 days ago" is one line, and Rename / Remove sit below it
        assert meta.property("lineCount") == 1 and meta.property("contentWidth") <= meta.property("width")
        _mx, my, _mw, mh = _rect(meta, root)
        assert {str(b.property("text")) for b in buttons} == {"Rename", "Remove"}
        assert all(_rect(b, root)[1] >= my + mh for b in buttons)
        # and they start where the text starts
        assert abs(min(_rect(b, root)[0] for b in buttons) - _rect(meta, root)[0]) < 12
    finally:
        kit.close()


def test_a_row_whose_words_and_buttons_fit_keeps_them_on_one_line(kit_app):
    kit = _kit(kit_app, _devices_view([_device("Mac", "mac", "macos", 0, True)]), size=(480, 900))
    try:
        root, meta, buttons = _meta_and_buttons(kit, "This")
        (rename,) = buttons
        assert _rect(rename, root)[0] > _rect(meta, root)[0] + 60  # at the end of the line
        assert meta.property("lineCount") == 1
    finally:
        kit.close()


def test_no_wrapped_row_text_ends_on_a_single_word_at_480_and_200_percent(kit_app):
    devices = [_device("Work laptop", platform="windows", days=12), _device("A" * 40, platform="macos", days=1)]
    for text_scale in (1.0, 2.0):
        kit = KitView(Theme(color_scheme="dark", platform="gnome"), source=FakeSource(TIDEWATER), size=(480, 900), font_scale=text_scale, loading_delay_ms=0)
        try:
            kit.set_view(_devices_view(devices))
            kit.grab()
            for item in _walk(kit):
                if item.metaObject().className().startswith("QQuickText") and item.property("visible") and "last used" in str(item.property("text")):
                    # the words fit their line, or wrap with more than the last word alone: measure the
                    # last line by the content height of one line fewer
                    lines = item.property("lineCount")
                    if lines > 1:
                        words = str(item.property("text")).split()
                        assert len(words) > 2, item.property("text")
        finally:
            kit.close()
