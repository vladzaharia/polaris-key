# @pkey-feature ui.cli
"""The optional Textual app ([tui], UI-KITS §8 terminal board "Textual app"): the account view
renders the same models and catalog copy as the CLI, in a theme from the brand tokens and the
product's accent; buttons are one shape (primary in the accent, secondary tonal)."""

from __future__ import annotations

import asyncio

import pytest

textual = pytest.importorskip("textual")

from polaris_key.ui.core import Copy, Theme  # noqa: E402
from polaris_key.ui.core.models import DeviceRow, DevicesView, UpdateView, gate_view  # noqa: E402
from polaris_key.ui.terminal.textual_app import PolarisKeyApp  # noqa: E402

from .fixtures import Presentation  # noqa: E402

C = Copy("en")
DATA = {
    "gate": gate_view("ok", now=0, holder="Mara Fennick", email="mara@fennick.studio", signed_in=True, tier="Pro", term="Lifetime", version="2.4.1"),
    "devices": DevicesView("Devices", "list", (DeviceRow("d1", "Work laptop", "Windows 11"), DeviceRow("d2", "MacBook Pro", "macOS 26", True))),
    "update": UpdateView("UpdatePrompt", "available", "2.5", "2.4.1"),
}


class _Client:
    product = "tidewater"
    presentation_source = Presentation()


def _texts(app: PolarisKeyApp) -> str:
    from textual.widgets import Button, Static

    out = [str(w.render()) for w in app.query(Static)]
    out += [str(b.label) for b in app.query(Button)]
    return "\n".join(out)


def test_the_account_view_and_its_sections() -> None:
    async def run() -> None:
        app = PolarisKeyApp(_Client(), scheme="dark", data=DATA, manage_url="https://polaris.locker")
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            text = _texts(app)
            assert C("account.tier", tier="Pro") in text and "Lifetime" in text and C("account.holder", name="Mara Fennick") in text
            assert C("common.manage") in text and C("common.signOut") in text
            assert app.theme == "polaris-key-dark"
            primary = app.query_one("#pk-manage")
            assert "pk-primary" in primary.classes and "pk-secondary" in app.query_one("#pk-sign-out").classes
            await pilot.press("down")
            await pilot.pause()
            assert app.section == "devices" and "Work laptop" in _texts(app)
            await pilot.press("down")
            await pilot.pause()
            assert app.section == "updates" and C("update.install") in _texts(app)

    asyncio.run(run())


def test_native_keeps_textuals_theme_and_ink_has_no_accent() -> None:
    async def run() -> None:
        app = PolarisKeyApp(_Client(), theme=Theme(preset="native"), scheme="light", data=DATA)
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            assert app.theme == "textual-light"
        bare = PolarisKeyApp(None, product="tidewater", scheme="dark", data=DATA)
        assert bare.identity.accent_source == "ink"

    asyncio.run(run())


# ── The update section follows the state's own handling (UI-KITS DL4, DL6, DL7) ─────────────


def _updates(u) -> "tuple[str, list[str]]":
    """The text and the button classes of the Updates section for one update state."""
    from textual.widgets import Button

    async def run():
        app = PolarisKeyApp(_Client(), scheme="dark", data={**DATA, "update": u})
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            app.show("updates")
            await pilot.pause()
            return _texts(app), [(str(b.label), sorted(b.classes)) for b in app.query(Button)]

    return asyncio.run(run())


def test_a_mandatory_update_offers_no_later() -> None:
    text, buttons = _updates(UpdateView("UpdatePrompt", "mandatory", "2.5", "2.4.1"))
    assert C("update.mandatoryTitle", product="Tidewater Studio") in text
    assert [b for b, _ in buttons] == [C("update.install")]
    assert all("pk-primary" in cls for _, cls in buttons)


def test_a_blocked_update_names_the_refusal_and_has_nothing_to_press() -> None:
    text, buttons = _updates(UpdateView("UpdatePrompt", "blocked", current="2.4.1"))
    assert C("update.blockedTitle") in text and C("update.blockedBody", product="Tidewater Studio") in text
    assert buttons == []


def test_a_store_update_is_the_stores_to_install() -> None:
    text, buttons = _updates(UpdateView("UpdatePrompt", "store", "2.5", "2.4.1"))
    assert C("update.platform.generic", product="Tidewater Studio") in text
    assert buttons == []


def test_withdrawn_content_has_its_fix_as_the_only_action() -> None:
    text, buttons = _updates(UpdateView("UpdatePrompt", "revoked-required-content", "2.5", "2.4.1"))
    assert C("core.codes.pack-revoked.title") in text
    assert [b for b, _ in buttons] == [C("update.install")]


def test_an_available_update_still_offers_later_beside_the_one_primary() -> None:
    _, buttons = _updates(UpdateView("UpdatePrompt", "available", "2.5", "2.4.1"))
    assert [b for b, _ in buttons] == [C("update.install"), C("update.later")]
    assert sum("pk-primary" in cls for _, cls in buttons) == 1


def test_a_check_that_could_not_run_is_an_error_with_try_again() -> None:
    from textual.widgets import Button

    class Core:
        version = "2.4.1"

    class Offline(_Client):
        core = Core()

        class _Update:
            @property
            def configured(self) -> bool:
                raise OSError("offline")

        update = _Update()

    async def run() -> None:
        app = PolarisKeyApp(Offline(), scheme="dark", data={k: v for k, v in DATA.items() if k != "update"})
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            app.show("updates")
            await pilot.pause()
            check = app.query_one("#pk-check", Button)
            assert str(check.label) == C("common.tryAgain") and "pk-primary" in check.classes
            # and the failure is said, from the catalog, above it (DL7)
            assert C("core.codes.network.title") in _texts(app)

    asyncio.run(run())


# ── Productizing against UI-KITS (§1.2, DL4-DL9, the narrow and short renders) ───────────────


def _lines(app: PolarisKeyApp) -> "list[str]":
    return ["".join(seg.text for seg in strip).rstrip() for strip in app.screen._compositor.render_strips()]


def _drive(data, size=(80, 24), section="account", client=None, manage_url="https://polaris.locker", then=None):
    """Open the app on ``data`` at ``size``, show ``section``, optionally run ``then(app, pilot)``,
    and return ``(app-state-snapshot)``: texts, buttons, screen lines."""
    from textual.widgets import Button

    async def run():
        app = PolarisKeyApp(client or _Client(), scheme="dark", data={**DATA, **data}, manage_url=manage_url)
        async with app.run_test(size=size) as pilot:
            await pilot.pause()
            if section != "account":
                app.show(section)
                await pilot.pause()
            if then is not None:
                await then(app, pilot)
                await pilot.pause()
            buttons = [(b.id, str(b.label), sorted(b.classes)) for b in app.query(Button)]
            return _texts(app), buttons, _lines(app), app

    return asyncio.run(run())


def _primaries(buttons) -> "list[str]":
    return [bid for bid, _, cls in buttons if "pk-primary" in cls]


def test_the_header_carries_a_monogram_and_the_name_once() -> None:
    from textual.widgets import Static

    async def run() -> None:
        app = PolarisKeyApp(_Client(), scheme="dark", data=DATA, manage_url="https://polaris.locker")
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            header = str(app.query_one("#pk-header", Static).render())
            assert header.startswith(" T ") and "Tidewater Studio" in header
            pane = "\n".join(str(w.render()) for w in app.query("#pk-main Static"))
            assert "Tidewater" not in pane, "DL5: the product name is on the screen once"
        # and the monogram survives the narrow header, which drops the section instead
        narrow = PolarisKeyApp(_Client(), scheme="dark", data=DATA)
        async with narrow.run_test(size=(40, 24)) as pilot:
            await pilot.pause()
            assert _lines(narrow)[0].strip() == "T  Tidewater Studio"

    asyncio.run(run())


@pytest.mark.parametrize(
    "gate, expect",
    [
        (gate_view("ok", now=0, signed_in=True, holder="Mara", tier="Pro", term="Lifetime"), 1),
        (gate_view("ok", now=0, tier="Pro"), 1),
        (gate_view("grace", now=0, grace_until=3 * 86400), 1),
        (gate_view("expired", now=0), 1),
        (gate_view("revoked", now=0), 1),
        (gate_view("version-too-old", now=0, allowed_min="3.0"), 1),
        (gate_view("version-too-new", now=0, allowed_max="2.0"), 1),
        (gate_view("channel-not-entitled", now=0), 1),
        (gate_view("none", now=0), 1),
        (gate_view("not-applicable", now=0), 0),
    ],
)
def test_one_primary_on_every_account_state(gate, expect) -> None:
    _, buttons, _, _ = _drive({"gate": gate})
    assert len(_primaries(buttons)) == expect, (gate.state, buttons)


def test_a_lone_action_is_the_primary() -> None:
    _, buttons, _, _ = _drive({}, manage_url=None)
    assert [(b, "pk-primary" in c) for b, _, c in buttons] == [("pk-sign-out", True)]


@pytest.mark.parametrize("state", ["revoked", "expired"])
def test_a_refusal_is_a_triangle_with_its_fix_as_the_primary(state: str) -> None:
    text, buttons, lines, _ = _drive({"gate": gate_view(state, now=0)})
    assert f"▲ {C(f'core.gate.{state}.title')}" in text and C(f"core.gate.{state}.message") in text
    assert "✗" not in text and "✓" not in "".join(lines)
    labels = {bid: label for bid, label, _ in buttons}
    assert _primaries(buttons) == ["pk-manage"] and labels["pk-manage"] == C("common.manage") + " ↗"
    assert labels["pk-reconnect"] == C("common.tryAgain") and labels["pk-sign-out"] == C("common.signOut")


def test_a_version_below_the_range_has_the_update_as_its_fix() -> None:
    from textual.widgets import Button

    async def go(app, pilot):
        await pilot.click("#pk-fix-update")

    text, buttons, _, app = _drive({"gate": gate_view("version-too-old", now=0, allowed_min="3.0")}, then=go)
    assert app.section == "updates" and C("update.install") in text


def test_a_refusal_with_no_page_to_send_you_to_is_named_in_words() -> None:
    class Bare:
        presentation_source = Presentation()

    text, buttons, _, _ = _drive({"gate": gate_view("channel-not-entitled", now=0)}, client=Bare(), manage_url=None)
    assert C("status.contact", developer="Harbor Audio") in text
    assert [b for b, _, _ in buttons] == ["pk-reconnect", "pk-sign-out"] and _primaries(buttons) == ["pk-reconnect"]


def test_the_grace_banner_is_a_triangle_with_reconnect() -> None:
    text, buttons, _, _ = _drive({"gate": gate_view("grace", now=0, grace_until=3 * 86400)})
    assert "▲ " + C("grace.daysLeft", days=3) in text
    assert [(b, l) for b, l, _ in buttons][0] == ("pk-reconnect", C("common.reconnect"))
    assert _primaries(buttons) == ["pk-reconnect"]


def test_nothing_held_is_the_catalog_prompt_with_try_again() -> None:
    text, buttons, _, _ = _drive({"gate": gate_view("none", now=0)})
    assert C("core.gate.needs-activation.title") in text and C("core.gate.needs-activation.message") in text
    assert [l for _, l, _ in buttons] == [C("common.tryAgain")]


def test_cancelling_a_sign_out_is_not_an_error() -> None:
    from textual.widgets import Static

    async def go(app, pilot):
        await pilot.click("#pk-sign-out")
        await pilot.pause()
        assert C("signin.signout.title", product="Tidewater Studio") in _texts(app)
        assert _primaries_now(app) == ["pk-sign-out-confirm"]
        await pilot.click("#pk-cancel")

    text, buttons, _, app = _drive({}, then=go)
    assert app.section == "account" and C("common.signOut") in text and C("common.cancel") not in text
    assert not app.query(".pk-error") and not app.query(".pk-refusal")


def _primaries_now(app) -> "list[str]":
    return [b.id for b in app.query(".pk-primary")]


def test_later_and_quit_close_without_an_error() -> None:
    async def go(app, pilot):
        await pilot.click("#pk-later")

    _, _, _, app = _drive({}, section="updates", then=go)
    assert app.section == "account" and not app.query(".pk-error") and not app.query(".pk-refusal")

    async def run() -> None:
        quitting = PolarisKeyApp(_Client(), scheme="dark", data=DATA)
        async with quitting.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            await pilot.press("q")
        assert quitting.return_value is None

    asyncio.run(run())


def test_a_sign_out_that_fails_says_so_under_the_action() -> None:
    class Identity:
        def sign_out(self) -> None:
            raise OSError("offline")

    class Failing(_Client):
        identity = Identity()

    async def go(app, pilot):
        await pilot.click("#pk-sign-out")
        await pilot.pause()
        await pilot.click("#pk-sign-out-confirm")
        await pilot.pause()
        await pilot.pause()
        note = app.query_one("#pk-note")
        assert note.display and "pk-error" in note.classes and C("core.codes.network.message") in str(note.render())
        # the action stays so it can be tried again
        assert app.query("#pk-sign-out-confirm")

    _drive({}, client=Failing(), then=go)


def test_a_failed_device_read_is_an_error_with_try_again_not_an_empty_list() -> None:
    class Core:
        version = "2.4.1"

    class Failing(_Client):
        core = Core()

        def list_devices(self):
            raise OSError("offline")


    async def run() -> None:
        app = PolarisKeyApp(Failing(), scheme="dark", data={k: v for k, v in DATA.items() if k != "devices"})
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            app.show("devices")
            await pilot.pause()
            text = _texts(app)
            assert C("devices.loadFailed") in text and C("devices.empty") not in text and C("devices.browser") not in text
            assert [str(b.label) for b in app.query("Button")] == [C("common.tryAgain")]

    asyncio.run(run())


def test_the_browser_only_devices_pane_has_its_one_action_and_platforms_are_named() -> None:
    text, buttons, _, _ = _drive({"devices": DevicesView("Devices", "browser-mode")}, section="devices")
    assert C("devices.browser") in text
    assert [(b, l) for b, l, _ in buttons] == [("pk-devices-manage", C("devices.manage") + " ↗")] and _primaries(buttons) == ["pk-devices-manage"]
    rows = DevicesView("Devices", "list", (DeviceRow("d1", "Mac", "macos", True),))
    text, _, _, _ = _drive({"devices": rows}, section="devices")
    assert "macOS" in text and "macos" not in text


def test_the_download_button_leaves_the_app_and_says_so() -> None:
    u = UpdateView("UpdatePrompt", "available", "2.5", "2.4.1", notes_url="https://t.app/2.5", installable=False)
    _, buttons, _, _ = _drive({"update": u}, section="updates")
    assert dict((b, l) for b, l, _ in buttons)["pk-download"] == C("update.install") + " ↗"
    # with no link at all there is nothing to press: where it comes from is said in words
    none = UpdateView("UpdatePrompt", "available", "2.5", "2.4.1", installable=False)
    text, buttons, _, _ = _drive({"update": none}, section="updates")
    assert buttons == [] and C("cli.update.downloadNoLink", product="Tidewater Studio") in text


def test_focus_starts_on_the_primary_and_tab_walks_the_pane_then_the_list() -> None:
    async def run() -> None:
        app = PolarisKeyApp(_Client(), scheme="dark", data=DATA, manage_url="https://polaris.locker")
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            await pilot.pause()
            assert app.focused is not None and app.focused.id == "pk-manage"
            await pilot.press("tab")
            assert app.focused.id == "pk-sign-out"
            await pilot.press("tab")
            assert app.focused.id == "pk-nav"
            # the focused button is drawn differently from its sibling (visible focus)
            await pilot.press("shift+tab")
            await pilot.press("shift+tab")
            assert app.focused.id == "pk-manage" and "reverse" in str(app.focused.styles.text_style)
            # arrows reach the sections from the pane too
            await pilot.press("down")
            await pilot.pause()
            assert app.section == "devices"

    asyncio.run(run())


@pytest.mark.parametrize("width", [60, 40])
def test_narrow_widths_stack_the_pane_and_keep_every_action_on_screen(width: int) -> None:
    from textual.widgets import Button, ListView

    async def run() -> None:
        app = PolarisKeyApp(_Client(), scheme="dark", data=DATA, manage_url="https://polaris.locker")
        async with app.run_test(size=(width, 24)) as pilot:
            await pilot.pause()
            nav = app.query_one("#pk-nav", ListView)
            assert nav.region.height == 1 and nav.region.width == width
            rows = _lines(app)
            assert C("account.title") in rows[1] and C("account.devices") in rows[1] and C("account.updates") in rows[1]
            for b in app.query(Button):
                assert b.region.width > 0 and b.region.right <= width, b.id
            ys = [b.region.y for b in app.query(Button)]
            assert ys == sorted(set(ys)), "the actions stack whole, one per row"
            for section in ("devices", "updates"):
                app.show(section)
                await pilot.pause()
                assert all(b.region.right <= width for b in app.query(Button))
                body = [l for l in _lines(app)[2:] if l.strip()]
                assert all(len(l) <= width for l in body)

    asyncio.run(run())


def test_a_short_terminal_still_shows_the_header_and_the_primary() -> None:
    from textual.widgets import Button

    for size in ((60, 10), (80, 10), (40, 8)):
        for section in ("account", "updates"):
            _, buttons, lines, app = _drive({}, size=size, section=section)
            assert "Tidewater Studio" in lines[0]
            for b in app.query(Button):
                assert b.region.bottom <= size[1] - 1, (size, section, b.id)
            assert _primaries(buttons)
