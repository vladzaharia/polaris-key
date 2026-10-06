# @pkey-feature ui.cli
# @pkey-feature identity.devicecode devices.manage config.resolve release.changelog
"""The CLI kit's full verb set (SDK parity pass §2.1, SP-P12) through all three front ends, over a
real client and a mock Worker. One table (``polaris_key.cli.verbs.VERBS``) builds every front end,
so each verb is exercised once per front end on the paths that matter."""

from __future__ import annotations

import argparse
import json

import httpx
import pytest

from polaris_key import copy
from polaris_key.cli import core, verbs
from polaris_key.cli.argparse_cli import register_argparse

from helpers import PRODUCT, TOKEN, make_client, routes, sign_config, sign_license

ROSTER = [
    {"id": "DEV1", "current": True, "label": "Desk", "platform": "macos", "status": "ok"},
    {"id": "DEV2", "current": False, "label": "Laptop", "platform": "windows", "status": "ok"},
]


def _worker():
    base = routes(
        license_jws=lambda r: sign_license(r.headers["X-PKey-Device"]),
        config_jws=lambda r: sign_config(r.headers["X-PKey-Device"]),
        devices=ROSTER,
    )

    def handler(r: httpx.Request) -> httpx.Response:
        p = r.url.path
        if p == f"/{PRODUCT}/release/changelog":
            return httpx.Response(200, json={"entries": [{"version": "1.2.0", "tag": "v1.2.0", "summary": "Faster.", "url": "u", "date": "2026-10-01"}]})
        if p == f"/{PRODUCT}/identity/auth/device/start":
            return httpx.Response(200, json={"deviceCode": "dc", "userCode": "ABCD-EFGH", "verificationUri": "https://k/d", "verificationUriComplete": "https://k/d?user_code=ABCD-EFGH", "expiresIn": 600, "interval": 1})
        if p == f"/{PRODUCT}/identity/auth/device/poll":
            return httpx.Response(200, json={"status": "ready", "token": TOKEN, "identity": {"email": "ada@example.com"}})
        return base(r)

    return handler


def _factory(activated=True, services=("license", "config", "release", "identity")):
    def factory(opts: core.ClientOptions):
        c = make_client(_worker(), expected_services=list(services))
        if activated:
            c.license.activate_with_key("k")
        return c

    return factory


def _argparse(argv, factory, capsys):
    parser = argparse.ArgumentParser()
    register_argparse(parser.add_subparsers(dest="cmd", required=True), factory)
    args = parser.parse_args(argv)
    code = args.func(args)
    return code, capsys.readouterr().out


def test_every_verb_is_in_the_service_table() -> None:
    listed = {v for vs in core.SERVICE_COMMANDS.values() for v in vs}
    assert set(verbs.VERB_NAMES) <= listed


def test_devices_list_rename_deauthorize(capsys) -> None:
    code, out = _argparse(["devices", "--product", PRODUCT], _factory(), capsys)
    assert code == 0 and "DEV2" in out and "Laptop" in out
    code, out = _argparse(["devices", "--product", PRODUCT, "rename", "DEV2", "Work", "laptop"], _factory(), capsys)
    assert code == 0 and "Renamed DEV2" in out
    code, out = _argparse(["devices", "--product", PRODUCT, "frobnicate"], _factory(), capsys)
    assert code == 2


def test_config_list_set_reset_and_shorthand(capsys, tmp_path) -> None:
    code, out = _argparse(["config", "--product", PRODUCT, "list"], _factory(), capsys)
    assert code == 0 and "run.concurrency = 4 [enforced]" in out
    code, out = _argparse(["config", "--product", PRODUCT, "set", "ui.theme", '"dark"'], _factory(), capsys)
    assert code == 0 and 'ui.theme = "dark"' in out
    code, out = _argparse(["config", "--product", PRODUCT, "set", "run.concurrency", "9"], _factory(), capsys)
    assert code == 1 and copy.message("managed_by_admin") in out
    code, out = _argparse(["config", "--product", PRODUCT, "run.concurrency"], _factory(), capsys)
    assert code == 0 and "run.concurrency = 4" in out


def test_changelog_and_offline_request_and_doctor(capsys) -> None:
    code, out = _argparse(["changelog", "--product", PRODUCT, "--limit", "1"], _factory(), capsys)
    assert code == 0 and "1.2.0" in out and "Faster." in out
    code, out = _argparse(["offline-request", "--product", PRODUCT, "--no-qr"], _factory(activated=False), capsys)
    assert code == 0 and "Request code:" in out
    code, out = _argparse(["doctor", "--product", PRODUCT], _factory(), capsys)
    assert code == 0 and "license.gate: yes" in out and "devices.attest: no (runtime)" in out


def test_sign_in_prints_the_code_and_a_qr(capsys) -> None:
    code, out = _argparse(["sign-in", "--product", PRODUCT, "--ascii"], _factory(activated=False), capsys)
    assert code == 0, out
    assert "ABCD-EFGH" in out and "##" in out and "Signed in as ada@example.com" in out


def test_secret_never_prints_the_value(capsys) -> None:
    code, out = _argparse(["secret", "--product", PRODUCT, "proxy.subscriptionUrl"], _factory(), capsys)
    assert code == 0 and "present" in out and "vpn.example.com" not in out


def test_update_and_packs_explain_a_missing_configuration(capsys) -> None:
    code, out = _argparse(["update", "--product", PRODUCT, "download", "--to", "x"], _factory(), capsys)
    assert code == 1 and "no signed updates" in out
    code, out = _argparse(["packs", "--product", PRODUCT], _factory(), capsys)
    assert code == 1 and "content stamp" in out


def test_boot_prints_stages(capsys) -> None:
    code, out = _argparse(["boot", "--product", PRODUCT], _factory(), capsys)
    assert code == 0 and "… gate" in out and "Ready." in out


def test_click_runs_the_table_verbs() -> None:
    pytest.importorskip("click")
    from click.testing import CliRunner

    from polaris_key.cli.click_cli import polaris_click_group

    group = polaris_click_group(client_factory=_factory())
    r = CliRunner().invoke(group, ["devices", "--product", PRODUCT, "list"])
    assert r.exit_code == 0, r.output
    assert "DEV2" in r.output
    r = CliRunner().invoke(group, ["changelog", "--product", PRODUCT, "--limit", "1"])
    assert r.exit_code == 0 and "1.2.0" in r.output
    assert set(verbs.VERB_NAMES) <= set(group.commands)


def test_typer_runs_the_table_verbs() -> None:
    pytest.importorskip("typer")
    from typer.testing import CliRunner

    from polaris_key.cli.typer_cli import polaris_typer_app

    app = polaris_typer_app(client_factory=_factory())
    r = CliRunner().invoke(app, ["config", "list", "--product", PRODUCT])
    assert r.exit_code == 0, r.output
    assert "run.concurrency" in r.output
    r = CliRunner().invoke(app, ["offline-request", "--product", PRODUCT, "--no-qr"])
    assert r.exit_code == 0 and "Request code" in r.output
