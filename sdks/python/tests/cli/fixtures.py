"""The terminal kit's fixture states (UI-KITS §5.2, §8 "Fixtures"): the Tidewater Studio product by
Harbor Audio, its account (Mara Fennick, Fennick Studio) and its devices (Work laptop, Mara's iPad,
MacBook Pro), rendered through every component and state the terminal draws.

Each fixture names its catalog component and state (``packages/brand/kit-copy/components.json``),
so the goldens are ``<component>-<state>-<theme>`` like every kit's baselines, and the string lint
can hold each render's copy keys to the catalog's list for that state. The product's accent comes
from a fake presentation source (HA-13's seam), never from integrator code.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

from polaris_key.ui.core import Theme
from polaris_key.ui.core.models import (
    ActivateView,
    BootView,
    DeviceRow,
    DevicesView,
    OfflineView,
    ProgressView,
    ReleaseNotesView,
    SettingRow,
    SettingsView,
    SignInModel,
    UpdateView,
    gate_view,
    parse_key,
)
from polaris_key.ui.terminal import screens
from polaris_key.ui.terminal.env import TermEnv
from polaris_key.ui.terminal.parts import Kit
from polaris_key.ui.terminal.text import Line

PRODUCT = "tidewater"
KEY = "pkey_tidewater_7Q2MzK8vRb1xLp4n3WPLDA"
NOW = 1_791_000_000
DAY = 86_400


class Presentation:
    """A fake presentation source (HA-13's ``PresentationSource`` seam): the product's registered
    name, developer and accent, with no integrator code."""

    def current(self) -> dict:
        return {"name": "Tidewater Studio", "developerName": "Harbor Audio", "accent": "#369186"}


@dataclass(frozen=True)
class Fixture:
    component: str
    state: str
    verb: str
    draw: Callable[[Kit], List[Line]]
    #: A second render of the same state (docs: ``<component>-<state>-<variant>``).
    variant: str = ""

    @property
    def name(self) -> str:
        return f"{kebab(self.component)}-{self.state}" + (f"-{self.variant}" if self.variant else "")


def kebab(name: str) -> str:
    out = ""
    for i, ch in enumerate(name):
        if ch.isupper() and i:
            out += "-"
        out += ch.lower()
    return out


def kit(env: TermEnv, theme: Optional[Theme] = None) -> Kit:
    return Kit.create(env, theme=theme, product=PRODUCT, source=Presentation(), prog="tidewater")


class _Prompt:
    userCode = "WDJB-MJHT"
    verificationUri = "https://key.plrs.im/device"
    verificationUriComplete = "https://key.plrs.im/device?user_code=WDJB-MJHT"
    expiresAt = NOW + 252


class _Result:
    def __init__(self, status: str, name: Optional[str] = None, email: Optional[str] = None, message: str = "") -> None:
        self.status = status
        self.message = message
        self.identity = type("I", (), {"name": name, "email": email})() if (name or email) else None


def _sign_in(headless: bool, *steps: Tuple[str, object]) -> Callable[[Kit], List[Line]]:
    def draw(k: Kit) -> List[Line]:
        m = SignInModel(headless=headless)
        view = m.prompted(_Prompt(), NOW)
        for step, arg in steps:
            view = getattr(m, step)(arg) if arg is not None else getattr(m, step)()
        return screens.sign_in(k, view, "login", frame=2)

    return draw


def _gate(status: str, **kw: object) -> Callable[[Kit], List[Line]]:
    def draw(k: Kit) -> List[Line]:
        return screens.gate(k, gate_view(status, now=NOW, developer=k.identity.developer, **kw), "status")  # type: ignore[arg-type]

    return draw


_ACCOUNT = dict(holder="Mara Fennick", email="mara@fennick.studio", signed_in=True, tier="Pro", term="Lifetime", version="2.4.1", channel="stable")
_ROWS = (
    DeviceRow("dev_9k2", "Work laptop", "Windows 11", False, "41 days ago"),
    DeviceRow("dev_4m7", "Mara’s iPad", "iPadOS 26", False, "yesterday"),
    DeviceRow("dev_1c3", "MacBook Pro", "macOS 26", True, "today"),
)
_NOTES = ("Stem export in one click, with loudness matching", "Track freeze now works with every plug-in")
_UPDATE = dict(version="2.5", current="2.4.1", size="61 MB", notes=_NOTES, notes_url="https://tidewater.app/releases/2.5")
_LIMIT = ActivateView("DeviceLimit", "browser-mode", "device-limit", "device_limit", KEY, 3, 3, "https://key.plrs.im/portal/tidewater/devices")


FIXTURES: Tuple[Fixture, ...] = (
    # ── PolarisKeyGate, StatusScreen, GraceBanner, AccountAndLicense (status) ──
    Fixture("PolarisKeyGate", "needs-activation", "status", _gate("needs-activation")),
    Fixture("PolarisKeyGate", "licensed", "status", _gate("not-applicable")),
    Fixture("AccountAndLicense", "signed-in", "status", _gate("ok", **_ACCOUNT)),
    Fixture("AccountAndLicense", "key-only", "status", _gate("ok", tier="Pro", term="Lifetime", version="2.4.1", channel="stable")),
    Fixture("GraceBanner", "days-left", "status", _gate("grace", grace_until=NOW + 3 * DAY, **_ACCOUNT)),
    Fixture("GraceBanner", "last-day", "status", _gate("grace", grace_until=NOW + DAY // 2, **_ACCOUNT)),
    Fixture("StatusScreen", "revoked", "status", _gate("revoked")),
    Fixture("StatusScreen", "expired", "status", _gate("expired")),
    Fixture("StatusScreen", "version-too-old", "status", _gate("version-too-old", allowed_min="2.4.0")),
    Fixture("StatusScreen", "version-too-new", "status", _gate("version-too-new", allowed_min="1.0.0", allowed_max="2.3.9")),
    Fixture("StatusScreen", "channel-not-entitled", "status", _gate("channel-not-entitled")),
    # ── Boot ──
    Fixture("Boot", "progress", "boot", lambda k: screens.boot_progress(k, "gate", 2) + screens.boot(k, BootView("Boot", "progress", "ready"), "boot")),
    Fixture("Boot", "progress", "boot", lambda k: screens.boot(k, BootView("Boot", "progress", "ready", update_available=True), "boot"), "update"),
    Fixture("Boot", "fetching", "boot", lambda k: screens.boot_progress(k, "fetch", 2, done="38 MB", total="91 MB")),
    Fixture("Boot", "consent", "boot", lambda k: screens.boot(k, BootView("Boot", "consent", size="91 MB", metered=True), "boot")),
    Fixture("Boot", "offline", "boot", lambda k: screens.boot(k, BootView("Boot", "offline", "offline", playable=True), "boot")),
    Fixture("Boot", "blocked", "boot", lambda k: screens.boot(k, BootView("Boot", "blocked", "blocked", "version-too-old"), "boot")),
    Fixture("Boot", "declined", "boot", lambda k: screens.boot(k, BootView("Boot", "declined", "fetch"), "boot")),
    Fixture("Boot", "rolled-back", "boot", lambda k: screens.boot(k, BootView("Boot", "rolled-back", "ready", rolled_back=True), "boot")),
    Fixture("Boot", "error", "boot", lambda k: screens.boot(k, BootView("Boot", "error", "error", code="mount-failed"), "boot")),
    # ── SignIn and SignInHandoff (SIGN-IN.md §4.15 frame 32: the browser, or a code when headless) ──
    Fixture("SignInHandoff", "starting", "login", lambda k: screens.sign_in(k, SignInModel().view, "login", frame=2)),
    Fixture("SignIn", "handoff", "login", _sign_in(False)),
    Fixture("SignInHandoff", "no-browser", "login", _sign_in(False, ("browser_failed", None))),
    Fixture("SignInHandoff", "code", "login", _sign_in(True)),
    Fixture("SignInHandoff", "waiting", "login", _sign_in(False, ("use_code", None))),
    Fixture("SignInHandoff", "link-copied", "login", _sign_in(True, ("copied", None))),
    Fixture("SignIn", "finishing", "login", lambda k: screens.sign_in(k, SignInModel()._set(component="SignIn", state="finishing", url_complete=_Prompt.verificationUriComplete), "login", frame=2)),
    Fixture("SignIn", "done", "login", _sign_in(False, ("finished", _Result("ready", "Mara Fennick", "mara@fennick.studio")))),
    Fixture("SignInHandoff", "expired", "login", _sign_in(True, ("finished", _Result("expired")))),
    Fixture("SignInHandoff", "denied", "login", _sign_in(True, ("finished", _Result("error", message="access_denied")))),
    Fixture("SignInHandoff", "cancelled", "login", _sign_in(False, ("cancelled", None))),
    Fixture("SignIn", "error", "login", _sign_in(False, ("failed", "sign-in-unavailable"))),
    # ── Activate ──
    Fixture("Activate", "empty", "activate", lambda k: screens.key_entry(k, "", parse_key(""))),
    Fixture("Activate", "typing", "activate", lambda k: screens.key_entry(k, "pkey_tidewater_7Q2M", parse_key("pkey_tidewater_7Q2M"))),
    Fixture("Activate", "parsed", "activate", lambda k: screens.key_entry(k, KEY, parse_key(KEY))),
    Fixture("Activate", "cut-short", "activate", lambda k: screens.key_entry(k, KEY[:25], parse_key(KEY[:25], final=True))),
    Fixture("Activate", "rejected", "activate", lambda k: screens.key_entry(k, "TIDE-1234-ABCD", parse_key("TIDE-1234-ABCD", final=True))),
    Fixture("Activate", "busy", "activate", lambda k: screens.key_entry(k, KEY, parse_key(KEY), busy=True, frame=2)),
    Fixture("Activate", "device-limit", "activate", lambda k: screens.activate(k, ActivateView("DeviceLimit", "failed", "device-limit", "device_limit", KEY), "activate")),
    Fixture("Activate", "done", "activate", lambda k: screens.activate(k, ActivateView("Activate", "done", "ok", key=KEY), "activate")),
    # ── DeviceLimit (browser mode, then Try again) ──
    Fixture("DeviceLimit", "browser-mode", "activate", lambda k: screens.device_limit(k, _LIMIT, "activate")),
    Fixture("DeviceLimit", "browser-mode", "activate", lambda k: screens.device_limit(k, _LIMIT, "activate", opened=True), "opened"),
    # ── OfflineActivation ──
    Fixture("OfflineActivation", "default", "offline-request", lambda k: screens.offline_activation(k, OfflineView("OfflineActivation", "default", request_code="dev_8f3a2c19e04b"), "offline-request")),
    Fixture("OfflineActivation", "rejected-signature", "import-bundle", lambda k: screens.offline_activation(k, OfflineView("OfflineActivation", "rejected-signature", code="bundle-jws-rejected"), "import-bundle")),
    Fixture("OfflineActivation", "done", "import-bundle", lambda k: screens.offline_activation(k, OfflineView("OfflineActivation", "done", imported=("license", "config")), "import-bundle")),
    # ── Devices ──
    Fixture("Devices", "list", "devices", lambda k: screens.devices(k, DevicesView("Devices", "list", _ROWS), "devices")),
    Fixture("Devices", "confirming", "devices", lambda k: screens.devices(k, DevicesView("Devices", "confirming", target=_ROWS[0]), "devices")),
    Fixture("Devices", "empty", "devices", lambda k: screens.devices(k, DevicesView("Devices", "empty"), "devices")),
    Fixture("Devices", "browser-mode", "devices", lambda k: screens.devices(k, DevicesView("Devices", "browser-mode"), "devices")),
    # ── UpdatePrompt, UpdateProgress, ReleaseNotes ──
    Fixture("UpdatePrompt", "available", "update", lambda k: screens.update(k, UpdateView("UpdatePrompt", "available", **_UPDATE), "update")),  # type: ignore[arg-type]
    Fixture("UpdatePrompt", "downloading", "update", lambda k: screens.update(k, UpdateView("UpdatePrompt", "downloading", "2.5", "2.4.1", fraction=0.62, done="38 MB", total="61 MB", eta="20 s"), "update")),
    Fixture("UpdatePrompt", "ready", "update", lambda k: screens.update(k, UpdateView("UpdatePrompt", "ready", "2.5", "2.4.1"), "update")),
    Fixture("UpdatePrompt", "mandatory", "update", lambda k: screens.update(k, UpdateView("UpdatePrompt", "mandatory", "2.5", "2.4.1", critical=True), "update")),
    Fixture("UpdatePrompt", "blocked", "update", lambda k: screens.update(k, UpdateView("UpdatePrompt", "blocked", current="2.4.1"), "update")),
    Fixture("UpdatePrompt", "store", "update", lambda k: screens.update(k, UpdateView("UpdatePrompt", "store", "2.5", "2.4.1", listing_url="https://apps.apple.com/app/id6450000000"), "update")),
    Fixture("UpdatePrompt", "platform", "update", lambda k: screens.update(k, UpdateView("UpdatePrompt", "platform", "2.5", "2.4.1"), "update")),
    Fixture("UpdatePrompt", "revoked-required-content", "update", lambda k: screens.update(k, UpdateView("UpdatePrompt", "revoked-required-content", "2.5", "2.4.1"), "update")),
    Fixture("UpdatePrompt", "up-to-date", "update", lambda k: screens.update(k, UpdateView("UpdatePrompt", "up-to-date", current="2.4.1"), "update")),
    Fixture("UpdateProgress", "queued", "packs", lambda k: screens.update_progress(k, ProgressView("UpdateProgress", "queued", "studio-presets"), "packs")),
    Fixture("UpdateProgress", "downloading", "packs", lambda k: screens.update_progress(k, ProgressView("UpdateProgress", "downloading", "studio-presets", 0.42, "38 MB", "91 MB", "1 min"), "packs")),
    Fixture("UpdateProgress", "installing", "packs", lambda k: screens.update_progress(k, ProgressView("UpdateProgress", "installing", "studio-presets"), "packs")),
    Fixture("UpdateProgress", "failed", "packs", lambda k: screens.update_progress(k, ProgressView("UpdateProgress", "failed", "studio-presets", code="chunk-bundle-truncated"), "packs")),
    Fixture("UpdateProgress", "done", "packs", lambda k: screens.update_progress(k, ProgressView("UpdateProgress", "done", "studio-presets"), "packs")),
    Fixture("ReleaseNotes", "list", "changelog", lambda k: screens.release_notes(k, ReleaseNotesView("ReleaseNotes", "list", (("2.5", "2026-10-01", _NOTES, "https://tidewater.app/releases/2.5"), ("2.4.1", "2026-09-12", ("Fixes a crash when a plug-in is missing",), None))), "changelog")),
    Fixture("ReleaseNotes", "empty", "changelog", lambda k: screens.release_notes(k, ReleaseNotesView("ReleaseNotes", "empty"), "changelog")),
    Fixture("ReleaseNotes", "error", "changelog", lambda k: screens.release_notes(k, ReleaseNotesView("ReleaseNotes", "error"), "changelog")),
    # ── Settings (config) ──
    Fixture("Settings", "list", "config", lambda k: screens.settings(k, SettingsView("Settings", "list", (SettingRow("audio.sampleRate", 48000, "default"), SettingRow("ui.theme", "dark", "local"))), "config")),
    Fixture("Settings", "locked", "config", lambda k: screens.settings(k, SettingsView("Settings", "locked", (SettingRow("telemetry.crashReports", True, "enforced", "Fennick Studio"), SettingRow("ui.theme", "dark", "local"))), "config")),
    Fixture("Settings", "saving", "config", lambda k: screens.settings(k, SettingsView("Settings", "saved", (SettingRow("ui.theme", "light", "local"),)), "config")),
    Fixture("Settings", "error", "config", lambda k: screens.settings(k, SettingsView("Settings", "error", code="managed_by_admin"), "config")),
)

#: Catalog states the terminal never draws, and why (UI-KITS §1.3: the terminal is the browser
#: presentation of sign-in, SIGN-IN.md D-93; layer 1 has no device list for a key, §4.3).
NOT_DRAWN = {
    ("SignIn", "methods"): "the terminal's step 1 is the login command itself",
    ("SignIn", "code"): "email codes are entered on the hosted card (S-16 D17)",
    ("SignIn", "choose"): "the card chooses the license (SIGN-IN.md D-93)",
    ("SignIn", "replace"): "the card replaces a device (SIGN-IN.md D-93)",
    ("SignIn", "key"): "the key path is the activate verb",
    ("SignIn", "expired"): "the terminal's sign-in expires with its code: SignInHandoff expired",
    ("SignInHandoff", "finishing"): "the SDK redeems the code inside wait_for_sign_in; SignIn finishing is drawn",
    ("DeviceLimit", "default"): "no device list for a key in layer 1 (UI-KITS §4.3); browser mode is drawn",
    ("DeviceLimit", "busy"): "no in-app replace in layer 1",
    ("DeviceLimit", "failed"): "no in-app replace in layer 1; after the browser, Try again is browser-mode-opened",
    ("DeviceLimit", "removed"): "no in-app replace in layer 1",
    ("OfflineActivation", "loaded"): "the file is read and submitted in one step",
    ("Devices", "loading"): "the list prints when it has loaded",
    ("Devices", "renaming"): "rename takes its label on the command line",
    ("Devices", "error"): "a failed list, rename or removal is the command's error line and exit code",
    ("UpdateProgress", "paused"): "a terminal download never waits for Wi-Fi",
    ("Settings", "loading"): "the list prints when it has loaded",
    ("Settings", "dirty"): "config set saves at once",
    ("ReleaseNotes", "loading"): "the list prints when it has loaded",
    ("AccountAndLicense", "loading"): "the summary prints when it has loaded",
    ("AccountAndLicense", "offline"): "drawn as GraceBanner",
    ("GraceBanner", "expired"): "drawn as StatusScreen expired",
    ("PolarisKeyGate", "booting"): "drawn as Boot progress",
    ("PolarisKeyGate", "grace"): "drawn as GraceBanner",
    ("PolarisKeyGate", "blocked"): "drawn as StatusScreen",
    ("PolarisKeyGate", "error"): "drawn as Boot error",
}

#: Catalog components the terminal does not draw at all, and why.
OUT_OF_SCOPE = {
    "Welcome": "the terminal's chooser is the help: login, activate, enroll (UI-KITS §1.3 terminal row)",
    "LicenseChoice": "never license rows in a terminal (SIGN-IN.md D-93)",
    "Paywall": "purchases happen in the portal or the store, not in a CLI",
    "EntitlementGate": "a host CLI checks entitlements itself",
    "CloudSyncStatus": "should tier; no CLI verb yet",
    "About": "should tier; doctor covers diagnostics",
    "ChannelPicker": "should tier; update --channel",
    "Toast": "a terminal prints lines, it has no toasts",
}
