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
import json
import ntpath
import os
import re
import subprocess
import sys
import uuid
from typing import Callable, Dict, Mapping, NamedTuple, Optional, Sequence, Tuple

from ..core.b64url import b64url_encode

__all__ = [
    "COMPONENT_ORDER",
    "LINUX_ANCHOR_PATHS",
    "WINDOWS_CIM_COMMAND",
    "AnchorSource",
    "FingerprintIO",
    "WindowsCimCommand",
    "collect_fingerprint",
    "hash_components",
    "linux_anchor_source",
    "parse_windows_cim",
    "ram_bucket",
    "raw_components",
    "read_linux_anchor",
    "trim_ascii_whitespace",
    "windows_powershell_path",
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


# ── The pure derivation rules (WIRE-CONTRACT-V3 §6.1), pinned by fingerprint.json ──────────


class WindowsCimCommand(NamedTuple):
    """The pinned Windows CIM call (``fingerprint.json``'s ``windowsCimCommand``)."""

    program: str
    args: Tuple[str, ...]
    #: ``"null"``: the child's stdin is the null device, never the caller's.
    stdin: str
    timeout_ms: int


#: Rule 1's one PowerShell call. One line with no double quotes, so Windows argument quoting
#: cannot mangle it, and pure-ASCII output, so neither a console code page nor a missing
#: console can corrupt a value. stdin is the null device, because Windows PowerShell 5.1 reads
#: a redirected stdin as pipeline input and would otherwise wait out the timeout under a
#: parent whose stdin is an open pipe.
WINDOWS_CIM_COMMAND = WindowsCimCommand(
    program="powershell.exe",
    args=(
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop';$b=$null;$m=$null;"
        "try{$b=@(Get-CimInstance -ClassName Win32_BaseBoard -Property SerialNumber)[-1].SerialNumber}catch{};"
        "try{$m=@(Get-CimInstance -ClassName Win32_ComputerSystem -Property Model)[-1].Model}catch{};"
        "$j=ConvertTo-Json -Compress -InputObject @{boardSerial=$b;machineModel=$m};"
        "$o='';foreach($c in $j.ToCharArray()){$n=[int]$c;if($n -gt 126){$o+='\\u'+$n.ToString('x4')}else{$o+=$c}};$o",
    ),
    stdin="null",
    timeout_ms=10_000,
)

#: Rules 1 and 2 trim exactly U+0009–U+000D and U+0020. ``str.strip()`` would also drop
#: U+001F and U+00A0, which the corpus pins as kept.
_ASCII_WHITESPACE = "\t\n\x0b\x0c\r "


def trim_ascii_whitespace(value: str) -> str:
    return value.strip(_ASCII_WHITESPACE)


def parse_windows_cim(stdout: Optional[str]) -> Dict[str, str]:
    """Rule 1: parse what :data:`WINDOWS_CIM_COMMAND` printed.

    Strips one leading U+FEFF, requires a JSON object, and keeps ``boardSerial`` /
    ``machineModel`` only when each is a string that is non-empty after trimming ASCII
    whitespace. Vendor placeholders are kept verbatim (what the retired WMI command-line tool
    returned, so Windows 10 sees no drift); other keys are ignored; anything else yields
    ``{}``.
    """
    if not stdout:
        return {}
    text = stdout[1:] if stdout.startswith("\ufeff") else stdout
    try:
        parsed = json.loads(text)
    except ValueError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    out: Dict[str, str] = {}
    for key in ("boardSerial", "machineModel"):
        value = parsed.get(key)
        if not isinstance(value, str):
            continue
        trimmed = trim_ascii_whitespace(value)
        if trimmed:
            out[key] = trimmed
    return out


#: Rule 2's sources, in order. No DMI file is ever read: ``product_uuid`` and
#: ``board_serial`` are root-only, so reading them made the fingerprint privilege-dependent.
LINUX_ANCHOR_PATHS = ("/etc/machine-id", "/var/lib/dbus/machine-id")


class AnchorSource(NamedTuple):
    source: str
    value: str


def linux_anchor_source(files: Mapping[str, Optional[str]]) -> Optional[AnchorSource]:
    """Rule 2: the first of ``/etc/machine-id`` and ``/var/lib/dbus/machine-id`` whose
    content, trimmed of ASCII whitespace, is non-empty and not ``uninitialized``.

    ``files`` maps each READABLE path to its raw content; an absent (or ``None``) path is
    unreadable. ``None`` means the host has no anchor. The same value is the Linux device
    id's raw input.
    """
    for source in LINUX_ANCHOR_PATHS:
        content = files.get(source)
        if not isinstance(content, str):
            continue
        value = trim_ascii_whitespace(content)
        if value and value != "uninitialized":
            return AnchorSource(source, value)
    return None


def ram_bucket(total_bytes: int) -> Optional[str]:
    """Rule 3: ``g = floor(bytes / 2**30)``; ``None`` when ``g == 0``, otherwise the largest
    power of two not above ``g``, in decimal. Integer arithmetic, dividing BEFORE any
    logarithm (a float ``log2`` rounds a total just below a power of two up from 1 PiB).

    What the bucket buys is stability while the reported total stays between two powers of
    two (a 16 GB machine reporting 15.4 GiB buckets to 8, and keeps doing so).
    """
    g = int(total_bytes) >> 30
    if g <= 0:
        return None
    return str(1 << (g.bit_length() - 1))


# ── The platform reads ─────────────────────────────────────────────────────────────────


#: Run a command (argv, timeout in seconds) → stdout or ``None``.
RunFn = Callable[[Sequence[str], float], Optional[str]]
#: Read a file → raw content or ``None`` when unreadable.
ReadFn = Callable[[str], Optional[str]]


class FingerprintIO(NamedTuple):
    """The two side effects a reader performs, injectable so tests can drive any OS's
    branch on any host."""

    run: RunFn
    read: ReadFn


def _run(args: Sequence[str], timeout: float = 2.0) -> Optional[str]:
    """Run a command, returning ``None`` on any failure.

    stdin is the null device on every platform (the child must never inherit the caller's
    stdin: PowerShell would wait on an open pipe), and on Windows no console window is
    created (a ``pythonw`` app would otherwise flash one per call). Output is captured as
    bytes and decoded as UTF-8 with replacement.
    """
    kwargs: Dict[str, object] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    try:
        out = subprocess.run(
            list(args),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=timeout,
            **kwargs,  # type: ignore[arg-type]
        ).stdout
        return out.decode("utf-8", errors="replace") or None
    except Exception:
        return None


def _read(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


DEFAULT_IO = FingerprintIO(run=_run, read=_read)


def _read_trimmed(io: FingerprintIO, path: str) -> Optional[str]:
    content = io.read(path)
    return (trim_ascii_whitespace(content) or None) if content is not None else None


def windows_powershell_path(env: Optional[Mapping[str, str]] = None) -> str:
    """``%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`` when
    ``SystemRoot`` is an absolute path, else the bare name."""
    env = os.environ if env is None else env
    root = env.get("SystemRoot") or env.get("SYSTEMROOT")
    if root and re.match(r"^(?:[A-Za-z]:[\\/]|\\\\)", root):
        return ntpath.join(
            root, "System32", "WindowsPowerShell", "v1.0", WINDOWS_CIM_COMMAND.program
        )
    return WINDOWS_CIM_COMMAND.program


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
    """This machine's bucket, or ``None`` when RAM cannot be determined (the component is
    then omitted without calling the rule)."""
    total = _total_memory_bytes()
    if not total:
        return None
    return ram_bucket(total)


def _cpu_model() -> Optional[str]:
    """CPU brand plus logical core count — one component, since they change together."""
    cores = os.cpu_count()
    brand: Optional[str] = None
    if sys.platform == "darwin":
        brand = (_run(["sysctl", "-n", "machdep.cpu.brand_string"]) or "").strip() or None
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


#: Anchor probes run by absolute path, never through ``PATH``: a planted ``ioreg`` or
#: ``reg`` earlier on ``PATH`` would otherwise choose the device's identity.
IOREG_PATH = "/usr/sbin/ioreg"


def reg_exe_path() -> str:
    root = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
    return root.rstrip("\\/") + r"\System32\reg.exe"


def _darwin_components(io: FingerprintIO) -> Dict[str, str]:
    ioreg = io.run([IOREG_PATH, "-rd1", "-c", "IOPlatformExpertDevice"], 2.0)
    return _present(
        machineUuid=_match(ioreg, _IOREG_UUID_RE),
        boardSerial=_match(ioreg, _IOREG_SERIAL_RE),
        bootVolumeUuid=_match(io.run(["diskutil", "info", "-plist", "/"], 2.0), _VOLUME_UUID_RE),
        machineModel=(io.run(["sysctl", "-n", "hw.model"], 2.0) or "").strip() or None,
    )


def _registry_machine_guid(io: FingerprintIO) -> Optional[str]:
    try:
        import winreg  # type: ignore

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography"
        ) as k:
            return str(winreg.QueryValueEx(k, "MachineGuid")[0]) or None
    except Exception:
        return _match(
            io.run([reg_exe_path(), "query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"], 2.0),
            _REG_GUID_RE,
        )


def _win32_components(io: FingerprintIO, env: Optional[Mapping[str, str]]) -> Dict[str, str]:
    cim = parse_windows_cim(
        io.run(
            [windows_powershell_path(env), *WINDOWS_CIM_COMMAND.args],
            WINDOWS_CIM_COMMAND.timeout_ms / 1000,
        )
    )
    return _present(
        machineUuid=_registry_machine_guid(io),
        boardSerial=cim.get("boardSerial"),
        bootVolumeUuid=_match(io.run(["cmd", "/c", "vol", "C:"], 2.0), _VOL_SERIAL_RE),
        machineModel=cim.get("machineModel"),
    )


def read_linux_anchor(io: Optional[FingerprintIO] = None) -> Optional[AnchorSource]:
    """Read only rule 2's two files and hand their raw contents to
    :func:`linux_anchor_source`."""
    io = io or DEFAULT_IO
    return linux_anchor_source({path: io.read(path) for path in LINUX_ANCHOR_PATHS})


def _linux_components(io: FingerprintIO) -> Dict[str, str]:
    anchor = read_linux_anchor(io)
    return _present(
        # Rule 2: machine-id only, never product_uuid or board_serial, so root and non-root
        # agree. A host with neither file (most container images) has no anchor.
        machineUuid=anchor.value if anchor else None,
        bootVolumeUuid=(io.run(["findmnt", "-no", "UUID", "/"], 2.0) or "").strip() or None,
        machineModel=_read_trimmed(io, "/sys/class/dmi/id/product_name"),
    )


def _present(**kwargs: Optional[str]) -> Dict[str, str]:
    """Keep only components that actually read — the omission rule, in one place."""
    return {k: v for k, v in kwargs.items() if v}


def raw_components(
    *,
    platform: Optional[str] = None,
    io: Optional[FingerprintIO] = None,
    env: Optional[Mapping[str, str]] = None,
    total_bytes: Optional[int] = None,
) -> Dict[str, str]:
    """Read the platform-specific raw component values.

    Every argument is a test seam: ``platform`` (default ``sys.platform``) picks the OS
    branch, ``io`` replaces the command runner and file reader, ``env`` the environment used
    to resolve PowerShell, and ``total_bytes`` the RAM total.
    """
    platform = platform or sys.platform
    io = io or DEFAULT_IO
    if platform == "darwin":
        platform_specific = _darwin_components(io)
    elif platform == "win32":
        platform_specific = _win32_components(io, env)
    else:
        platform_specific = _linux_components(io)
    return {
        **platform_specific,
        **_present(
            cpuModel=_cpu_model(),
            primaryMac=_primary_mac(),
            ramBucket=ram_bucket(total_bytes) if total_bytes is not None else _ram_bucket(),
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
