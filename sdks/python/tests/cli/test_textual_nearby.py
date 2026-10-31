# @pkey-feature identity.nearby
"""The Textual app's "Approve a nearby device" (I-47.13, D-6): the account view offers it when the product and
runtime do; pressing it listens (the advert stands only then), a device that asks shows its three codes and
Deny, a code is picked by its button, the license is chosen by button, the outcome has Done, and leaving the
pane stops the advert. The other device's name is drawn as text."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, List, Optional

import pytest

textual = pytest.importorskip("textual")

from polaris_key.ui.core import Copy  # noqa: E402
from polaris_key.ui.core.models import gate_view  # noqa: E402
from polaris_key.ui.terminal.textual_app import PolarisKeyApp  # noqa: E402

from .fake_session import FakeAsk  # noqa: E402
from .fixtures import Presentation  # noqa: E402
from .test_textual import _texts  # noqa: E402

C = Copy("en")
GATE = gate_view("ok", now=0, holder="Mara Fennick", email="mara@fennick.studio", signed_in=True, tier="Pro", term="Lifetime", version="2.4.1")


class _Client:
    product = "tidewater"
    presentation_source = Presentation()

    def __init__(self, ask: Optional[FakeAsk] = None, *, available: bool = True, calls: Optional[List[str]] = None) -> None:
        self.calls = calls if calls is not None else []

        def on_request(handler: Any, **opts: Any) -> Any:
            self.calls.append("on_request")
            if ask is not None:
                handler(ask)
            return SimpleNamespace(stop=lambda: self.calls.append("stop"))

        self.identity = SimpleNamespace(nearby=SimpleNamespace(available=lambda *, role: available, on_request=on_request), sign_out=lambda: None)


def _app(client: _Client) -> PolarisKeyApp:
    return PolarisKeyApp(client, scheme="dark", data={"gate": GATE})


def test_the_account_view_offers_it_only_when_the_product_and_runtime_do() -> None:
    async def run() -> None:
        for available in (True, False):
            app = _app(_Client(available=available))
            async with app.run_test(size=(80, 24)) as pilot:
                await pilot.pause()
                assert (C("signin.nearby.menu") in _texts(app)) is available

    asyncio.run(run())


def test_a_device_asks_its_three_codes_are_buttons_and_a_pick_approves() -> None:
    async def run() -> None:
        ask = FakeAsk(device="New phone")
        client = _Client(ask)
        app = _app(client)
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            await pilot.click("#pk-approve")
            await pilot.pause()
            text = _texts(app)
            assert C("signin.nearby.ask", device="New phone") in text
            assert all(code in text for code in ("111 111", "482 913", "777 777")) and C("signin.approve.deny") in text
            await pilot.click("#pk-code-2")
            await pilot.pause(0.3)
            assert ask.picks == ["482 913"]
            assert C("signin.nearby.approved", device="New phone") in _texts(app)
            assert client.calls == ["on_request", "stop"]
            await pilot.click("#pk-approve-done")
            await pilot.pause()
            assert C("signin.nearby.menu") in _texts(app) and C("common.signOut") in _texts(app)

    asyncio.run(run())


def test_deny_never_picks_and_leaving_the_pane_stops_the_advert() -> None:
    async def run() -> None:
        ask = FakeAsk()
        client = _Client(ask)
        app = _app(client)
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            await pilot.click("#pk-approve")
            await pilot.pause()
            await pilot.click("#pk-approve-deny")
            await pilot.pause()
            assert ask.picks == [] and ask.denied == 1 and C("signin.approve.deniedDone") in _texts(app)
            assert client.calls == ["on_request", "stop"]
        waiting = _Client(None)
        app = _app(waiting)
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            await pilot.click("#pk-approve")
            await pilot.pause()
            assert C("signin.cli.approveWaiting") in _texts(app) and waiting.calls == ["on_request"]
            await pilot.press("down")  # another section: nothing is left listening
            await pilot.pause()
            assert waiting.calls == ["on_request", "stop"]

    asyncio.run(run())


def test_the_license_choice_is_buttons_and_a_hostile_name_is_text() -> None:
    async def run() -> None:
        chosen: List[Any] = []
        view = {
            "choices": [{"id": "lic_1", "tierName": "Pro", "name": None, "state": "free"}, {"id": "lic_2", "tierName": "Team", "name": "Harbor team", "state": "free"}],
            "create": {"tierName": "Pro", "access": "account"},
        }
        step = SimpleNamespace(
            kind="choose",
            choices=view,
            choose=lambda c: (chosen.append(c), SimpleNamespace(kind="approved"))[1],
            cancel=lambda: SimpleNamespace(kind="denied"),
        )
        ask = FakeAsk(lambda code: step, device="Evil\x1b]52;c;ZXZpbA==\x07 ‮phone\x1b[2J")
        app = _app(_Client(ask))
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            await pilot.click("#pk-approve")
            await pilot.pause()
            assert "\x1b" not in _texts(app) and "Evil" in _texts(app)
            await pilot.click("#pk-code-1")
            await pilot.pause(0.3)
            text = _texts(app)
            assert "Pro" in text and "Harbor team" in text and C("signin.choice.create") in text
            await pilot.click("#pk-choice-2")
            await pilot.pause(0.3)
            assert chosen == [{"kind": "license", "licenseId": "lic_2"}]

    asyncio.run(run())


@pytest.mark.parametrize("code,key", [("nearby-unsupported", "signin.cli.approveUnsupported"), ("account_required", "core.codes.account_required.title")])
def test_an_unsupported_runtime_and_a_signed_out_device_are_said_in_words(code: str, key: str) -> None:
    async def run() -> None:
        from polaris_key.core.errors import PolarisError

        client = _Client()

        def boom(handler: Any, **opts: Any) -> Any:
            raise PolarisError(code, "x")

        client.identity.nearby.on_request = boom
        app = _app(client)
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            await pilot.click("#pk-approve")
            await pilot.pause()
            assert C(key) in _texts(app)

    asyncio.run(run())
