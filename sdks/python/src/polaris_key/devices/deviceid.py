"""The device identity formula — wire contract v3 §6, pinned by
``conformance/corpus/v2/fingerprint.json`` (``fingerprintVersion`` 1, unchanged in v3).

Mirrors ``packages/sdk-node/src/devices/deviceId.ts``: read the OS identifier (macOS
``ioreg`` / Windows registry / Linux ``/etc/machine-id`` else ``/var/lib/dbus/machine-id``), then SHA-256 over
``pkey-device:<product>:<raw>`` and take the first 32 chars of its base64url digest, so
the raw OS identifier never leaves the device.

NOTE the domain prefix is ``pkey-device:`` and is deliberately NOT rebranded: it is baked
into every device id already enrolled, and changing it would orphan the fleet. §8 rebrands
user-visible identifiers, not hash domains — the fingerprint module's ``pkey-hw`` prefix is
frozen for exactly the same reason.
"""

from __future__ import annotations

import hashlib
import re
import sys
import uuid
from typing import Optional

from ..core.b64url import b64url_encode
from .fingerprint import DEFAULT_IO, FingerprintIO, read_linux_anchor

__all__ = ["derive_device_id", "device_id_from_raw", "raw_os_device_id"]

_IOREG_UUID_RE = re.compile(r'"IOPlatformUUID"\s*=\s*"([^"]+)"')
_REG_GUID_RE = re.compile(r"MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)")


def raw_os_device_id(
    platform: Optional[str] = None, io: Optional[FingerprintIO] = None
) -> Optional[str]:
    """Best-effort read of the OS device identifier. Returns ``None`` if unavailable.

    On Linux this is rule 2 of WIRE-CONTRACT-V3 §6.1, the same anchor the fingerprint's
    ``machineUuid`` uses: the first of ``/etc/machine-id`` and ``/var/lib/dbus/machine-id``
    that is non-empty after trimming ASCII whitespace and not ``uninitialized`` (which this
    reader used to accept, giving every such host one shared id). ``platform`` and ``io`` are
    test seams.
    """
    platform = platform or sys.platform
    io = io or DEFAULT_IO
    try:
        if platform == "darwin":
            out = io.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], 2.0)
            m = _IOREG_UUID_RE.search(out or "")
            return m.group(1) if m else None
        if platform == "win32":
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
                out = io.run(
                    ["reg", "query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"],
                    2.0,
                )
                m = _REG_GUID_RE.search(out or "")
                return m.group(1) if m else None
        # Linux / others.
        anchor = read_linux_anchor(io)
        return anchor.value if anchor else None
    except Exception:
        return None


def device_id_from_raw(product_slug: str, raw: str) -> str:
    """The device-id formula itself, split out from the hardware read so it can be pinned by
    ``conformance/corpus/v2/fingerprint.json``. Node, Python, Swift and Godot must agree exactly."""
    digest = hashlib.sha256(f"pkey-device:{product_slug}:{raw}".encode("utf-8")).digest()
    return b64url_encode(digest)[:32]


def derive_device_id(product_slug: str, fallback: Optional[str] = None) -> str:
    """Derive a stable, hashed device id (base64url, first 32 chars)."""
    return device_id_from_raw(product_slug, raw_os_device_id() or fallback or str(uuid.uuid4()))
