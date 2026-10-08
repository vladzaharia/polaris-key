"""Targeted coverage for the corners the other suites don't reach:

* ``FileStore`` secure-write 0600 + ``O_NOFOLLOW`` symlink refusal.
* ``derive_device_id`` per-OS branches (macOS ioreg / Windows registry / Linux file),
  driven through the injectable platform + command runner/file reader (P1b-09).
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

import polaris_key.devices.deviceid as deviceid
from polaris_key.cli import core
from polaris_key.ui.core import Copy

C = Copy("en")
from polaris_key.core.context import (
    DocumentBlocked,
    DocumentDeviceCap,
    DocumentError,
    DocumentNotModified,
    DocumentOk,
    DocumentUnauthorized,
)
from polaris_key.core.models import AllowedRange
from polaris_key.devices.deviceid import derive_device_id, raw_os_device_id
from polaris_key.devices.facts import ProbeDeclaration, collect_facts, run_probes
from polaris_key.devices.fingerprint import FingerprintIO
from polaris_key.devices.store import FileStore

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
    from polaris_key.core.store import CacheRecord

    store = FileStore(PRODUCT, str(tmp_path))
    cache_path = os.path.join(str(tmp_path), PRODUCT, "managed.json")
    outside = tmp_path / "cache-outside.json"
    outside.write_text("attacker-owned")
    os.symlink(str(outside), cache_path)
    with pytest.raises(OSError):
        store.write_cache(CacheRecord())
    assert outside.read_text() == "attacker-owned"


# ── derive_device_id per-OS branches ────────────────────────────────────────────────
def _io(commands=None, files=None) -> FingerprintIO:
    """A fake command runner + file reader (P1b-09's injectable seam)."""
    commands = commands or {}
    files = files or {}
    return FingerprintIO(
        run=lambda args, timeout: commands.get(args[0]),
        read=lambda path: files.get(path),
    )


def test_device_id_macos_branch() -> None:
    fake_out = '    "IOPlatformUUID" = "ABCDEF01-2345-6789-ABCD-EF0123456789"\n'
    io = _io(commands={"ioreg": fake_out})
    assert raw_os_device_id("darwin", io) == "ABCDEF01-2345-6789-ABCD-EF0123456789"
    a = derive_device_id(PRODUCT, "fixed")
    b = derive_device_id(PRODUCT, "fixed")
    assert a == b and len(a) == 32


def test_device_id_windows_branch_via_reg_fallback(monkeypatch) -> None:
    # Force the winreg import to fail so the `reg query` text-parse fallback runs.
    import builtins

    real_import = builtins.__import__

    def _no_winreg(name, *args, **kwargs):
        if name == "winreg":
            raise ImportError("no winreg in this test")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _no_winreg)
    io = _io(
        commands={
            "reg": (
                "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\n"
                "    MachineGuid    REG_SZ    11111111-2222-3333-4444-555555555555\n"
            )
        }
    )
    assert raw_os_device_id("win32", io) == "11111111-2222-3333-4444-555555555555"


def test_device_id_linux_branch_reads_machine_id() -> None:
    io = _io(files={"/etc/machine-id": "deadbeefcafebabe\n"})
    assert raw_os_device_id("linux", io) == "deadbeefcafebabe"


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


def test_document_500_is_server_error_with_status() -> None:
    res = _get_document(lambda r: httpx.Response(500, text="boom"))
    assert isinstance(res, DocumentError)
    assert res.status == 500 and res.code == "server-error"
    res = _get_document(lambda r: httpx.Response(500, json={"error": "internal_error", "message": "boom"}))
    assert (res.status, res.code, res.message) == (500, "server-error", "boom")


def test_document_network_exception_is_error_status_zero() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    res = _get_document(handler)
    assert isinstance(res, DocumentError) and res.status == 0 and res.code == "network-error"


# ── device facts ────────────────────────────────────────────────────────────────────
# @pkey-feature devices.facts
def test_collect_facts_reports_the_python_runtime() -> None:
    facts = collect_facts()
    assert facts["runtime"]["name"] == "python"
    assert facts["os"]["name"] and facts["os"]["version"]
    assert "probes" not in facts, "no probes declared ⇒ no probes reported"


# @pkey-feature devices.facts
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
            license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]),
            config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]),
            **kw,
        )
    )


def test_cli_activate_then_status_then_deactivate() -> None:
    c = _cli_client()
    r = core.activate(c, "my-key")
    assert r.code == 0 and Copy("en")("core.activation.ok.title") in r.lines

    st = core.status(c)
    assert st.code == 0
    assert st.data["status"] == "ok" and st.data["usable"] is True
    assert any("Grace Hopper" in line for line in st.lines)
    # P1b-09: the token store is named (in --json; in the lines only when degraded).
    assert st.data["tokenStore"] == {"backend": "memory", "degraded": None}

    d = core.deactivate(c)
    assert d.code == 0 and d.data == {"signedOut": True}
    # After deactivate the gate is needs-activation -> status exits non-zero.
    assert core.status(c).code == 1
    c.close()


def test_cli_status_exits_zero_on_not_applicable() -> None:
    """For a product with License disabled the gate is ``not-applicable`` and USABLE, so
    the CLI must not report failure."""
    c = make_client(
        routes(config_jws=lambda r: sign_config(r.headers["X-PKey-Device"])),
        expected_services=["config"],
    )
    st = core.status(c)
    assert st.code == 0
    assert st.data["status"] == "not-applicable"
    c.close()


def test_cli_activate_unauthorized_returns_code_1() -> None:
    c = make_client(lambda r: httpx.Response(401, text="bad key"))
    r = core.activate(c, "nope")
    assert r.code == 1 and C("core.activation.unauthorized.title") in r.lines
    assert not any("nope" in line for line in r.lines), "the key never goes back to the scrollback"
    c.close()


def test_cli_activate_device_limit_reports_counts() -> None:
    c = make_client(lambda r: httpx.Response(403, json={"limit": 3, "deviceCount": 3}))
    r = core.activate(c, "k")
    assert r.code == 1
    assert C("deviceLimit.heading", used=3, limit=3) in r.lines
    assert r.data["deviceCount"] == 3 and r.data["limit"] == 3
    c.close()


def test_cli_enroll_disabled_has_its_own_message() -> None:
    c = make_client(lambda r: httpx.Response(404))
    r = core.enroll(c)
    assert r.code == 1
    assert C("core.activation.enroll-disabled.title") in r.lines
    c.close()


def test_cli_register_syncs_and_reports_the_device_id() -> None:
    c = _cli_client()
    r = core.register(c)
    assert r.code == 0
    assert any(c.core.device_id in line for line in r.lines)
    assert C("core.gate.ok.title") in r.lines and r.data["status"] == "ok"
    c.close()


@pytest.mark.parametrize(
    "status,fragment",
    [
        (403, "core.codes.registration_closed.title"),
        (429, "core.codes.rate_limited.title"),
        (404, "core.codes.not-configured.title"),
    ],
)
def test_cli_register_failure_messages(status: int, fragment: str) -> None:
    c = make_client(lambda r: httpx.Response(status))
    r = core.register(c)
    assert r.code == 1 and C(fragment) in r.lines
    c.close()


def test_cli_config_prints_value_and_source() -> None:
    c = _cli_client()
    core.activate(c, "k")
    r = core.config(c, "run.concurrency")
    assert r.code == 0
    assert r.data == {"key": "run.concurrency", "value": 4, "source": "enforced"}
    fb = core.config(c, "missing.key", "DEFAULT")
    assert fb.data == {"key": "missing.key", "value": "DEFAULT", "source": "fallback"}
    c.close()


def test_cli_import_bundle_success_and_refusal(tmp_path) -> None:
    from helpers import sign_bundle

    c = _cli_client()
    device_id = c.core.device_id
    good = sign_bundle(device_id, docs={"license": sign_license(device_id)})
    r = core.import_bundle(c, good)
    assert r.code == 0 and C("offlineActivation.done") in r.lines

    bad = sign_bundle("someone-else")
    r2 = core.import_bundle(c, bad)
    assert r2.code == 1
    # The copy names the STEP, which is the operator's remedy.
    assert C("core.codes.bundle-claims-rejected.message") in r2.lines
    assert r2.data["error"] == "bundle-claims-rejected"
    c.close()


def test_cli_read_bundle_file(tmp_path) -> None:
    path = tmp_path / "b.pkeybundle"
    path.write_text("  a.b.c \n")
    assert core.read_bundle_file(str(path)) == "a.b.c"
    empty = tmp_path / "empty.pkeybundle"
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
    assert core.SERVICE_COMMANDS["devices"] == ("register", "devices")
    assert core.SERVICE_COMMANDS["config"] == ("config", "secret", "mint")
    assert core.SERVICE_COMMANDS["core"] == ("import-bundle", "offline-request", "boot", "doctor")
    assert core.SERVICE_COMMANDS["identity"] == ("sign-in", "sign-out", "login", "logout")
    assert core.SERVICE_COMMANDS["release"] == ("changelog",)
    assert core.SERVICE_COMMANDS["update"] == ("update", "packs")


def test_no_service_flags_reads_as_silence_not_as_an_empty_expectation() -> None:
    """A CLI cannot tell "I passed no ``--service``" from "I meant none", so the safe
    reading is silence — the client keeps the suite default rather than turning every
    sub-client off. (A host that genuinely wants the empty expectation passes
    ``expected_services=[]`` to the client directly; see ``test_capabilities.py``.)"""
    assert core.parse_services(None) is None  # argparse's "no flags"
    assert core.parse_services(()) is None  # click's "no flags"
    assert core.parse_services(["config", "release"]) == ["config", "release"]
