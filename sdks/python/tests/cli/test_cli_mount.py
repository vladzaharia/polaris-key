# @pkey-feature ui.cli.contract
"""The ``mount`` and ``help`` rows of the ``cli`` family in conformance/corpus/v2/ui-matrix.json
(plans/UK-51.md), run against the argparse, click and typer adapters: what registering the kit into a
host CLI adds, the error and the skip when a host command collides, the options a bound mount hides,
and the help page's order. A row an adapter fails is a bug against the row or the adapter, never a
reason to skip it (AGENTS.md rule 1)."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import pytest

from polaris_key.cli import mount
from polaris_key.cli.argparse_cli import GroupedHelpParser, register_argparse
from polaris_key.cli.mount import BOUND_OPTIONS, IDS, END_USER, plan_mount

ROOT = Path(__file__).resolve().parents[4]
CLI = json.loads((ROOT / "conformance" / "corpus" / "v2" / "ui-matrix.json").read_text(encoding="utf-8"))["cli"]
CONFIG = {"product_slug": "tidewater", "trust": {}}
_ESC = re.compile(r"\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)")
ALIAS_WORDS = {"login": ("sign-in",), "logout": ("sign-out",)}


def _bind(options: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if "namespace" in options:
        out["namespace"] = options["namespace"]
    if "verbs" in options:
        out["verbs"] = options["verbs"]
    if "onCollision" in options:
        out["on_collision"] = options["onCollision"]
    if options.get("config"):
        out.update(config=CONFIG, version="2.4.1")
    return out


def _words_of(ids: List[str], namespace: Optional[str]) -> Set[str]:
    """The top-level words the mounted ids are typed as: the namespace, or each id's first word (and
    the alias words of ``login`` and ``logout``)."""
    if namespace:
        return {namespace}
    words: Set[str] = set()
    for i in ids:
        first = i.split(" ")[0]
        words.add(first)
        words.update(ALIAS_WORDS.get(first, ()))
    return words


def _expected_ids(row: Dict[str, Any]) -> List[str]:
    ns = row["input"]["options"].get("namespace")
    return [m[len(ns) + 1 :] if ns else m for m in row["expect"]["mounted"]]


# ── argparse ────────────────────────────────────────────────────────────────────────────────


def _argparse_host(host: List[str], groups: Optional[Dict[str, str]] = None) -> Any:
    parser = GroupedHelpParser(prog="mytool", description="mytool")
    sub = parser.add_subparsers(dest="command")
    for w in host:
        sub.add_parser(w, help=f"Run {w}", group=(groups or {}).get(w))
    return parser, sub


def _suppressed(p: argparse.ArgumentParser) -> Set[str]:
    return {a.option_strings[-1] for a in p._actions if a.option_strings and a.help == argparse.SUPPRESS}


@pytest.mark.parametrize("row", CLI["mount"], ids=[r["name"] for r in CLI["mount"]])
def test_argparse_mount(row: Dict[str, Any]) -> None:
    host = row["input"]["host"]
    options = row["input"]["options"]
    _, sub = _argparse_host(host)
    warnings: List[str] = []
    if row["expect"]["error"]:
        with pytest.raises(mount.VerbCollisionError) as caught:
            register_argparse(sub, **_bind(options), warn=warnings.append)
        err = caught.value
        want = row["expect"]["error"]
        assert err.code == want["code"] and err.words == want["words"] and list(err.fixes) == want["fixes"]
        for w in want["words"]:
            assert f'"{w}"' in str(err)
        for f in want["fixes"]:
            assert f in str(err)
        assert set(sub._name_parser_map) == set(host), "nothing was mounted"
        return
    register_argparse(sub, **_bind(options), warn=warnings.append)
    ns = options.get("namespace")
    added = set(sub._name_parser_map) - set(host)
    assert added == _words_of(_expected_ids(row), ns)
    if ns:
        nested = set(next(a for a in sub._name_parser_map[ns]._actions if isinstance(a, argparse._SubParsersAction))._name_parser_map)
        assert nested == _words_of(_expected_ids(row), None)
    assert len(warnings) == (1 if row["expect"]["skipped"] else 0)
    for v in row["expect"]["skipped"]:
        assert v in warnings[0]
    for w in host:
        assert sub._name_parser_map[w].prog == f"mytool {w}"
    # The hidden options: a bound mount takes them off every verb's help.
    words = sorted(nested if ns else added)
    holder = sub._name_parser_map[ns] if ns else None
    verbs_ = (
        next(a for a in holder._actions if isinstance(a, argparse._SubParsersAction))._name_parser_map if holder else sub._name_parser_map
    )
    for w in words:
        hidden = _suppressed(verbs_[w])
        if row["expect"]["hidden"]:
            assert set(BOUND_OPTIONS) <= hidden and set(row["expect"]["hidden"]) <= hidden
            assert "--product" in {o for a in verbs_[w]._actions for o in a.option_strings} and not any(
                a.required for a in verbs_[w]._actions
            )
        else:
            assert not (hidden & set(BOUND_OPTIONS))


def test_the_plan_is_the_corpus_s() -> None:
    for row in CLI["mount"]:
        o = row["input"]["options"]
        ns = o.get("namespace")
        try:
            plan = plan_mount(
                row["input"]["host"], namespace=ns, verbs=o.get("verbs"), on_collision=o.get("onCollision", "error"), bound=bool(o.get("config"))
            )
        except Exception as e:
            assert row["expect"]["error"] and e.code == row["expect"]["error"]["code"]  # type: ignore[attr-defined]
            continue
        assert [f"{ns} {i}" if ns else i for i in plan.ids] == row["expect"]["mounted"], row["name"]
        assert list(plan.skipped) == row["expect"]["skipped"]
        assert list(plan.hidden) == row["expect"]["hidden"]


def test_the_defaults_and_the_python_only_ids() -> None:
    assert list(plan_mount([]).ids) == list(END_USER) == CLI["verbs"]["endUser"]
    known = {i for i, _ in IDS}
    assert set(CLI["verbs"]["endUser"]) | set(CLI["verbs"]["developer"]) - {"completion"} <= known
    # update download is Python's, outside the corpus lists: named, never default.
    assert "update download" in known and "update download" not in set(END_USER) | set(CLI["verbs"]["developer"])
    assert "update download" in plan_mount([], verbs=["update"]).ids
    with pytest.raises(ValueError, match="polaris-unknown-verb"):
        plan_mount([], verbs=["nope"])


def test_a_partly_mounted_verb_refuses_the_rest(capsys: pytest.CaptureFixture[str]) -> None:
    _, sub = _argparse_host(["export"])
    register_argparse(sub, client=_Client(), verbs=["update check", "update apply"])
    parser = sub._name_parser_map["update"]
    args = parser.parse_args(["download", "--to", "x"])
    assert args.func(args) == 2
    assert "update [apply | check]" in " ".join(capsys.readouterr().out.split())


class _Client:
    product = "tidewater"

    def close(self) -> None:
        raise AssertionError("a client the host gave is the host's to close")


@pytest.mark.parametrize("row", CLI["help"], ids=[r["name"] for r in CLI["help"]])
def test_argparse_help(row: Dict[str, Any]) -> None:
    groups = {c: s["heading"] for s in row["input"]["host"] for c in s["commands"]}
    parser, sub = _argparse_host(list(groups), groups)
    register_argparse(sub, **_bind(row["input"]["options"]), warn=lambda m: None)
    text = _ESC.sub("", parser.format_help())
    sections: List[Dict[str, Any]] = []
    for line in text.splitlines():
        if re.match(r"^\S", line) and not line.startswith(("Usage", "mytool", "Run ")):
            sections.append({"heading": line, "commands": []})
        elif re.match(r"^ {2}\S", line) and sections:
            sections[-1]["commands"].append(re.split(r"\s{2,}", line.strip())[0])
    got = [{"heading": s["heading"], "commands": sorted(s["commands"])} for s in sections if s["commands"]]
    from polaris_key.ui.core import Copy

    want = [
        {"heading": Copy("en")(s["copy"]) if "copy" in s else s["heading"], "commands": s["commands"]} for s in row["expect"]["sections"]
    ]
    assert got == want


def test_a_host_help_has_no_integration_flags() -> None:
    parser, sub = _argparse_host(["export"])
    register_argparse(sub, config=CONFIG, version="1.0.0")
    for name in ("status", "activate"):
        text = sub._name_parser_map[name].format_help()
        for flag in ("--product", "--trust", "--base-url", "--service", "--config-dir", "--version"):
            assert flag not in text, (name, flag)
    assert "--json" in sub._name_parser_map["status"].format_help()
    assert "--product" not in parser.format_help()


# ── click and typer ─────────────────────────────────────────────────────────────────────────


def _click_names(group: Any, ns: Optional[str]) -> Set[str]:
    return set((group.commands[ns].commands if ns else group.commands))


@pytest.mark.parametrize("row", CLI["mount"], ids=[r["name"] for r in CLI["mount"]])
def test_click_mount(row: Dict[str, Any]) -> None:
    click = pytest.importorskip("click")
    from polaris_key.cli.click_cli import register_click

    host = click.Group("mytool")
    for w in row["input"]["host"]:
        host.add_command(click.Command(w, callback=lambda: None))
    options = row["input"]["options"]
    warnings: List[str] = []
    if row["expect"]["error"]:
        with pytest.raises(mount.VerbCollisionError) as caught:
            register_click(host, **_bind(options), warn=warnings.append)
        assert caught.value.words == row["expect"]["error"]["words"]
        assert set(host.commands) == set(row["input"]["host"])
        return
    register_click(host, **_bind(options), warn=warnings.append)
    ns = options.get("namespace")
    assert set(host.commands) - set(row["input"]["host"]) == (_words_of(_expected_ids(row), ns))
    if ns:
        assert set(host.commands[ns].commands) == _words_of(_expected_ids(row), None)
    assert len(warnings) == (1 if row["expect"]["skipped"] else 0)
    verb_group = host.commands[ns] if ns else host
    for name in _words_of(_expected_ids(row), None):
        cmd = verb_group.commands[name]
        hidden = {o for p in cmd.params for o in getattr(p, "opts", []) if getattr(p, "hidden", False)}
        if row["expect"]["hidden"]:
            assert set(BOUND_OPTIONS) <= hidden
            assert not any(getattr(p, "required", False) for p in cmd.params if getattr(p, "opts", None))
        else:
            assert not (hidden & set(BOUND_OPTIONS))


@pytest.mark.parametrize("row", CLI["mount"], ids=[r["name"] for r in CLI["mount"]])
def test_typer_mount(row: Dict[str, Any]) -> None:
    typer = pytest.importorskip("typer")
    from polaris_key.cli.typer_cli import register_typer

    host = typer.Typer()
    for w in row["input"]["host"]:
        host.command(name=w)(lambda: None)
    options = row["input"]["options"]
    warnings: List[str] = []
    if row["expect"]["error"]:
        with pytest.raises(mount.VerbCollisionError) as caught:
            register_typer(host, **_bind(options), warn=warnings.append)
        assert caught.value.words == row["expect"]["error"]["words"]
        assert len(host.registered_commands) == len(row["input"]["host"])
        return
    register_typer(host, **_bind(options), warn=warnings.append)
    ns = options.get("namespace")
    names = {c.name for c in host.registered_commands} - set(row["input"]["host"])
    if ns:
        group = next(g for g in host.registered_groups if g.name == ns)
        assert names == set()
        assert {c.name for c in group.typer_instance.registered_commands} == _words_of(_expected_ids(row), None)
    else:
        assert names == _words_of(_expected_ids(row), None)
    assert len(warnings) == (1 if row["expect"]["skipped"] else 0)
