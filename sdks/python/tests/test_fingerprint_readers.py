# @pkey-feature devices.fingerprint
"""The platform READS behind the fingerprint and the device id (P1b-09 plan §5.1–§5.3).

The pure rules are pinned by ``test_fingerprint_conformance.py``; this file proves the readers
route through them: the exact PowerShell argv, no ``wmic``, a null stdin on every platform, no
console window on Windows, and no DMI file ever opened on Linux. Every OS's branch runs on any
host through the injectable ``platform`` and ``io``.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import pytest

import polaris_key.devices.fingerprint as fp
from polaris_key.devices.deviceid import raw_os_device_id
from polaris_key.devices.fingerprint import (
    WINDOWS_CIM_COMMAND,
    FingerprintIO,
    raw_components,
    windows_powershell_path,
)

CORPUS = json.loads(
    (
        Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "fingerprint.json"
    ).read_text(encoding="utf-8")
)

PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
MACHINE_ID = "b7f3a1c95d2e4f6a8b0c1d2e3f4a5b6c"
DMI = {
    "/sys/class/dmi/id/product_uuid": "4C4C4544-0042-3510-8048-B4C04F4E3732\n",
    "/sys/class/dmi/id/board_serial": ".CN1234567890.\n",
}
MACHINE_IDS = {
    "/etc/machine-id": f"{MACHINE_ID}\n",
    "/var/lib/dbus/machine-id": f"{MACHINE_ID}\n",
}


class _Recorder:
    """A fake io: canned command output and file contents; every run and read logged."""

    def __init__(self, files: Dict[str, str], commands: Optional[Dict[str, str]] = None) -> None:
        self.files = files
        self.commands = commands or {}
        self.runs: List[Tuple[List[str], float]] = []
        self.reads: List[str] = []
        self.io = FingerprintIO(run=self._run, read=self._read)

    def _run(self, args: Sequence[str], timeout: float) -> Optional[str]:
        self.runs.append((list(args), timeout))
        return self.commands.get(args[0])

    def _read(self, path: str) -> Optional[str]:
        self.reads.append(path)
        return self.files.get(path)


# ── Windows ─────────────────────────────────────────────────────────────────────────
def test_windows_runs_exactly_the_pinned_argv_with_the_10s_timeout(monkeypatch) -> None:
    rec = _Recorder(
        {},
        {PS: '{"boardSerial":"  PF2ABCDE ","machineModel":"XPS 15 9530"}\r\n'},
    )
    raw = raw_components(
        platform="win32", io=rec.io, env={"SystemRoot": "C:\\Windows"}, total_bytes=17179869184
    )
    assert raw["boardSerial"] == "PF2ABCDE"
    assert raw["machineModel"] == "XPS 15 9530"
    assert raw["ramBucket"] == "16"
    ps = [r for r in rec.runs if r[0][0] == PS]
    assert len(ps) == 1
    assert ps[0][0][1:] == CORPUS["windowsCimCommand"]["args"]
    assert ps[0][1] == CORPUS["windowsCimCommand"]["timeoutMs"] / 1000
    assert not any("wmic" in a.lower() for args, _ in rec.runs for a in args)


def test_a_garbled_cim_call_costs_only_its_two_components() -> None:
    rec = _Recorder({}, {PS: "Get-CimInstance : Access denied\r\n"})
    raw = raw_components(platform="win32", io=rec.io, env={"SystemRoot": "C:\\Windows"})
    assert "boardSerial" not in raw and "machineModel" not in raw


def test_powershell_resolves_under_an_absolute_system_root_else_bare() -> None:
    assert windows_powershell_path({"SystemRoot": "C:\\Windows"}) == PS
    assert windows_powershell_path({"SystemRoot": "Windows"}) == "powershell.exe"
    assert windows_powershell_path({"SystemRoot": "\\Windows"}) == "powershell.exe"
    assert windows_powershell_path({}) == "powershell.exe"


def _capture_subprocess(monkeypatch, stdout: bytes = b"") -> List[Dict[str, object]]:
    calls: List[Dict[str, object]] = []

    class _Done:
        def __init__(self) -> None:
            self.stdout = stdout

    def _fake_run(args, **kwargs):  # noqa: ANN001
        calls.append({"args": args, **kwargs})
        return _Done()

    monkeypatch.setattr(fp.subprocess, "run", _fake_run)
    return calls


@pytest.mark.parametrize("platform", ["win32", "linux", "darwin"])
def test_every_run_gives_the_child_a_null_stdin(monkeypatch, platform: str) -> None:
    monkeypatch.setattr(fp.sys, "platform", platform)
    calls = _capture_subprocess(monkeypatch, b'{"boardSerial":"A1"}')
    out = fp._run([PS, *WINDOWS_CIM_COMMAND.args], WINDOWS_CIM_COMMAND.timeout_ms / 1000)
    assert out == '{"boardSerial":"A1"}'
    call = calls[0]
    assert call["stdin"] is subprocess.DEVNULL
    assert call["timeout"] == 10.0
    assert call["args"] == [PS, *CORPUS["windowsCimCommand"]["args"]]
    if platform == "win32":
        assert call["creationflags"] == getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    else:
        assert "creationflags" not in call


def test_output_is_decoded_as_utf8_with_replacement(monkeypatch) -> None:
    _capture_subprocess(monkeypatch, '{"machineModel":"Modèle"}'.encode("utf-8") + b"\xff")
    assert fp._run(["x"], 2.0) == '{"machineModel":"Modèle"}�'


def test_no_wmic_anywhere_in_the_module_source() -> None:
    assert "wmic" not in Path(fp.__file__).read_text(encoding="utf-8").lower()


# ── Linux ───────────────────────────────────────────────────────────────────────────
def test_root_and_unprivileged_yield_one_machine_uuid_and_dmi_is_never_opened() -> None:
    root = _Recorder({**DMI, **MACHINE_IDS})
    user = _Recorder(dict(MACHINE_IDS))
    as_root = raw_components(platform="linux", io=root.io)
    as_user = raw_components(platform="linux", io=user.io)
    assert as_root["machineUuid"] == MACHINE_ID
    assert as_root == as_user
    assert "boardSerial" not in as_root
    for reads in (root.reads, user.reads):
        assert "/sys/class/dmi/id/product_uuid" not in reads
        assert "/sys/class/dmi/id/board_serial" not in reads


def test_a_host_with_only_dmi_files_has_no_anchor() -> None:
    rec = _Recorder(dict(DMI))
    assert "machineUuid" not in raw_components(platform="linux", io=rec.io)


def test_product_name_and_findmnt() -> None:
    rec = _Recorder(
        {**MACHINE_IDS, "/sys/class/dmi/id/product_name": "ThinkPad X1\n"},
        {"findmnt": "0d6c3e4a-1111\n"},
    )
    raw = raw_components(platform="linux", io=rec.io)
    assert raw["machineModel"] == "ThinkPad X1"
    assert raw["bootVolumeUuid"] == "0d6c3e4a-1111"


def test_the_device_id_uses_the_same_rule() -> None:
    assert raw_os_device_id("linux", _Recorder({"/var/lib/dbus/machine-id": "dbus\n"}).io) == "dbus"
    # `uninitialized` is no longer accepted (it gave every such host one id).
    assert (
        raw_os_device_id(
            "linux",
            _Recorder(
                {"/etc/machine-id": "uninitialized\n", "/var/lib/dbus/machine-id": "dbus\n"}
            ).io,
        )
        == "dbus"
    )
    assert raw_os_device_id("linux", _Recorder({"/etc/machine-id": "uninitialized\n"}).io) is None
    root = _Recorder({**DMI, **MACHINE_IDS})
    assert raw_os_device_id("linux", root.io) == raw_os_device_id(
        "linux", _Recorder(dict(MACHINE_IDS)).io
    )
    assert "/sys/class/dmi/id/product_uuid" not in root.reads


# ── ramBucket in the reader ─────────────────────────────────────────────────────────
def test_ram_bucket_is_omitted_below_one_gib() -> None:
    raw = raw_components(platform="linux", io=_Recorder({}).io, total_bytes=536870912)
    assert "ramBucket" not in raw


def test_ram_bucket_of_a_16gb_linux_memtotal_is_8() -> None:
    raw = raw_components(platform="linux", io=_Recorder({}).io, total_bytes=16496934912)
    assert raw["ramBucket"] == "8"
