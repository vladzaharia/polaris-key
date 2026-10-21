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
from dataclasses import dataclass
from typing import Any, Callable, List, Mapping, Optional, Sequence, Union

from ..ui.core import Copy
from . import core, mount, verbs


def _add_common(p: argparse.ArgumentParser, bound: bool = False) -> None:
    """The integration options. A mount bound to a client or config keeps them out of the host's
    help (they are accepted, and ignored but ``--config-dir``): the host already said all of it."""
    hide = argparse.SUPPRESS if bound else None
    p.add_argument("--product", required=not bound, default=None, help=hide or "Product slug (the doc audience).")
    p.add_argument(
        "--version",
        default=None,
        help=hide or "This client's version (default: the installed polaris-key version).",
    )
    p.add_argument("--base-url", default=None, help=hide or "Override the control-plane base URL.")
    p.add_argument("--config-dir", default=None, help=hide or "Override the config dir.")
    p.add_argument(
        "--trust",
        action="append",
        metavar="kid=rawBase64url",
        help=hide or "A trusted signing key (repeatable).",
    )
    p.add_argument(
        "--service",
        action="append",
        metavar="SLUG",
        help=hide
        or (
            "A service this build expects the product to run (repeatable). The D-21 "
            "fail-closed fallback used until discovery has been fetched."
        ),
    )
    for o in verbs.UI_OPTS:
        p.add_argument(f"--{o.name}", action="store_true", help=mount.option_help(o))


def _options(args: argparse.Namespace, binding: Optional[mount.Binding] = None) -> core.ClientOptions:
    if binding is not None and binding.bound and binding.options is not None:
        from dataclasses import replace

        return replace(binding.options, config_dir=getattr(args, "config_dir", None))
    try:
        trust = core.parse_trust(args.trust)
        services = core.parse_services(getattr(args, "service", None))
    except ValueError as e:
        raise SystemExit(str(e))
    return core.ClientOptions(
        product=args.product,
        version=args.version or core.DEFAULT_VERSION,
        trust=trust,
        base_url=args.base_url,
        config_dir=args.config_dir,
        expected_services=services,
    )


def register_argparse(
    subparsers: "argparse._SubParsersAction",
    client_factory: Optional[core.ClientFactory] = None,
    *,
    theme: Any = None,
    prog: Optional[str] = None,
    client: Any = None,
    config: Optional[Mapping[str, Any]] = None,
    version: Optional[str] = None,
    namespace: Optional[str] = None,
    verbs: Union[Sequence[str], str, None] = None,
    on_collision: str = "error",
    warn: Optional[Callable[[str], None]] = None,
) -> "argparse._SubParsersAction":
    """Add the Polaris Key subcommands to an existing subparsers object.

    Each registered subcommand gets a ``func(args) -> int`` default so the host CLI can
    dispatch with ``args.func(args)``.

    * ``client=`` (a client you keep) or ``config=`` (your generated ``polaris_config.CONFIG``, with
      ``version=``) bind the mount: ``--product``, ``--trust``, ``--base-url``, ``--service``,
      ``--config-dir`` and the per-verb ``--version`` are hidden, and nothing else is needed.
    * ``verbs=`` picks the verbs by id (``"activate"``, ``"devices list"``), by a one-word verb's
      alias or by group (``"devices"``); the default is the end-user set
      (:data:`polaris_key.cli.mount.END_USER`), ``"all"`` mounts every verb.
    * ``namespace="license"`` nests every verb: ``mytool license activate``.
    * ``on_collision``: a verb whose first word the host already uses fails the registration with
      ``polaris-verb-collision`` (``"error"``, default); ``"skip"`` drops the verb and warns once.
    * ``client_factory`` (default: build from the parsed options) lets a consumer pin trust keys or
      the base URL; ``theme`` restyles the terminal kit; ``prog`` is the command the kit's fix lines
      name (default: the host parser's).
    """
    binding = mount.resolve_binding(client_factory, client=client, config=config, version=version)
    host_prog = prog or getattr(subparsers, "_prog_prefix", None) or "polaris-key"
    plan = mount.plan_mount(
        list(getattr(subparsers, "_name_parser_map", {})),
        namespace=namespace,
        verbs=verbs,
        on_collision=on_collision,
        bound=binding.bound,
        prog=host_prog,
    )
    if plan.skipped:
        (warn or (lambda m: print(m, file=sys.stderr)))(mount.skip_warning(plan.skipped, host_prog))
    shown = f"{host_prog} {namespace}" if namespace else host_prog
    heading = Copy("en")("cli.help.group")
    target = subparsers
    if namespace:
        previous = getattr(subparsers, "_parser_class", None)
        subparsers._parser_class = GroupedHelpParser  # type: ignore[attr-defined]
        try:
            holder = _add(subparsers, namespace, help=Copy("en")("cli.help.namespace"), group=heading)
        finally:
            subparsers._parser_class = previous  # type: ignore[attr-defined]
        holder.description = Copy("en")("cli.help.namespace")
        target = holder.add_subparsers(dest="polaris_command", required=True)
        target._pk_mount = MountInfo(plan=plan, bound=binding.bound, legacy=False, prog=shown, nested=True)  # type: ignore[attr-defined]
    legacy = verbs == "all" and namespace is None
    _match_modern_argparse(subparsers)
    if getattr(target, "metavar", None) is None:
        target.metavar = "<command>"
    product = binding.product or host_prog
    by_name = {v.name: v for v in verbs_table()}
    for name in plan.verbs:
        verb = by_name[name]
        alias = name in mount.ALIASES
        if legacy:
            shown_help = " | ".join(plan.actions[verb.name]) if verb.name in plan.actions else verb.help
            list_help = f"[{verb.group}] {shown_help}"
        else:
            # The catalog's line, as the grouped help writes it; an alias is not a command of its own.
            list_help = argparse.SUPPRESS if alias else mount.verb_help(verb.name, plan.ids, product)
        p = _add(target, verb.name, help=list_help, group=heading)
        p._pk_desc = mount.verb_help(verb.name, plan.ids, product)  # type: ignore[attr-defined]
        p._pk_usage = mount.verb_usage(mount.ALIASES.get(verb.name, verb.name), plan.ids)  # type: ignore[attr-defined]
        allowed = plan.actions.get(verb.name)
        _add_common(p, binding.bound)
        if verb.arg:
            p.add_argument(verb.arg, nargs="?", default=None, help=verb.help)
        elif verb.words:
            # ``default=None``: before Python 3.13 a bare ``nargs="*"`` positional is *required* (it is only
            # optional with a default), so 3.9 listed it as a required argument of every verb.
            p.add_argument("words", nargs="*", default=None, metavar="ARG", help=argparse.SUPPRESS if not legacy else verb.help)
        for o in verb.opts:
            flag = f"--{o.name}"
            hide = (not legacy) and bool(allowed) and o.name == "to" and "download" not in allowed
            text = mount.option_help(o, hide) if not legacy else o.help
            if o.kind == "flag":
                p.add_argument(flag, action="store_true", help=text)
            else:
                p.add_argument(flag, type=int if o.kind == "int" else str, default=o.default, help=text)
        p.set_defaults(func=_verb(binding.factory, verb, theme, shown, binding, plan.actions or None, plan.ids))
    info = MountInfo(plan=plan, bound=binding.bound, legacy=verbs == "all" and namespace is None, prog=host_prog)
    subparsers._pk_mount = info  # type: ignore[attr-defined]
    if binding.bound:
        from .gate import GateTarget, bind_gate

        def build() -> Any:
            return binding.factory(binding.options)

        bind_gate(GateTarget(build, binding.close, shown, plan.ids, theme))
    return subparsers


class _IndentedWidths:
    """Python 3.9's ``HelpFormatter.add_argument`` measures a subcommand's name *before* the
    indent it is printed at, so the description column sits two cells to the left of where 3.10+
    puts it. This mixin measures it where it is printed, as newer Pythons do."""

    def add_argument(self, action: argparse.Action) -> None:
        if action.help is argparse.SUPPRESS:
            return
        width = len(self._format_action_invocation(action)) + self._current_indent  # type: ignore[attr-defined]
        for sub in self._iter_indented_subactions(action):  # type: ignore[attr-defined]
            width = max(width, len(self._format_action_invocation(sub)) + self._current_indent)  # type: ignore[attr-defined]
        self._action_max_length = max(self._action_max_length, width)  # type: ignore[attr-defined]
        self._add_item(self._format_action, [action])  # type: ignore[attr-defined]


def _match_modern_argparse(subparsers: "argparse._SubParsersAction") -> None:
    """Make the host's help read the same on Python 3.9 as on 3.10+: 3.9 titles the flag section
    "optional arguments:" (3.10 renamed it "options:") and misaligns the subcommand column
    (see :class:`_IndentedWidths`). argparse keeps no link from a subparsers action to its parser,
    so the parser is found through the action list they share. Nothing happens on 3.10+."""
    if sys.version_info >= (3, 10):
        return
    import gc

    for holder in gc.get_referrers(subparsers):
        if not isinstance(holder, list):
            continue
        for d in gc.get_referrers(holder):
            if not isinstance(d, dict):
                continue
            for owner in gc.get_referrers(d):
                if not isinstance(owner, argparse.ArgumentParser) or owner._actions is not holder and subparsers not in owner._actions:
                    continue
                group = getattr(owner, "_optionals", None)
                if getattr(group, "title", None) == "optional arguments":
                    group.title = "options"
                make = owner.formatter_class
                if not getattr(make, "_pk_indented", False):

                    def indented(*args: Any, __make: Any = make, **kwargs: Any) -> Any:
                        fmt = __make(*args, **kwargs)
                        if not isinstance(fmt, _IndentedWidths):
                            fmt.__class__ = type(fmt.__class__.__name__, (_IndentedWidths, fmt.__class__), {})
                        return fmt

                    indented._pk_indented = True  # type: ignore[attr-defined]
                    owner.formatter_class = indented  # type: ignore[assignment]
                return


def verbs_table() -> Any:
    return verbs.VERBS


def _add(sub: "argparse._SubParsersAction", name: str, *, help: str, group: Optional[str] = None) -> argparse.ArgumentParser:
    """``add_parser``, tagging the parser with its help heading when the action takes one."""
    # An alias is no command of its own: without ``help`` argparse lists nothing for it.
    p = sub.add_parser(name) if help == argparse.SUPPRESS else sub.add_parser(name, help=help)
    p._pk_group = group  # type: ignore[attr-defined]
    return p


@dataclass
class MountInfo:
    """What a mount tells the help: which verbs it added, whether it is the standalone CLI."""

    plan: Any
    bound: bool
    legacy: bool
    prog: str
    #: Inside the namespace's own command: its help lists the verbs, not the namespace.
    nested: bool = False


def json_usage_error(command: str, message: str, out: Any = None) -> int:
    """With ``--json``, a usage error still ends with a result line (exit 2)."""
    import json

    from ..ui.terminal.exit import EXIT
    from ..ui.terminal.flows import JSON_VERSION

    obj = {"v": JSON_VERSION, "command": command, "event": "result", "ok": False, "exit": EXIT.usage, "error": "usage", "message": message}
    (out or sys.stdout).write(json.dumps(obj, ensure_ascii=True) + "\n")
    return EXIT.usage


def _verb(
    factory: core.ClientFactory,
    verb: "verbs.Verb",
    theme: Any,
    prog: str,
    binding: Optional[mount.Binding] = None,
    actions: Any = None,
    mounted: Any = None,
):
    def run(args: argparse.Namespace) -> int:
        if getattr(args, "json", False):
            try:
                opts = _options(args, binding)
            except SystemExit as e:
                return json_usage_error(verb.name, str(e.code))
        else:
            opts = _options(args, binding)
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
        result = verbs.run(factory, opts, verb, ns, theme=theme, prog=prog, close=binding.close if binding else True, actions=actions, mounted=mounted)
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

    @staticmethod
    def _break_term(term: str, room: int) -> List[str]:
        """``term`` in pieces of at most ``room`` cells, broken after a hyphen (an option longer than
        the terminal is the only word the kit's wrap would leave whole)."""
        out: List[str] = []
        while len(term) > room > 8:
            cut = term.rfind("-", 0, room)
            if cut < 2:
                break
            out.append(term[: cut + 1])
            term = term[cut + 1 :]
        return out + [term]

    def pair(self, term: str, text: str, width: int) -> None:
        S, Line = self._Span, self._Line
        stacked = self.cols < self.stack_below or self.cols - 2 - width < 16
        if stacked:
            room = max(1, self.cols - 4)
            pieces = self._break_term(term, room)
            for i, r in enumerate(self._wrap([S(pieces[0], ("strong",))], room)):
                self.rows.append(self._to_ansi(Line([S("  " if not i else "      ")] + r), self.pal))
            for extra in pieces[1:]:
                self.rows.append(self._to_ansi(Line([S("      "), S(extra, ("strong",))]), self.pal))
            for r in self._wrap([S(text, ("muted",))], max(1, self.cols - 4)):
                self.rows.append(self._to_ansi(Line([S("    ")] + r), self.pal))
            return
        body = self._wrap([S(text, ("muted",))], max(1, self.cols - 2 - width))
        if self._cell_len(term) >= width:
            # A term wider than the column takes a line of its own; its description sits under it.
            for i, r in enumerate(self._wrap([S(term, ("strong",))], max(1, self.cols - 2))):
                self.rows.append(self._to_ansi(Line([S("  " if not i else "    ")] + r), self.pal))
            for r in body:
                self.rows.append(self._to_ansi(Line([S(" " * (2 + width))] + r), self.pal))
            return
        pad = S(" " * (width - self._cell_len(term)))
        for i, r in enumerate(body):
            head = [S("  "), S(term, ("strong",)), pad] if i == 0 else [S(" " * (2 + width))]
            self.rows.append(self._to_ansi(Line(head + r), self.pal))

    def text(self) -> str:
        return "\n".join(r.rstrip() for r in self.rows) + "\n"


class _GroupedSubParsers(argparse._SubParsersAction):
    """``add_parser(name, group="Build")``: the heading the command is listed under in
    :class:`GroupedHelpParser`'s help."""

    def add_parser(self, name: str, *, group: Optional[str] = None, **kwargs: Any) -> argparse.ArgumentParser:  # type: ignore[override]
        parser = super().add_parser(name, **kwargs)
        parser._pk_group = group  # type: ignore[attr-defined]
        return parser


class GroupedHelpParser(argparse.ArgumentParser):
    """``polaris-key --help``: the verbs grouped by owning service, commands in ``strong`` and
    their descriptions in mute (UI-KITS §1.5 rule 13), in 80 columns or the terminal's width.
    Descriptions wrap under their column; below 50 columns each command stacks above its
    description, as the Node kit's help does. Each verb's own ``--help`` is :class:`VerbHelpParser`'s.

    As a host's parser (verbs mounted with :func:`register_argparse`) it lists the host's commands
    first, under the heading each was added with (``add_parser(name, group="Build")``; default
    ``Commands``), then the license verbs under one heading, or one entry with a namespace."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.register("action", "parsers", _GroupedSubParsers)

    def add_subparsers(self, **kwargs: Any) -> "argparse._SubParsersAction":
        kwargs.setdefault("parser_class", VerbHelpParser)
        return super().add_subparsers(**kwargs)

    def _mount(self) -> Optional[Any]:
        for a in self._actions:
            info = getattr(a, "_pk_mount", None)
            if info is not None:
                return a, info
        return None

    def format_help(self) -> str:
        found = self._mount()
        if found is not None and not found[1].legacy:
            return self._format_mounted(*found)
        return self._format_standalone()

    def _format_mounted(self, action: Any, info: Any) -> str:
        w = _HelpWriter()
        S = w._Span
        copy = Copy("en")
        plan = info.plan
        w.line(S(self.prog, ("strong",)), S(w.sep, ("muted",)), S(self.description or "", ("muted",)))
        w.line()
        flags = "" if info.bound else " --product <slug>"
        w.line(S(copy("cli.help.usage"), ("muted",)), S("  " + f"{self.prog} <command>{flags} [options]"), hang=7)
        helps = {c.dest: c.help or "" for c in action._choices_actions}
        owned = set(plan.verbs) | ({plan.namespace} if plan.namespace and not info.nested else set())
        sections: List[Any] = []
        for name, parser in action.choices.items():
            if name in owned:
                continue
            heading = getattr(parser, "_pk_group", None) or "Commands"
            for sec in sections:
                if sec[0] == heading:
                    sec[1].append((name, helps.get(name, "")))
                    break
            else:
                sections.append((heading, [(name, helps.get(name, ""))]))
        if plan.namespace and not info.nested:
            license_rows = [(plan.namespace, helps.get(plan.namespace, ""))]
        else:
            license_rows = [(mount.id_term(i), self._id_help(copy, i)) for i in mount.help_order(plan.ids)]
        sections.append((copy("cli.help.group"), license_rows))
        width = min(36, max((len(t) for _, rows in sections for t, _ in rows), default=0) + 2)
        for heading, rows in sections:
            if not rows:
                continue
            w.line()
            w.line(S(heading, ("strong",)))
            for term, text in rows:
                w.pair(term, text, width)
        w.line()
        w.line(S(copy("cli.help.more", command=f"{self.prog} <command> --help"), ("muted",)))
        return w.text()

    @staticmethod
    def _id_help(copy: Any, id_: str) -> str:
        key = mount.ID_COPY.get(id_)
        if key:
            return copy(key, product="the app")
        first = id_.split(" ")[0]
        return next((v.help for v in verbs.VERBS if v.name == first), "")

    def _format_standalone(self) -> str:
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
        from ..ui.core import Copy

        copy = Copy("en")
        w = _HelpWriter()
        S = w._Span
        verb = self.prog.rsplit(" ", 1)[-1]
        desc = getattr(self, "_pk_desc", None) or next((v.help for v in verbs.VERBS if v.name == verb), self.description or "")
        w.line(S(self.prog, ("strong",)))
        w.line(S(desc, ("muted",)))
        w.line()
        shown = [a for a in self._actions if a.help != argparse.SUPPRESS]
        positional = [a for a in shown if not a.option_strings and a.dest != "help"]
        required = [a for a in shown if a.option_strings and a.required]
        meta = lambda a: "slug" if a.dest == "product" else str(a.metavar or a.dest).lower().replace("_", "-")  # noqa: E731
        usage = [self.prog] + [f"{a.option_strings[-1]} <{meta(a)}>" for a in required]
        words = getattr(self, "_pk_usage", None)
        if words:
            usage.append(words)
        else:
            usage += [f"[{(a.metavar or a.dest)}]" if a.nargs in ("?", "*") else f"<{a.metavar or a.dest}>" for a in positional]
        usage.append("[options]")
        w.line(S(copy("cli.help.usage"), ("muted",)), S("  " + " ".join(usage)), hang=7)
        w.line()
        w.line(S(copy("cli.help.options"), ("strong",)))
        rows = []
        for a in shown:
            if not a.option_strings or a.dest == "help":
                continue
            flag = a.option_strings[-1]
            if a.nargs != 0:
                flag += f" <{meta(a)}>"
            rows.append((flag, (a.help or "").replace("%(default)s", str(a.default))))
        rows.append(("-h, --help", copy("cli.option.help")))
        # A gutter of two cells at least, so a label never touches its description.
        width = min(26, max(len(r[0]) for r in rows) + 2)
        for term, text in rows:
            w.pair(term, text, width)
        return w.text()


def build_parser() -> argparse.ArgumentParser:
    parser = GroupedHelpParser(prog="polaris-key", description="Polaris Key client.")
    sub = parser.add_subparsers(dest="command", required=True)
    register_argparse(sub, verbs="all")
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
        from ..ui.terminal.exit import EXIT

        return EXIT.interrupted


if __name__ == "__main__":
    raise SystemExit(main())
