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
from polaris_key.ui.core import Copy

C = Copy("en")
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
    register_argparse(parser.add_subparsers(dest="cmd", required=True), factory, verbs="all")
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
    assert code == 0 and C("common.done") in out and "Work laptop" in out
    code, out = _argparse(["devices", "--product", PRODUCT, "frobnicate"], _factory(), capsys)
    assert code == 2


def test_config_list_set_reset_and_shorthand(capsys, tmp_path) -> None:
    code, out = _argparse(["config", "--product", PRODUCT, "list"], _factory(), capsys)
    assert code == 0 and any("run.concurrency" in ln and C("core.codes.managed_by_admin.title") in ln for ln in out.splitlines())
    code, out = _argparse(["config", "--product", PRODUCT, "set", "ui.theme", '"dark"'], _factory(), capsys)
    assert code == 0 and C("settings.saved") in out and '"dark"' in out
    code, out = _argparse(["config", "--product", PRODUCT, "set", "run.concurrency", "9"], _factory(), capsys)
    assert code == 1 and " ".join(copy.message("managed_by_admin").split()) in " ".join(out.split())
    code, out = _argparse(["config", "--product", PRODUCT, "run.concurrency", "--json"], _factory(), capsys)
    assert code == 0 and json.loads(out)["value"] == 4 and json.loads(out)["source"] == "enforced"


def test_changelog_and_offline_request_and_doctor(capsys) -> None:
    code, out = _argparse(["changelog", "--product", PRODUCT, "--limit", "1"], _factory(), capsys)
    assert code == 0 and "1.2.0" in out and "Faster." in out
    code, out = _argparse(["offline-request", "--product", PRODUCT, "--no-qr"], _factory(activated=False), capsys)
    assert code == 0 and C("offlineActivation.request") in out
    code, out = _argparse(["doctor", "--product", PRODUCT], _factory(), capsys)
    assert code == 0 and "license.gate: yes" in out and "devices.attest: no (runtime)" in out
    code, out = _argparse(["doctor", "--product", PRODUCT, "--json"], _factory(), capsys)
    assert code == 0 and json.loads(out)["supports"]["devices.attest"] == "runtime"


def test_sign_in_without_a_terminal_prints_the_code_and_no_qr(capsys) -> None:
    """Piped (no terminal), sign-in shows the code view once and waits; never a QR in a terminal
    (SIGN-IN.md D-67, D-68)."""
    code, out = _argparse(["sign-in", "--product", PRODUCT, "--ascii"], _factory(activated=False), capsys)
    assert code == 0, out
    assert "ABCD-EFGH" in out and "##" not in out and "▀" not in out
    assert C("account.holder", name="ada@example.com") in out


def test_sign_in_json_prints_pending_then_the_result(capsys) -> None:
    code, out = _argparse(["login", "--product", PRODUCT, "--json"], _factory(activated=False), capsys)
    assert code == 0, out
    pending, result = [json.loads(ln) for ln in out.strip().splitlines()]
    assert pending["event"] == "pending" and pending["userCode"] == "ABCD-EFGH"
    assert pending["verificationUri"] == "https://k/d"
    assert result["event"] == "result" and result["state"] == "signedIn" and result["email"] == "ada@example.com"


def _argparse_err(argv, factory, capsys):
    parser = argparse.ArgumentParser()
    register_argparse(parser.add_subparsers(dest="cmd", required=True), factory, verbs="all")
    args = parser.parse_args(argv)
    code = args.func(args)
    cap = capsys.readouterr()
    return code, cap.out, cap.err


def test_secret_prints_the_value_only_with_reveal(capsys) -> None:
    code, out, err = _argparse_err(["secret", "--product", PRODUCT, "proxy.subscriptionUrl"], _factory(), capsys)
    assert code == 2 and out == "" and "vpn.example.com" not in err
    assert "secret proxy.subscriptionUrl --reveal" in " ".join(err.split())
    code, out, _ = _argparse_err(["secret", "--product", PRODUCT, "proxy.subscriptionUrl", "--json"], _factory(), capsys)
    assert code == 0 and json.loads(out)["present"] is True and "vpn.example.com" not in out
    code, out, _ = _argparse_err(["secret", "--product", PRODUCT, "proxy.subscriptionUrl", "--reveal"], _factory(), capsys)
    assert code == 0 and out == "https://vpn.example.com/sub/abc\n"


def test_secret_and_mint_values_never_reach_a_ci_log(capsys, monkeypatch) -> None:
    """Printed raw for a script (``--reveal``), a secret or a minted token a line of which a CI runner
    would obey (GitHub Actions, Azure Pipelines, TeamCity) is withheld unless
    ``--allow-workflow-commands``; ``--json`` and a run without ``--reveal`` never carry the value."""
    # NEL (U+0085) too: GitHub's runner trims it (.NET TrimStart) before it looks for ``::``.
    hostile = "x\n::add-mask::y\n##vso[task.setvariable variable=a]b\n##teamcity[buildStatus text='c']\n\u0085::set-output name=d::e"
    for name, value in (("GITHUB_ACTIONS", "true"), ("TF_BUILD", "True"), ("TEAMCITY_VERSION", "2024.12")):
        monkeypatch.setenv(name, value)

    class _Token:
        token = hostile
        expiresAt = 1

    def factory(opts: core.ClientOptions):
        c = _factory()(opts)
        c.config.get_secret = lambda key: hostile
        c.config.mint_token = lambda recipe: _Token()
        return c

    parts = ("add-mask", "##vso[", "setvariable", "##teamcity[", "buildStatus", "set-output")
    for argv in (["secret", "--product", PRODUCT, "api.key"], ["mint", "--product", PRODUCT, "cdn"]):
        for extra in ([], ["--json"], ["--reveal"]):
            code, out, err = _argparse_err(argv + extra, factory, capsys)
            for part in parts:
                assert part not in out, (argv, extra, out)
            assert code == (0 if extra == ["--json"] else 2 if not extra else 1), (argv, extra, out, err)
        # Asked for, by name: the value goes out byte for byte.
        code, out, _ = _argparse_err(argv + ["--reveal", "--allow-workflow-commands"], factory, capsys)
        assert code == 0 and out == hostile + "\n"


def test_update_and_packs_explain_a_missing_configuration(capsys) -> None:
    code, out = _argparse(["update", "--product", PRODUCT, "download", "--to", "x"], _factory(), capsys)
    assert code == 1 and "Updates aren" in out
    code, out = _argparse(["packs", "--product", PRODUCT], _factory(), capsys)
    assert code == 1 and "content stamp" in out


def test_boot_prints_stages(capsys) -> None:
    code, out = _argparse(["boot", "--product", PRODUCT], _factory(), capsys)
    assert code == 0 and C("boot.ready") in out
    code, out = _argparse(["boot", "--product", PRODUCT, "--json"], _factory(), capsys)
    objs = [json.loads(ln) for ln in out.strip().splitlines()]
    assert {"v": 1, "command": "boot", "event": "stage", "stage": "gate"} in objs
    assert objs[-1]["event"] == "result" and objs[-1]["outcome"] == "ready"


def test_click_runs_the_table_verbs() -> None:
    pytest.importorskip("click")
    from click.testing import CliRunner

    from polaris_key.cli.click_cli import polaris_click_group

    group = polaris_click_group(client_factory=_factory(), verbs="all")
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

    app = polaris_typer_app(client_factory=_factory(), verbs="all")
    r = CliRunner().invoke(app, ["config", "list", "--product", PRODUCT])
    assert r.exit_code == 0, r.output
    assert "run.concurrency" in r.output
    r = CliRunner().invoke(app, ["offline-request", "--product", PRODUCT, "--no-qr"])
    assert r.exit_code == 0 and C("offlineActivation.request") in r.output


def test_usage_results_carry_usage_and_message_like_the_node_kit(capsys) -> None:
    """``devices rename`` with no id, and ``activate --json`` with no key: exit 2, ``error: usage``,
    the ``usage`` line and a ``message`` (the Node kit's fields)."""
    code, out = _argparse(["devices", "--product", PRODUCT, "--json", "rename"], _factory(), capsys)
    r = json.loads(out.strip().splitlines()[-1])
    assert code == 2 and r["error"] == "usage"
    assert r["usage"].endswith("devices rename <deviceId> [label...]") and r["message"] == r["usage"]
    code, out = _argparse(["activate", "--product", PRODUCT, "--json"], _factory(activated=False), capsys)
    r = json.loads(out.strip().splitlines()[-1])
    assert code == 2 and r["error"] == "usage"
    assert r["usage"].endswith(" activate") and r["message"]


def test_a_malformed_key_is_refused_locally_without_a_request(capsys) -> None:
    """Keys start with pkey_: exit 1 with the kit's sentence, as the Node kit, and no request."""
    hits: list = []
    base = _worker()

    def spy(r: httpx.Request) -> httpx.Response:
        hits.append(r.url.path)
        return base(r)

    def factory(opts: core.ClientOptions):
        return make_client(spy, expected_services=["license", "config"])

    code, out = _argparse(["activate", "--product", PRODUCT, "not-a-key"], factory, capsys)
    assert code == 1 and C("part.keyField.malformed") in out and "Keys start with pkey_" in out
    assert not any("activate" in p for p in hits)
    code, out = _argparse(["activate", "--product", PRODUCT, "--json", "not-a-key"], factory, capsys)
    r = json.loads(out.strip().splitlines()[-1])
    assert code == 1 and r["kind"] == "malformed" and r["code"] is None
    assert "not-a-key" not in out
