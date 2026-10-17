"""The ``polaris-key`` CLI.

A framework-agnostic command *core* (:mod:`.core`, :mod:`.verbs`) holds all behavior and draws
through the terminal kit (``polaris_key.ui.terminal``: styled with rich when the ``[cli]`` extra is
installed, plain lines otherwise, ``--json`` on every verb). The argparse entry point
(:mod:`.argparse_cli`) is the default, dependency-free front end. Optional ``click``/``typer``
adapters wrap the same verb table so the three never diverge.

Verbs are grouped by owning service — see :data:`polaris_key.cli.core.SERVICE_COMMANDS`.
"""

from __future__ import annotations

from .core import (
    SERVICE_COMMANDS,
    ClientFactory,
    ClientOptions,
    CommandResult,
    activate,
    build_client,
    config,
    deactivate,
    default_client_factory,
    enroll,
    import_bundle,
    parse_services,
    parse_trust,
    read_bundle_file,
    register,
    run_command,
    status,
)

__all__ = [
    "ClientFactory",
    "ClientOptions",
    "CommandResult",
    "SERVICE_COMMANDS",
    "activate",
    "enroll",
    "build_client",
    "config",
    "deactivate",
    "default_client_factory",
    "import_bundle",
    "parse_services",
    "parse_trust",
    "read_bundle_file",
    "register",
    "run_command",
    "status",
    "main",
    "register_argparse",
    "polaris_click_group",
    "polaris_typer_app",
    "require_license",
    "require_entitlement",
    "END_USER",
]


def register_argparse(subparsers, client_factory=None, *, theme=None, prog=None, **mount):
    """Re-export: add the Polaris Key subcommands to an existing argparse subparsers object.
    ``mount`` is ``client=``, ``config=``, ``version=``, ``namespace=``, ``verbs=``,
    ``on_collision=`` and ``warn=`` (see :func:`polaris_key.cli.argparse_cli.register_argparse`)."""
    from .argparse_cli import register_argparse as _reg

    return _reg(subparsers, client_factory, theme=theme, prog=prog, **mount)


def polaris_click_group(client_factory=None, name: str = "polaris", *, theme=None, prog=None, **mount):
    """Re-export: build a ``click.Group`` (requires the ``click`` extra). ``mount`` as for
    :func:`register_argparse`, except that ``namespace`` is the group's ``name``."""
    from .click_cli import polaris_click_group as _grp

    return _grp(client_factory, name, theme=theme, prog=prog, **mount)


def polaris_typer_app(client_factory=None, *, theme=None, prog=None, **mount):
    """Re-export: build a ``typer.Typer`` app (requires the ``typer`` extra). ``mount`` as for
    :func:`polaris_click_group`."""
    from .typer_cli import polaris_typer_app as _app

    return _app(client_factory, theme=theme, prog=prog, **mount)


def __getattr__(name):
    """The gate and the mount's constants load when first used, so registering verbs stays light."""
    if name in ("require_license", "require_entitlement"):
        from . import gate

        return getattr(gate, name)
    if name == "END_USER":
        from .mount import END_USER

        return END_USER
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def main(argv=None) -> int:
    """Default entry point — the argparse front end."""
    from .argparse_cli import main as _main

    return _main(argv)
