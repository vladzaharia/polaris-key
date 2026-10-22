# @pkey-feature ui.cli.mount
"""What a developer meets when adding the verbs to a host CLI: a config that names the command that
fixes it, a skip that is silent for the people using the program, an unexpected failure that is never
a traceback, and a usage error that still ends in a ``--json`` result line (the Node kit's
``test/cli/cliDx.test.ts`` runs the same cases)."""

from __future__ import annotations

import json
from typing import Any, Dict, List

import pytest

from polaris_key.cli import mount
from polaris_key.cli.argparse_cli import GroupedHelpParser, register_argparse
from polaris_key.cli.mount import check_config

PIN = "A" * 43
GOOD: Dict[str, Any] = {"product_slug": "tidewater", "base_url": "https://key.plrs.im", "trust": {"k1": PIN}}
FIX = "pkey sdk --lang python --write"


@pytest.mark.parametrize(
    "config, says",
    [
        (None, "config is missing"),
        ({**GOOD, "product_slug": ""}, "no product_slug"),
        ({"product_slug": "tw"}, "has no trust"),
        ({**GOOD, "trust": {}}, "no license could verify"),
        ({**GOOD, "trust": {"<your-signing-key-id>": "<x>"}}, "not a raw Ed25519 public key"),
        ({**GOOD, "base_url": "nope"}, "not an http(s) origin"),
    ],
    ids=["none", "no slug", "no trust", "no pins", "placeholder pin", "bad base url"],
)
def test_a_config_the_cli_cannot_work_from_says_what_to_run(config: Any, says: str) -> None:
    with pytest.raises(ValueError) as caught:
        check_config(config)
    assert caught.value.code == "polaris-bad-config"  # type: ignore[attr-defined]
    assert says in str(caught.value) and FIX in str(caught.value)


def test_the_generated_shape_passes() -> None:
    check_config(GOOD)
    check_config({k: v for k, v in GOOD.items() if k != "base_url"})


def test_it_fails_the_registration_not_the_first_verb() -> None:
    parser = GroupedHelpParser(prog="tidewater")
    with pytest.raises(ValueError, match="pkey sdk --lang python --write"):
        register_argparse(parser.add_subparsers(dest="command"), config={"product_slug": "tw"}, version="1.0.0")


def test_a_collision_names_all_three_fixes() -> None:
    with pytest.raises(mount.VerbCollisionError) as caught:
        mount.plan_mount(["status"], prog="tidewater")
    text = str(caught.value)
    assert 'namespace="license"' in text and "out of verbs" in text and 'on_collision="skip"' in text


def _host(**mount_options: Any) -> GroupedHelpParser:
    parser = GroupedHelpParser(prog="tidewater")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("status", help="Host status")
    register_argparse(sub, config=GOOD, version="1.0.0", on_collision="skip", **mount_options)
    return parser


def test_a_skipped_verb_is_silent_unless_the_developer_asks(capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DEBUG", raising=False)
    skipped: List[List[str]] = []
    _host(on_skip=skipped.append)
    assert skipped == [["status"]]
    assert capsys.readouterr().err == ""
    monkeypatch.setenv("DEBUG", "polaris")
    _host()
    assert "skipped status" in capsys.readouterr().err
    warned: List[str] = []
    monkeypatch.delenv("DEBUG")
    _host(warn=warned.append)
    assert len(warned) == 1 and capsys.readouterr().err == ""


def _broken_host() -> GroupedHelpParser:
    def broken(opts: Any) -> Any:
        raise RuntimeError("boom from the host's factory")

    parser = GroupedHelpParser(prog="tidewater")
    register_argparse(parser.add_subparsers(dest="command", required=True), broken, verbs=["status"])
    return parser


def test_an_unexpected_failure_is_a_screen_not_a_traceback(capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DEBUG", raising=False)
    args = _broken_host().parse_args(["status", "--product", "tw"])
    assert args.func(args) == 1
    out = capsys.readouterr()
    assert "boom" not in out.out + out.err and "Traceback" not in out.out + out.err
    assert out.out.strip(), "the generic screen"
    monkeypatch.setenv("DEBUG", "polaris")
    assert args.func(args) == 1
    assert "boom from the host's factory" in capsys.readouterr().err


def _result(text: str) -> Dict[str, Any]:
    return json.loads(text.strip().splitlines()[-1])


def test_argparse_usage_errors_end_in_a_result_line(capsys: pytest.CaptureFixture) -> None:
    parser = _host()
    for argv in (["login", "--bogus", "--json"], ["login", "extra", "--json"], ["nope", "--json"]):
        with pytest.raises(SystemExit) as e:
            parser.parse_args(argv)
        assert e.value.code == 2
        last = _result(capsys.readouterr().out)
        assert last["event"] == "result" and last["error"] == "usage" and last["exit"] == 2 and last["ok"] is False
    with pytest.raises(SystemExit):
        parser.parse_args(["login", "--bogus"])
    assert capsys.readouterr().out == ""


def test_click_usage_errors_end_in_a_result_line() -> None:
    click = pytest.importorskip("click")
    from click.testing import CliRunner

    from polaris_key.cli.click_cli import register_click

    host = click.Group("tidewater")
    register_click(host, config=GOOD, version="1.0.0")
    res = CliRunner().invoke(host, ["login", "--bogus", "--json"])
    assert res.exit_code == 2
    last = _result(res.output)
    assert last["command"] == "login" and last["error"] == "usage" and last["exit"] == 2


def test_typer_usage_errors_end_in_a_result_line() -> None:
    typer = pytest.importorskip("typer")
    from typer.testing import CliRunner

    from polaris_key.cli.typer_cli import register_typer

    host = typer.Typer()
    host.command(name="export")(lambda: None)
    register_typer(host, config=GOOD, version="1.0.0")
    res = CliRunner().invoke(host, ["login", "--bogus", "--json"])
    assert res.exit_code == 2
    last = _result(res.output)
    assert last["command"] == "login" and last["error"] == "usage" and last["exit"] == 2
