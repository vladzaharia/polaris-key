"""Targeted coverage for the corners the other suites don't reach:

* ``FileStore`` secure-write 0600 + ``O_NOFOLLOW`` symlink refusal.
* ``derive_device_id`` per-OS branches (macOS ioreg / Windows registry / Linux file),
  driven by monkeypatching the platform + the subprocess/file reads.
* The full ``CoreContext.get_document`` status taxonomy (304/401/403/429/200/other/network).
* Device facts + probe declarations.
* The framework-agnostic CLI ``core`` result mapping against a real client.
"""

from __future__ import annotations

import os
import stat
from typing import Any, Dict

import httpx
import pytest

import polaris.devices.deviceid as deviceid
from polaris.cli import core
from polaris.core.context import (
    DocumentBlocked,
    DocumentDeviceCap,
    DocumentError,
    DocumentNotModified,
    DocumentOk,
    DocumentUnauthorized,
)
from polaris.core.models import AllowedRange
from polaris.devices.deviceid import derive_device_id, raw_os_device_id
from polaris.devices.facts import ProbeDeclaration, collect_facts, run_probes
from polaris.devices.store import FileStore

from helpers import PRODUCT, TOKEN, make_client, routes, sign_config, sign_license


# ── FileStore secure write: 0600 + O_NOFOLLOW ───────────────────────────────────────
def test_filestore_device_file_is_0600(tmp_path) -> None:
    store = FileStore(PRODUCT, str(tmp_path))
    dev = store.get_device_id()
    assert len(dev) == 32
    mode = stat.S_IMODE(
        os.stat(os.path.join(str(tmp_path), PRODUCT, "device")).st_mode
    )
    assert mode == 0o600


def test_filestore_dir_is_private_0700(tmp_path) -> None:
    FileStore(PRODUCT, str(tmp_path))
    dir_mode = stat.S_IMODE(os.stat(os.path.join(str(tmp_path), PRODUCT)).st_mode)
    assert dir_mode == 0o700


@pytest.mark.skipif(not hasattr(os, "O_NOFOLLOW"), reason="O_NOFOLLOW unavailable")
def test_filestore_refuses_to_follow_a_planted_symlink(tmp_path) -> None:
    """A symlink planted at the token path must NOT be followed on write."""
    store = FileStore(PRODUCT, str(tmp_path))
    token_path = os.path.join(str(tmp_path), PRODUCT, "token")
    outside = tmp_path / "outside.txt"
    outside.write_text("attacker-owned")
    os.symlink(str(outside), token_path)
    with pytest.raises(OSError):
        store.set_token("secret-token")
    assert outside.read_text() == "attacker-owned"


@pytest.mark.skipif(not hasattr(os, "O_NOFOLLOW"), reason="O_NOFOLLOW unavailable")
def test_the_cache_file_is_symlink_guarded_too(tmp_path) -> None:
    """Every secure write goes through the same guard — not just the token."""
    from polaris.core.store import CacheRecord

    store = FileStore(PRODUCT, str(tmp_path))
    cache_path = os.path.join(str(tmp_path), PRODUCT, "managed.json")
    outside = tmp_path / "cache-outside.json"
    outside.write_text("attacker-owned")
    os.symlink(str(outside), cache_path)
    with pytest.raises(OSError):
        store.write_cache(CacheRecord())
    assert outside.read_text() == "attacker-owned"


# ── derive_device_id per-OS branches ────────────────────────────────────────────────
def test_device_id_macos_branch(monkeypatch) -> None:
    monkeypatch.setattr(deviceid.sys, "platform", "darwin", raising=False)
    fake_out = '    "IOPlatformUUID" = "ABCDEF01-2345-6789-ABCD-EF0123456789"\n'

    class _Res:
        stdout = fake_out

    monkeypatch.setattr(deviceid.subprocess, "run", lambda *a, **k: _Res())
    assert raw_os_device_id() == "ABCDEF01-2345-6789-ABCD-EF0123456789"
    a = derive_device_id(PRODUCT)
    b = derive_device_id(PRODUCT)
    assert a == b and len(a) == 32


def test_device_id_windows_branch_via_reg_fallback(monkeypatch) -> None:
    monkeypatch.setattr(deviceid.sys, "platform", "win32", raising=False)

    # Force the winreg import to fail so the `reg query` text-parse fallback runs.
    import builtins

    real_import = builtins.__import__

    def _no_winreg(name, *args, **kwargs):
        if name == "winreg":
            raise ImportError("no winreg in this test")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _no_winreg)

    class _Res:
        stdout = (
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\n"
            "    MachineGuid    REG_SZ    11111111-2222-3333-4444-555555555555\n"
        )

    monkeypatch.setattr(deviceid.subprocess, "run", lambda *a, **k: _Res())
    assert raw_os_device_id() == "11111111-2222-3333-4444-555555555555"


def test_device_id_linux_branch_reads_machine_id(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(deviceid.sys, "platform", "linux", raising=False)
    machine_id = tmp_path / "linux-machine-id"
    machine_id.write_text("deadbeefcafebabe\n")

    real_open = open

    def _fake_open(path, *args, **kwargs):
        if path == "/etc/machine-id":
            return real_open(str(machine_id), *args, **kwargs)
        raise OSError("not found")

    monkeypatch.setattr("builtins.open", _fake_open)
    assert raw_os_device_id() == "deadbeefcafebabe"


def test_device_id_falls_back_to_uuid_when_unavailable(monkeypatch) -> None:
    monkeypatch.setattr(deviceid, "raw_os_device_id", lambda: None)
    a = derive_device_id(PRODUCT, fallback="seed-1")
    b = derive_device_id(PRODUCT, fallback="seed-1")
    c = derive_device_id(PRODUCT, fallback="seed-2")
    assert a == b
    assert a != c
    assert len(a) == 32


# ── the signed-document status taxonomy (§5) ────────────────────────────────────────
def _get_document(handler, *, etag=None, path="license/document"):
    c = make_client(handler)
    try:
        return c.core.get_document(path, TOKEN, etag)
    finally:
        c.close()


def test_document_200_returns_ok_with_etag() -> None:
    res = _get_document(
        lambda r: httpx.Response(200, text="a.b.c", headers={"etag": "v9"})
    )
    assert isinstance(res, DocumentOk)
    assert res.jws == "a.b.c" and res.etag == "v9"


def test_document_304_not_modified_sends_if_none_match() -> None:
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        seen["inm"] = r.headers.get("if-none-match")
        return httpx.Response(304)

    assert isinstance(_get_document(handler, etag="v9"), DocumentNotModified)
    assert seen["inm"] == "v9"


def test_document_401_unauthorized() -> None:
    assert isinstance(_get_document(lambda r: httpx.Response(401)), DocumentUnauthorized)


def test_document_429_device_cap_parses_body() -> None:
    res = _get_document(
        lambda r: httpx.Response(429, json={"limit": 3, "deviceCount": 4})
    )
    assert isinstance(res, DocumentDeviceCap)
    assert res.limit == 3 and res.deviceCount == 4


def test_document_403_blocked_parses_the_v3_nested_shape() -> None:
    res = _get_document(
        lambda r: httpx.Response(
            403,
            json={
                "error": {"code": "version_blocked", "reason": "version-too-new"},
                "allowedRange": {"max": "1.5.0"},
            },
        )
    )
    assert isinstance(res, DocumentBlocked)
    assert res.reason == "version-too-new"
    assert res.allowedRange == AllowedRange(max="1.5.0")


def test_document_403_blocked_reads_the_flat_shape_too() -> None:
    res = _get_document(
        lambda r: httpx.Response(
            403, json={"reason": "version-too-new", "allowedRange": {"max": "1.5.0"}}
        )
    )
    assert isinstance(res, DocumentBlocked) and res.reason == "version-too-new"


def test_document_403_defaults_to_the_stricter_reason_when_the_body_says_nothing() -> None:
    res = _get_document(lambda r: httpx.Response(403, json={}))
    assert isinstance(res, DocumentBlocked)
    assert res.reason == "version-too-old"
    assert res.allowedRange is None


def test_document_500_is_error_with_status_and_text() -> None:
    res = _get_document(lambda r: httpx.Response(500, text="boom"))
    assert isinstance(res, DocumentError)
    assert res.status == 500 and res.message == "boom"


def test_document_network_exception_is_error_status_zero() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    res = _get_document(handler)
    assert isinstance(res, DocumentError) and res.status == 0


# ── device facts ────────────────────────────────────────────────────────────────────
def test_collect_facts_reports_the_python_runtime() -> None:
    facts = collect_facts()
    assert facts["runtime"]["name"] == "python"
    assert facts["os"]["name"] and facts["os"]["version"]
    assert "probes" not in facts, "no probes declared ⇒ no probes reported"


def test_a_probe_with_no_target_for_this_platform_is_not_applicable(tmp_path) -> None:
    """Reporting it as ``present: False`` would be a lie an admin cannot distinguish from
    "not installed"."""
    present = tmp_path / "installed"
    present.write_text("x")
    declarations = [
        ProbeDeclaration(
            id="here", macos=str(present), windows=str(present), linux=str(present)
        ),
        ProbeDeclaration(id="elsewhere"),
    ]
    results = run_probes(declarations)
    assert results == {"here": {"present": True}}
    assert "elsewhere" not in results
    facts = collect_facts(declarations)
    assert facts["probes"]["here"]["present"] is True


# ── CLI core against a REAL client ──────────────────────────────────────────────────
def _cli_client(**kw: Any):
    return make_client(
        routes(
            license_jws=lambda r: sign_license(r.headers["X-Polaris-Device"]),
            config_jws=lambda r: sign_config(r.headers["X-Polaris-Device"]),
            **kw,
        )
    )


def test_cli_activate_then_status_then_deactivate() -> None:
    c = _cli_client()
    r = core.activate(c, "my-key")
    assert r.code == 0 and any("Activated" in line for line in r.lines)

    st = core.status(c)
    assert st.code == 0
    assert any("Status: ok" in line for line in st.lines)
    assert any("Licensed to: Grace Hopper" in line for line in st.lines)
    assert st.lines[-1] == "Usable: True"

    d = core.deactivate(c)
    assert d.code == 0 and any("Deactivated" in line for line in d.lines)
    # After deactivate the gate is needs-activation -> status exits non-zero.
    assert core.status(c).code == 1
    c.close()


def test_cli_status_exits_zero_on_not_applicable() -> None:
    """For a product with License disabled the gate is ``not-applicable`` and USABLE, so
    the CLI must not report failure."""
    c = make_client(
        routes(config_jws=lambda r: sign_config(r.headers["X-Polaris-Device"])),
        expected_services=["config"],
    )
    st = core.status(c)
    assert st.code == 0
    assert any("Status: not-applicable" in line for line in st.lines)
    c.close()


def test_cli_activate_unauthorized_returns_code_1() -> None:
    c = make_client(lambda r: httpx.Response(401, text="bad key"))
    r = core.activate(c, "nope")
    assert r.code == 1 and any("invalid or revoked" in line for line in r.lines)
    c.close()


def test_cli_activate_device_limit_reports_counts() -> None:
    c = make_client(lambda r: httpx.Response(403, json={"limit": 3, "deviceCount": 3}))
    r = core.activate(c, "k")
    assert r.code == 1
    assert any("device limit reached" in line for line in r.lines)
    assert any("3/3" in line for line in r.lines)
    c.close()


def test_cli_enroll_disabled_has_its_own_message() -> None:
    c = make_client(lambda r: httpx.Response(404))
    r = core.enroll(c)
    assert r.code == 1
    assert any("keyless enrollment" in line for line in r.lines)
    c.close()


def test_cli_register_syncs_and_reports_the_device_id() -> None:
    c = _cli_client()
    r = core.register(c)
    assert r.code == 0
    assert any(c.core.device_id in line for line in r.lines)
    assert any("Status: ok" in line for line in r.lines)
    c.close()


@pytest.mark.parametrize(
    "status,fragment",
    [
        (403, "keyless registration"),
        (429, "too many attempts"),
        (404, "unknown product"),
    ],
)
def test_cli_register_failure_messages(status: int, fragment: str) -> None:
    c = make_client(lambda r: httpx.Response(status))
    r = core.register(c)
    assert r.code == 1 and any(fragment in line for line in r.lines)
    c.close()


def test_cli_config_prints_value_and_source() -> None:
    c = _cli_client()
    core.activate(c, "k")
    r = core.config(c, "run.concurrency")
    assert r.code == 0
    assert "run.concurrency = 4" in r.lines[0] and "enforced" in r.lines[0]
    fb = core.config(c, "missing.key", "DEFAULT")
    assert "missing.key = 'DEFAULT'" in fb.lines[0] and "fallback" in fb.lines[0]
    c.close()


def test_cli_import_bundle_success_and_refusal(tmp_path) -> None:
    from helpers import sign_bundle

    c = _cli_client()
    device_id = c.core.device_id
    good = sign_bundle(device_id, docs={"license": sign_license(device_id)})
    r = core.import_bundle(c, good)
    assert r.code == 0 and any("Imported bundle" in line for line in r.lines)

    bad = sign_bundle("someone-else")
    r2 = core.import_bundle(c, bad)
    assert r2.code == 1
    assert any("Bundle import failed" in line for line in r2.lines)
    # The message names the STEP, which is the operator's remedy.
    assert any("bundle-claims-rejected" in line for line in r2.lines)
    c.close()


def test_cli_read_bundle_file(tmp_path) -> None:
    path = tmp_path / "b.plrsbundle"
    path.write_text("  a.b.c \n")
    assert core.read_bundle_file(str(path)) == "a.b.c"
    empty = tmp_path / "empty.plrsbundle"
    empty.write_text("   ")
    with pytest.raises(ValueError):
        core.read_bundle_file(str(empty))


def test_command_result_emit_prints_each_line(capsys) -> None:
    core.CommandResult(0, ["one", "two"]).emit()
    out = capsys.readouterr().out.splitlines()
    assert out == ["one", "two"]


def test_service_commands_group_every_verb_by_owner() -> None:
    """The CLI's grouping IS the SDK's carve — `register` is a DEVICES verb, not a
    licensing one, which is why a config-only product has a provisioning story at all."""
    assert core.SERVICE_COMMANDS["license"] == (
        "activate",
        "enroll",
        "deactivate",
        "status",
    )
    assert core.SERVICE_COMMANDS["devices"] == ("register",)
    assert core.SERVICE_COMMANDS["config"] == ("config",)
    assert core.SERVICE_COMMANDS["core"] == ("import-bundle",)


def test_no_service_flags_reads_as_silence_not_as_an_empty_expectation() -> None:
    """A CLI cannot tell "I passed no ``--service``" from "I meant none", so the safe
    reading is silence — the client keeps the suite default rather than turning every
    sub-client off. (A host that genuinely wants the empty expectation passes
    ``expected_services=[]`` to the client directly; see ``test_capabilities.py``.)"""
    assert core.parse_services(None) is None  # argparse's "no flags"
    assert core.parse_services(()) is None  # click's "no flags"
    assert core.parse_services(["config", "release"]) == ["config", "release"]
