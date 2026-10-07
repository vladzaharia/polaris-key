"""The fixture adapter for the tidewater demo: a client that answers like the real one, for the
fictional Tidewater Studio by Harbor Audio (UI-KITS §8 "Fixtures"), with no Worker.

It keeps a little state between runs in a file under the temp directory, so ``activate`` then
``status`` show a licensed product. Keys:

* any ``pkey_tidewater_`` key with a 22-character body activates;
* a key ending ``LIMITS`` hits the device limit first (Replace a device, then Try again);
* ``login`` signs in as Mara Fennick about four seconds after the code is shown.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from polaris_key.client import DeviceInfo
from polaris_key.core.errors import PolarisError
from polaris_key.core.models import DocProfile
from polaris_key.devices.client import RegisterClosed
from polaris_key.license.endpoints import ActivationDeviceLimit, ActivationEnrollDisabled, ActivationOk, ActivationUnauthorized
from polaris_key.release.client import ChangelogEntry
from polaris_key.update.client import VersionCheck

STATE = os.path.join(tempfile.gettempdir(), "polaris-key-tidewater-demo.json")
MANAGE_URL = "https://key.plrs.im/portal/tidewater/devices"


def _load() -> Dict[str, Any]:
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save(state: Dict[str, Any]) -> None:
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f)


class Presentation:
    """The product's registered presentation, as HA-13's source will serve it."""

    def current(self) -> Dict[str, str]:
        return {"name": "Tidewater Studio", "developerName": "Harbor Audio", "accent": "#369186"}


@dataclass
class _Core:
    version: str = "2.4.1"
    channel: str = "stable"
    device_id: str = "dev_8f3a2c19e04b"
    base_url: str = "https://key.plrs.im"
    local_only: bool = True


@dataclass
class _State:
    status: str
    graceUntil: Optional[int] = None
    allowedRange: Any = None


class _License:
    def __init__(self, c: "FixtureClient") -> None:
        self.c = c

    def activate_with_key(self, key: str) -> Any:
        time.sleep(0.6)
        body = key[len("pkey_tidewater_") :] if key.startswith("pkey_tidewater_") else ""
        if len(body) != 22:
            return ActivationUnauthorized()
        if body.endswith("LIMITS") and not self.c.state.get("replaced"):
            self.c.state["replaced"] = True
            _save(self.c.state)
            return ActivationDeviceLimit(limit=3, deviceCount=3, manage_url=MANAGE_URL)
        self.c.state.update(activated=True, replaced=False)
        _save(self.c.state)
        return ActivationOk(token="pkeyt_demo")

    def enroll(self) -> Any:
        return ActivationEnrollDisabled()

    def deactivate(self) -> None:
        self.c.state.update(activated=False, signed_in=False)
        _save(self.c.state)

    def get_profile(self) -> Optional[DocProfile]:
        if self.c.state.get("signed_in"):
            return DocProfile(name="Mara Fennick", email="mara@fennick.studio")
        return None


@dataclass
class _Prompt:
    deviceCode: str = field(default="dc-demo", repr=False)
    userCode: str = "WDJB-MJHT"
    verificationUri: str = "https://key.plrs.im/device"
    verificationUriComplete: str = "https://key.plrs.im/device?user_code=WDJB-MJHT"
    expiresIn: int = 600
    interval: int = 1
    expiresAt: int = 0


class _Identity:
    def __init__(self, c: "FixtureClient") -> None:
        self.c = c

    def begin_sign_in(self, device_name: Optional[str] = None, *, confirm_identity: bool = False) -> _Prompt:
        time.sleep(0.4)
        return _Prompt(expiresAt=int(time.time()) + 600)

    def wait_for_sign_in(self, prompt: Any, timeout: Optional[float] = None, *, cancel: Optional[threading.Event] = None, on_confirm: Any = None) -> Any:
        if cancel is not None and cancel.wait(4.0):
            raise PolarisError("cancelled", "cancelled")
        if cancel is None:
            time.sleep(4.0)
        self.c.state.update(activated=True, signed_in=True)
        _save(self.c.state)
        ident = type("Identity", (), {"name": "Mara Fennick", "email": "mara@fennick.studio"})()
        return type("Result", (), {"status": "ready", "identity": ident, "attached": None, "message": None})()

    def current(self) -> Optional[Dict[str, Any]]:
        return {"name": "Mara Fennick", "email": "mara@fennick.studio"} if self.c.state.get("signed_in") else None

    def sign_out(self) -> None:
        self.c.license.deactivate()


class _Config:
    VALUES = {"audio.sampleRate": (48000, "default"), "telemetry.crashReports": (True, "enforced")}

    def __init__(self, c: "FixtureClient") -> None:
        self.c = c

    def list_user_config(self) -> List[Dict[str, Any]]:
        return [{"key": k, "value": v, "enforced": s == "enforced", "org": "Fennick Studio" if s == "enforced" else None} for k, (v, s) in self.VALUES.items()]

    def local_values(self) -> Dict[str, Any]:
        return dict(self.c.state.get("local", {}))

    def get_config(self, key: str, fallback: Any = None) -> Any:
        if key in self.c.state.get("local", {}):
            return self.c.state["local"][key]
        return self.VALUES.get(key, (fallback, ""))[0]

    def get_config_source(self, key: str) -> str:
        if key in self.c.state.get("local", {}):
            return "local"
        return self.VALUES.get(key, (None, "fallback"))[1]

    def set(self, key: str, value: Any) -> None:
        if self.VALUES.get(key, (None, ""))[1] == "enforced":
            raise PolarisError("managed_by_admin", "set by the organisation")
        self.c.state.setdefault("local", {})[key] = value
        _save(self.c.state)

    def clear(self, key: str) -> None:
        self.c.state.get("local", {}).pop(key, None)
        _save(self.c.state)

    def get_secret(self, key: str) -> Optional[str]:
        return None


class _Release:
    def changelog(self) -> List[ChangelogEntry]:
        return [
            ChangelogEntry("2.5", "v2.5", "Stem export in one click, with loudness matching\nTrack freeze now works with every plug-in", "https://tidewater.app/releases/2.5", "2026-10-01"),
            ChangelogEntry("2.4.1", "v2.4.1", "Fixes a crash when a plug-in is missing", "https://tidewater.app/releases/2.4.1", "2026-09-12"),
        ]


class _Packs:
    configured = False


class _Update:
    _configured = None
    driver = None
    packs = _Packs()

    def check(self, channel: Optional[str] = None) -> VersionCheck:
        return VersionCheck("2.5", "v2.5", "https://tidewater.app/releases/2.5", True)


class _Devices:
    def register(self) -> Any:
        return RegisterClosed()


class FixtureClient:
    """Duck-types the part of ``PolarisKeyClient`` the terminal kit uses."""

    product = "tidewater"

    def __init__(self) -> None:
        self.state = _load()
        self.core = _Core()
        self.license = _License(self)
        self.identity = _Identity(self)
        self.config = _Config(self)
        self.release = _Release()
        self.update = _Update()
        self.devices = _Devices()
        self.presentation_source = Presentation()

    def status(self, now: Optional[int] = None) -> _State:
        return _State("ok" if self.state.get("activated") else "needs-activation")

    def is_licensed(self, now: Optional[int] = None) -> bool:
        return bool(self.state.get("activated"))

    def list_devices(self) -> List[DeviceInfo]:
        return [
            DeviceInfo("dev_9k2", False, "ok", label="Work laptop", platform="Windows 11"),
            DeviceInfo("dev_4m7", False, "ok", label="Mara’s iPad", platform="iPadOS 26"),
            DeviceInfo(self.core.device_id, True, "ok", label="MacBook Pro", platform="macOS 26"),
        ]

    def rename_device(self, device_id: str, label: Optional[str]) -> None:
        pass

    def deauthorize_device(self, device_id: str) -> None:
        pass

    def store_status(self) -> None:
        return None

    def try_discover(self) -> None:
        return None

    def capabilities(self) -> Dict[str, Dict[str, bool]]:
        return {s: {"enabled": True} for s in ("license", "config", "release", "identity")}

    def supports(self, feature: str) -> bool:
        return True

    def outlet_id(self) -> Optional[str]:
        return None

    def import_bundle(self, jws: str, now: Optional[int] = None) -> Any:
        raise PolarisError("bundle-jws-rejected", "the demo accepts no bundles")

    def sync(self, *, force: bool = False) -> None:
        pass

    def close(self) -> None:
        pass
