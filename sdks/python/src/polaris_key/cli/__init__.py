"""The polaris-key CLI.

A framework-agnostic command *core* (:mod:`.core`) holds all behavior; the argparse
entry point (:mod:`.argparse_cli`) is the default, dependency-free front end. Optional
``click``/``typer`` adapters wrap the same core so the three never diverge.
"""

from __future__ import annotations

from .core import CommandResult, activate, deactivate, status

__all__ = ["CommandResult", "activate", "deactivate", "status", "main"]


def main(argv: list[str] | None = None) -> int:
    """Default entry point — the argparse front end."""
    from .argparse_cli import main as _main

    return _main(argv)
