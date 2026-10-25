"""``account_page(client)`` and ``settings_page(client)``: the account, devices and settings panes of the
Qt kit as one embeddable Qt Quick page (UI-KITS "Embedding", a Qt Quick page; DL2: panes join the host).

The page draws what the client holds: the account and its license (:func:`~polaris_key.ui.core.ui_settings.account_view`),
the device roster (``client.devices``) and the catalog settings (``client.config``). The account pane links to
the other two (a Review button on their rows); each of them has a Back. Everything that needs the network
runs off the GUI thread and comes back on it.

What only the host can do draws only when the host passes a handler (UI-KITS decision 7): Manage
(``on_manage``), Check for updates (``on_check_update``), Renew (``renew_url``) and the release channel's
choice (``channels`` with ``on_channel``). The ChannelPicker without them is locked, with the reason.

Like the gate, the page owns no event loop: put :meth:`AccountPage.container` in a widgets layout, or
:meth:`AccountPage.show` it as a window.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from ..core.identity import presentation_source
from ..core.theme import Theme
from ..core.ui_contract import SERVICES, context_of
from ..core.ui_devices import devices_view
from ..core.ui_settings import account_view, settings_view
from ..core.ui_view import View, actions_for, valid_link
from . import _binding as qt
from .flow import default_open_url
from .kit import KitView

__all__ = ["AccountPage", "account_page", "settings_page"]

#: What a store outlet is called where the channel is locked to it ("Steam sets the channel.").
_STORES = {
    "steam": "Steam",
    "itch": "itch.io",
    "flathub": "Flathub",
    "snap": "the Snap Store",
    "ms-store": "the Microsoft Store",
    "app-store": "the App Store",
    "play": "Google Play",
    "play-testing": "Google Play",
    "testflight": "TestFlight",
    "altstore": "AltStore",
    "winget": "winget",
    "fdroid-repo": "F-Droid",
}
_SECTIONS = ("account", "devices", "settings")
_DAY = 86400


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


class AccountPage:
    """The account, devices and settings panes over one client. ``section`` is the pane shown first."""

    def __init__(
        self,
        client: Any,
        *,
        section: str = "account",
        theme: Optional[Theme] = None,
        size: Tuple[int, int] = (520, 640),
        on_manage: Optional[Callable[[], None]] = None,
        on_check_update: Optional[Callable[[], None]] = None,
        on_sign_out: Optional[Callable[[], None]] = None,
        renew_url: Optional[str] = None,
        open_url: Optional[Callable[[str], bool]] = None,
        channels: Optional[Sequence[Tuple[str, str]]] = None,
        on_channel: Optional[Callable[[str], None]] = None,
        platform: Optional[Mapping[str, Any]] = None,
    ) -> None:
        if section not in _SECTIONS:
            raise ValueError("section is one of %s, not %r" % (", ".join(_SECTIONS), section))
        self.client = client
        self.kit = KitView(theme, source=presentation_source(client), size=size)
        self.on_manage = on_manage
        self.on_check_update = on_check_update
        self.on_sign_out = on_sign_out
        self.renew_url = valid_link(renew_url)
        self._open_url = open_url or default_open_url
        self._channels = tuple(channels) if channels else ()
        self.on_channel = on_channel
        self.platform = platform
        self.section = section
        self._closed = False
        #: The device roster: ``None`` until read, then a list of the dicts the devices pane draws; and
        #: what is being done to one of them (``rename`` / ``remove``), and the rename's text.
        self._roster: Optional[List[Dict[str, Any]]] = None
        self._roster_error = False
        self._edit: Optional[Tuple[str, str]] = None  # (kind, device id)
        self._rename_text = ""
        self._settings_error: Optional[str] = None
        self._channel: Optional[str] = None
        bridge = self.kit.bridge
        bridge.row_invoked.connect(self._row_invoked)
        bridge.invoked.connect(self._invoked)
        bridge.edited.connect(self._edited)
        self.show_section(section)

    # ── the host's handles ──────────────────────────────────────────────────────────────────
    @property
    def view(self) -> Any:
        """The ``QQuickView`` (a window): ``show()`` it, or use :meth:`container`."""
        return self.kit.view

    def container(self, parent: Any = None) -> Any:
        """The page as a ``QWidget`` for the host's own layout (see :meth:`KitView.container`)."""
        return self.kit.container(parent)

    def show(self) -> None:
        """Open the page as a window of its own."""
        self.kit.view.show()

    @property
    def screen(self) -> Optional[View]:
        """The screen drawn now (a ui-matrix component and state)."""
        return self.kit.bridge.view

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.kit.close()

    # ── what the client holds ───────────────────────────────────────────────────────────────
    def _services(self) -> List[str]:
        enabled = getattr(getattr(self.client, "core", None), "enabled", None)
        if callable(enabled):
            try:
                return [slug for slug, _requires in SERVICES if enabled(slug)]
            except Exception:
                pass
        return [slug for slug, _r in SERVICES if slug != "identity" or hasattr(self.client, "identity")]

    def _input(self, **extra: Any) -> Dict[str, Any]:
        ident = self.kit.bridge.identity
        data: Dict[str, Any] = {
            "services": self._services(),
            "presentation": {"name": ident.name, "developerName": ident.developer},
            **extra,
        }
        if self.platform is not None:
            data["platform"] = dict(self.platform)
        return {k: v for k, v in data.items() if v is not None}

    def _status(self) -> str:
        try:
            return str(self.client.status().status)
        except Exception:
            return "ok"

    def _license_info(self) -> Any:
        info = getattr(getattr(self.client, "license", None), "license_info", None)
        try:
            return info() if callable(info) else None
        except Exception:
            return None

    def _identity(self) -> Optional[Mapping[str, Any]]:
        current = getattr(getattr(self.client, "identity", None), "current", None)
        try:
            return current() if callable(current) else None
        except Exception:
            return None

    def _channel_picker(self, info: Any, channel: str) -> Optional[Dict[str, Any]]:
        options = list(self._channels) or [(c, c) for c in (getattr(info, "entitledChannels", None) or (channel,))]
        free = bool(self.on_channel and self._channels)
        update = getattr(self.client, "update", None)
        outlet = getattr(update, "outlet", None)
        kind = getattr(outlet, "id", None) or getattr(outlet, "kind", None)
        store = _STORES.get(str(kind or ""))
        if not store:
            store = self.kit.bridge.identity.name or ""  # no store: the app sets it
        return {
            "options": [{"value": v, "label": label} for v, label in options],
            "locked": not free,
            "store": store,
        }

    def account(self) -> Dict[str, Any]:
        """The account the pane draws, in the ui-matrix's ``account`` shape."""
        who = self._identity()
        info = self._license_info()
        status = self._status()
        account: Dict[str, Any] = {"signedIn": who is not None}
        if who is not None:
            account["holder"] = _text(who.get("name")) or _text(who.get("email"))
        tier = _text(getattr(info, "tierLabel", None)) or _text(getattr(info, "tier", None))
        if tier:
            account["tier"] = tier
        limit = getattr(info, "deviceLimit", None)
        used = len(self._roster) if self._roster is not None else None
        if used is not None and isinstance(limit, int):
            account["devices"] = {"used": used, "limit": limit}
        elif used is not None:
            account["devices"] = {"used": used}
        core = getattr(self.client, "core", None)
        version = _text(getattr(core, "version", None))
        if version:
            account["version"] = version
        channel = self._channel or _text(getattr(core, "channel", None))
        if channel:
            account["channel"] = channel
            account["channelPicker"] = self._channel_picker(info, channel)
        if status in ("expired", "grace") and self.renew_url:
            account["renew"] = True
        if "license" in self._services():
            account["devicesPage"] = True
        if "config" in self._services() and self._config_rows():
            account["settingsPage"] = True
        return account

    def _config_rows(self) -> List[Dict[str, Any]]:
        config = getattr(self.client, "config", None)
        lister = getattr(config, "list_user_config", None)
        try:
            entries = lister() if callable(lister) else []
        except Exception:
            return []
        rows: List[Dict[str, Any]] = []
        for entry in entries:
            key = entry.get("key")
            if not isinstance(key, str):
                continue
            value = entry.get("value")
            try:
                where = str(config.get_config_source(key))
            except Exception:
                where = "default"
            row: Dict[str, Any] = {
                "key": key,
                "type": "boolean" if isinstance(value, bool) else "number" if isinstance(value, (int, float)) else "string",
                "source": where if where in ("local", "env") else "default",
                "locked": entry.get("enforced") is True,
                "value": value,
            }
            for member in ("label", "min", "max", "step", "options", "advanced", "org", "display"):
                if member in entry:
                    row[member] = entry[member]
            rows.append(row)
        return rows

    # ── drawing ─────────────────────────────────────────────────────────────────────────────
    def show_section(self, section: str) -> None:
        """Show the ``account``, ``devices`` or ``settings`` pane."""
        if section not in _SECTIONS:
            raise ValueError("section is one of %s, not %r" % (", ".join(_SECTIONS), section))
        self.section = section
        self._edit = None
        self._settings_error = None
        if section == "devices" and self._roster is None:
            self._load_roster()
        self.render()

    def refresh(self) -> None:
        """Re-read the client and draw the pane again."""
        self.render()

    def render(self) -> None:
        if self._closed:
            return
        if self.section == "devices":
            self._render_devices()
        elif self.section == "settings":
            self._render_settings()
        else:
            self._render_account()
        if self.section == "account" and self._roster is None and "license" in self._services():
            self._load_roster(draw=False)

    def _back(self, view: View) -> View:
        copy = tuple(sorted(set(view.copy) | {"common.back"}))
        return _replace_copy(view, copy)

    def _render_account(self) -> None:
        account = self.account()
        status = self._status()
        ctx = context_of(self._input(account=account, gate={"status": status}))
        view = account_view(ctx)
        drop = set()
        if self.on_manage is None:
            drop.update(("common.manage", "a11y.externalLink"))
        if self.on_check_update is None:
            drop.add("update.checkNow")
        if not self._can_sign_out():
            drop.add("common.signOut")
        if "a11y.externalLink" in drop and account.get("renew"):
            drop.discard("a11y.externalLink")
        view = _replace_copy(view, tuple(k for k in view.copy if k not in drop))
        self.kit.set_view(view, {"account": account})

    def _can_sign_out(self) -> bool:
        return hasattr(getattr(self.client, "identity", None), "sign_out") or hasattr(getattr(self.client, "license", None), "deactivate")

    def _render_devices(self) -> None:
        if self._roster is None and not self._roster_error:
            view = devices_view(context_of(self._input(loading=True, elapsedMs=0)))
            self.kit.set_view(self._back(view), {})
            return
        if self._roster is None:
            view = devices_view(context_of(self._input(error={"code": "device_list_failed"})))
            self.kit.set_view(self._back(view), {})
            return
        extra: Dict[str, Any] = {}
        selected: Optional[int] = None
        if self._edit is not None:
            kind, ident = self._edit
            at = next((i for i, d in enumerate(self._roster) if d["id"] == ident), None)
            if at is not None:
                selected = at
                extra["edit"] = {"kind": kind, "device": self._roster[at].get("name")}
        ctx = context_of(self._input(devices=self._roster, **extra))
        view = devices_view(ctx)
        data: Dict[str, Any] = {"devices": self._roster, **extra}
        if selected is not None:
            data["selected"] = selected
        self.kit.set_view(self._back(view), data)

    def _render_settings(self) -> None:
        rows = self._config_rows()
        extra: Dict[str, Any] = {}
        if self._settings_error:
            extra["error"] = {"code": self._settings_error}
            extra["edit"] = {"kind": "value"}
        ctx = context_of(self._input(config=rows, **extra))
        view = settings_view(ctx)
        self.kit.set_view(self._back(view), {"config": rows, **extra})

    # ── the roster ──────────────────────────────────────────────────────────────────────────
    def _load_roster(self, draw: bool = True) -> None:
        devices = getattr(self.client, "devices", None)
        lister = getattr(devices, "list", None)
        if not callable(lister):
            return

        def done(result: Any, error: Optional[BaseException]) -> None:
            if error is not None:
                self._roster_error = self._roster is None
            else:
                self._roster_error = False
                now = time.time()
                self._roster = [
                    {
                        "id": d.id,
                        "name": d.label or "",
                        "platform": d.platform,
                        "current": d.current is True,
                        "lastSeenDays": max(0, int((now - d.lastSeen) // _DAY)) if isinstance(d.lastSeen, (int, float)) else None,
                    }
                    for d in result
                ]
            self.render()

        self._work(lister, done)

    def _work(self, fn: Callable[[], Any], done: Callable[[Any, Optional[BaseException]], None]) -> None:
        def run() -> None:
            try:
                result, error = fn(), None
            except BaseException as e:  # noqa: BLE001 - every failure is a result for the GUI thread
                result, error = None, e
            try:
                self.kit.bridge.post(lambda: None if self._closed else done(result, error))
            except RuntimeError:
                pass  # the page closed while the call was out

        threading.Thread(target=run, daemon=True, name="polaris-key-account").start()

    # ── what the controls do ────────────────────────────────────────────────────────────────
    def _invoked(self, key: str, _action: str) -> None:
        if key == "common.back":
            self.show_section("account")
        elif key == "common.tryAgain":
            if self.section == "devices":
                self._roster, self._roster_error = None, False
                self._load_roster()
                self.render()
            else:
                self._settings_error = None
                self.render()

    def _row_invoked(self, key: str, action: str, row: str) -> None:
        handler = {
            "manage": lambda: self.on_manage and self.on_manage(),
            "renew": lambda: self.renew_url and self._open_url(self.renew_url),
            "check-update": lambda: self.on_check_update and self.on_check_update(),
            "sign-out": self._sign_out,
            "open-devices": lambda: self.show_section("devices"),
            "open-settings": lambda: self.show_section("settings"),
        }.get(action)
        if handler is not None:
            handler()
            return
        if self.section == "devices":
            self._device_action(action, row.split(":")[0])
        elif self.section == "settings":
            self._setting_action(action, row)

    def _sign_out(self) -> None:
        identity = getattr(self.client, "identity", None)
        out = getattr(identity, "sign_out", None) or getattr(getattr(self.client, "license", None), "deactivate", None)

        def done(_result: Any, _error: Optional[BaseException]) -> None:
            self._roster = None
            if self.on_sign_out is not None:
                self.on_sign_out()
            self.render()

        if callable(out):
            self._work(out, done)

    def _device_action(self, action: str, ident: str) -> None:
        devices = getattr(self.client, "devices", None)
        roster = self._roster or []
        device = next((d for d in roster if d["id"] == ident), None)
        if device is None:
            return
        if action == "rename":
            self._edit, self._rename_text = ("rename", ident), device.get("name") or ""
            self.render()
        elif action == "remove":
            if self._edit == ("remove", ident):
                self._edit = None
                self._work(lambda: devices.deauthorize(ident), lambda _r, e: self._after_device(e))
            else:
                self._edit = ("remove", ident)
                self.render()
        elif action == "save" and self._edit is not None and self._edit[0] == "rename":
            label = self._rename_text.strip() or None
            self._edit = None
            self._work(lambda: devices.rename(ident, label), lambda _r, e: self._after_device(e))
        elif action == "cancel":
            self._edit = None
            self.render()

    def _after_device(self, error: Optional[BaseException]) -> None:
        self._load_roster()

    def _edited(self, key: str, text: str) -> None:
        if key == "devices.renameLabel":
            self._rename_text = text  # drawn again only when the person saves: a rebuilt field loses its cursor
        elif key == "channel":
            if self.on_channel is not None:
                self._channel = text
                self.on_channel(text)
                self.render()
        elif key.startswith("config:") and self.section == "settings":
            self._set_setting(key[len("config:"):], text)

    def _set_setting(self, key: str, text: str) -> None:
        config = getattr(self.client, "config", None)
        row = next((r for r in self._config_rows() if r["key"] == key), None)
        if row is None or row.get("locked"):
            return
        value: Any = text
        if row["type"] == "boolean":
            value = text.strip().lower() in ("true", "1", "on")
        elif row["type"] == "number":
            try:
                number = float(text)
            except ValueError:
                return
            value = int(number) if number.is_integer() else number
        try:
            config.set(key, value)
            self._settings_error = None
        except Exception as e:  # noqa: BLE001 - the pane says it could not save, in the catalog's words
            self._settings_error = str(getattr(e, "code", "") or "settings_save_failed")
        self.render()

    def _setting_action(self, action: str, row: str) -> None:
        if action == "reset":
            try:
                self.client.config.clear(row)
                self._settings_error = None
            except Exception as e:  # noqa: BLE001
                self._settings_error = str(getattr(e, "code", "") or "settings_save_failed")
            self.render()


def _replace_copy(view: View, copy: Tuple[str, ...]) -> View:
    import dataclasses

    primary = view.decisions.primary
    decisions = dataclasses.replace(view.decisions, primary=None) if primary is not None and primary not in copy else view.decisions
    return dataclasses.replace(view, copy=copy, actions=actions_for(copy), decisions=decisions)


def account_page(client: Any, **options: Any) -> AccountPage:
    """The account page for ``client``: account and license first, with the devices and the settings a
    Review away. ``options`` are those of :class:`AccountPage` (``theme``, ``size``, ``on_manage`` ...)."""
    return AccountPage(client, section="account", **options)


def settings_page(client: Any, **options: Any) -> AccountPage:
    """The same page opened on the catalog settings (the account is its Back)."""
    return AccountPage(client, section="settings", **options)
