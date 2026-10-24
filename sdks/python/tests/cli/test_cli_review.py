# @pkey-feature ui.cli.mount
"""UK-48's UX review round: the demo's update verbs and pane, the program name in click and typer
hosts, the default mount's help per framework, and the gate's states (cannot decide, the reason
before the prompt, Esc, checking)."""

from __future__ import annotations

import asyncio
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, List

import pytest

from polaris_key.cli import gate, mount
from polaris_key.cli.argparse_cli import GroupedHelpParser, register_argparse
from polaris_key.cli.gate import require_license
from polaris_key.ui.terminal.exit import EXIT

from .golden_support import GOLDEN, check
from .test_cli_contract import KEY, _Keys, _terminal, plain
from .test_cli_gate import _client

EXAMPLES = Path(__file__).resolve().parents[4] / "examples"
HELP = GOLDEN / "scenes"
HOST = SimpleNamespace(product="tidewater", close=lambda: None)


def _demo() -> Any:
    sys.path.insert(0, str(EXAMPLES / "ui" / "terminal-python"))
    import importlib.util

    spec = importlib.util.spec_from_file_location("tidewater_demo", EXAMPLES / "ui" / "terminal-python" / "tidewater.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── B1: the demo's update verbs and pane ─────────────────────────────────────────────────────


def test_the_demo_runs_update_check_and_apply(capsys: pytest.CaptureFixture[str]) -> None:
    demo = _demo()
    assert demo.main(["update", "check"]) == 0
    out = capsys.readouterr().out
    assert "2.5 is available" in out and "tidewater.app/releases/2.5" in out
    assert demo.main(["update", "apply"]) == 1
    out = capsys.readouterr().out
    assert "Updates aren" in out and "tidewater.app/releases/2.5" in out
    assert demo.main(["update", "check", "--json"]) == 0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["url"] == "https://tidewater.app/releases/2.5"


def test_the_updates_pane_offers_the_download() -> None:
    pytest.importorskip("textual")
    from polaris_key.ui.terminal.textual_app import PolarisKeyApp

    fixtures = __import__("tidewater_fixtures", fromlist=["FixtureClient"])

    async def run() -> None:
        app = PolarisKeyApp(fixtures.FixtureClient(), scheme="dark")
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.press("down")
            await pilot.press("down")
            await pilot.pause()
            assert app.section == "updates"
            assert app.query_one("#pk-download") is not None
            assert not app.query("#pk-install")

    _demo()
    asyncio.run(run())


# ── B2: the program name ─────────────────────────────────────────────────────────────────────


def _gated_export(host: Any, kind: str) -> str:
    """Run a gated ``export`` in a click or typer host (a license that is needed) and return stderr."""
    import click.testing

    if kind == "typer":
        import typer
        from polaris_key.cli.typer_cli import register_typer

        app = typer.Typer(name="tidewater")

        @app.command()
        @require_license
        def export() -> None: ...

        register_typer(app, client=host)
        cmd = typer.main.get_command(app)
    else:
        import click
        from polaris_key.cli.click_cli import register_click

        @click.group("tidewater")
        def cmd() -> None: ...

        @cmd.command()
        @require_license
        def export() -> None: ...

        register_click(cmd, client=host)
    result = click.testing.CliRunner().invoke(cmd, ["export"], prog_name="tidewater")
    assert result.exit_code == 4, result.output
    return result.output


@pytest.mark.parametrize("kind", ["click", "typer"])
def test_a_host_s_fix_lines_name_the_host(kind: str) -> None:
    pytest.importorskip(kind)
    out = plain(_gated_export(_client("needs-activation", True), kind))
    assert "tidewater activate" in out and "polaris-key" not in out


def test_the_default_group_is_license_and_says_so(capsys: pytest.CaptureFixture[str]) -> None:
    click = pytest.importorskip("click")
    from polaris_key.cli.click_cli import polaris_click_group

    g = polaris_click_group(client=HOST)
    assert g.name == "license"
    host = click.Group("tidewater")
    host.add_command(g)
    ctx = click.Context(host, info_name="tidewater")
    text = host.get_help(ctx)
    assert "license" in text and "Activate, sign in, devices and updates" in text and "Polaris Key client" not in text


# ── B3: the documented default's help, per framework ─────────────────────────────────────────


def _help_at(columns: int, make: Any) -> str:
    import os

    old = os.environ.get("COLUMNS")
    os.environ["COLUMNS"] = str(columns)
    try:
        return plain(make(columns))
    finally:
        if old is None:
            os.environ.pop("COLUMNS", None)
        else:
            os.environ["COLUMNS"] = old


def _argparse_help(columns: int) -> str:
    import argparse

    p = argparse.ArgumentParser(prog="tidewater", formatter_class=lambda prog: argparse.HelpFormatter(prog, width=columns))
    sub = p.add_subparsers(dest="c")
    sub.add_parser("export", help="Export a mix")
    register_argparse(sub, client=HOST)
    return p.format_help()


def _click_help(columns: int) -> str:
    import click

    @click.group("tidewater", context_settings={"max_content_width": columns, "terminal_width": columns})
    def g() -> None: ...

    @g.command()
    def export() -> None:
        """Export a mix"""

    from polaris_key.cli.click_cli import register_click

    register_click(g, client=HOST)
    return g.get_help(click.Context(g, info_name="tidewater", terminal_width=columns, max_content_width=columns))


def _typer_help(columns: int) -> str:
    import typer
    import click.testing

    from polaris_key.cli.typer_cli import register_typer

    app = typer.Typer(name="tidewater")

    @app.command()
    def export() -> None:
        """Export a mix"""

    register_typer(app, client=HOST)
    # typer reads TERMINAL_WIDTH once, at import, so the width of the first test would stick for
    # every later one (B-119): set the module's width for this render.
    from typer import rich_utils

    old = rich_utils.MAX_WIDTH
    rich_utils.MAX_WIDTH = columns
    try:
        r = click.testing.CliRunner().invoke(typer.main.get_command(app), ["--help"], prog_name="tidewater", terminal_width=columns, env={"COLUMNS": str(columns), "NO_COLOR": "1"})
    finally:
        rich_utils.MAX_WIDTH = old
    return r.output


@pytest.mark.parametrize("columns", [32, 40, 80])
@pytest.mark.parametrize("framework", ["argparse", "click", "typer"])
def test_the_default_mount_help(framework: str, columns: int) -> None:
    if framework != "argparse":
        pytest.importorskip(framework)
    make = {"argparse": _argparse_help, "click": _click_help, "typer": _typer_help}[framework]
    text = _help_at(columns, make)
    # No service tags, no alias entries, no raw brace list, nothing past the terminal.
    for tag in ("[license]", "[identity]", "[devices]", "[update]", "==SUPPRESS=="):
        assert tag not in text
    assert "{" not in text
    assert "sign-in" not in text.replace("Sign in", "") and "sign-out" not in text
    check(HELP / f"help-{framework}-{columns}.txt", text)
    # Nothing is wider than the terminal, and a wide terminal gets a wide render (B-119).
    if framework == "typer":
        widest = max(len(ln) for ln in text.splitlines())
        assert widest <= columns and (columns < 80 or widest > 40)


def test_argparse_aliases_still_run() -> None:
    import argparse

    p = argparse.ArgumentParser(prog="tidewater")
    sub = p.add_subparsers(dest="c")
    register_argparse(sub, client=HOST)
    assert p.parse_args(["sign-in", "--json"]).func is not None and p.parse_args(["sign-out"]).func is not None


# ── S2–S5: the gate's states ─────────────────────────────────────────────────────────────────


def test_a_gate_that_cannot_decide_says_so_with_a_cross_and_no_fix() -> None:
    class Broken:
        product = "tidewater"

        def status(self) -> Any:
            raise RuntimeError("x")

    err = io.StringIO()
    assert gate.run_gate(Broken(), command="export", prog="tidewater", stderr=err, env={"TERM": "xterm"}) == 4
    text = plain(err.getvalue())
    # A failed check has no fix row (the cross itself is pinned by the gate rows and the scene): it is not a refusal the person can resolve (DL6).
    assert "Couldn't check your license" in text and "Signed out" not in text
    assert "tidewater status" not in text and "tidewater activate" not in text


def test_the_inline_flow_says_why_and_esc_draws_the_refusal() -> None:
    t = _terminal("export", interactive=True, keys=_Keys(["esc"]))
    t.err = io.StringIO()
    code = gate.run_gate(_client("expired", True), command="export", entitlement="export.pdf", prog="tidewater", terminal=t)
    assert code == EXIT.failed
    assert "export needs a license" in plain(t.device.out.getvalue())
    refusal = plain(t.err.getvalue())
    assert "License expired" in refusal and "tidewater activate" in refusal and "tidewater login" in refusal


def test_a_slow_check_says_it_is_checking(monkeypatch: pytest.MonkeyPatch) -> None:
    import time

    monkeypatch.setattr(gate, "CHECKING_AFTER_SECONDS", 0.05)
    state = {"s": "needs-activation"}

    class Slow:
        product = "tidewater"
        entitlements = SimpleNamespace(has=lambda n: False)

        def status(self) -> Any:
            return SimpleNamespace(status=state["s"])

        def sync(self) -> None:
            time.sleep(0.3)

    t = _terminal("export")
    t.err = io.StringIO()
    gate.run_gate(Slow(), command="export", prog="tidewater", terminal=t)
    assert "Checking your license" in plain(t.err.getvalue())
    quick = _terminal("export")
    quick.err = io.StringIO()
    gate.run_gate(_client("needs-activation", True), command="export", prog="tidewater", terminal=quick)
    assert "Checking your license" not in plain(quick.err.getvalue())


# ── S13: the masked entry fits narrow terminals ──────────────────────────────────────────────


@pytest.mark.parametrize("columns", [32, 40])
def test_the_key_entry_line_fits_with_its_cursor(columns: int) -> None:
    from polaris_key.ui.core.models import parse_key
    from polaris_key.ui.terminal import screens
    from polaris_key.ui.terminal.text import cell_len

    from .fixtures import kit
    from .golden_support import env

    k = kit(env("none", "unicode", columns, "dark"))
    for raw in (KEY, KEY[:20], "pkey_tidewater_"):
        lines = screens.key_entry(k, raw, parse_key(raw, final=False))
        assert all(cell_len(ln.text.rstrip()) <= columns for ln in lines), (columns, raw)


def test_the_update_screen_offers_only_the_verbs_the_host_mounted() -> None:
    # B-112: the fix rows follow the mount, as the gates do.
    from polaris_key.ui.core.models import UpdateView
    from polaris_key.ui.terminal import screens

    from .fixtures import _UPDATE, kit
    from .golden_support import env

    def shown(mounted):
        k = kit(env("none", "unicode", 80, "dark"))
        k.mounted = mounted
        v = UpdateView("UpdatePrompt", "available", **{**_UPDATE, "installable": True})
        return "\n".join(ln.text for ln in screens.update(k, v, "update"))

    everything = shown(None)
    assert "tidewater changelog" in everything and "tidewater update apply" in everything
    partial = shown(("update check", "update apply"))
    assert "changelog" not in partial and "tidewater update apply" in partial
    assert "changelog" not in shown(("update check",)) and "update apply" not in shown(("update check",))


def test_a_mistyped_command_names_itself_not_every_choice(capsys: pytest.CaptureFixture[str]) -> None:
    # B-117: argparse's "(choose from 'activate', 'enroll', ...)" list is gone.
    from polaris_key.cli.argparse_cli import main

    with pytest.raises(SystemExit) as e:
        main(["stats"])
    assert e.value.code == 2
    err = capsys.readouterr().err
    assert "'stats' is not a command" in err and "--help" in err and "choose from" not in err


def test_the_mint_fix_says_it_mints_and_the_key_file_titles_come_from_the_catalog() -> None:
    from polaris_key.ui.terminal import flows

    out = flows._hidden(_terminal("mint"), "cli.mint.hidden", "mint ci --reveal", {"recipe": "ci"}, reveal_key="cli.mint.reveal")
    text = "\n".join(out.text)
    assert "Nothing was minted" in text and "Mint and print a token" in text and "Print the value" not in text
    assert "The key file is empty" in "\n".join(flows.key_file_problem(_terminal("activate"), "/tmp/k", True).text)
    assert "can't be read" in "\n".join(flows.key_file_problem(_terminal("activate"), "/tmp/k", False).text)


def test_the_key_on_the_command_line_warns_under_the_header_not_above_it(capsys: pytest.CaptureFixture[str]) -> None:
    # B-114 (Python): the shell-history warning is a row of the screen, never text above the chip.
    from polaris_key.cli import verbs

    client = SimpleNamespace(
        product="tidewater",
        license=SimpleNamespace(activate_with_key=lambda key: SimpleNamespace(kind="ok")),
        status=lambda: SimpleNamespace(status="ok"),
        is_licensed=lambda: True,
        core=SimpleNamespace(version="1.0.0", channel=None),
    )
    ns = verbs.namespace(next(v for v in verbs.VERBS if v.name == "activate"), [KEY], {})
    ns["_term"] = _terminal("activate")
    result = verbs.activate(client, ns)
    assert capsys.readouterr().err == "", "nothing is printed above the screen"
    text = "\n".join(result.lines)
    assert "shell history" in text and text.index("shell history") < text.index("License key")


def test_ascii_mode_spells_the_catalog_in_ascii() -> None:
    # B-120: grace lines and hints print "-" and "...", never "·" or "…".
    from polaris_key.ui.core.copy import Copy

    assert "·" in Copy("en")("devices.meta", platform="macOS", when="today")
    spelled = Copy("en", ascii=True)("devices.meta", platform="macOS", when="today")
    assert spelled.isascii() and " - " in spelled
    from .fixtures import kit
    from .golden_support import env

    k = kit(env("none", "ascii", 80, "dark"))
    assert k.copy.ascii and k.s("update.current", version="2.5", size="61 MB").isascii()


@pytest.mark.parametrize("columns", [32, 36, 40, 44, 50])
def test_signed_in_as_never_leaves_a_dangling_bracket(columns: int) -> None:
    # B-121: "Signed in as {name} ({email})" keeps "(" and ")" with the unit they wrap.
    from polaris_key.ui.core.models import SignInModel
    from polaris_key.ui.terminal import screens

    from .fixtures import kit
    from .golden_support import env

    class Prompt:
        userCode = "WDJB-MJHT"
        verificationUri = "https://polaris.locker/device"
        verificationUriComplete = "https://polaris.locker/device?user_code=WDJB-MJHT"
        expiresAt = 10**10

    for name, email in (("Mara Fennick", "mara.fennick@tidewater.example"), ("Al", "a@b.example"), ("Mara", "mara@x.io")):
        m = SignInModel(headless=False)
        m.prompted(Prompt(), 0)
        ident = SimpleNamespace(name=name, email=email)
        view = m.finished(SimpleNamespace(status="ready", identity=ident, message=""))
        rows = [ln.text.rstrip() for ln in screens.sign_in(kit(env("none", "unicode", columns, "dark")), view, "login", frame=2)]
        for row in rows:
            body = row[3:] if len(row) > 3 else row
            assert not body.startswith(")") and not row.rstrip().endswith("("), (columns, rows)
