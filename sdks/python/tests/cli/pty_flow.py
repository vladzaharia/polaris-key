"""The program the real-pty tests run (test_pty.py): one flow on the process's own terminal, with a
stub client, so the key reader, the OSC 11 and cursor-position questions and SIGWINCH are the real
ones. ``python pty_flow.py login|device-limit|update [long]``."""

from __future__ import annotations

import os
import sys
import threading
import time
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src"))

from polaris_key.core.errors import PolarisError  # noqa: E402
from polaris_key.license.endpoints import ActivationDeviceLimit  # noqa: E402
from polaris_key.ui.terminal import flows  # noqa: E402
from polaris_key.ui.terminal.device import Device  # noqa: E402
from polaris_key.ui.terminal.env import detect  # noqa: E402
from polaris_key.ui.terminal.flows import Terminal  # noqa: E402
from polaris_key.ui.terminal.parts import Kit  # noqa: E402

mode = sys.argv[1] if len(sys.argv) > 1 else "login"
long = "long" in sys.argv
NAME = "Tidewater Studio Professional Mastering Suite for Podcasters" if long else "Tidewater Studio"
CODE = "WDJB-MJHT-QXRP-LMNV" if long else "WDJB-MJHT"
URL = (
    "https://licensing.tidewater-studio-professional.example.com/activate/device?region=eu-west-2&channel=stable-26"
    if long
    else "https://key.plrs.im/device"
)
EXPIRE = float(os.environ.get("PTY_EXPIRE", "4"))


class Source:
    def current(self) -> dict:
        return {"name": NAME, "developerName": "Harbor Audio", "accent": "#369186"}


class Prompt:
    deviceCode = "dc"
    userCode = CODE
    verificationUri = URL
    verificationUriComplete = URL + ("&" if "?" in URL else "?") + "code=" + CODE
    expiresIn = 600
    interval = 1

    def __init__(self) -> None:
        self.expiresAt = int(time.time()) + 600


class Identity:
    def begin_sign_in(self, name=None, confirm_identity=False):
        return Prompt()

    def wait_for_sign_in(self, prompt, *, cancel: threading.Event, on_confirm=None):
        if cancel.wait(EXPIRE):
            raise PolarisError("cancelled", "cancelled")
        return SimpleNamespace(status="expired")


def update_client() -> SimpleNamespace:
    decision = SimpleNamespace(action="binary", release=SimpleNamespace(version="2.5.0", size=61_000_000), mandatory=False, critical=False, contentBlock=None, to_dict=lambda: {"action": "binary"})

    def install(check, on_progress):
        for i in range(1, 300):
            on_progress(i * 200_000, 61_000_000)
            time.sleep(0.1)
        return SimpleNamespace(kind="restartRequired", version="2.5.0")

    update = SimpleNamespace(_configured=object(), driver=object(), decide=lambda channel=None: SimpleNamespace(decision=decision, channel="stable"), install=install)
    return SimpleNamespace(product="tidewater", update=update, core=SimpleNamespace(version="2.4.1"))


te = detect(device_code=mode == "login")
kit = Kit.create(te, product="tidewater", source=Source(), prog="tidewater")
device = Device(te, kit.palette())
t = Terminal(kit, device, {"login": "login", "device-limit": "activate", "update": "update"}[mode])
if mode == "login":
    out = flows.sign_in(SimpleNamespace(product="tidewater", identity=Identity(), status=lambda: SimpleNamespace(status="ok")), t)
elif mode == "device-limit":
    limit = ActivationDeviceLimit(limit=3, deviceCount=3, manage_url=URL.replace("activate/device", "portal/devices") if long else "https://key.plrs.im/portal/tidewater/devices")
    out = flows.activate(SimpleNamespace(product="tidewater", license=SimpleNamespace(activate_with_key=lambda key: limit), status=lambda: None), t, "pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA")
else:
    out = flows.update(update_client(), t, ["apply"])
sys.exit(t.finish(out))
