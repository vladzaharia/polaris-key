"""Hardware fingerprint collection.

Mirrors ``packages/sdk-node/src/devices/fingerprint.ts``. Each component is hashed HERE, on the
device, as ``pkey-hw:<product>:<component>:<raw>`` → SHA-256 → base64url, first 22 chars, so
the raw serial/UUID/MAC never crosses the wire. The composite ``hwid`` is a second digest over
the present components in CANONICAL order, truncated to 32 chars.

Both formulas are pinned by ``conformance/corpus/v2/fingerprint.json`` — this module and its
Node/Swift/Worker counterparts must produce byte-identical output for identical input.

Every read is best-effort. A component that cannot be read is OMITTED, never substituted: a
partial fingerprint loses match precision, whereas a placeholder would make every partial
reader collide with every other one.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import subprocess
import sys
import uuid
from typing import Dict, Optional

from ..core.b64url import b64url_encode

__all__ = [
    "COMPONENT_ORDER",
    "collect_fingerprint",
    "hash_components",
    "raw_components",
]

#: Canonical component order. The hwid digest walks THIS list, never a dict's ordering.
COMPONENT_ORDER = (
    "machineUuid",
    "boardSerial",
    "cpuModel",
    "primaryMac",
    "bootVolumeUuid",
    "ramBucket",
    "machineModel",
)

_HASH_PREFIX = "pkey-hw"
_COMPONENT_LENGTH = 22
_HWID_LENGTH = 32

_IOREG_UUID_RE = re.compile(r'"IOPlatformUUID"\s*=\s*"([^"]+)"')
_IOREG_SERIAL_RE = re.compile(r'"IOPlatformSerialNumber"\s*=\s*"([^"]+)"')
_VOLUME_UUID_RE = re.compile(r"<key>VolumeUUID</key>\s*<string>([^<]+)</string>")
_REG_GUID_RE = re.compile(r"MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)")
_VOL_SERIAL_RE = re.compile(r"Volume Serial Number is ([A-Za-z0-9-]+)")


def _sha256_b64url(value: str, length: int) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return b64url_encode(digest)[:length]


def _run(*args: str) -> Optional[str]:
    """Run a command, returning ``None`` on any failure."""
    try:
        out = subprocess.run(
            list(args), capture_output=True, text=True, check=True, timeout=2
        ).stdout
        return out or None
    except Exception:
        return None


def _read(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def _match(text: Optional[str], pattern: "re.Pattern[str]") -> Optional[str]:
    if not text:
        return None
    m = pattern.search(text)
    return m.group(1).strip() if m else None


def _total_memory_bytes() -> Optional[int]:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        pass
    # sysconf is POSIX-only; Windows needs the Win32 call.
    try:
        import ctypes

        class _MemoryStatusEx(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = _MemoryStatusEx()
        status.dwLength = ctypes.sizeof(_MemoryStatusEx)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))  # type: ignore[attr-defined]
        return int(status.ullTotalPhys) or None
    except Exception:
        return None


def _ram_bucket() -> Optional[str]:
    """Total RAM rounded down to a power of two in GiB.

    Identical to the Node SDK's ``2 ** floor(log2(gib))`` so a BIOS/OS reporting 15.9 vs 16.0
    GiB never reads as a hardware change, and both SDKs bucket the same machine the same way.
    """
    total = _total_memory_bytes()
    if not total:
        return None
    gib = total / (1024**3)
    if gib < 1:
        return None
    return str(2 ** math.floor(math.log2(gib)))


def _cpu_model() -> Optional[str]:
    """CPU brand plus logical core count — one component, since they change together."""
    cores = os.cpu_count()
    brand: Optional[str] = None
    if sys.platform == "darwin":
        brand = (_run("sysctl", "-n", "machdep.cpu.brand_string") or "").strip() or None
    elif sys.platform == "win32":
        brand = os.environ.get("PROCESSOR_IDENTIFIER") or None
    else:
        cpuinfo = _read("/proc/cpuinfo")
        brand = _match(cpuinfo, re.compile(r"model name\s*:\s*(.+)"))
    if not brand or not cores:
        return None
    return f"{brand}:{cores}"


def _primary_mac() -> Optional[str]:
    """The host's MAC via ``uuid.getnode()``, in the same colon form the other SDKs use.

    Parity caveat: the Node SDK enumerates interfaces and takes the lowest MAC, while the
    stdlib gives Python no portable interface enumeration — ``getnode()`` returns *a* host
    MAC. On a single-NIC machine both pick the same value; on a multi-NIC machine they may
    differ, which shows up as exactly one differing component and is absorbed by the default
    drift tolerance of two.
    """
    node = uuid.getnode()
    # getnode() sets the multicast bit when it had to invent a random value — that is not a
    # stable hardware signal, so omit the component entirely rather than report noise.
    if (node >> 40) & 0x01:
        return None
    raw = f"{node:012x}"
    return ":".join(raw[i : i + 2] for i in range(0, 12, 2))


def _darwin_components() -> Dict[str, str]:
    ioreg = _run("ioreg", "-rd1", "-c", "IOPlatformExpertDevice")
    return _present(
        machineUuid=_match(ioreg, _IOREG_UUID_RE),
        boardSerial=_match(ioreg, _IOREG_SERIAL_RE),
        bootVolumeUuid=_match(_run("diskutil", "info", "-plist", "/"), _VOLUME_UUID_RE),
        machineModel=(_run("sysctl", "-n", "hw.model") or "").strip() or None,
    )


def _win32_components() -> Dict[str, str]:
    machine_uuid: Optional[str] = None
    try:
        import winreg  # type: ignore

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography"
        ) as k:
            machine_uuid = str(winreg.QueryValueEx(k, "MachineGuid")[0]) or None
    except Exception:
        machine_uuid = _match(
            _run("reg", "query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"),
            _REG_GUID_RE,
        )
    return _present(
        machineUuid=machine_uuid,
        boardSerial=_csv_value(_run("wmic", "baseboard", "get", "serialnumber", "/format:csv")),
        bootVolumeUuid=_match(_run("cmd", "/c", "vol", "C:"), _VOL_SERIAL_RE),
        machineModel=_csv_value(_run("wmic", "computersystem", "get", "model", "/format:csv")),
    )


def _csv_value(out: Optional[str]) -> Optional[str]:
    """``wmic ... /format:csv`` emits a blank line, a header row, then ``Node,<value>``."""
    if not out:
        return None
    rows = [line.strip() for line in out.splitlines() if line.strip()]
    if not rows or "," not in rows[-1]:
        return None
    return rows[-1].split(",", 1)[1].strip() or None


def _linux_components() -> Dict[str, str]:
    return _present(
        # product_uuid is genuinely hardware-scoped; machine-id is per OS INSTALL and changes
        # on a container/VM clone, so it is only the fallback.
        machineUuid=_read("/sys/class/dmi/id/product_uuid")
        or _read("/etc/machine-id")
        or _read("/var/lib/dbus/machine-id"),
        boardSerial=_read("/sys/class/dmi/id/board_serial"),
        bootVolumeUuid=(_run("findmnt", "-no", "UUID", "/") or "").strip() or None,
        machineModel=_read("/sys/class/dmi/id/product_name"),
    )


def _present(**kwargs: Optional[str]) -> Dict[str, str]:
    """Keep only components that actually read — the omission rule, in one place."""
    return {k: v for k, v in kwargs.items() if v}


def raw_components() -> Dict[str, str]:
    """Read the platform-specific raw component values."""
    if sys.platform == "darwin":
        platform_specific = _darwin_components()
    elif sys.platform == "win32":
        platform_specific = _win32_components()
    else:
        platform_specific = _linux_components()
    return {
        **platform_specific,
        **_present(
            cpuModel=_cpu_model(),
            primaryMac=_primary_mac(),
            ramBucket=_ram_bucket(),
        ),
    }


def hash_components(product_slug: str, raw: Dict[str, str]) -> Dict[str, object]:
    """Hash raw component values into the wire form. Pure — the conformance-tested unit."""
    components: Dict[str, str] = {}
    parts = []
    for component in COMPONENT_ORDER:
        value = raw.get(component)
        if value is None:
            continue
        digest = _sha256_b64url(
            f"{_HASH_PREFIX}:{product_slug}:{component}:{value}", _COMPONENT_LENGTH
        )
        components[component] = digest
        parts.append(f"{component}={digest}")
    return {
        "components": components,
        "hwid": _sha256_b64url("\n".join(parts), _HWID_LENGTH),
    }


def collect_fingerprint(product_slug: str) -> Optional[Dict[str, object]]:
    """Collect and hash this machine's fingerprint, or ``None`` if nothing could be read."""
    raw = raw_components()
    if not raw:
        return None
    return hash_components(product_slug, raw)
