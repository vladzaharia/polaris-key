# @pkey-feature ui.update
# @pkey-feature ui.settings
# @pkey-feature ui.gate
"""The Qt drop-in's extras (KX-QT-DROP): ``run_gate`` offers an update as a dialog over the host window
(scrim, Later / Update now, facts, progress), toasts a sign-in, and ``account_page`` / ``settings_page``
return an embeddable page over the client (account and license, devices, catalog settings, a locked
ChannelPicker). Everything runs live in QML against a fake client; ``conftest.qml_console`` fails any
test on a QML console error."""

from __future__ import annotations

import re
import time
from types import SimpleNamespace
from typing import Any, List, Optional

import pytest

pytest.importorskip("PySide6.QtQuick")

from polaris_key.devices.client import AccountDevice
from polaris_key.release.client import ChangelogEntry
from polaris_key.ui.core.theme import Theme
from polaris_key.ui.qt import UpdateOffer, account_page, settings_page
from polaris_key.ui.qt.gate import changelog_entry, run_gate, update_notes
from qt_fixtures import SNAPSHOTS, TIDEWATER, FakeSource
from snapshots_util import check
from test_qt_gate_flow import FakeClient, Opener, pump

SERVICES = ["license", "config", "identity", "release", "distribution", "update"]
NOTES = ("Faster project open", "Fixed the export crash", "A new dark icon")
SUMMARY = "- Faster project open\n* Fixed the export crash\n\n### A new dark icon\n- Fourth line is cut"


class FakeRelease:
    def __init__(self, entries: Optional[List[ChangelogEntry]] = None) -> None:
        self.entries = entries if entries is not None else [
            ChangelogEntry("2.5.0", "v2.5.0", SUMMARY, "https://example.com/releases/2.5.0"),
            ChangelogEntry("2.4.1", "v2.4.1", None, "https://example.com/releases/2.4.1"),
        ]
        self.calls = 0

    def changelog(self) -> List[ChangelogEntry]:
        self.calls += 1
        return self.entries


class FakeDevices:
    def __init__(self) -> None:
        now = int(time.time())
        self.rows = [
            AccountDevice(id="d1", status="ok", current=True, label="Studio Mac", platform="macos", lastSeen=now),
            AccountDevice(id="d2", status="ok", current=False, label="Work laptop", platform="windows", lastSeen=now - 9 * 86400),
        ]
        self.renamed: List[Any] = []
        self.removed: List[str] = []

    def list(self) -> List[AccountDevice]:
        return list(self.rows)

    def rename(self, device_id: str, label: Optional[str]) -> None:
        self.renamed.append((device_id, label))

    def deauthorize(self, device_id: str) -> None:
        self.removed.append(device_id)
        self.rows = [d for d in self.rows if d.id != device_id]


class FakeConfig:
    def __init__(self) -> None:
        self.values = {"audio.volume": 70, "ui.compact": False, "ui.language": "English"}
        self.local = {"ui.compact"}
        self.writes: List[Any] = []

    def list_user_config(self) -> List[dict]:
        return [
            {"key": "audio.volume", "value": self.values["audio.volume"], "enforced": False, "min": 0, "max": 100},
            {"key": "ui.compact", "value": self.values["ui.compact"], "enforced": False},
            {"key": "ui.language", "value": self.values["ui.language"], "enforced": True, "org": "Harbor Audio"},
        ]

    def get_config_source(self, key: str) -> str:
        return "local" if key in self.local else "remote"

    def set(self, key: str, value: Any) -> None:
        self.writes.append((key, value))
        self.values[key] = value
        self.local.add(key)

    def clear(self, key: str) -> None:
        self.writes.append((key, None))
        self.local.discard(key)


class DropClient(FakeClient):
    def __init__(self, status: str = "ok", *, signed_in: bool = True, outlet: Optional[str] = None) -> None:
        super().__init__(status, services=SERVICES)
        self.core.version = "2.4.1"
        self.core.channel = "stable"
        self.release = FakeRelease()
        self.devices = FakeDevices()
        self.config = FakeConfig()
        self.update = SimpleNamespace(outlet=SimpleNamespace(id=outlet, kind="store" if outlet else "direct"), decide=lambda **_: None)
        self.signed_in = signed_in
        self.signed_out = 0
        self.license.license_info = lambda: SimpleNamespace(
            tier="pro", tierLabel="Pro", deviceLimit=3, deviceCount=None, entitledChannels=("stable", "beta")
        )
        self.identity.current = lambda: {"name": "Ada", "email": "ada@example.com"} if self.signed_in else None
        self.identity.sign_out = self._sign_out

    def _sign_out(self) -> None:
        self.signed_out += 1
        self.signed_in = False


def plain(text: str) -> str:
    """``text`` without the FSI/PDI that isolate presentation text."""
    return text.replace("\u2068", "").replace("\u2069", "")


def labels(spec: Any) -> List[str]:
    return [plain(b.text) for b in spec.buttons]


def texts(spec: Any) -> List[str]:
    return [plain(t) for t in spec.body]


@pytest.fixture
def gates(kit_app):
    made: List[Any] = []

    def make(client: Optional[DropClient] = None, **kw: Any) -> Any:
        kw.setdefault("on_update", lambda offer: None)
        kw.setdefault("open_url", Opener())
        g = run_gate(client or DropClient(), kw.pop("window", None), theme=kw.pop("theme", Theme(color_scheme="dark", platform="gnome")), **kw)
        made.append(g)
        return g

    yield make
    for g in made:
        g.close()


@pytest.fixture
def pages(kit_app):
    made: List[Any] = []

    def make(factory: Any = account_page, client: Optional[DropClient] = None, **kw: Any) -> Any:
        kw.setdefault("theme", Theme(color_scheme="dark", platform="gnome"))
        kw.setdefault("size", (520, 760))
        page = factory(client or DropClient(), **kw)
        made.append(page)
        return page

    yield make
    for p in made:
        p.close()


# ── the pieces ──────────────────────────────────────────────────────────────────────────────────


def test_notes_are_at_most_three_plain_lines():
    assert update_notes(SUMMARY) == NOTES
    assert update_notes(None) == () and update_notes("") == () and update_notes("\n\n- \n") == ()


def test_changelog_entry_ignores_a_leading_v():
    entries = FakeRelease().entries
    assert changelog_entry(entries, "2.5.0").url.endswith("2.5.0")
    assert changelog_entry(entries, "v2.4.1").version == "2.4.1"
    assert changelog_entry(entries, "9.9.9") is None


# ── the update dialog ───────────────────────────────────────────────────────────────────────────


def test_dialog_has_the_facts(gates):
    g = gates()
    g.offer_update(UpdateOffer("2.5.0", size=61_000_000, notes=NOTES, notes_url="https://example.com/r"))
    spec = g._dialog.kit.bridge.screen_spec
    assert g.update_open
    assert plain(spec.title) == "Tidewater Studio 2.5.0"
    assert texts(spec) == ["You have 2.4.1 · 61 MB download", "What's new"] + ["• " + n for n in NOTES]
    assert labels(spec) == ["Update now", "All changes in 2.5.0", "Later"]
    assert [b.role for b in spec.buttons].count("primary") == 1


def test_size_only_when_known(gates):
    g = gates()
    g.offer_update(UpdateOffer("2.5.0", notes=NOTES))
    assert texts(g._dialog.kit.bridge.screen_spec)[0] == "You have 2.4.1"
    assert not any("download" in t for t in texts(g._dialog.kit.bridge.screen_spec))


def test_no_summary_hides_the_whats_new_label(gates, kit_app):
    client = DropClient()
    client.release.entries = [ChangelogEntry("2.5.0", "v2.5.0", None, "https://example.com/releases/2.5.0")]
    g = gates(client)
    g.offer_update("2.5.0")
    pump(kit_app, lambda: g.update.notes_url is not None)
    spec = g._dialog.kit.bridge.screen_spec
    assert "What's new" not in texts(spec)
    assert labels(spec) == ["Update now", "All changes in 2.5.0", "Later"]


def test_notes_come_from_the_changelog(gates, kit_app):
    client = DropClient()
    g = gates(client)
    g.offer_update("2.5.0")
    assert labels(g._dialog.kit.bridge.screen_spec) == ["Update now", "Later"]  # nothing known yet
    pump(kit_app, lambda: bool(g.update.notes))
    spec = g._dialog.kit.bridge.screen_spec
    assert g.update.notes == NOTES and g.update.notes_url == "https://example.com/releases/2.5.0"
    assert texts(spec)[1:] == ["What's new"] + ["• " + n for n in NOTES]
    assert "All changes in 2.5.0" in labels(spec)
    assert client.release.calls == 1


def test_all_changes_opens_the_release_page(gates):
    opener = Opener()
    g = gates(open_url=opener)
    g.offer_update(UpdateOffer("2.5.0", notes=NOTES, notes_url="https://example.com/r"))
    g._dialog.kit.bridge.invoke("update.allChanges", "")
    assert opener.urls == ["https://example.com/r"]


def test_update_now_is_the_hosts(gates):
    got: List[UpdateOffer] = []
    g = gates(on_update=got.append)
    g.offer_update(UpdateOffer("2.5.0", notes_url="https://example.com/r"))
    g._dialog.kit.bridge.invoke("update.install", "")
    assert [o.version for o in got] == ["2.5.0"]


def test_update_now_draws_only_with_a_handler(gates):
    g = gates(on_update=None)
    g.on_update = None
    g.offer_update(UpdateOffer("2.5.0", notes_url="https://example.com/r"))
    assert "Update now" not in labels(g._dialog.kit.bridge.screen_spec)
    assert "Later" in labels(g._dialog.kit.bridge.screen_spec)


def test_a_mandatory_update_has_no_later(gates):
    g = gates()
    g.offer_update(UpdateOffer("3.0.0", mandatory=True, notes_url="https://example.com/r"))
    spec = g._dialog.kit.bridge.screen_spec
    assert spec.state == "mandatory" and "Later" not in labels(spec) and "Update now" in labels(spec)
    assert plain(spec.title) == "Update to keep using Tidewater Studio"
    g.update_later()  # nothing to remember: the dialog stays
    assert g.update_open and g._later == set()


def test_later_is_remembered_per_version(gates, kit_app):
    g = gates()
    g.offer_update(UpdateOffer("2.5.0", notes_url="https://example.com/r"))
    g._dialog.kit.bridge.invoke("update.later", "")
    assert not g.update_open
    g.offer_update(UpdateOffer("2.5.0", notes_url="https://example.com/r"))  # the same version again: a toast
    assert not g.update_open
    assert g.toast is not None and "toast.updateAvailable" in g.toast.copy
    g.offer_update(UpdateOffer("2.6.0", notes_url="https://example.com/r"))  # a newer one: the dialog again
    assert g.update_open and plain(g._dialog.kit.bridge.screen_spec.title) == "Tidewater Studio 2.6.0"
    g.offer_update(UpdateOffer("2.5.0", mandatory=True, notes_url="https://example.com/r"))  # mandatory ignores Later
    assert g.update_open


def test_progress_fills_the_bar(gates):
    g = gates()
    g.offer_update(UpdateOffer("2.5.0", notes_url="https://example.com/r"))
    g.update_progress(0.4)
    spec = g._dialog.kit.bridge.screen_spec
    assert (spec.state, spec.progress) == ("downloading", pytest.approx(0.4))
    assert plain(spec.title) == "Tidewater Studio 2.5.0"
    assert "Restart when ready" not in labels(spec)
    g.update_progress(None, phase="install")
    assert g._dialog.kit.bridge.screen_spec.progress == -1.0  # no count: the shimmer, never an invented bar
    g.update_progress(1.0, phase="done")
    assert not g.update_open and g.update is None


def test_failed_download_offers_try_again_with_a_handler(gates):
    got: List[UpdateOffer] = []
    g = gates(on_update=got.append)
    g.offer_update(UpdateOffer("2.5.0", notes_url="https://example.com/r"))
    g.update_progress(0.2, phase="failed")
    spec = g._dialog.kit.bridge.screen_spec
    assert spec.state == "failed" and "Try again" in labels(spec)
    g._dialog.kit.bridge.invoke("common.tryAgain", "retry")
    assert len(got) == 1 and g._dialog.kit.bridge.screen_spec.state == "available"


def test_the_update_service_off_draws_nothing(gates):
    client = DropClient()
    client.core._on = ["license", "config", "identity"]
    g = gates(client)
    g.offer_update("2.5.0")
    assert not g.update_open


def test_check_for_update_offers_a_binary_decision(gates, kit_app):
    client = DropClient()
    decision = SimpleNamespace(action="binary", release=SimpleNamespace(version="2.5.0"), mandatory=True, critical=None)
    client.update.decide = lambda **_: SimpleNamespace(decision=decision)
    g = gates(client)
    g.check_for_update()
    pump(kit_app, lambda: g.update_open)
    assert g.update.version == "2.5.0" and g.update.mandatory and g.update.current == "2.4.1"
    none = SimpleNamespace(decision=SimpleNamespace(action="none", release=None))
    client.update.decide = lambda **_: none
    g.dismiss_update()
    g.check_for_update()
    time.sleep(0.05)
    kit_app.processEvents()
    assert not g.update_open


def test_the_dialog_sits_over_the_host_with_a_scrim(gates, kit_app):
    from PySide6.QtGui import QWindow

    host = QWindow()
    host.setGeometry(100, 80, 900, 700)
    host.show()
    g = gates(window=host)
    g.offer_update(UpdateOffer("2.5.0", notes_url="https://example.com/r"))
    dialog = g._dialog
    scrim = dialog.scrim.window
    assert g.update_open and scrim is not None and scrim.isVisible()
    assert (scrim.x(), scrim.y(), scrim.width(), scrim.height()) == (100, 80, 900, 700)  # the whole host
    assert dialog.kit.view.transientParent() == host and scrim.transientParent() == host
    cx, cy = dialog.kit.view.x() + dialog.kit.view.width() / 2, dialog.kit.view.y() + dialog.kit.view.height() / 2
    assert (cx, cy) == (100 + 450, 80 + 350)  # centred on the host
    assert dialog.kit.view.modality().name == "ApplicationModal"
    g.update_later()
    assert not scrim.isVisible()
    host.close()


# ── the signed-in toast ─────────────────────────────────────────────────────────────────────────


def test_a_sign_in_toasts_who_and_the_tier(gates, kit_app):
    client = DropClient("needs-activation")
    g = gates(client)
    g.flow.sign_in()
    g.flow.begin_sign_in()
    pump(kit_app, lambda: client.identity.waiting.is_set())
    client.identity.finish.set()
    pump(kit_app, lambda: g.toast is not None)
    spec = g._toast.kit.bridge.screen_spec
    assert texts(spec) == ["Signed in as Ada · Pro license"]
    assert labels(spec) == ["Dismiss"]
    assert g.open
    g._toast.kit.bridge.invoke("common.dismiss", "")
    assert g.toast is None


def test_the_toast_without_a_tier_is_just_who(gates, kit_app):
    client = DropClient("needs-activation")
    client.license.license_info = lambda: None
    g = gates(client)
    g._signed_in(SimpleNamespace(identity=SimpleNamespace(name="Ada")))
    assert texts(g._toast.kit.bridge.screen_spec) == ["Signed in as Ada"]


def test_toasts_can_be_turned_off(gates):
    g = gates(toasts=False)
    g._signed_in(SimpleNamespace(identity=SimpleNamespace(name="Ada")))
    assert g._toast is None


# ── the account page ────────────────────────────────────────────────────────────────────────────


def rows(page: Any) -> dict:
    out = {}
    for group in page.kit.bridge.screen_spec.groups:
        for row in group.rows:
            out[row.id] = row
    return out


def test_account_page_draws_account_and_license(pages, kit_app):
    page = pages()
    spec = page.kit.bridge.screen_spec
    assert (spec.component, spec.state) == ("AccountAndLicense", "signed-in")
    r = rows(page)
    assert plain(r["holder"].title) == "Signed in as Ada"
    assert plain(r["tier"].title) == "Pro license"
    assert plain(r["version"].title) == "Version 2.4.1"
    assert "signOut" in r


def test_host_actions_draw_only_with_a_handler(pages):
    bare = pages()
    r = rows(bare)
    assert not r["holder"].actions  # no Manage
    assert not r["version"].actions  # no Check for updates
    calls: List[str] = []
    wired = pages(on_manage=lambda: calls.append("manage"), on_check_update=lambda: calls.append("check"))
    r = rows(wired)
    assert [a.text for a in r["holder"].actions] == ["Manage"] and r["holder"].actions[0].external
    assert [a.text for a in r["version"].actions] == ["Check for updates"]
    wired.kit.bridge.invoke_row("common.manage", "manage", "holder")
    wired.kit.bridge.invoke_row("update.checkNow", "check-update", "version")
    assert calls == ["manage", "check"]


def test_renew_needs_a_page_to_open(pages):
    expired = DropClient("expired")
    assert not rows(pages(client=expired))["tier"].actions
    opener = Opener()
    page = pages(client=DropClient("expired"), renew_url="https://example.com/renew", open_url=opener)
    assert [plain(a.text) for a in rows(page)["tier"].actions] == ["Renew with Harbor Audio"]
    page.kit.bridge.invoke_row("status.renew", "renew", "tier")
    assert opener.urls == ["https://example.com/renew"]


def test_channel_picker_is_locked_with_its_reason(pages):
    channel = rows(pages())["channel"]
    assert channel.control == "value" and channel.locked and channel.lock_label
    assert channel.title == "Release channel" and channel.value.strip("⁨⁩") == "stable"
    assert plain(channel.meta) == "Tidewater Studio sets the channel."  # the app sets it: no store fixes it
    store = rows(pages(client=DropClient(outlet="steam")))["channel"]
    assert plain(store.meta) == "Steam sets the channel." and store.locked


def test_channel_picker_is_a_choice_only_with_a_handler(pages):
    picked: List[str] = []
    page = pages(channels=[("stable", "Stable"), ("beta", "Beta")], on_channel=picked.append)
    channel = rows(page)["channel"]
    assert channel.control == "choice" and not channel.locked
    assert [label for _v, label in channel.options] == ["Stable", "Beta"]
    page.kit.bridge.edit("channel", "beta")
    assert picked == ["beta"] and rows(page)["channel"].current == 1
    # channels without a handler would be a control that does nothing: locked
    assert rows(pages(channels=[("stable", "Stable")]))["channel"].locked


def test_sign_out_runs_the_clients(pages, kit_app):
    client = DropClient()
    done: List[int] = []
    page = pages(client=client, on_sign_out=lambda: done.append(1))
    page.kit.bridge.invoke_row("common.signOut", "sign-out", "signOut")
    pump(kit_app, lambda: bool(done))
    assert client.signed_out == 1
    assert page.kit.bridge.screen_spec.state == "key-only"


def test_a_key_activated_account_has_no_holder(pages):
    page = pages(client=DropClient(signed_in=False))
    assert page.kit.bridge.screen_spec.state == "key-only"
    assert "holder" not in rows(page)


def test_devices_pane_lists_renames_and_removes(pages, kit_app):
    client = DropClient()
    page = pages(client=client)
    page.kit.bridge.invoke_row("common.review", "open-devices", "devices")
    pump(kit_app, lambda: page.kit.bridge.screen_spec.state == "list")
    spec = page.kit.bridge.screen_spec
    assert spec.component == "Devices" and "Back" in labels(spec)
    r = rows(page)
    assert r["d1"].title.strip("⁨⁩") == "Studio Mac" and not any(a.text == "Remove" for a in r["d1"].actions)
    assert any(a.text == "Remove" for a in r["d2"].actions)
    # rename
    page.kit.bridge.invoke_row("devices.rename", "rename", "d2")
    assert page.kit.bridge.screen_spec.state == "renaming"
    page.kit.bridge.edit("devices.renameLabel", "Desk PC")
    page.kit.bridge.invoke_row("common.save", "save", "d2")
    pump(kit_app, lambda: client.devices.renamed == [("d2", "Desk PC")])
    # remove asks first
    page.kit.bridge.invoke_row("devices.remove", "remove", "d2")
    assert page.kit.bridge.screen_spec.state == "confirming" and client.devices.removed == []
    page.kit.bridge.invoke_row("devices.remove", "remove", "d2:confirm")
    pump(kit_app, lambda: client.devices.removed == ["d2"])
    pump(kit_app, lambda: "d2" not in rows(page))
    page.kit.bridge.invoke("common.back", "")
    assert page.kit.bridge.screen_spec.component == "AccountAndLicense"
    assert plain(rows(page)["devices"].value) == "1 of 3 devices"


def test_a_failed_roster_says_so(pages, kit_app):
    client = DropClient()

    def boom() -> List[Any]:
        raise RuntimeError("offline")

    client.devices.list = boom
    page = pages(client=client)
    page.show_section("devices")
    pump(kit_app, lambda: page.kit.bridge.screen_spec.state == "error")
    assert "Try again" in labels(page.kit.bridge.screen_spec)


def test_settings_page_edits_the_catalog(pages):
    client = DropClient()
    page = pages(settings_page, client=client)
    spec = page.kit.bridge.screen_spec
    assert (spec.component, spec.state) == ("Settings", "locked")  # one is set by an organisation
    r = rows(page)
    assert r["audio.volume"].control == "slider" and r["ui.compact"].control == "switch" and not r["ui.compact"].on
    assert r["ui.language"].locked and "Harbor Audio" in plain(r["ui.language"].meta)
    page.kit.bridge.edit("config:audio.volume", "40")
    page.kit.bridge.edit("config:ui.compact", "true")
    assert client.config.writes == [("audio.volume", 40), ("ui.compact", True)]
    page.kit.bridge.invoke_row("settings.reset", "reset", "ui.compact")
    assert client.config.writes[-1] == ("ui.compact", None)
    page.kit.bridge.edit("config:ui.language", "Deutsch")  # locked: refused
    assert len(client.config.writes) == 3
    page.kit.bridge.invoke("common.back", "")
    assert page.kit.bridge.screen_spec.component == "AccountAndLicense"


def test_settings_save_failure_is_an_error_state(pages):
    client = DropClient()

    def refuse(key: str, value: Any) -> None:
        raise RuntimeError("no")

    client.config.set = refuse
    page = pages(settings_page, client=client)
    page.kit.bridge.edit("config:audio.volume", "40")
    assert page.kit.bridge.screen_spec.state == "error"


def test_the_account_page_links_to_devices_and_settings(pages):
    r = rows(pages())
    assert [a.text for a in r["devices"].actions] == ["Review"] and r["devices"].actions[0].action == "open-devices"
    assert [a.text for a in r["settings"].actions] == ["Review"] and r["settings"].actions[0].action == "open-settings"
    off = DropClient()
    off.core._on = ["license", "identity"]
    assert "settings" not in rows(pages(client=off))


def test_page_embeds_in_a_widgets_layout(pages, kit_app):
    from PySide6.QtWidgets import QVBoxLayout, QWidget

    page = pages()
    host = QWidget()
    layout = QVBoxLayout(host)
    layout.addWidget(page.container(host))
    host.resize(520, 760)
    host.show()
    kit_app.processEvents()
    assert page.container() is page.container(host)
    page.close()  # before the window goes: the container owns the view
    host.close()


# ── baselines ───────────────────────────────────────────────────────────────────────────────────

DIALOG = (460, 560)


def _slug(*parts: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", "-".join(parts).lower()).strip("-")


def _shot(name: str, scheme: str, image: Any) -> None:
    assert not image.isNull()
    check(image, SNAPSHOTS / f"dropin-{_slug(name)}.{scheme}.png")


def _compose(dialog_image: Any, scheme: str) -> Any:
    """The dialog over a stand-in host window under the scrim: what the person sees (DL2)."""
    from PySide6.QtCore import QRect
    from PySide6.QtGui import QColor, QImage, QPainter
    from polaris_key.ui.qt.gate import _SCRIM

    host = QImage(900, 700, QImage.Format.Format_ARGB32)
    host.fill(QColor("#f4f5f7") if scheme == "light" else QColor("#15181e"))
    p = QPainter(host)
    p.fillRect(QRect(0, 0, 900, 56), QColor("#dfe2e7") if scheme == "light" else QColor("#1f232b"))
    for i in range(6):
        p.fillRect(QRect(40, 100 + i * 90, 820 - (i % 3) * 140, 56), QColor("#e9ebef") if scheme == "light" else QColor("#1b1f26"))
    p.fillRect(host.rect(), QColor(*_SCRIM[scheme]))
    p.drawImage(QRect(220, 70, dialog_image.width(), dialog_image.height()), dialog_image)
    p.end()
    return host


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_update_baselines(gates, scheme):
    theme = Theme(color_scheme=scheme, platform="gnome")
    g = gates(theme=theme)
    g.offer_update(UpdateOffer("2.5.0", size=61_000_000, notes=NOTES, notes_url="https://example.com/r"))
    _shot("update available", scheme, g._dialog.kit.grab())
    _shot("update over host", scheme, _compose(g._dialog.kit.grab(), scheme))
    g.update_progress(0.4)
    _shot("update downloading", scheme, g._dialog.kit.grab())
    g.update_progress(None, phase="failed")
    _shot("update failed", scheme, g._dialog.kit.grab())
    g.dismiss_update()
    g._fetch_notes = lambda v: None  # no changelog entry: the plain dialog
    g.offer_update(UpdateOffer("2.5.0", notes=(), notes_url=None, current="2.4.1"))
    _shot("update plain", scheme, g._dialog.kit.grab())
    g.dismiss_update()
    g.offer_update(UpdateOffer("3.0.0", mandatory=True, notes=NOTES[:1], notes_url="https://example.com/r", critical=True))
    _shot("update mandatory", scheme, g._dialog.kit.grab())


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_toast_baselines(gates, scheme):
    g = gates(theme=Theme(color_scheme=scheme, platform="gnome"))
    g._signed_in(SimpleNamespace(identity=SimpleNamespace(name="Ada")))
    _shot("toast signed in", scheme, g._toast.kit.grab())
    g.offer_update(UpdateOffer("2.5.0", notes_url="https://example.com/r"))
    g.update_later()
    g.offer_update(UpdateOffer("2.5.0", notes_url="https://example.com/r"))
    _shot("toast update again", scheme, g._toast.kit.grab())


@pytest.mark.parametrize("scheme", ["dark", "light"])
def test_page_baselines(pages, kit_app, scheme):
    theme = Theme(color_scheme=scheme, platform="gnome")
    page = pages(theme=theme, on_manage=lambda: None, on_check_update=lambda: None)
    pump(kit_app, lambda: page._roster is not None)
    _shot("account signed in", scheme, page.kit.grab())
    picker = pages(theme=theme, channels=[("stable", "Stable"), ("beta", "Beta")], on_channel=lambda c: None)
    pump(kit_app, lambda: picker._roster is not None)
    _shot("account channel choice", scheme, picker.kit.grab())
    page.show_section("devices")
    _shot("devices", scheme, page.kit.grab())
    page.show_section("settings")
    _shot("settings", scheme, page.kit.grab())


# ── the design rules, on every screen the drop-in adds ─────────────────────────────────────────


def _audit(spec: Any) -> None:
    assert all(b.text.strip() for b in spec.buttons), "every control is named"
    assert [b.role for b in spec.buttons].count("primary") <= 1, "one filled control (DL3)"
    assert not any("{" in t for t in [spec.title, *spec.body]), "no placeholder left in a sentence"
    assert spec.title or spec.body or spec.groups, "a screen says something"


def test_every_dropin_screen_follows_the_rules(gates, pages, kit_app):
    g = gates()
    g.offer_update(UpdateOffer("2.5.0", size=61_000_000, notes=NOTES, notes_url="https://example.com/r"))
    _audit(g._dialog.kit.bridge.screen_spec)
    for phase in ("download", "verify", "install", "paused", "failed"):
        g.update_progress(0.5 if phase in ("download", "verify") else None, phase=phase)
        _audit(g._dialog.kit.bridge.screen_spec)
    g.dismiss_update()
    g.offer_update(UpdateOffer("3.0.0", mandatory=True))
    _audit(g._dialog.kit.bridge.screen_spec)
    g._signed_in(SimpleNamespace(identity=SimpleNamespace(name="Ada")))
    _audit(g._toast.kit.bridge.screen_spec)
    page = pages(on_manage=lambda: None)
    pump(kit_app, lambda: page._roster is not None)
    for section in ("account", "devices", "settings"):
        page.show_section(section)
        _audit(page.kit.bridge.screen_spec)
