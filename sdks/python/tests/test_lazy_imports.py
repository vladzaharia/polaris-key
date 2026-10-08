# @pkey-feature ui.cli
"""``import polaris_key`` is cheap, and so is mounting the CLI verbs on a host CLI.

The package root used to import every service, httpx and cryptography (95 modules, 140-245 ms)
on every start of a host CLI, even for a command that was not ours. The root's re-exports now
resolve on first use (PEP 562), the CLI front ends import the client only when a verb runs, and
the installed version is read from package metadata only when asked for.
"""

from __future__ import annotations

import ast
import importlib
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Set, Tuple

import pytest

import polaris_key

#: Loaded only once a client is built or a re-exported name is used.
HEAVY = ("httpx", "cryptography", "polaris_key.client", "polaris_key.core", "polaris_key.update")


def _loaded_after(code: str) -> Set[str]:
    out = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code) + "\nimport sys\nprint('\\n'.join(sys.modules))"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    return {m for m in out if any(m == h or m.startswith(h + ".") for h in HEAVY)}


def test_importing_the_package_loads_no_client_httpx_or_cryptography() -> None:
    assert _loaded_after("import polaris_key") == set()


def test_mounting_the_verbs_on_a_host_cli_loads_no_client() -> None:
    """A host CLI that registers the verbs and runs its own command pays for none of it."""
    loaded = _loaded_after(
        """
        import argparse
        from polaris_key.cli import register_argparse
        p = argparse.ArgumentParser(prog="mytool")
        sub = p.add_subparsers(dest="cmd")
        sub.add_parser("own")
        register_argparse(sub, prog="mytool")
        assert p.parse_args(["own"]).cmd == "own"
        """
    )
    assert loaded == set()


def test_using_a_name_loads_what_it_needs() -> None:
    assert "httpx" in _loaded_after("import polaris_key; polaris_key.PolarisKeyClient")


def test_every_exported_name_resolves_to_its_defining_object() -> None:
    for name in polaris_key.__all__:
        assert hasattr(polaris_key, name), name
    assert polaris_key.create == polaris_key.PolarisKeyClient.create
    assert polaris_key.PolarisError is importlib.import_module("polaris_key.core.errors").PolarisError
    assert polaris_key.copy is importlib.import_module("polaris_key.copy")
    assert set(polaris_key.__all__) <= set(dir(polaris_key))
    namespace: dict = {}
    exec("from polaris_key import *", namespace)
    assert "PolarisKeyClient" in namespace and "ErrorCode" in namespace
    with pytest.raises(AttributeError):
        polaris_key.NoSuchName  # noqa: B018


def _type_checking_imports() -> Set[Tuple[str, str, str]]:
    """``(module, name, bound name)`` for every import inside the root's ``TYPE_CHECKING``
    block."""
    src = Path(polaris_key.__file__).read_text(encoding="utf-8")
    block = next(
        n
        for n in ast.parse(src).body
        if isinstance(n, ast.If) and isinstance(n.test, ast.Name) and n.test.id == "TYPE_CHECKING"
    )
    out = set()
    for n in block.body:
        if isinstance(n, ast.ImportFrom):
            module = "." + (n.module or "")
            for a in n.names:
                out.add((module, a.name, a.asname or a.name))
    return out


def test_the_lazy_table_matches_the_type_checking_imports() -> None:
    """What type checkers see is exactly what the runtime resolves."""
    lazy = {(module, attr, bound) for bound, (module, attr) in polaris_key._LAZY.items()}
    assert lazy == _type_checking_imports()
