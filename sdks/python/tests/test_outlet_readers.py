# @pkey-feature outlet.detect
"""The Python runtime's outlet readers over faked installs, and the update client's wiring.

The mapping is ``detect_outlet``, run row for row over ``outlet-matrix.json`` in
``test_outlet_matrix.py``. This file proves the READERS (``read_outlet_signals``, for every outlet
a Python process can see) and the WIRING: with no host outlet the update client detects
in-process and ``decide()`` uses the result; a host value always wins.
"""

from __future__ import annotations

import gzip
import json
from typing import Any, Dict, Mapping, Optional

import pytest

from polaris_key.core.errors import PolarisError
from polaris_key.update import (
    OutletFs,
    OutletReaderEnvironment,
    detect_outlet,
    detection_stamp,
    read_outlet_signals,
)
from test_release_update import Worker, options, seeded, v4_client

IDS = {
    "steamAppId": "3166810",
    "itchGameId": "1001",
    "flatpakId": "gg.vlad.Diceroll",
    "snapName": "diceroll",
    "caskToken": "diceroll",
    "homebrewFormula": "diceroll",
    "msixFamilyName": "Diceroll_abc123",
    "bundleId": "gg.vlad.diceroll",
}
STAMP = {"outlet": "direct", "outletKind": "direct", "outletIds": IDS}


def fake_fs(
    files: Optional[Mapping[str, bytes]] = None,
    links: Optional[Mapping[str, str]] = None,
    real: Optional[Mapping[str, str]] = None,
) -> OutletFs:
    files = dict(files or {})
    links = dict(links or {})
    real = dict(real or {})
    paths = list(files) + list(links)
    dirs = set()
    for p in paths:
        d = p.rsplit("/", 1)[0]
        while d:
            dirs.add(d)
            d = d.rsplit("/", 1)[0] if "/" in d else ""

    def read_bytes(p: str) -> bytes:
        if p not in files:
            raise FileNotFoundError(p)
        return files[p]

    def listdir(p: str) -> list:
        if p not in dirs:
            raise NotADirectoryError(p)
        return sorted({q[len(p) + 1 :].split("/")[0] for q in [*paths, *dirs] if q.startswith(p + "/")})

    def readlink(p: str) -> str:
        if p not in links:
            raise OSError(p)
        return links[p]

    return OutletFs(
        exists=lambda p: p in files or p in links or p in dirs,
        read_bytes=read_bytes,
        realpath=lambda p: real.get(p, links.get(p, p)),
        listdir=listdir,
        is_symlink=lambda p: p in links,
        readlink=readlink,
    )


def env(**kw: Any) -> OutletReaderEnvironment:
    kw.setdefault("fs", fake_fs())
    return OutletReaderEnvironment(**kw)


def read(e: OutletReaderEnvironment, ids: Mapping[str, str] = IDS) -> Dict[str, Any]:
    return read_outlet_signals(e, outlet_ids=ids)


def detect(e: OutletReaderEnvironment, stamp: Any = STAMP) -> Dict[str, Any]:
    st = detection_stamp(stamp)
    return detect_outlet(stamp=st, signals=read(e, st["outletIds"] if st else {}))


MAC_APP = "/Applications/Diceroll.app/Contents/MacOS/Diceroll"
RECEIPT = "/Applications/Diceroll.app/Contents/_MASReceipt/receipt"


# ── macOS ───────────────────────────────────────────────────────────────────────────────────


def test_a_frozen_app_store_bundle_reads_its_receipt() -> None:
    e = env(platform="darwin", executable=MAC_APP, frozen=True, fs=fake_fs({RECEIPT: b"r"}))
    assert read(e) == {"macos.masReceipt": True, "macos.receiptSandbox": False}
    assert detect(e) == {
        "kind": "app-store",
        "confidence": "attested",
        "source": "macos.masReceipt",
        "subkind": None,
    }
    tf = env(
        platform="darwin", executable=MAC_APP, frozen=True,
        fs=fake_fs({RECEIPT: b"..ProductionSandbox.."}),
    )
    assert detect(tf, None)["kind"] == "testflight"
    assert read(env(platform="darwin", executable=MAC_APP, frozen=True)) == {
        "macos.masReceipt": False
    }


def test_the_products_caskroom_link_restricts_to_homebrew() -> None:
    fs = fake_fs(links={"/opt/homebrew/Caskroom/diceroll/1.4.0/Diceroll.app": "/Applications/Diceroll.app"})
    e = env(platform="darwin", executable=MAC_APP, frozen=True, fs=fs)
    assert read(e)["macos.homebrewCask"] == "diceroll"
    assert detect(e) == {
        "kind": "direct",
        "confidence": "heuristic",
        "source": "macos.homebrewCask",
        "subkind": "homebrew",
    }
    assert "macos.homebrewCask" not in read(e, {"caskToken": "other"})


def test_a_formula_virtualenv_in_the_cellar_names_the_formula() -> None:
    fs = fake_fs(real={
        "/opt/homebrew/bin/diceroll": "/opt/homebrew/Cellar/diceroll/1.4.0/libexec/bin/diceroll",
        "/opt/homebrew/Cellar/diceroll/1.4.0/libexec": "/opt/homebrew/Cellar/diceroll/1.4.0/libexec",
    })
    e = env(
        platform="darwin",
        executable="/opt/homebrew/Cellar/diceroll/1.4.0/libexec/bin/python",
        script="/opt/homebrew/bin/diceroll",
        prefix="/opt/homebrew/Cellar/diceroll/1.4.0/libexec",
        fs=fs,
    )
    assert read(e)["macos.homebrewFormula"] == "diceroll"
    assert detect(e)["subkind"] == "homebrew"
    # The interpreter's own formula is found too, but the product's is preferred.
    other = env(
        platform="darwin",
        executable="/x/python",
        script="/opt/homebrew/Cellar/python@3.12/3.12.1/bin/tool",
        prefix="/opt/homebrew/Cellar/diceroll/1.4.0/libexec",
        fs=fake_fs(),
    )
    assert read(other)["macos.homebrewFormula"] == "diceroll"


# ── Windows ─────────────────────────────────────────────────────────────────────────────────


def test_package_identity_from_ctypes_gates_and_keeps_the_stamp() -> None:
    e = env(platform="win32", executable="C:\\app\\diceroll.exe", frozen=True,
            package_family_name=lambda: "Diceroll_abc123")
    assert read(e) == {"windows.packageIdentity": "Diceroll_abc123"}
    assert detect(e) == {"kind": "direct", "confidence": "stamp", "source": "stamp", "subkind": None}
    assert read(env(platform="win32", executable="C:\\a.exe", frozen=True)) == {}


@pytest.mark.parametrize(
    "path,value,kind,subkind",
    [
        ("C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\D\\d.exe", "winget", "winget", None),
        ("C:\\Users\\a\\scoop\\apps\\diceroll\\current\\d.exe", "scoop", "direct", "scoop"),
        ("C:\\ProgramData\\chocolatey\\lib\\diceroll\\tools\\d.exe", "chocolatey", "direct", "chocolatey"),
    ],
)
def test_windows_path_conventions(path: str, value: str, kind: str, subkind: Optional[str]) -> None:
    e = env(platform="win32", executable=path, frozen=True)
    assert read(e) == {"windows.pathConvention": value}
    got = detect(e)
    assert (got["kind"], got["subkind"], got["source"]) == (kind, subkind, "windows.pathConvention")


# ── Linux ───────────────────────────────────────────────────────────────────────────────────


def test_flatpak_info_with_this_id_names_flathub() -> None:
    fs = fake_fs({"/.flatpak-info": b"[Application]\nname=gg.vlad.Diceroll\n[Instance]\nbranch=master\n"})
    e = env(platform="linux", executable="/app/bin/diceroll", frozen=True, fs=fs)
    assert read(e) == {"linux.flatpakInfo": "gg.vlad.Diceroll"}
    assert detect(e)["kind"] == "flathub"


def test_snap_env_restricts_and_a_local_revision_vetoes() -> None:
    e = env(platform="linux", env={"SNAP_NAME": "diceroll", "SNAP_REVISION": "42"})
    assert read(e) == {"linux.snapEnv": {"name": "diceroll", "revision": "42"}}
    assert detect(e)["kind"] == "snap"
    local = env(platform="linux", env={"SNAP_NAME": "diceroll", "SNAP_REVISION": "x1"})
    assert detect(local, {"outlet": "snap", "outletIds": IDS})["kind"] == "unknown"


def test_appimage_env_around_the_executable() -> None:
    e = env(
        platform="linux",
        executable="/tmp/.mount_DicerX1/usr/bin/diceroll",
        frozen=True,
        env={"APPIMAGE": "/home/a/Diceroll.AppImage", "APPDIR": "/tmp/.mount_DicerX1"},
    )
    assert read(e)["linux.appImageEnv"]["exePath"] == "/tmp/.mount_DicerX1/usr/bin/diceroll"
    assert (detect(e)["kind"], detect(e)["subkind"]) == ("direct", "appimage")


# ── Steam and itch ──────────────────────────────────────────────────────────────────────────

LIB = "/home/a/.steam/steam"
ACF = b'"AppState"\n{\n\t"appid"\t\t"3166810"\n\t"installdir"\t\t"Diceroll"\n}\n'


def test_the_products_appmanifest_naming_this_install_moves_to_steam() -> None:
    e = env(
        platform="linux",
        executable=f"{LIB}/steamapps/common/Diceroll/diceroll",
        frozen=True,
        fs=fake_fs({f"{LIB}/steamapps/appmanifest_3166810.acf": ACF}),
    )
    assert read(e) == {"steam.libraryManifest": "3166810"}
    assert (detect(e)["kind"], detect(e)["confidence"]) == ("steam", "declared")
    other = env(
        platform="linux",
        executable=f"{LIB}/steamapps/common/Diceroll/diceroll",
        frozen=True,
        fs=fake_fs({f"{LIB}/steamapps/appmanifest_3166810.acf": ACF.replace(b"Diceroll", b"Other")}),
    )
    assert read(other) == {}


def test_steam_env_only_with_this_app_id() -> None:
    e = env(env={"SteamAppId": "3166810", "SteamClientLaunch": "1"})
    assert read(e) == {"steam.appIdEnv": {"appId": "3166810", "clientLaunch": True}}
    assert (detect(e)["kind"], detect(e)["confidence"]) == ("steam", "heuristic")
    assert detect(env(env={"SteamAppId": "480"}))["kind"] == "direct"


def test_the_itch_receipt_names_itch_and_itchio_app_is_diagnostic() -> None:
    receipt = gzip.compress(json.dumps({"game": {"id": 1001}}).encode())
    e = env(
        executable="/home/a/itch/apps/diceroll/bin/diceroll",
        frozen=True,
        env={"ITCHIO_APP": "1"},
        fs=fake_fs({"/home/a/itch/apps/diceroll/.itch/receipt.json.gz": receipt}),
    )
    assert read(e) == {"itch.receipt": "1001", "itch.appEnv": True}
    assert detect(e)["source"] == "itch.receipt"
    assert detect(env(env={"ITCHIO_APP": "1"}))["kind"] == "direct"


def test_no_stamp_never_selects_from_heuristics() -> None:
    assert detect(env(env={"SteamAppId": "3166810"}), None)["kind"] == "unknown"


def test_the_real_process_environment_reads_without_raising() -> None:
    assert isinstance(read_outlet_signals(), dict)


# ── The update client ───────────────────────────────────────────────────────────────────────

STEAM_ENV = env(env={"SteamAppId": "3166810"}, frozen=True, executable="/x/diceroll")
QUIET_ENV = env(frozen=True, executable="/x/diceroll")


def test_the_client_detects_when_the_host_names_no_outlet_and_decide_uses_it() -> None:
    worker = Worker()
    worker.feeds["stable"] = seeded(worker)
    plain = v4_client(worker, update=options(outlet=None, stamp=STAMP, outlet_environment=QUIET_ENV))
    assert plain.update.detected == {"kind": "direct", "confidence": "stamp", "source": "stamp", "subkind": None}
    assert plain.update.outlet.to_dict() == {"id": "direct", "kind": "direct", "subkind": None}
    assert plain.update.decide(channel="stable").decision.action == "binary"
    plain.close()

    steam = v4_client(worker, update=options(outlet=None, stamp=STAMP, outlet_environment=STEAM_ENV))
    assert steam.update.detected["source"] == "steam.appIdEnv"
    assert steam.update.outlet.to_dict() == {"id": None, "kind": "steam", "subkind": None}
    d = steam.update.decide(channel="stable").decision
    assert (d.action, d.reason) == ("none", "not-available")
    steam.close()


def test_the_hosts_outlet_wins_and_nothing_is_detected() -> None:
    c = v4_client(Worker(), update=options(outlet="direct", stamp=STAMP, outlet_environment=STEAM_ENV))
    assert c.update.detected is None
    assert c.update.outlet.to_dict() == {"id": "direct", "kind": "direct", "subkind": None}
    c.close()


def test_a_host_result_is_used_and_detect_false_leaves_the_stamp() -> None:
    given = v4_client(Worker(), update=options(
        outlet=None, stamp=STAMP, outlet_environment=STEAM_ENV,
        detected={"kind": "itch", "confidence": "declared", "source": "itch.receipt", "subkind": None},
    ))
    assert given.update.outlet.to_dict() == {"id": None, "kind": "itch", "subkind": None}
    given.close()
    off = v4_client(Worker(), update=options(outlet=None, stamp=STAMP, detect=False, outlet_environment=STEAM_ENV))
    assert off.update.detected is None
    assert off.update.outlet.to_dict() == {"id": "direct", "kind": "direct", "subkind": None}
    off.close()


def test_no_stamp_is_unknown_and_bad_options_are_refused() -> None:
    c = v4_client(Worker(), update=options(outlet=None, outlet_environment=STEAM_ENV))
    assert c.update.outlet.to_dict() == {"id": None, "kind": "unknown", "subkind": None}
    c.close()
    for bad in ({"detect": "yes"}, {"outlet_environment": {"env": {}}}):
        with pytest.raises(PolarisError) as e:
            v4_client(Worker(), update=options(outlet=None, **bad))
        assert e.value.code == "invalid-options"
