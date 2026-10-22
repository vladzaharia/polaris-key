# @pkey-feature ui.cli
"""The Textual app's Settings and About sections (UI-KITS §4.1/§4.3 Settings, §8 "Textual app"): one
row per managed setting with the control its type calls for, the source markers and Reset to default,
locked rows read-only with who set them, an error under the control that failed, keyboard-only use,
and the 60- and 40-column and short renders."""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List

import pytest

pytest.importorskip("textual")

from textual.widgets import Button, Input, Select, Static, Switch  # noqa: E402

from polaris_key.core.errors import PolarisError  # noqa: E402
from polaris_key.ui.core import Copy  # noqa: E402
from polaris_key.ui.terminal.textual_app import SECTIONS, PolarisKeyApp  # noqa: E402

from .test_textual import DATA, _Client, _lines, _texts  # noqa: E402

C = Copy("en")
CATALOG = {
    "schemaVersion": 1,
    "entries": [
        {"key": "audio.muted", "label": "Mute audio", "schema": {"type": "boolean"}},
        {"key": "ui.theme", "label": "Theme", "schema": {"type": "string", "enum": ["dark", "light"]}, "ui": {"optionLabels": {"dark": "Dark", "light": "Light"}}},
        {"key": "audio.volume", "label": "Volume", "schema": {"type": "integer", "minimum": 0, "maximum": 100}},
        {"key": "profile.name", "label": "Name", "schema": {"type": "string"}},
        {"key": "telemetry.crash", "label": "Crash reports", "schema": {"type": "boolean"}},
        {"key": "debug.trace", "label": "Trace", "schema": {"type": "boolean"}, "ui": {"advanced": True}},
    ],
}


class _Config:
    """The SDK's ConfigClient surface the settings pane reads and writes."""

    def __init__(self) -> None:
        self.values: Dict[str, Any] = {
            "audio.muted": True, "ui.theme": "dark", "audio.volume": 40, "profile.name": "Mara", "telemetry.crash": True, "debug.trace": False,
        }
        self.sources = {"audio.muted": "local", "ui.theme": "remote-default", "audio.volume": "env", "profile.name": "remote-default", "telemetry.crash": "enforced", "debug.trace": "remote-default"}
        self.fail: Any = None
        self.calls: List[tuple] = []

    def list_user_config(self) -> List[Dict[str, Any]]:
        return [{"key": k, "value": v, "enforced": self.sources[k] == "enforced", **({"org": "Fennick Studio"} if self.sources[k] == "enforced" else {})} for k, v in self.values.items()]

    def get_config_source(self, key: str) -> str:
        return self.sources[key]

    def fetch_schema(self) -> Any:
        return CATALOG

    def set(self, key: str, value: Any) -> None:
        self.calls.append(("set", key, value))
        if self.fail is not None:
            raise self.fail
        self.values[key] = value
        self.sources[key] = "local"

    def clear(self, key: str) -> None:
        self.calls.append(("clear", key))
        self.sources[key] = "remote-default"


class _Live(_Client):
    def __init__(self, config: Any = None) -> None:
        self.config = config or _Config()


def _drive(then, *, size=(80, 30), client=None, section="settings", data=None, manage_url="https://polaris.locker", **kw):
    async def run():
        app = PolarisKeyApp(client or _Live(), scheme="dark", data={**DATA, **(data or {})}, manage_url=manage_url, **kw)
        async with app.run_test(size=size) as pilot:
            await pilot.pause()
            app.show(section)
            await pilot.pause()
            await pilot.pause()
            return await then(app, pilot)

    return asyncio.run(run())


def _row_of(app: PolarisKeyApp, key: str) -> int:
    return next(i for i, (r, _) in enumerate(app._rows) if r["key"] == key)


async def _settle(pilot) -> None:
    for _ in range(3):
        await pilot.pause()


def test_the_sections_are_the_five_in_the_spec() -> None:
    assert [s for s, _ in SECTIONS] == ["account", "devices", "updates", "settings", "about"]


def test_one_row_per_setting_with_the_control_its_type_calls_for() -> None:
    async def then(app, pilot):
        text = _texts(app)
        assert len(app._rows) == 5
        # a boolean is a switch, with its state in words
        assert isinstance(app.query_one(f"#pk-set-{_row_of(app, 'audio.muted')}"), Switch)
        assert C("settings.on") in text
        # a choice is a select showing the label, not the raw value
        theme = app.query_one(f"#pk-set-{_row_of(app, 'ui.theme')}")
        assert isinstance(theme, Select) and theme.value == "dark" and "Dark" in _texts(app) + "\n".join(_lines(app))
        # a bounded number is a field that carries its range
        volume = app.query_one(f"#pk-set-{_row_of(app, 'audio.volume')}")
        assert isinstance(volume, Input) and volume.value == "40" and volume.type == "integer"
        assert C("settings.range", min=0, max=100) in text
        # a string is a text field
        assert app.query_one(f"#pk-set-{_row_of(app, 'profile.name')}").type == "text"
        # names, never raw keys
        assert "Mute audio" in text and "audio.muted" not in text

    _drive(then)


def test_markers_say_where_each_value_comes_from_and_only_the_changed_one_resets() -> None:
    async def then(app, pilot):
        text = _texts(app)
        for key in ("settings.source.local", "settings.source.default", "settings.source.env"):
            assert C(key) in text
        resets = [str(b.label) for b in app.query(Button)]
        assert resets == [C("settings.reset")]
        assert app.query_one(f"#pk-reset-{_row_of(app, 'audio.muted')}", Button)
        # groups: the developer's defaults under their name, managed rows under theirs
        assert C("settings.fromDeveloper", developer="Harbor Audio") in text and C("account.managedSettings") in text

    _drive(then)


def test_a_locked_row_is_read_only_and_names_who_set_it() -> None:
    async def then(app, pilot):
        text = _texts(app)
        assert "Crash reports" in text and C("settings.setBy", org="Fennick Studio") in text and C("settings.on") in text
        locked = [w for w in app.query(".pk-locked")]
        assert len(locked) == 1
        # nothing in it takes input or focus
        assert not locked[0].query(Switch) and not locked[0].query(Input) and not locked[0].query(Button)
        assert all(not w.can_focus for w in locked[0].query("*"))
        assert len(app._rows) == 5 and len([w for w in app.query(Switch) if w.id != "pk-adv"]) == 1  # only the one unlocked boolean

    _drive(then)


def test_a_toggle_writes_through_the_sdk_and_says_saved_under_itself() -> None:
    client = _Live()

    async def then(app, pilot):
        i = _row_of(app, "audio.muted")
        app.query_one(f"#pk-set-{i}").focus()
        await pilot.press("space")
        await _settle(pilot)
        assert client.config.calls == [("set", "audio.muted", False)]
        assert str(app.query_one(f"#pk-set-note-{i}", Static).render()) == C("settings.saved")
        # focus stays on the control that changed, so the keyboard is not thrown back to the list
        assert app.focused is not None and app.focused.id == f"pk-set-{i}"
        assert C("settings.off") in _texts(app)

    _drive(then, client=client)


def test_a_choice_is_picked_with_the_keyboard() -> None:
    client = _Live()

    async def then(app, pilot):
        i = _row_of(app, "ui.theme")
        app.query_one(f"#pk-set-{i}").focus()
        await pilot.press("enter", "down", "enter")
        await _settle(pilot)
        assert client.config.calls == [("set", "ui.theme", "light")]

    _drive(then, client=client)


def test_a_number_is_typed_and_saved_with_enter() -> None:
    client = _Live()

    async def then(app, pilot):
        i = _row_of(app, "audio.volume")
        field = app.query_one(f"#pk-set-{i}", Input)
        field.focus()
        field.value = "75"
        await pilot.pause()
        # typed but not saved: the pane says so
        assert str(app.query_one(f"#pk-set-note-{i}", Static).render()) == C("settings.unsaved")
        await pilot.press("enter")
        await _settle(pilot)
        assert client.config.calls == [("set", "audio.volume", 75)]
        assert app.query_one(f"#pk-set-{i}", Input).value == "75"

    _drive(then, client=client)


def test_a_number_outside_its_range_is_refused_under_its_control_and_never_sent() -> None:
    client = _Live()

    async def then(app, pilot):
        i = _row_of(app, "audio.volume")
        field = app.query_one(f"#pk-set-{i}", Input)
        field.focus()
        field.value = "250"
        await pilot.press("enter")
        await _settle(pilot)
        assert client.config.calls == []
        note = app.query_one(f"#pk-set-note-{i}", Static)
        assert str(note.render()) == C("settings.range", min=0, max=100) and "pk-error" in note.classes
        # the error is on that row only
        others = [str(n.render()) for n in app.query(".pk-rownote") if n.id != note.id and n.display]
        assert others == []

    _drive(then, client=client)


def test_a_save_that_fails_shows_its_error_under_that_control_and_keeps_the_old_value() -> None:
    client = _Live()
    client.config.fail = PolarisError("bad_request", "nope")

    async def then(app, pilot):
        i = _row_of(app, "audio.muted")
        app.query_one(f"#pk-set-{i}").focus()
        await pilot.press("space")
        await _settle(pilot)
        note = app.query_one(f"#pk-set-note-{i}", Static)
        assert str(note.render()) == C("settings.error") and "pk-error" in note.classes
        assert app.query_one(f"#pk-set-{i}", Switch).value is True
        # a code the catalog has copy for is said in its words
        client.config.fail = PolarisError("managed_by_admin", "enforced")
        app.query_one(f"#pk-set-{i}").focus()
        await pilot.press("space")
        await _settle(pilot)
        assert C("core.codes.managed_by_admin.message") in _texts(app)

    _drive(then, client=client)


def test_reset_to_default_clears_the_value_and_puts_the_marker_back() -> None:
    client = _Live()

    async def then(app, pilot):
        i = _row_of(app, "audio.muted")
        app.query_one(f"#pk-reset-{i}").focus()
        await pilot.press("enter")
        await _settle(pilot)
        assert client.config.calls == [("clear", "audio.muted")]
        assert not list(app.query(Button))
        assert C("settings.source.local") not in _texts(app)

    _drive(then, client=client)


def test_advanced_settings_wait_behind_their_switch() -> None:
    client = _Live()

    async def then(app, pilot):
        assert "Trace" not in _texts(app) and C("settings.advanced") in _texts(app)
        app.query_one("#pk-adv").focus()
        await pilot.press("space")
        await _settle(pilot)
        assert "Trace" in _texts(app)

    _drive(then, client=client)


def test_the_keyboard_walks_the_controls_in_order_and_never_leaves_the_pane_by_arrow() -> None:
    async def then(app, pilot):
        order = [w.id for w in app.screen.focus_chain]
        assert order[0] == "pk-nav" and order[1:] == [i for i in order[1:] if i.startswith("pk-")]
        controls = [i for i in order if i.startswith(("pk-set-", "pk-reset-", "pk-adv"))]
        app.query_one("#pk-nav").focus()
        await pilot.press("tab")
        assert app.focused.id == controls[0]
        await pilot.press("down")
        assert app.focused.id == controls[1]
        await pilot.press("up")
        assert app.focused.id == controls[0]
        # from the first control, up goes back to the list, and the section is still Settings
        await pilot.press("up")
        assert app.focused.id == "pk-nav" and app.section == "settings"
        # shift+tab from the list wraps to the last control, in order
        await pilot.press("shift+tab")
        assert app.focused.id == controls[-1]

    _drive(then)


def test_down_from_the_list_still_changes_the_section() -> None:
    async def then(app, pilot):
        app.query_one("#pk-nav").focus()
        await pilot.press("down")
        await _settle(pilot)
        assert app.section == "about"

    _drive(then)


def test_no_settings_and_a_failed_read_are_different_screens() -> None:
    async def empty(app, pilot):
        assert C("settings.empty") in _texts(app)

    _drive(empty, data={"settings": []})

    class _Broken(_Config):
        def list_user_config(self):
            raise OSError("offline")

    async def failed(app, pilot):
        assert C("settings.loadFailed") in _texts(app) and C("settings.empty") not in _texts(app)
        retry = app.query_one("#pk-settings-retry", Button)
        assert "pk-primary" in retry.classes and str(retry.label) == C("common.tryAgain")

    _drive(failed, client=_Live(_Broken()))


# ── About ────────────────────────────────────────────────────────────────────────────────────


def test_about_names_the_version_developer_sdk_license_and_links() -> None:
    async def then(app, pilot):
        from polaris_key import SDK_VERSION

        text = _texts(app)
        assert C("about.version", version="2.4.1") in text
        assert C("common.byDeveloper", developer="Harbor Audio") in text
        assert f"{C('cli.doctor.sdk')} {SDK_VERSION}" in text
        assert C("account.tier", tier="Pro") + " · Lifetime" in text
        labels = {b.id: str(b.label) for b in app.query(Button)}
        assert labels == {
            "pk-about-manage": C("common.manage") + " ↗",
            "pk-about-support": C("status.contact", developer="Harbor Audio") + " ↗",
        }
        # the product is in the header once, and the pane does not repeat it
        pane = "\n".join(str(w.render()) for w in app.query("#pk-main Static"))
        assert "Tidewater" not in pane
        # reading a page is nothing to commit to: no primary
        assert not [b for b in app.query(Button) if "pk-primary" in b.classes]

    _drive(then, section="about", support_url="https://support.example")


def test_about_offers_only_the_links_it_has() -> None:
    async def no_support(app, pilot):
        # the manage page is always the product's own page; support only where the host names one
        assert [b.id for b in app.query(Button)] == ["pk-about-manage"]

    _drive(no_support, section="about")


def test_about_links_open_the_page(monkeypatch) -> None:
    opened: List[str] = []
    import webbrowser

    monkeypatch.setattr(webbrowser, "open", lambda url: opened.append(url) or True)

    async def then(app, pilot):
        app.query_one("#pk-about-support").focus()
        await pilot.press("enter")
        await pilot.pause()
        app.query_one("#pk-about-manage").focus()
        await pilot.press("enter")
        await pilot.pause()

    _drive(then, section="about", support_url="https://support.example")
    assert opened == ["https://support.example", "https://polaris.locker"]


# ── Narrow and short renders (UI-KITS §7.1) ──────────────────────────────────────────────────


@pytest.mark.parametrize("width", [60, 40])
@pytest.mark.parametrize("section", ["settings", "about"])
def test_narrow_renders_keep_to_the_width_and_keep_the_active_section_in_view(width: int, section: str) -> None:
    async def then(app, pilot):
        lines = _lines(app)
        assert all(len(line) <= width for line in lines)
        assert lines[0].strip().startswith("T  Tidewater Studio")
        label = app._label(dict(SECTIONS)[section])
        # the section row scrolls to the section you are in
        assert label[:8] in lines[1] or section == "about" and "About" in lines[1]
        assert app.has_class("-narrow")
        if section == "settings":
            # controls stack: a reset button sits under its switch, whole
            reset = app.query(Button).first()
            assert str(reset.label) == C("settings.reset") and reset.region.x <= 2
            assert reset.region.right <= width

    _drive(then, size=(width, 40), section=section, support_url="https://support.example")


def test_a_short_terminal_drops_its_padding_and_still_reaches_every_control() -> None:
    async def then(app, pilot):
        assert app.has_class("-short")
        lines = _lines(app)
        assert len(lines) == 10 and C("settings.title") in "\n".join(lines)
        # the pane scrolls to the control that has focus
        last = [w for w in app.screen.focus_chain if w.id and w.id.startswith("pk-set-")][-1]
        last.focus()
        await pilot.pause()
        await pilot.pause()
        assert last.region.height > 0 and 0 <= last.region.y < 10 - 1

    _drive(then, size=(80, 10))
