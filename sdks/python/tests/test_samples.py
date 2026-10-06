"""The samples in examples/python-* stay runnable against this SDK (SP-P15)."""

from __future__ import annotations

import ast
import importlib.util
import re
from pathlib import Path

import pytest

from polaris_key.cli.verbs import VERB_NAMES

EXAMPLES = Path(__file__).resolve().parents[3] / "examples"


def _load(path: Path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cli_sample_mounts_every_verb_next_to_its_own_command(capsys: pytest.CaptureFixture[str]) -> None:
    sample = _load(EXAMPLES / "python-cli" / "mytool.py")
    with pytest.raises(SystemExit) as exit_:
        sample.main(["--help"])
    assert exit_.value.code == 0
    out = capsys.readouterr().out
    assert "run" in out
    for verb in VERB_NAMES:
        assert verb in out, verb


def test_renpy_snippet_python_blocks_compile() -> None:
    """Ren'Py's `init python:` and `$` lines are plain Python; compile each one."""
    source = (EXAMPLES / "python-renpy" / "polaris_key.rpy").read_text(encoding="utf-8")
    lines = source.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("init python:"))
    block = []
    for line in lines[start + 1 :]:
        if line and not line.startswith(" "):
            break
        block.append(line[4:] if line.startswith("    ") else line)
    ast.parse("\n".join(block))
    for line in lines:
        m = re.match(r"\s*\$ (.+)$", line)
        if m:
            ast.parse(m.group(1))
    assert "polaris_key.create(" in source and "pkey.boot()" in source
