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
        if verb.arg:
            p.add_argument(verb.arg, nargs="?", default=None, help=verb.help)
        elif verb.words:
            p.add_argument("words", nargs="*", metavar="ARG", help=verb.help)
        for o in verb.opts:
            flag = f"--{o.name}"
            if o.kind == "flag":
                p.add_argument(flag, action="store_true", help=o.help)
            else:
                p.add_argument(flag, type=int if o.kind == "int" else str, default=o.default, help=o.help)
        p.set_defaults(func=_verb(factory, verb, theme, shown))

    return subparsers


def json_usage_error(command: str, message: str, out: Any = None) -> int:
    """With ``--json``, a usage error still ends with a result line (exit 2)."""
    import json

    from ..ui.terminal.flows import JSON_VERSION

    obj = {"v": JSON_VERSION, "command": command, "event": "result", "ok": False, "exit": 2, "error": "usage", "message": message}
    (out or sys.stdout).write(json.dumps(obj, ensure_ascii=True) + "\n")
    return 2


def _verb(factory: core.ClientFactory, verb: "verbs.Verb", theme: Any, prog: str):
    def run(args: argparse.Namespace) -> int:
        if getattr(args, "json", False):
            try:
                opts = _options(args)
            except SystemExit as e:
                return json_usage_error(verb.name, str(e.code))
        else:
            opts = _options(args)
        values = {
            verbs.option_dest(o.name): getattr(args, verbs.option_dest(o.name), o.default)
            for o in verb.opts + verbs.UI_OPTS
        }
        if verb.arg:
            value = getattr(args, verb.arg, None)
            words = [value] if value else []
        else:
            words = getattr(args, "words", [])
        ns = verbs.namespace(verb, words, values)
        result = verbs.run(factory, opts, verb, ns, theme=theme, prog=prog)
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


class _HelpWriter:
    """Writes help lines in the kit's look: commands in ``strong``, descriptions in mute, wrapped
    to the terminal's width. Below 50 columns each term stacks above its description."""

    def __init__(self) -> None:
        from ..ui import ansi
        from ..ui.terminal.env import detect
        from ..ui.terminal.parts import STACK_COLUMNS
        from ..ui.terminal.text import Line, Palette, Span, cell_len, to_ansi, wrap

        self._Line, self._Span, self._cell_len, self._to_ansi, self._wrap = Line, Span, cell_len, to_ansi, wrap
        self.env = detect()
        self.pal = Palette(color=self.env.color, hyperlinks=False, attributes=self.env.tty and not self.env.dumb)
        self.cols = self.env.width
        self.rows: List[str] = []
        self.sep = " " + ansi.SYMBOLS[self.env.symbols]["separator"] + " "
        self.stack_below = STACK_COLUMNS

    def line(self, *spans: Any, hang: int = 0) -> None:
        """One paragraph: wrapped to the width, each continuation hanging ``hang`` cells in."""
        spans_l = list(spans)
        if not spans_l:
            self.rows.append("")
            return
        for i, r in enumerate(self._wrap(spans_l, max(1, self.cols - hang))):
            lead = [self._Span(" " * hang)] if i and hang else []
            self.rows.append(self._to_ansi(self._Line(lead + r), self.pal))

    def pair(self, term: str, text: str, width: int) -> None:
        S, Line = self._Span, self._Line
        stacked = self.cols < self.stack_below or self.cols - 2 - width < 16
        if stacked:
            for i, r in enumerate(self._wrap([S(term, ("strong",))], max(1, self.cols - 4))):
                self.rows.append(self._to_ansi(Line([S("  " if not i else "      ")] + r), self.pal))
            for r in self._wrap([S(text, ("muted",))], max(1, self.cols - 4)):
                self.rows.append(self._to_ansi(Line([S("    ")] + r), self.pal))
            return
        body = self._wrap([S(text, ("muted",))], max(1, self.cols - 2 - width))
        if self._cell_len(term) > width:
            # A term wider than the column takes a line of its own; its description sits under it.
            self.rows.append(self._to_ansi(Line([S("  "), S(term, ("strong",))]), self.pal))
            for r in body:
                self.rows.append(self._to_ansi(Line([S(" " * (2 + width))] + r), self.pal))
            return
        pad = S(" " * (width - self._cell_len(term)))
        for i, r in enumerate(body):
            head = [S("  "), S(term, ("strong",)), pad] if i == 0 else [S(" " * (2 + width))]
            self.rows.append(self._to_ansi(Line(head + r), self.pal))

    def text(self) -> str:
        return "\n".join(r.rstrip() for r in self.rows) + "\n"


class GroupedHelpParser(argparse.ArgumentParser):
    """``polaris-key --help``: the verbs grouped by owning service, commands in ``strong`` and
    their descriptions in mute (UI-KITS §1.5 rule 13), in 80 columns or the terminal's width.
    Descriptions wrap under their column; below 50 columns each command stacks above its
    description, as the Node kit's help does. Each verb's own ``--help`` is :class:`VerbHelpParser`'s."""

    def add_subparsers(self, **kwargs: Any) -> "argparse._SubParsersAction":
        kwargs.setdefault("parser_class", VerbHelpParser)
        return super().add_subparsers(**kwargs)

    def format_help(self) -> str:
        w = _HelpWriter()
        S = w._Span
        w.line(S(self.prog, ("strong",)), S(w.sep, ("muted",)), S(self.description or "", ("muted",)))
        w.line()
        # The usage lines hang under their text (seven cells in, past "Usage  ").
        w.line(S("Usage", ("muted",)), S("  " + f"{self.prog} <command> --product <slug> [options]"), hang=7)
        w.line(S("       "), S(f"{self.prog} <command> --help", ("muted",)), hang=7)
        width = max(len(v.name) for v in verbs.VERBS) + 4
        for title, group in HELP_GROUPS:
            members = [v for v in verbs.VERBS if v.group == group]
            if not members:
                continue
            w.line()
            w.line(S(title, ("strong",)))
            for v in members:
                w.pair(v.name, v.help, width)
        w.line()
        w.line(S("Every command takes", ("strong",)))
        for o in verbs.UI_OPTS:
            w.pair(f"--{o.name}", o.help, width)
        w.pair("-h, --help", "Help for a command.", width)
        return w.text()


class VerbHelpParser(argparse.ArgumentParser):
    """``polaris-key <verb> --help``: the verb's title and description, its usage and its options,
    in the kit's look (the Node kit's ``renderVerbHelp``), never the whole command list."""

    def format_help(self) -> str:
        w = _HelpWriter()
        S = w._Span
        name = self.prog.split(" ", 1)[-1] if " " in self.prog else self.prog
        verb = self.prog.rsplit(" ", 1)[-1]
        desc = next((v.help for v in verbs.VERBS if v.name == verb), self.description or "")
        w.line(S(self.prog, ("strong",)))
        w.line(S(desc, ("muted",)))
        w.line()
        positional = [a for a in self._actions if not a.option_strings and a.dest != "help"]
        required = [a for a in self._actions if a.option_strings and a.required]
        meta = lambda a: "slug" if a.dest == "product" else str(a.metavar or a.dest).lower().replace("_", "-")  # noqa: E731
        usage = [self.prog] + [f"{a.option_strings[-1]} <{meta(a)}>" for a in required]
        usage += [f"[{(a.metavar or a.dest)}]" if a.nargs in ("?", "*") else f"<{a.metavar or a.dest}>" for a in positional]
        usage.append("[options]")
        w.line(S("Usage", ("muted",)), S("  " + " ".join(usage)), hang=7)
        w.line()
        w.line(S("Options", ("strong",)))
        rows = []
        for a in self._actions:
            if not a.option_strings or a.dest == "help":
                continue
            flag = a.option_strings[-1]
            if a.nargs != 0:
                flag += f" <{meta(a)}>"
            rows.append((flag, (a.help or "") .replace("%(default)s", str(a.default))))
        rows.append(("-h, --help", "Help for a command."))
        width = min(24, max(len(r[0]) for r in rows))
        for term, text in rows:
            w.pair(term, text, width)
        return w.text()


def build_parser() -> argparse.ArgumentParser:
    parser = GroupedHelpParser(prog="polaris-key", description="Polaris Key client.")
    sub = parser.add_subparsers(dest="command", required=True)
    register_argparse(sub)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as e:
        # argparse printed its usage to stderr; --json still ends with a result line.
        if e.code not in (0, None) and "--json" in argv:
            command = next((a for a in argv if not a.startswith("-")), "")
            return json_usage_error(command, "usage")
        raise
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
