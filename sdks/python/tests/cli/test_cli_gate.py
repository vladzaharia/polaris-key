# @pkey-feature ui.cli.mount ui.cli.contract
"""The ``gate`` rows of the ``cli`` family in conformance/corpus/v2/ui-matrix.json (plans/UK-51.md):
what ``require_license`` does with a host command for every license status, terminal and
entitlement. A row the gate fails is a bug against the row or the gate, never a reason to skip it
(AGENTS.md rule 1)."""

from __future__ import annotations

import io
import json
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest

from polaris_key.cli import gate
from polaris_key.cli.gate import require_license
from polaris_key.license.endpoints import ActivationOk
from polaris_key.ui import ansi
from polaris_key.ui.core import Copy
from polaris_key.ui.terminal.exit import EXIT

from .test_cli_contract import CLI, KEY, _Keys, _terminal, plain

C = Copy("en")
GLYPH = ansi.SYMBOLS["unicode"]
USABLE = ("ok", "grace", "not-applicable")


def _client(status: str, entitled: bool, *, product: str = "tidewater", throws: bool = False, portal: Any = None) -> Any:
    state = {"status": status}

    def activate(key: str) -> Any:
        state["status"] = "ok"
        return ActivationOk(token="pkeyt_secret")

    class Client:
        license = SimpleNamespace(activate_with_key=activate)
        entitlements = SimpleNamespace(has=lambda name: entitled and state["status"] in USABLE)

        def status(self) -> Any:
            if throws:
                raise RuntimeError("the check failed")
            return SimpleNamespace(status=state["status"])

        def sync(self) -> None:
            return None

        def portal(self) -> Any:
            return portal

    Client.product = product  # type: ignore[attr-defined]
    return Client()


def _run(inp: Dict[str, Any]) -> Dict[str, Any]:
    # No product page: discovery says the product's portal is off (DISC-01).
    client = _client(
        inp["status"],
        inp["entitled"],
        throws=inp.get("check") == "throws",
        portal={"enabled": False} if inp.get("portal") is False else None,
    )
    flow = inp["tty"] and not inp["json"] and inp["status"] in ("expired", "revoked", "needs-activation")
    keys = _Keys([*KEY, "enter"]) if flow else None
    t = _terminal(inp["command"], json_mode=inp["json"], interactive=bool(inp["tty"]) and not inp["json"], keys=keys)
    t.err = io.StringIO()
    ran: List[int] = []

    # The terminal is the test's (scripted keys, captured streams), so run the gate itself; the
    # decorator around it is covered below.
    code = gate.run_gate(
        client, command=inp["command"], entitlement="export.pdf", prog="tidewater", mounted=inp.get("mounted"), terminal=t, json=inp["json"]
    )
    if code is None:
        ran.append(1)
    return {"code": code, "ran": len(ran), "stdout": t.device.out.getvalue(), "stderr": t.err.getvalue()}


@pytest.mark.parametrize("row", CLI["gate"], ids=[r["name"] for r in CLI["gate"]])
def test_gate(row: Dict[str, Any]) -> None:
    r = _run(row["input"])
    e = row["expect"]
    if e["outcome"] == "run":
        assert r["code"] is None and r["ran"] == 1 and r["stderr"] == ""
        return
    if e["outcome"] == "flow":
        # The activate flow drew on stdout; the command then runs, unless the license still lacks the
        # entitlement (activating a key grants none): that refuses with 4.
        assert "activate" in plain(r["stdout"])
        if row["input"]["entitled"]:
            assert r["code"] is None and r["ran"] == 1
        else:
            assert r["code"] == EXIT.license_required and r["ran"] == 0
        return
    assert r["ran"] == 0 and r["code"] == EXIT.license_required == e["exit"]
    if e["stream"] == "stdout":
        lines = r["stdout"].strip().splitlines()
        assert len(lines) == 1 and json.loads(lines[0]) == e["result"]
        assert r["stderr"] == ""
        return
    # Text: once, on stderr; a triangle for a refusal and a cross for a check that failed; stdout
    # stays empty.
    assert r["stdout"] == ""
    text = plain(r["stderr"])
    flat = " ".join(text.replace("\u2502", " ").replace("\u2514", " ").split())
    mark, other = ("fail", "warn") if e["outcome"] == "fail" else ("warn", "fail")
    assert GLYPH[mark] in text and GLYPH[other] not in text
    shown = [C(key, command=row["input"]["command"]) for key in e["copy"]]
    for line in shown:
        assert line in flat
    assert flat.count(shown[-1]) == 1
    # A refusal is its title: the rows that fix it follow, so no message line.
    if e["outcome"] == "refuse":
        assert len(e["copy"]) == 1
        if e["copy"][0].startswith("core.gate."):
            assert C(e["copy"][0].replace(".title", ".message")) not in flat
    # The link leads the fix rows: the product page, or the developer's name.
    if e.get("link") == "portal":
        assert "polaris.locker/activate?product=tidewater" in "".join(text.split())
    elif e.get("link") == "contact":
        assert "Contact " in text
    else:
        assert "polaris.locker/activate" not in text and "Contact " not in text
    for verb in ("activate", "login", "update apply", "status"):
        assert (f"tidewater {verb}" in text) == (verb in e["fix"])
    assert "\x1b" not in r["stderr"]


def test_the_decorator_ends_with_exit_4_and_does_not_run_the_command(capsys: pytest.CaptureFixture[str]) -> None:
    ran: List[int] = []

    @require_license(client=_client("needs-activation", True), prog="tidewater")
    def export() -> None:
        ran.append(1)

    with pytest.raises(SystemExit) as caught:
        export()
    assert caught.value.code == EXIT.license_required == 4 and ran == []
    err = capsys.readouterr().err
    assert "tidewater activate" in plain(err) and capsys.readouterr().out == ""


def test_the_decorator_runs_the_command_on_a_license_that_holds_the_entitlement() -> None:
    @gate.require_entitlement("export.pdf", client=_client("ok", True))
    def export(n: int) -> int:
        return n + 1

    assert export(1) == 2


def test_a_gate_with_no_mount_and_no_client_says_what_to_do() -> None:
    gate._latest = None

    @require_license
    def export() -> None: ...

    with pytest.raises(RuntimeError, match="client= or config="):
        export()


def test_a_json_refusal_is_read_from_the_argparse_namespace(capsys: pytest.CaptureFixture[str]) -> None:
    @require_license(client=_client("expired", True), prog="tidewater")
    def export(args: Any) -> None: ...

    with pytest.raises(SystemExit) as caught:
        export(SimpleNamespace(json=True, no_color=False, ascii=False))
    assert caught.value.code == 4
    line = json.loads(capsys.readouterr().out.strip())
    assert line["error"] == "license_required" and line["command"] == "export" and line["exit"] == 4


def test_a_gate_that_cannot_decide_refuses_with_4_and_never_runs_the_command(capsys: pytest.CaptureFixture[str]) -> None:
    class Broken:
        product = "tidewater"
        entitlements = SimpleNamespace(has=lambda n: True)

        def status(self) -> Any:
            raise RuntimeError("store unreadable")

    ran: List[int] = []

    @require_license(client=Broken(), prog="tidewater")
    def export(args: Any) -> None:
        ran.append(1)

    for flags, as_json in ((SimpleNamespace(json=False), False), (SimpleNamespace(json=True), True)):
        with pytest.raises(SystemExit) as caught:
            export(flags)
        assert caught.value.code == 4 and ran == []
        cap = capsys.readouterr()
        if as_json:
            line = json.loads(cap.out.strip().splitlines()[-1])
            assert line["error"] == "license_required" and line["exit"] == 4
        else:
            text = plain(cap.err)
            assert cap.out == "" and "Couldn't check your license" in text and "tidewater " not in text


def test_a_failing_refusal_still_exits_4(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(gate, "refusal_outcome", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("draw")))

    class Broken:
        def status(self) -> Any:
            raise RuntimeError("x")

    assert gate.run_gate(Broken(), command="export", json=True) == 4
    assert json.loads(capsys.readouterr().out.strip())["error"] == "license_required"


def test_ctrl_c_passes_through_the_gate() -> None:
    class Interrupted:
        def status(self) -> Any:
            raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        gate.run_gate(Interrupted(), command="export")


def test_a_status_this_kit_does_not_know_is_never_read_as_signed_out() -> None:
    err = io.StringIO()
    code = gate.run_gate(_client("from-the-future", True), command="export", prog="tidewater", stderr=err, env={"TERM": "xterm"})
    text = plain(err.getvalue())
    assert code == 4 and "Couldn't check your license" in text and "Signed out" not in text


def test_the_command_does_not_butt_against_the_flows_closing_row() -> None:
    # B-121: an inline flow that lets the command run leaves a blank line after its last row.
    t = _terminal("export", interactive=True, keys=_Keys([*KEY, "enter"]))
    t.err = io.StringIO()
    assert gate.run_gate(_client("needs-activation", True), command="export", entitlement="export.pdf", prog="tidewater", terminal=t) is None
    assert t.device.out.getvalue().endswith("\n\n")
