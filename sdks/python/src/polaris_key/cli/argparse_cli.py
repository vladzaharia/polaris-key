"""The dependency-free argparse front end + injectable hook for the ``polaris-key`` CLI.

Every verb comes from one table (:data:`polaris_key.cli.verbs.VERBS`), grouped by owning service
(see :data:`polaris_key.cli.core.SERVICE_COMMANDS`)::

    license   activate · enroll · deactivate · status
    identity  sign-in (login) · sign-out (logout)
    devices   register · devices
    config    config · secret · mint
    release   changelog
    update    update · packs
    core      import-bundle · offline-request · boot · doctor

Each draws through the terminal kit (``polaris_key.ui.terminal``, UK-13) and takes ``--json``,
``--no-color`` and ``--ascii``. Trust keys are passed as repeated ``--trust kid=rawBase64url``
pairs so the CLI stays product-agnostic (no pinned keys baked in). Used as ``python -m polaris_key``
and the ``polaris-key`` console script.

Consumers can inject the same commands into their own argparse CLI via
:func:`register_argparse`, passing a ``client_factory`` to control how the client is built and a
``theme`` (``polaris_key.ui.core.Theme``) to restyle the kit.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any, List, Optional

from . import core, verbs


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--product", required=True, help="Product slug (the doc audience).")
    p.add_argument(
        "--version",
        default=core.DEFAULT_VERSION,
        help=f"This client's version (default: {core.DEFAULT_VERSION}).",
    )
    p.add_argument("--base-url", default=None, help="Override the control-plane base URL.")
    p.add_argument("--config-dir", default=None, help="Override the config dir.")
    p.add_argument(
        "--trust",
        action="append",
        metavar="kid=rawBase64url",
        help="A trusted signing key (repeatable).",
    )
    p.add_argument(
        "--service",
        action="append",
        metavar="SLUG",
        help=(
            "A service this build expects the product to run (repeatable). The D-21 "
            "fail-closed fallback used until discovery has been fetched."
        ),
    )
    for o in verbs.UI_OPTS:
        p.add_argument(f"--{o.name}", action="store_true", help=o.help)


def _options(args: argparse.Namespace) -> core.ClientOptions:
    try:
        trust = core.parse_trust(args.trust)
    except ValueError as e:
        raise SystemExit(str(e))
    return core.ClientOptions(
        product=args.product,
        version=args.version,
        trust=trust,
        base_url=args.base_url,
        config_dir=args.config_dir,
        expected_services=core.parse_services(getattr(args, "service", None)),
    )


def register_argparse(
    subparsers: "argparse._SubParsersAction",
    client_factory: Optional[core.ClientFactory] = None,
    *,
    theme: Any = None,
    prog: Optional[str] = None,
) -> "argparse._SubParsersAction":
    """Add the Polaris Key subcommands to an existing subparsers object.

    Each registered subcommand gets a ``func(args) -> int`` default so the host CLI can
    dispatch with ``args.func(args)``. ``client_factory`` (default: build from the parsed
    options) lets a consumer pin trust keys / base URL; ``theme`` restyles the terminal kit, and
    ``prog`` is the command the kit's fix lines name (default: the host parser's).
    """
    factory = client_factory or core.default_client_factory
    shown = prog or getattr(subparsers, "_prog_prefix", None) or "polaris-key"

    for verb in verbs.VERBS:
        p = subparsers.add_parser(verb.name, help=f"[{verb.group}] {verb.help}")
        _add_common(p)
        if verb.words:
            p.add_argument("words", nargs="*", metavar="ARG", help=verb.help)
        for o in verb.opts:
            flag = f"--{o.name}"
            if o.kind == "flag":
                p.add_argument(flag, action="store_true", help=o.help)
            else:
                p.add_argument(flag, type=int if o.kind == "int" else str, default=o.default, help=o.help)
        p.set_defaults(func=_verb(factory, verb, theme, shown))

    return subparsers


def _verb(factory: core.ClientFactory, verb: "verbs.Verb", theme: Any, prog: str):
    def run(args: argparse.Namespace) -> int:
        values = {
            verbs.option_dest(o.name): getattr(args, verbs.option_dest(o.name), o.default)
            for o in verb.opts + verbs.UI_OPTS
        }
        ns = verbs.namespace(verb, getattr(args, "words", []), values)
        result = verbs.run(factory, _options(args), verb, ns, theme=theme, prog=prog)
        result.emit()
        return result.code

    return run


#: Help groups, in the order the help lists them (the owning service of each verb).
HELP_GROUPS = (
    ("License", "license"),
    ("Sign-in", "identity"),
    ("Devices", "devices"),
    ("Config", "config"),
    ("Updates", "update"),
    ("Release", "release"),
    ("Core", "core"),
)


class GroupedHelpParser(argparse.ArgumentParser):
    """``polaris-key --help``: the verbs grouped by owning service, commands in ``strong`` and
    their descriptions in mute (UI-KITS §1.5 rule 13), in 80 columns."""

    def format_help(self) -> str:
        from ..ui import ansi
        from ..ui.terminal.env import detect
        from ..ui.terminal.text import Line, Palette, Span, to_ansi

        env = detect()
        pal = Palette(color=env.color)
        rows: List[str] = []

        def line(*spans: Span) -> None:
            rows.append(to_ansi(Line(list(spans)), pal))

        sep = " " + ansi.SYMBOLS[env.symbols]["separator"] + " "
        line(Span(self.prog, ("strong",)), Span(sep, ("muted",)), Span(self.description or "", ("muted",)))
        line()
        line(Span("Usage", ("muted",)), Span(f"  {self.prog} <command> --product <slug> [options]"))
        width = max(len(v.name) for v in verbs.VERBS) + 4
        for title, group in HELP_GROUPS:
            members = [v for v in verbs.VERBS if v.group == group]
            if not members:
                continue
            line()
            line(Span(title, ("strong",)))
            for v in members:
                line(Span("  " + v.name.ljust(width), ("strong",)), Span(v.help, ("muted",)))
        line()
        line(Span("Options", ("strong",)))
        for o in verbs.UI_OPTS:
            line(Span("  " + f"--{o.name}".ljust(width), ("strong",)), Span(o.help, ("muted",)))
        line(Span("  " + "-h, --help".ljust(width), ("strong",)), Span("Help for a command.", ("muted",)))
        return "\n".join(r.rstrip() for r in rows) + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = GroupedHelpParser(prog="polaris-key", description="Polaris Key client.")
    sub = parser.add_subparsers(dest="command", required=True)
    register_argparse(sub)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv if argv is not None else sys.argv[1:])
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
