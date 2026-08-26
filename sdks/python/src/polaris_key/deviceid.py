"""Stable, hashed per-device id.

Mirrors ``store.ts``'s ``rawDeviceId`` + ``deriveDeviceId``: read the OS identifier
(macOS ``ioreg`` / Windows registry / Linux ``/etc/machine-id``), then SHA-256 over
``pkey-device:<product>:<raw>`` and take the first 32 chars of its base64url digest, so
the raw OS identifier never leaves the device.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
import uuid
from typing import Optional

from .b64url import b64url_encode

__all__ = ["derive_device_id", "device_id_from_raw"]

_IOREG_UUID_RE = re.compile(r'"IOPlatformUUID"\s*=\s*"([^"]+)"')
_REG_GUID_RE = re.compile(r"MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)")


def raw_os_device_id() -> Optional[str]:
    """Best-effort read of the OS device identifier. Returns ``None`` if unavailable."""
    try:
        if sys.platform == "darwin":
            out = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
            m = _IOREG_UUID_RE.search(out)
            return m.group(1) if m else None
        if sys.platform == "win32":
            try:
                import winreg  # type: ignore

                with winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    r"SOFTWARE\Microsoft\Cryptography",
                ) as k:
                    val, _ = winreg.QueryValueEx(k, "MachineGuid")
                    return str(val) or None
            except Exception:
                # Fall back to parsing `reg query` output if winreg is unavailable.
                out = subprocess.run(
                    [
                        "reg",
                        "query",
                        r"HKLM\SOFTWARE\Microsoft\Cryptography",
                        "/v",
                        "MachineGuid",
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                ).stdout
                m = _REG_GUID_RE.search(out)
                return m.group(1) if m else None
        # Linux / others.
        for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    val = f.read().strip()
                if val:
                    return val
            except OSError:
                continue
        return None
    except Exception:
        return None


def device_id_from_raw(product_slug: str, raw: str) -> str:
    """The device-id formula itself, split out from the hardware read so it can be pinned by
    ``conformance/corpus/v1/fingerprint.json``. Node, Python, and Swift must agree exactly."""
    digest = hashlib.sha256(f"pkey-device:{product_slug}:{raw}".encode("utf-8")).digest()
    return b64url_encode(digest)[:32]


def derive_device_id(product_slug: str, fallback: Optional[str] = None) -> str:
    """Derive a stable, hashed device id (base64url, first 32 chars)."""
    return device_id_from_raw(product_slug, raw_os_device_id() or fallback or str(uuid.uuid4()))
