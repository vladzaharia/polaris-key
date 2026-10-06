# @pkey-feature ui.cli
"""Tests for the composable CLI command hooks.

The ``core`` commands are exercised against a tiny *fake* client that duck-types only the
surface the commands touch — no network, no real ``PolarisKeyClient``. The argparse / click /
typer hooks are then wired against a factory that returns that fake client, so each
framework adapter is verified to dispatch into the shared core. click / typer tests skip
gracefully if the optional extra is missing.

v3 adds two verbs to every adapter — ``register`` (devices) and ``import-bundle`` (core) —
and the ``--service`` flag that carries the D-21 capability expectation.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import pytest

from polaris_key.cli import core
from polaris_key.core.errors import PolarisError
from polaris_key.core.models import AllowedRange
from polaris_key.devices.client import RegisterClosed, RegisterOk
from polaris_key.core.store import StoreDegraded, StoreStatus
from polaris_key.license.endpoints import (
    ActivationDeviceLimit,
    ActivationFingerprintRequired,
    ActivationOk,
    ActivationUnauthorized,
)


# ── A minimal fake client ─────────────────────────────────────────────────────────────
@dataclass
class _State:
    status: str = "ok"
    graceUntil: Optional[int] = None
    allowedRange: Optional[AllowedRange] = None


class _FakeProfile:
    def __init__(self, name: str, email: str) -> None:
        self.name = name
        self.email = email


@dataclass
class _ImportResult:
    bundleId: str
    imported: List[str]


class _FakeLicense:
    def __init__(self, owner: "FakeClient") -> None:
        self._owner = owner

    def activate_with_key(self, key: str) -> Any:
        self._owner.activated_key = key
        return self._owner._activation_result

    def enroll(self) -> Any:
        self._owner.enrolled = True
        return self._owner._activation_result

    def deactivate(self) -> None:
        self._owner.deactivated = True

    def get_profile(self):
        return self._owner._profile


class _FakeConfig:
    def __init__(self, owner: "FakeClient") -> None:
        self._owner = owner

    def get_config(self, key: str, fallback: Any = None) -> Any:
        return self._owner._config.get(key, fallback)

    def get_config_source(self, key: str) -> str:
        return self._owner._sources.get(key, "fallback")


class _FakeDevices:
    def __init__(self, owner: "FakeClient") -> None:
        self._owner = owner

    def register(self) -> Any:
        self._owner.registered = True
        return self._owner._register_result


class FakeClient:
    """Duck-types the subset of ``PolarisKeyClient`` the core commands use."""

    def __init__(
        self,
        *,
        activation_result: Any = None,
        register_result: Any = None,
        state: Optional[_State] = None,
        licensed: bool = True,
        profile: Optional[_FakeProfile] = None,
        config: Optional[Dict[str, Any]] = None,
        sources: Optional[Dict[str, str]] = None,
        bundle_error: Optional[PolarisError] = None,
    ) -> None:
        self._activation_result = (
            activation_result
            if activation_result is not None
            else ActivationOk(token="pkeyt_t", schemaVersion=4)
        )
        self._register_result = (
            register_result
            if register_result is not None
            else RegisterOk(token="pkeyt_t", deviceId="dev-123")
        )
        self._state = state or _State()
        self._licensed = licensed
        self._profile = profile
        self._config = config or {}
        self._sources = sources or {}
        self._bundle_error = bundle_error
        self.closed = False
        self.deactivated = False
        self.registered = False
        self.enrolled = False
        self.synced = False
        self.imported: Optional[str] = None
        self.license = _FakeLicense(self)
        self.config = _FakeConfig(self)
        self.devices = _FakeDevices(self)

    def status(self, now: Optional[int] = None) -> _State:
        return self._state

    def is_licensed(self, now: Optional[int] = None) -> bool:
        return self._licensed

    def sync(self, *, force: bool = False) -> None:
        self.synced = True

    def import_bundle(self, jws: str, now: Optional[int] = None) -> _ImportResult:
        if self._bundle_error is not None:
            raise self._bundle_error
        self.imported = jws
        return _ImportResult(bundleId="B1", imported=["license"])

    def close(self) -> None:
        self.closed = True


def _factory_for(client: FakeClient) -> core.ClientFactory:
    def factory(opts: core.ClientOptions) -> Any:
        factory.opts = opts  # type: ignore[attr-defined]
        return client

    return factory


# ── core.parse_trust ──────────────────────────────────────────────────────────────────
def test_parse_trust_ok():
    assert core.parse_trust(["a=1", "b=2"]) == {"a": "1", "b": "2"}
    assert core.parse_trust(None) == {}


def test_parse_trust_rejects_bad_pair():
    with pytest.raises(ValueError):
        core.parse_trust(["no-equals"])


# ── core commands ─────────────────────────────────────────────────────────────────────
def test_activate_ok():
    c = FakeClient(state=_State(status="ok"))
    r = core.activate(c, "KEY-123")
    assert r.code == 0 and "Activated" in r.lines[0]
    assert c.activated_key == "KEY-123"


def test_activate_device_limit():
    c = FakeClient(activation_result=ActivationDeviceLimit(limit=3, deviceCount=3))
    r = core.activate(c, "KEY")
    assert r.code == 1
    assert "device limit reached" in r.lines[0] and "3/3" in r.lines[0]


def test_activate_unauthorized():
    c = FakeClient(activation_result=ActivationUnauthorized())
    r = core.activate(c, "KEY")
    assert r.code == 1 and "invalid or revoked" in r.lines[0]


def test_enroll_ok():
    c = FakeClient(state=_State(status="ok"))
    r = core.enroll(c)
    assert r.code == 0 and "Enrolled" in r.lines[0]
    assert c.enrolled is True


def test_register_syncs_and_reports():
    c = FakeClient(state=_State(status="ok"))
    r = core.register(c)
    assert r.code == 0
    assert "Registered device dev-123" in r.lines[0]
    assert c.registered is True and c.synced is True


def test_register_closed_is_reported_not_retried():
    c = FakeClient(register_result=RegisterClosed())
    r = core.register(c)
    assert r.code == 1
    assert "keyless registration" in r.lines[0]
    assert c.synced is False, "a refusal must not be retried against activate"


def test_status_licensed_with_profile():
    c = FakeClient(
        state=_State(status="ok", graceUntil=123),
        licensed=True,
        profile=_FakeProfile("Grace Hopper", "grace@example.com"),
    )
    r = core.status(c)
    assert r.code == 0
    assert r.lines[0] == "Status: ok"
    assert any("Grace until (epoch): 123" in ln for ln in r.lines)
    assert any("Grace Hopper" in ln for ln in r.lines)
    assert r.lines[-1] == "Usable: True"


def test_status_shows_the_allowed_range_when_blocked():
    c = FakeClient(
        state=_State(status="version-too-old", allowedRange=AllowedRange(min="2.0.0")),
        licensed=False,
    )
    r = core.status(c)
    assert r.code == 1
    assert any("min=2.0.0" in ln for ln in r.lines)


def test_status_unlicensed_nonzero():
    c = FakeClient(state=_State(status="expired"), licensed=False)
    assert core.status(c).code == 1


def test_status_not_applicable_is_zero():
    c = FakeClient(state=_State(status="not-applicable"), licensed=True)
    r = core.status(c)
    assert r.code == 0 and r.lines[0] == "Status: not-applicable"


# ── P1b-09: the Linux enrol hint and the token-store line ─────────────────────────────
def test_enroll_fingerprint_required_on_linux_names_the_machine_id_remedy():
    c = FakeClient(activation_result=ActivationFingerprintRequired())
    r = core.enroll(c, platform="linux")
    assert r.code == 1
    assert r.lines[0].startswith("Enrollment failed")
    assert core.LINUX_NO_MACHINE_ID_HINT in r.lines
    assert "/etc/machine-id" in core.LINUX_NO_MACHINE_ID_HINT


def test_enroll_fingerprint_required_elsewhere_has_no_hint():
    c = FakeClient(activation_result=ActivationFingerprintRequired())
    r = core.enroll(c, platform="darwin")
    assert r.code == 1
    assert core.LINUX_NO_MACHINE_ID_HINT not in r.lines


def test_activation_fingerprint_required_on_linux_has_no_enrol_hint():
    c = FakeClient(activation_result=ActivationFingerprintRequired())
    r = core.activate(c, "KEY")
    assert core.LINUX_NO_MACHINE_ID_HINT not in r.lines


def test_status_prints_the_token_store_line():
    c = FakeClient(state=_State(status="ok"))
    c.store_status = lambda: StoreStatus(  # type: ignore[attr-defined]
        "file", StoreDegraded("keyring-unavailable", "no keyring extra")
    )
    r = core.status(c)
    assert r.lines[-1] == "Token store: file (degraded: keyring-unavailable: no keyring extra)"
    c.store_status = lambda: StoreStatus("keyring")  # type: ignore[attr-defined]
    assert core.status(c).lines[-1] == "Token store: keyring"


def test_status_without_store_status_prints_no_store_line():
    c = FakeClient(state=_State(status="ok"))
    assert not any(ln.startswith("Token store") for ln in core.status(c).lines)


def test_config_layered_value():
    c = FakeClient(config={"run.concurrency": 4}, sources={"run.concurrency": "enforced"})
    r = core.config(c, "run.concurrency")
    assert r.code == 0
    assert "run.concurrency = 4" in r.lines[0] and "enforced" in r.lines[0]


def test_config_fallback():
    c = FakeClient()
    r = core.config(c, "missing.key", "DEFAULT")
    assert "missing.key = 'DEFAULT'" in r.lines[0] and "fallback" in r.lines[0]


def test_import_bundle_ok_and_refusal():
    c = FakeClient(state=_State(status="ok"))
    r = core.import_bundle(c, "a.b.c")
    assert r.code == 0 and "Imported bundle B1 (license)" in r.lines[0]
    assert c.imported == "a.b.c"

    refused = FakeClient(
        bundle_error=PolarisError("bundle-claims-rejected", "wrong device")
    )
    r2 = core.import_bundle(refused, "a.b.c")
    assert r2.code == 1
    assert "Bundle import failed: wrong device" in r2.lines[0]
    assert "bundle-claims-rejected" in r2.lines[1]


def test_run_command_always_closes():
    c = FakeClient()
    core.run_command(_factory_for(c), core.ClientOptions(product="djdl"), core.deactivate)
    assert c.closed is True and c.deactivated is True


# ── argparse hook ─────────────────────────────────────────────────────────────────────
def _argparse_app(client: FakeClient) -> argparse.ArgumentParser:
    from polaris_key.cli.argparse_cli import register_argparse

    parser = argparse.ArgumentParser(prog="host")
    sub = parser.add_subparsers(dest="command", required=True)
    register_argparse(sub, client_factory=_factory_for(client))
    return parser


def test_register_argparse_wires_every_v3_subcommand():
    parser = _argparse_app(FakeClient())
    actions = [a for a in parser._actions if isinstance(a, argparse._SubParsersAction)]
    assert actions, "expected a subparsers action"
    names = set(actions[0].choices)
    expected = {
        verb for verbs in core.SERVICE_COMMANDS.values() for verb in verbs
    }
    assert expected <= names, f"missing {expected - names}"


def test_register_argparse_dispatch_activate(capsys):
    client = FakeClient()
    parser = _argparse_app(client)
    args = parser.parse_args(["activate", "--product", "djdl", "KEY-9"])
    assert args.func(args) == 0
    assert client.activated_key == "KEY-9"
    assert client.closed is True
    assert "Activated" in capsys.readouterr().out


def test_register_argparse_dispatch_register(capsys):
    client = FakeClient()
    parser = _argparse_app(client)
    args = parser.parse_args(["register", "--product", "djdl"])
    assert args.func(args) == 0
    assert client.registered is True
    assert "Registered device dev-123" in capsys.readouterr().out


def test_register_argparse_dispatch_enroll(capsys):
    client = FakeClient()
    parser = _argparse_app(client)
    args = parser.parse_args(["enroll", "--product", "djdl"])
    assert args.func(args) == 0
    assert client.enrolled is True
    assert "Enrolled" in capsys.readouterr().out


def test_register_argparse_dispatch_config(capsys):
    client = FakeClient(config={"ui.theme": "dark"}, sources={"ui.theme": "remote-default"})
    parser = _argparse_app(client)
    args = parser.parse_args(["config", "--product", "djdl", "ui.theme"])
    assert args.func(args) == 0
    out = capsys.readouterr().out
    assert "ui.theme = 'dark'" in out and "remote-default" in out


def test_register_argparse_dispatch_import_bundle(tmp_path, capsys):
    client = FakeClient()
    path = tmp_path / "offline.pkeybundle"
    path.write_text("a.b.c\n")
    parser = _argparse_app(client)
    args = parser.parse_args(["import-bundle", "--product", "djdl", str(path)])
    assert args.func(args) == 0
    assert client.imported == "a.b.c"
    assert "Imported bundle B1" in capsys.readouterr().out


def test_register_argparse_import_bundle_reads_stdin(monkeypatch, capsys):
    import io

    client = FakeClient()
    parser = _argparse_app(client)
    monkeypatch.setattr("sys.stdin", io.StringIO("x.y.z\n"))
    args = parser.parse_args(["import-bundle", "--product", "djdl", "-"])
    assert args.func(args) == 0
    assert client.imported == "x.y.z"


def test_register_argparse_passes_trust_and_services_to_the_factory():
    client = FakeClient()
    factory = _factory_for(client)
    parser = argparse.ArgumentParser(prog="host")
    sub = parser.add_subparsers(dest="command", required=True)
    from polaris_key.cli.argparse_cli import register_argparse

    register_argparse(sub, client_factory=factory)
    args = parser.parse_args(
        [
            "status",
            "--product",
            "djdl",
            "--trust",
            "kid1=raw1",
            "--trust",
            "kid2=raw2",
            "--service",
            "config",
            "--service",
            "release",
        ]
    )
    args.func(args)
    assert factory.opts.trust == {"kid1": "raw1", "kid2": "raw2"}  # type: ignore[attr-defined]
    assert factory.opts.product == "djdl"  # type: ignore[attr-defined]
    assert factory.opts.expected_services == ["config", "release"]  # type: ignore[attr-defined]


def test_register_argparse_rejects_a_malformed_trust_pair():
    parser = _argparse_app(FakeClient())
    args = parser.parse_args(["status", "--product", "djdl", "--trust", "no-equals"])
    with pytest.raises(SystemExit):
        args.func(args)


def test_the_default_parser_is_named_polaris_key():
    from polaris_key.cli.argparse_cli import build_parser

    assert build_parser().prog == "polaris-key"


# ── click hook ────────────────────────────────────────────────────────────────────────
def test_polaris_click_group_builds_and_invokes():
    pytest.importorskip("click")
    import click
    from click.testing import CliRunner

    from polaris_key.cli.click_cli import polaris_click_group

    client = FakeClient(config={"run.concurrency": 4}, sources={"run.concurrency": "enforced"})
    group = polaris_click_group(client_factory=_factory_for(client))

    @click.group()
    def app() -> None:
        pass

    app.add_command(group)

    runner = CliRunner()
    result = runner.invoke(app, ["polaris", "config", "--product", "djdl", "run.concurrency"])
    assert result.exit_code == 0, result.output
    assert "run.concurrency = 4" in result.output and "enforced" in result.output


def test_polaris_click_group_exposes_every_v3_verb():
    pytest.importorskip("click")
    from polaris_key.cli.click_cli import polaris_click_group

    group = polaris_click_group(client_factory=_factory_for(FakeClient()))
    expected = {verb for verbs in core.SERVICE_COMMANDS.values() for verb in verbs}
    assert expected <= set(group.commands)


def test_polaris_click_group_register_and_activate_exit_codes():
    pytest.importorskip("click")
    from click.testing import CliRunner

    from polaris_key.cli.click_cli import polaris_click_group

    runner = CliRunner()
    ok = FakeClient(state=_State(status="ok"))
    result = runner.invoke(
        polaris_click_group(client_factory=_factory_for(ok)),
        ["register", "--product", "djdl"],
    )
    assert result.exit_code == 0, result.output
    assert "Registered device dev-123" in result.output

    bad = FakeClient(activation_result=ActivationUnauthorized())
    result = runner.invoke(
        polaris_click_group(client_factory=_factory_for(bad)),
        ["activate", "--product", "djdl", "BADKEY"],
    )
    assert result.exit_code == 1
    assert "invalid or revoked" in result.output


def test_polaris_click_group_import_bundle(tmp_path):
    pytest.importorskip("click")
    from click.testing import CliRunner

    from polaris_key.cli.click_cli import polaris_click_group

    client = FakeClient()
    path = tmp_path / "offline.pkeybundle"
    path.write_text("a.b.c")
    runner = CliRunner()
    result = runner.invoke(
        polaris_click_group(client_factory=_factory_for(client)),
        ["import-bundle", "--product", "djdl", str(path)],
    )
    assert result.exit_code == 0, result.output
    assert client.imported == "a.b.c"


# ── typer hook ────────────────────────────────────────────────────────────────────────
def test_polaris_typer_app_builds_and_invokes():
    pytest.importorskip("typer")
    import typer
    from typer.testing import CliRunner

    from polaris_key.cli.typer_cli import polaris_typer_app

    client = FakeClient(
        state=_State(status="ok"),
        licensed=True,
        profile=_FakeProfile("Ada Lovelace", "ada@example.com"),
    )
    sub = polaris_typer_app(client_factory=_factory_for(client))

    app = typer.Typer()
    app.add_typer(sub, name="polaris")

    runner = CliRunner()
    result = runner.invoke(app, ["polaris", "status", "--product", "djdl"])
    assert result.exit_code == 0, result.output
    assert "Status: ok" in result.output and "Ada Lovelace" in result.output


def test_polaris_typer_app_config():
    pytest.importorskip("typer")
    from typer.testing import CliRunner

    from polaris_key.cli.typer_cli import polaris_typer_app

    client = FakeClient(config={"x": "y"}, sources={"x": "local"})
    runner = CliRunner()
    result = runner.invoke(
        polaris_typer_app(client_factory=_factory_for(client)),
        ["config", "--product", "djdl", "x"],
    )
    assert result.exit_code == 0, result.output
    assert "x = 'y'" in result.output and "local" in result.output


def test_polaris_typer_app_register_and_import_bundle(tmp_path):
    pytest.importorskip("typer")
    from typer.testing import CliRunner

    from polaris_key.cli.typer_cli import polaris_typer_app

    runner = CliRunner()
    client = FakeClient(state=_State(status="ok"))
    result = runner.invoke(
        polaris_typer_app(client_factory=_factory_for(client)),
        ["register", "--product", "djdl"],
    )
    assert result.exit_code == 0, result.output
    assert client.registered is True

    other = FakeClient()
    path = tmp_path / "offline.pkeybundle"
    path.write_text("a.b.c")
    result = runner.invoke(
        polaris_typer_app(client_factory=_factory_for(other)),
        ["import-bundle", "--product", "djdl", str(path)],
    )
    assert result.exit_code == 0, result.output
    assert other.imported == "a.b.c"


def test_the_cli_barrel_re_exports_all_three_adapters():
    from polaris_key import cli

    assert callable(cli.register_argparse)
    assert callable(cli.polaris_click_group)
    assert callable(cli.polaris_typer_app)
    assert callable(cli.main)
