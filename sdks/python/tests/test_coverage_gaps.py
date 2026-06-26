"""Targeted coverage for the corners the existing suites don't reach:

* FileStore secure-write 0600 + ``O_NOFOLLOW`` symlink refusal.
* ``derive_device_id`` per-OS branches (macOS ioreg / Windows registry / Linux file),
  driven by monkeypatching the platform + the subprocess/file reads.
* The full ``fetch_managed_config`` status taxonomy (304/401/403/429/200/other/network).
* The framework-agnostic CLI ``core`` (activate / deactivate / status) result mapping.
"""

from __future__ import annotations

import os
import stat
from typing import Any, Dict

import httpx
import pytest

import polaris_key.deviceid as deviceid
from polaris_key.cli import core
from polaris_key.client import PolarisKeyClient
from polaris_key.deviceid import derive_device_id, raw_os_device_id
from polaris_key.fetch import (
    FetchBlocked,
    FetchDeviceCap,
    FetchError,
    FetchNotModified,
    FetchOk,
    FetchUnauthorized,
    fetch_managed_config,
)
from polaris_key.models import AllowedRange
from polaris_key.store import FileStore, InMemoryStore
from polaris_key.verify import sign_jws

PRODUCT = "djdl"
KID = "pkey-test-prod-2026"
PUBKEY_RAW = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"
PRIVATE_PEM = (
    "-----BEGIN PRIVATE KEY-----\n"
    "MC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n"
    "-----END PRIVATE KEY-----"
)
TRUST = {KID: PUBKEY_RAW}


# ── FileStore secure write: 0600 + O_NOFOLLOW ────────────────────────────────────
def test_filestore_device_file_is_0600(tmp_path) -> None:
    store = FileStore(PRODUCT, str(tmp_path))
    dev = store.get_device_id()
    assert len(dev) == 32
    mode = stat.S_IMODE(os.stat(os.path.join(str(tmp_path), PRODUCT, "device")).st_mode)
    assert mode == 0o600


def test_filestore_dir_is_private_0700(tmp_path) -> None:
    FileStore(PRODUCT, str(tmp_path))
    dir_mode = stat.S_IMODE(os.stat(os.path.join(str(tmp_path), PRODUCT)).st_mode)
    assert dir_mode == 0o700


@pytest.mark.skipif(not hasattr(os, "O_NOFOLLOW"), reason="O_NOFOLLOW unavailable")
def test_filestore_refuses_to_follow_a_planted_symlink(tmp_path) -> None:
    """A symlink planted at the token path must NOT be followed on write (anti-symlink)."""
    store = FileStore(PRODUCT, str(tmp_path))
    token_path = os.path.join(str(tmp_path), PRODUCT, "token")
    outside = tmp_path / "outside.txt"
    outside.write_text("attacker-owned")
    # Plant a symlink where the store will try to write.
    os.symlink(str(outside), token_path)
    with pytest.raises(OSError):
        store.set_token("secret-token")
    # The symlink target was NOT clobbered.
    assert outside.read_text() == "attacker-owned"


def test_filestore_ignores_unreadable_cache(tmp_path) -> None:
    store = FileStore(PRODUCT, str(tmp_path))
    # A corrupt cache file decodes to None rather than raising.
    cache_path = os.path.join(str(tmp_path), PRODUCT, "managed.json")
    with open(cache_path, "w", encoding="utf-8") as f:
        f.write("{not json")
    assert store.read_cache() is None


# ── derive_device_id per-OS branches ─────────────────────────────────────────────
def test_device_id_macos_branch(monkeypatch) -> None:
    monkeypatch.setattr(deviceid.sys, "platform", "darwin", raising=False)
    fake_out = '    "IOPlatformUUID" = "ABCDEF01-2345-6789-ABCD-EF0123456789"\n'

    class _Res:
        stdout = fake_out

    monkeypatch.setattr(deviceid.subprocess, "run", lambda *a, **k: _Res())
    assert raw_os_device_id() == "ABCDEF01-2345-6789-ABCD-EF0123456789"
    # And derive_device_id is a stable 32-char hash over it.
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


def test_device_id_linux_branch_reads_device_id(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(deviceid.sys, "platform", "linux", raising=False)
    device_id = tmp_path / "linux-device-id"
    device_id.write_text("deadbeefcafebabe\n")

    real_open = open

    def _fake_open(path, *args, **kwargs):
        if path == "/etc/machine-id":
            return real_open(str(device_id), *args, **kwargs)
        raise OSError("not found")

    monkeypatch.setattr("builtins.open", _fake_open)
    assert raw_os_device_id() == "deadbeefcafebabe"


def test_device_id_falls_back_to_uuid_when_unavailable(monkeypatch) -> None:
    # No raw OS device identifier available -> a provided fallback seed is used.
    monkeypatch.setattr(deviceid, "raw_os_device_id", lambda: None)
    a = derive_device_id(PRODUCT, fallback="seed-1")
    b = derive_device_id(PRODUCT, fallback="seed-1")
    c = derive_device_id(PRODUCT, fallback="seed-2")
    assert a == b
    assert a != c
    assert len(a) == 32


# ── fetch status taxonomy ────────────────────────────────────────────────────────
def _fetch(handler, *, etag: str | None = None):
    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport, base_url="")
    try:
        return fetch_managed_config(
            base_url="https://key.example",
            product=PRODUCT,
            token="tok",
            device_id="dev",
            version="1.0.0",
            channel="stable",
            etag=etag,
            client=client,
        )
    finally:
        client.close()


def test_fetch_200_returns_ok_with_etag() -> None:
    res = _fetch(lambda r: httpx.Response(200, text="a.b.c", headers={"etag": "v9"}))
    assert isinstance(res, FetchOk)
    assert res.jws == "a.b.c"
    assert res.etag == "v9"


def test_fetch_304_not_modified_sends_if_none_match() -> None:
    seen: Dict[str, Any] = {}

    def handler(r: httpx.Request) -> httpx.Response:
        seen["inm"] = r.headers.get("if-none-match")
        return httpx.Response(304)

    res = _fetch(handler, etag="v9")
    assert isinstance(res, FetchNotModified)
    assert seen["inm"] == "v9"


def test_fetch_401_unauthorized() -> None:
    res = _fetch(lambda r: httpx.Response(401))
    assert isinstance(res, FetchUnauthorized)


def test_fetch_429_device_cap_parses_body() -> None:
    res = _fetch(lambda r: httpx.Response(429, json={"limit": 3, "deviceCount": 4}))
    assert isinstance(res, FetchDeviceCap)
    assert res.limit == 3 and res.deviceCount == 4


def test_fetch_403_blocked_parses_reason_and_range() -> None:
    res = _fetch(
        lambda r: httpx.Response(
            403, json={"reason": "version-too-new", "allowedRange": {"max": "1.5.0"}}
        )
    )
    assert isinstance(res, FetchBlocked)
    assert res.reason == "version-too-new"
    assert res.allowedRange == AllowedRange(max="1.5.0")


def test_fetch_403_blocked_defaults_reason_when_absent() -> None:
    res = _fetch(lambda r: httpx.Response(403, json={}))
    assert isinstance(res, FetchBlocked)
    assert res.reason == "version-too-old"
    assert res.allowedRange is None


def test_fetch_500_is_error_with_status_and_text() -> None:
    res = _fetch(lambda r: httpx.Response(500, text="boom"))
    assert isinstance(res, FetchError)
    assert res.status == 500 and res.message == "boom"


def test_fetch_network_exception_is_error_status_zero() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    res = _fetch(handler)
    assert isinstance(res, FetchError)
    assert res.status == 0


# ── CLI core: activate / deactivate / status ─────────────────────────────────────
# CLI `core.status` uses real wall-clock time (no `now` injection), so the doc's window
# must stay valid far into the future for the assertions to be time-independent.
_FAR_FUTURE = 4_102_444_800  # 2100-01-01


def _doc(device_id: str, *, issued: int = 1700000000) -> Dict[str, Any]:
    return {
        "schemaVersion": 1,
        "aud": PRODUCT,
        "iss": "key.plrs.im",
        "licenseId": "lic_cli",
        "deviceId": device_id,
        "issuedAt": issued,
        "expiresAt": _FAR_FUTURE,
        "graceUntil": _FAR_FUTURE,
        "profile": {
            "name": "Grace Hopper",
            "firstName": "Grace",
            "email": "grace@example.com",
            "activatedAt": 1690000000,
        },
        "payload": {"config": {}, "secrets": {}, "entitlements": {}},
    }


def _cli_client(handler) -> PolarisKeyClient:
    http = httpx.Client(transport=httpx.MockTransport(handler), base_url="")
    c = PolarisKeyClient(
        product_slug=PRODUCT,
        version="1.0.0",
        trust=TRUST,
        base_url="https://key.example",
        store=InMemoryStore(PRODUCT),
        client=http,
    )
    c.init()
    return c


def test_cli_activate_success_then_status_then_deactivate() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        path = r.url.path
        if path == f"/{PRODUCT}/activate":
            return httpx.Response(200, json={"token": "tok", "schemaVersion": 1})
        if path == f"/{PRODUCT}/config":
            return httpx.Response(
                200, text=sign_jws(_doc(r.headers["X-PKey-Device"]), PRIVATE_PEM, KID)
            )
        if path in (f"/{PRODUCT}/config/report", f"/{PRODUCT}/deauthorize"):
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404)

    c = _cli_client(handler)
    r = core.activate(c, "my-key")
    assert r.code == 0 and any("Activated" in line for line in r.lines)

    st = core.status(c)
    assert st.code == 0
    assert any("Status: ok" in line for line in st.lines)
    assert any("Licensed to: Grace Hopper" in line for line in st.lines)

    d = core.deactivate(c)
    assert d.code == 0 and any("Deactivated" in line for line in d.lines)
    # After deactivate the gate is needs-activation -> status exits non-zero.
    assert core.status(c).code == 1
    c.close()


def test_cli_activate_unauthorized_returns_code_1() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path == f"/{PRODUCT}/activate":
            return httpx.Response(401, text="bad key")
        return httpx.Response(404)

    c = _cli_client(handler)
    r = core.activate(c, "nope")
    assert r.code == 1 and any("invalid or revoked" in line for line in r.lines)
    c.close()


def test_cli_activate_device_limit_reports_counts() -> None:
    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.path == f"/{PRODUCT}/activate":
            return httpx.Response(403, json={"limit": 3, "deviceCount": 3})
        return httpx.Response(404)

    c = _cli_client(handler)
    r = core.activate(c, "k")
    assert r.code == 1
    assert any("device limit reached" in line for line in r.lines)
    assert any("3/3" in line for line in r.lines)
    c.close()


def test_command_result_emit_prints_each_line(capsys) -> None:
    core.CommandResult(0, ["one", "two"]).emit()
    out = capsys.readouterr().out.splitlines()
    assert out == ["one", "two"]
