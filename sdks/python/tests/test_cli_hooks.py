"""Tests for the composable CLI command hooks.

The ``core`` commands are exercised against a tiny *fake* client that duck-types only the
methods the commands call — no network, no real ``PolarisKeyClient``. The argparse / click /
typer hooks are then wired against a factory that returns that fake client, so each
framework adapter is verified to dispatch into the shared core. click / typer tests skip
gracefully if the optional extra is missing.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Any, Dict, Optional

import pytest

from polaris_key.cli import core
from polaris_key.endpoints import EnrollMachineLimit, EnrollOk, EnrollUnauthorized


# ── A minimal fake client ─────────────────────────────────────────────────────────────
@dataclass
class _State:
    status: str = "ok"
    graceUntil: Optional[int] = None
    allowedRange: Optional[Any] = None


class _FakeProfile:
    def __init__(self, name: str, email: str) -> None:
        self.name = name
        self.email = email


class FakeClient:
    """Duck-types the subset of ``PolarisKeyClient`` the core commands use."""

    def __init__(
        self,
        *,
        enroll_result: Any = None,
        state: Optional[_State] = None,
        licensed: bool = True,
        profile: Optional[_FakeProfile] = None,
        config: Optional[Dict[str, Any]] = None,
        sources: Optional[Dict[str, str]] = None,
    ) -> None:
        self._enroll_result = enroll_result if enroll_result is not None else EnrollOk(token="t", schemaVersion=1)
        self._state = state or _State()
        self._licensed = licensed
        self._profile = profile
        self._config = config or {}
        self._sources = sources or {}
        self.closed = False
        self.deactivated = False

    def activate_with_key(self, key: str) -> Any:
        self.activated_key = key
        return self._enroll_result

    def deactivate(self) -> None:
        self.deactivated = True

    def status(self, now: Optional[int] = None) -> _State:
        return self._state

    def is_licensed(self, now: Optional[int] = None) -> bool:
        return self._licensed

    def get_profile(self) -> Optional[_FakeProfile]:
        return self._profile

    def get_config(self, key: str, fallback: Any = None) -> Any:
        return self._config.get(key, fallback)

    def get_config_source(self, key: str) -> str:
        return self._sources.get(key, "fallback")

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
    c = FakeClient(enroll_result=EnrollOk(token="t", schemaVersion=1), state=_State(status="ok"))
    r = core.activate(c, "KEY-123")
    assert r.code == 0
    assert "Activated" in r.lines[0]
    assert c.activated_key == "KEY-123"


def test_activate_machine_limit():
    c = FakeClient(enroll_result=EnrollMachineLimit(limit=3, machineCount=3))
    r = core.activate(c, "KEY")
    assert r.code == 1
    assert "device limit reached" in r.lines[0]
    assert "3/3" in r.lines[0]


def test_activate_unauthorized():
    c = FakeClient(enroll_result=EnrollUnauthorized())
    r = core.activate(c, "KEY")
    assert r.code == 1
    assert "invalid or revoked" in r.lines[0]


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


def test_status_unlicensed_nonzero():
    c = FakeClient(state=_State(status="expired"), licensed=False)
    r = core.status(c)
    assert r.code == 1


def test_config_layered_value():
    c = FakeClient(
        config={"run.concurrency": 4},
        sources={"run.concurrency": "enforced"},
    )
    r = core.config(c, "run.concurrency")
    assert r.code == 0
    assert "run.concurrency = 4" in r.lines[0]
    assert "enforced" in r.lines[0]


def test_config_fallback():
    c = FakeClient()
    r = core.config(c, "missing.key", "DEFAULT")
    assert "missing.key = 'DEFAULT'" in r.lines[0]
    assert "fallback" in r.lines[0]


def test_run_command_always_closes():
    c = FakeClient()
    core.run_command(_factory_for(c), core.ClientOptions(product="djdl"), core.deactivate)
    assert c.closed is True
    assert c.deactivated is True


# ── argparse hook ─────────────────────────────────────────────────────────────────────
def _argparse_app(client: FakeClient) -> argparse.ArgumentParser:
    from polaris_key.cli.argparse_cli import register_argparse

    parser = argparse.ArgumentParser(prog="host")
    sub = parser.add_subparsers(dest="command", required=True)
    register_argparse(sub, client_factory=_factory_for(client))
    return parser


def test_register_argparse_wires_subcommands():
    parser = _argparse_app(FakeClient())
    # The four Polaris subcommands are registered on the host's subparsers.
    actions = [a for a in parser._actions if isinstance(a, argparse._SubParsersAction)]
    assert actions, "expected a subparsers action"
    names = set(actions[0].choices)
    assert {"activate", "deactivate", "status", "config"} <= names


def test_register_argparse_dispatch_activate(capsys):
    client = FakeClient(enroll_result=EnrollOk(token="t", schemaVersion=1))
    parser = _argparse_app(client)
    args = parser.parse_args(["activate", "--product", "djdl", "KEY-9"])
    code = args.func(args)
    assert code == 0
    assert client.activated_key == "KEY-9"
    assert client.closed is True
    assert "Activated" in capsys.readouterr().out


def test_register_argparse_dispatch_config(capsys):
    client = FakeClient(config={"ui.theme": "dark"}, sources={"ui.theme": "remote-default"})
    parser = _argparse_app(client)
    args = parser.parse_args(["config", "--product", "djdl", "ui.theme"])
    code = args.func(args)
    assert code == 0
    out = capsys.readouterr().out
    assert "ui.theme = 'dark'" in out
    assert "remote-default" in out


def test_register_argparse_passes_trust_to_factory():
    client = FakeClient()
    factory = _factory_for(client)
    parser = argparse.ArgumentParser(prog="host")
    sub = parser.add_subparsers(dest="command", required=True)
    from polaris_key.cli.argparse_cli import register_argparse

    register_argparse(sub, client_factory=factory)
    args = parser.parse_args(
        ["status", "--product", "djdl", "--trust", "kid1=raw1", "--trust", "kid2=raw2"]
    )
    args.func(args)
    assert factory.opts.trust == {"kid1": "raw1", "kid2": "raw2"}  # type: ignore[attr-defined]
    assert factory.opts.product == "djdl"  # type: ignore[attr-defined]


# ── click hook ────────────────────────────────────────────────────────────────────────
def test_polaris_click_group_builds_and_invokes():
    pytest.importorskip("click")
    from click.testing import CliRunner

    from polaris_key.cli.click_cli import polaris_click_group

    client = FakeClient(config={"run.concurrency": 4}, sources={"run.concurrency": "enforced"})
    group = polaris_click_group(client_factory=_factory_for(client))

    # Mountable onto a host app.
    import click

    @click.group()
    def app() -> None:
        pass

    app.add_command(group)

    runner = CliRunner()
    result = runner.invoke(
        app, ["polaris-key", "config", "--product", "djdl", "run.concurrency"]
    )
    assert result.exit_code == 0, result.output
    assert "run.concurrency = 4" in result.output
    assert "enforced" in result.output


def test_polaris_click_group_activate_exit_code():
    pytest.importorskip("click")
    from click.testing import CliRunner

    from polaris_key.cli.click_cli import polaris_click_group

    client = FakeClient(enroll_result=EnrollUnauthorized())
    group = polaris_click_group(client_factory=_factory_for(client))
    runner = CliRunner()
    result = runner.invoke(group, ["activate", "--product", "djdl", "BADKEY"])
    assert result.exit_code == 1
    assert "invalid or revoked" in result.output


# ── typer hook ────────────────────────────────────────────────────────────────────────
def test_polaris_typer_app_builds_and_invokes():
    pytest.importorskip("typer")
    from typer.testing import CliRunner

    from polaris_key.cli.typer_cli import polaris_typer_app

    client = FakeClient(
        state=_State(status="ok"),
        licensed=True,
        profile=_FakeProfile("Ada Lovelace", "ada@example.com"),
    )
    sub = polaris_typer_app(client_factory=_factory_for(client))

    # Mountable onto a host app.
    import typer

    app = typer.Typer()
    app.add_typer(sub, name="key")

    runner = CliRunner()
    result = runner.invoke(app, ["key", "status", "--product", "djdl"])
    assert result.exit_code == 0, result.output
    assert "Status: ok" in result.output
    assert "Ada Lovelace" in result.output


def test_polaris_typer_app_config():
    pytest.importorskip("typer")
    from typer.testing import CliRunner

    from polaris_key.cli.typer_cli import polaris_typer_app

    client = FakeClient(config={"x": "y"}, sources={"x": "local"})
    app = polaris_typer_app(client_factory=_factory_for(client))
    runner = CliRunner()
    result = runner.invoke(app, ["config", "--product", "djdl", "x"])
    assert result.exit_code == 0, result.output
    assert "x = 'y'" in result.output
    assert "local" in result.output
