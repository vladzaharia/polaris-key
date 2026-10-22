"""The Python half of the docs snippet lane. Run by the vitest lane with the SDK's own venv.

  pylane.py check <dir>    ast-parse every *.py in <dir> at the 3.9 floor, then run mypy over them
  pylane.py symbols        print every public name the SDK exports, as JSON
"""

import ast
import importlib
import json
import pkgutil
import subprocess
import sys
from pathlib import Path


def check(directory: Path) -> int:
    files = sorted(directory.glob("snip_*.py"))
    for f in files:
        try:
            ast.parse(f.read_text(), filename=f.name, feature_version=(3, 9))
        except SyntaxError as e:
            print(f"{f.name}:{e.lineno}: error: {e.msg}  [syntax]")
    proc = subprocess.run(
        [sys.executable, "-m", "mypy", "--no-incremental", "--cache-dir=/dev/null", "--disable-error-code=import-untyped", *[f.name for f in files]],
        cwd=directory,
        capture_output=True,
        text=True,
    )
    print(proc.stdout, end="")
    return 0


def symbols() -> int:
    import polaris_key

    names: set[str] = set()

    def add(obj: object, depth: int = 0) -> None:
        for name in dir(obj):
            if name.startswith("_"):
                continue
            names.add(name)
            if depth < 2:
                child = getattr(obj, name, None)
                if isinstance(child, type):
                    for attr in dir(child):
                        if not attr.startswith("_"):
                            names.add(attr)

    def defined(body: list) -> list:
        # The names a block binds, through if/try/with blocks (members a class defines only when
        # an optional binding loads, such as the Qt signals) but not into nested functions.
        out: list = []
        for node in body:
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                out.append(node.name)
                if isinstance(node, ast.ClassDef):
                    out.extend(defined(node.body))
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                out.extend(t.id for t in targets if isinstance(t, ast.Name))
            elif isinstance(node, (ast.If, ast.Try, ast.With)):
                for block in ("body", "orelse", "finalbody"):
                    out.extend(defined(getattr(node, block, [])))
                for handler in getattr(node, "handlers", []):
                    out.extend(defined(handler.body))
        return out

    add(polaris_key)
    for mod in pkgutil.walk_packages(polaris_key.__path__, "polaris_key.", onerror=lambda _name: None):
        # The source too: a module whose optional extra cannot load on this host (PySide6 without
        # libEGL on a headless Linux runner) fails to import, or imports without its bindings, and
        # still exports what it defines.
        spec = mod.module_finder.find_spec(mod.name)  # type: ignore[call-arg]
        if spec is not None and spec.origin and spec.origin.endswith(".py"):
            names.update(n for n in defined(ast.parse(Path(spec.origin).read_text()).body) if not n.startswith("_"))
        try:
            add(importlib.import_module(mod.name))
        except Exception:  # an optional extra that is not installed, or cannot load on this host
            pass
        names.add(mod.name.rsplit(".", 1)[-1])
    print(json.dumps(sorted(names)))
    return 0


if __name__ == "__main__":
    if sys.argv[1] == "check":
        raise SystemExit(check(Path(sys.argv[2])))
    raise SystemExit(symbols())
