"""The polaris-key CLI.

A framework-agnostic command *core* (:mod:`.core`) holds all behavior; the argparse
entry point (:mod:`.argparse_cli`) is the default, dependency-free front end. Optional
``click``/``typer`` adapters wrap the same core so the three never diverge.
"""

from __future__ import annotations

from .core import (
    ClientFactory,
    ClientOptions,
    CommandResult,
    activate,
    build_client,
    config,
    deactivate,
    default_client_factory,
    parse_trust,
    run_command,
    status,
)

__all__ = [
    "ClientFactory",
    "ClientOptions",
    "CommandResult",
    "activate",
    "build_client",
    "config",
    "deactivate",
    "default_client_factory",
    "parse_trust",
    "run_command",
    "status",
    "main",
    "register_argparse",
    "polaris_click_group",
    "polaris_typer_app",
]


def register_argparse(subparsers, client_factory=None):
    """Re-export: add Polaris Key subcommands to an existing argparse subparsers object."""
    from .argparse_cli import register_argparse as _reg

    return _reg(subparsers, client_factory)


def polaris_click_group(client_factory=None):
    """Re-export: build a ``click.Group`` (requires the ``click`` extra)."""
    from .click_cli import polaris_click_group as _grp

    return _grp(client_factory)


def polaris_typer_app(client_factory=None):
    """Re-export: build a ``typer.Typer`` app (requires the ``typer`` extra)."""
    from .typer_cli import polaris_typer_app as _app

    return _app(client_factory)


def main(argv: list[str] | None = None) -> int:
    """Default entry point — the argparse front end."""
    from .argparse_cli import main as _main

    return _main(argv)
