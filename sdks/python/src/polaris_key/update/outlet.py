"""The Python runtime's outlet signals (plans/P3-01.md §2.9, §4.7; notes/S-06 §§2–9; E9 §1.2).

Pure Python: the environment, the executable and script path conventions (``sys.executable``,
never ``sys._MEIPASS``), a few product-named files, and ``GetCurrentPackageFamilyName`` through
``ctypes`` on Windows. No native extension, no child process.

The MAPPING is ``polaris_key.core.detection.detect_outlet``, shared with every SDK and pinned by
``outlet-matrix.json``. This module only READS, and reads only markers: it never enumerates
installed applications (AGENTS rule 7). A launcher's file is read only when the product's own
identity names it (``appmanifest_<steamAppId>.acf``, ``Caskroom/<caskToken>/``).

==========================  ================================================================
signal                      read from
==========================  ================================================================
macos.masReceipt            ``<bundle>/Contents/_MASReceipt/receipt`` (a frozen ``.app`` only)
macos.receiptSandbox        that receipt holds the ASCII ``ProductionSandbox`` (TestFlight)
macos.homebrewCask          ``<prefix>/Caskroom/<caskToken>/<version>/<App>.app`` links here
macos.homebrewFormula       the app's (or the environment's) realpath is under ``Cellar/<f>/``
windows.packageIdentity     ``GetCurrentPackageFamilyName`` (kernel32, through ctypes)
windows.pathConvention      the app is under WinGet/Packages, scoop/apps or chocolatey/lib
linux.flatpakInfo           ``/.flatpak-info``'s ``[Application] name``
linux.snapEnv               ``SNAP_NAME``, ``SNAP_REVISION``
linux.appImageEnv           ``APPIMAGE``, ``APPDIR`` and the executable path
steam.libraryManifest       ``<library>/steamapps/appmanifest_<steamAppId>.acf`` names this install
steam.appIdEnv              ``SteamAppId``, ``SteamClientLaunch``
itch.receipt                the nearest ``.itch/receipt.json.gz`` above the app: ``game.id``
itch.appEnv                 ``ITCHIO_APP=1`` (diagnostic only)
==========================  ================================================================

PEP 376's ``INSTALLER`` (``pip``, ``uv``, ``conda``) is not read: it names no outlet kind or
subkind in the v4 vocabulary, so it could only be a new signal, which is a corpus change.
``steam_appid.txt`` is not read (S-06 refuted it). Windows' ``SignatureKind``, App Installer URI
and external location need WinRT and are absent, so a packaged install keeps its stamp.
"""

from __future__ import annotations

import gzip
import json
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional

__all__ = [
    "OutletFs",
    "OutletReaderEnvironment",
    "process_outlet_environment",
    "read_outlet_signals",
]


@dataclass
class OutletFs:
    """The file-system calls the readers make, so a test can fake a whole install."""

    exists: Callable[[str], bool] = os.path.exists
    read_bytes: Callable[[str], bytes] = lambda p: open(p, "rb").read()  # noqa: E731
    realpath: Callable[[str], str] = os.path.realpath
    listdir: Callable[[str], List[str]] = os.listdir
    is_symlink: Callable[[str], bool] = os.path.islink
    readlink: Callable[[str], str] = os.readlink


def _package_family_name() -> Optional[str]:
    """``GetCurrentPackageFamilyName`` (Windows 8+): this process's MSIX family name, or None
    when it runs without package identity (``APPMODEL_ERROR_NO_PACKAGE``)."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        fn = ctypes.windll.kernel32.GetCurrentPackageFamilyName  # type: ignore[attr-defined]
        fn.argtypes = [ctypes.POINTER(wintypes.UINT), wintypes.LPWSTR]
        fn.restype = wintypes.LONG
        length = wintypes.UINT(0)
        rc = fn(ctypes.byref(length), None)
        if rc != 122 or length.value == 0:  # ERROR_INSUFFICIENT_BUFFER means "has identity"
            return None
        buf = ctypes.create_unicode_buffer(length.value)
        if fn(ctypes.byref(length), buf) != 0:
            return None
        return buf.value or None
    except Exception:
        return None


@dataclass
class OutletReaderEnvironment:
    """What the readers look at. ``process_outlet_environment()`` is this process's."""

    env: Mapping[str, str] = field(default_factory=dict)
    #: ``sys.platform``: ``darwin``, ``win32``, ``linux``.
    platform: str = ""
    #: ``sys.executable``: the interpreter, or a frozen app's executable.
    executable: str = ""
    #: ``sys.argv[0]``: the script a plain interpreter runs.
    script: Optional[str] = None
    #: ``sys.prefix``: a Homebrew formula's virtualenv lives in its Cellar.
    prefix: Optional[str] = None
    #: ``sys.frozen``: PyInstaller, Nuitka, py2app.
    frozen: bool = False
    fs: OutletFs = field(default_factory=OutletFs)
    #: The MSIX family name reader (ctypes on Windows).
    package_family_name: Callable[[], Optional[str]] = lambda: None


def process_outlet_environment() -> OutletReaderEnvironment:
    """This process's environment for the readers."""
    return OutletReaderEnvironment(
        env=dict(os.environ),
        platform=sys.platform,
        executable=sys.executable or "",
        script=sys.argv[0] if sys.argv and sys.argv[0] else None,
        prefix=sys.prefix,
        frozen=bool(getattr(sys, "frozen", False)),
        fs=OutletFs(),
        package_family_name=_package_family_name,
    )


def _slashed(p: str) -> str:
    return p.replace("\\", "/")


def _safe(f: Callable[[], Any], fallback: Any) -> Any:
    try:
        return f()
    except Exception:
        return fallback


def _app_bundle(executable: str) -> Optional[str]:
    m = re.match(r"^(.*?\.app)/Contents/MacOS/", _slashed(executable))
    return m.group(1) if m else None


def _acf_value(text: str, key: str) -> Optional[str]:
    m = re.search(r'"%s"\s+"([^"]*)"' % re.escape(key), text, re.IGNORECASE)
    return m.group(1) if m else None


def _flatpak_app_name(text: str) -> Optional[str]:
    section = ""
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            section = line
        elif section == "[Application]" and line.startswith("name="):
            return line[len("name=") :].strip() or None
    return None


def _decimal_id(v: Any) -> Optional[str]:
    """An integer ``game.id`` (a JSON number) as a decimal string."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int) and v >= 0:
        return str(v)
    if isinstance(v, float) and v.is_integer() and 0 <= v <= 2**53 - 1:
        return str(int(v))
    if isinstance(v, str) and re.fullmatch(r"[0-9]+", v):
        return v
    return None


def read_outlet_signals(
    env: Optional[OutletReaderEnvironment] = None,
    *,
    outlet_ids: Optional[Mapping[str, str]] = None,
) -> Dict[str, Any]:
    """Read this runtime's outlet signals. Every reader is independent and silent: one that
    cannot read its marker records nothing. Never raises. ``outlet_ids`` (the stamp's) says
    which launcher files to read. Pass the result, with the stamp, to ``detect_outlet``."""
    e = env if env is not None else process_outlet_environment()
    fs = e.fs
    ids: Mapping[str, str] = outlet_ids or {}
    signals: Dict[str, Any] = {}

    app = e.executable if e.frozen or not e.script else e.script
    app_real = _safe(lambda: fs.realpath(app), app) if app else ""

    # ── macOS ───────────────────────────────────────────────────────────────────────────────
    if e.platform == "darwin":
        bundle = _app_bundle(e.executable)
        if bundle is not None:
            receipt = f"{bundle}/Contents/_MASReceipt/receipt"
            exists = bool(_safe(lambda: fs.exists(receipt), False))
            signals["macos.masReceipt"] = exists
            if exists:
                signals["macos.receiptSandbox"] = bool(
                    _safe(lambda: b"ProductionSandbox" in fs.read_bytes(receipt), False)
                )
            token = ids.get("caskToken")
            if isinstance(token, str) and re.fullmatch(r"[a-z0-9][a-z0-9@._+-]*", token):
                for prefix in ("/opt/homebrew", "/usr/local"):
                    root = f"{prefix}/Caskroom/{token}"

                    def linked(root: str = root, bundle: str = bundle) -> bool:
                        for version in fs.listdir(root):
                            for entry in _safe(lambda v=version: fs.listdir(f"{root}/{v}"), []):
                                p = f"{root}/{version}/{entry}"
                                if (
                                    entry.endswith(".app")
                                    and fs.is_symlink(p)
                                    and (
                                        fs.readlink(p) == bundle
                                        or _safe(lambda p=p: fs.realpath(p), "") == bundle
                                    )
                                ):
                                    return True
                        return False

                    if _safe(linked, False):
                        signals["macos.homebrewCask"] = token
                        break
        formulas: List[str] = []
        for path in (app_real, _safe(lambda: fs.realpath(e.prefix or ""), "")):
            m = re.search(r"/Cellar/([^/]+)/", _slashed(path or ""))
            if m:
                formulas.append(m.group(1))
        if formulas:
            want = ids.get("homebrewFormula")
            signals["macos.homebrewFormula"] = want if want in formulas else formulas[0]

    # ── Windows ─────────────────────────────────────────────────────────────────────────────
    if e.platform == "win32":
        family = _safe(e.package_family_name, None)
        if isinstance(family, str) and family:
            signals["windows.packageIdentity"] = family
        p = _slashed(app).lower()
        if "/microsoft/winget/packages/" in p:
            signals["windows.pathConvention"] = "winget"
        elif "/scoop/apps/" in p:
            signals["windows.pathConvention"] = "scoop"
        elif "/chocolatey/lib/" in p:
            signals["windows.pathConvention"] = "chocolatey"

    # ── Linux ───────────────────────────────────────────────────────────────────────────────
    if e.platform.startswith("linux"):
        name = _safe(
            lambda: _flatpak_app_name(fs.read_bytes("/.flatpak-info").decode("utf-8"))
            if fs.exists("/.flatpak-info")
            else None,
            None,
        )
        if name is not None:
            signals["linux.flatpakInfo"] = name
        if e.env.get("SNAP_NAME"):
            signals["linux.snapEnv"] = {
                "name": e.env["SNAP_NAME"],
                "revision": e.env.get("SNAP_REVISION"),
            }
        if e.env.get("APPIMAGE") and e.env.get("APPDIR"):
            signals["linux.appImageEnv"] = {
                "appImage": e.env["APPIMAGE"],
                "appDir": e.env["APPDIR"],
                "exePath": e.executable,
            }

    # ── Steam and itch (any desktop) ────────────────────────────────────────────────────────
    steam_id = ids.get("steamAppId")
    if isinstance(steam_id, str) and re.fullmatch(r"[0-9]+", steam_id):
        m = re.match(r"^(.*)/steamapps/common/([^/]+)/", _slashed(app_real), re.IGNORECASE)
        if m:
            manifest = f"{m.group(1)}/steamapps/appmanifest_{steam_id}.acf"
            text = _safe(lambda: fs.read_bytes(manifest).decode("utf-8"), None)
            if text is not None:
                appid = _acf_value(text, "appid")
                installdir = _acf_value(text, "installdir")
                if appid is not None and (installdir or "").lower() == m.group(2).lower():
                    signals["steam.libraryManifest"] = appid
    if e.env.get("SteamAppId"):
        signals["steam.appIdEnv"] = {
            "appId": e.env["SteamAppId"],
            "clientLaunch": e.env.get("SteamClientLaunch") == "1",
        }
    d = os.path.dirname(_slashed(app_real)) if app_real else ""
    for _ in range(12):
        if not d:
            break
        receipt = f"{d}/.itch/receipt.json.gz"
        if _safe(lambda r=receipt: fs.exists(r), False):

            def game_id(r: str = receipt) -> Optional[str]:
                doc = json.loads(gzip.decompress(fs.read_bytes(r)).decode("utf-8"))
                game = doc.get("game") if isinstance(doc, dict) else None
                return _decimal_id(game.get("id")) if isinstance(game, dict) else None

            gid = _safe(game_id, None)
            if gid is not None:
                signals["itch.receipt"] = gid
            break
        up = os.path.dirname(d)
        if up == d:
            break
        d = up
    if e.env.get("ITCHIO_APP") == "1":
        signals["itch.appEnv"] = True
    return signals
