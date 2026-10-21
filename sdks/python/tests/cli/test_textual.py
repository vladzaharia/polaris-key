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
            assert "Tidewater Studio Pro" in text and C("account.holder", name="Mara Fennick") in text
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


def test_a_check_that_could_not_run_is_a_button_not_a_label() -> None:
    from textual.widgets import Button

    class Core:
        version = "2.4.1"

    class Offline(_Client):
        core = Core()

        class update:
            configured = property(lambda self: (_ for _ in ()).throw(OSError("offline")))

    async def run() -> None:
        app = PolarisKeyApp(Offline(), scheme="dark", data={k: v for k, v in DATA.items() if k != "update"})
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            app.show("updates")
            await pilot.pause()
            check = app.query_one("#pk-check", Button)
            assert str(check.label) == C("update.checkNow") and "pk-primary" in check.classes

    asyncio.run(run())
