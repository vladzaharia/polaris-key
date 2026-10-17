"""Optional ``click`` adapter + injectable hook over the shared command core.

Importing this module requires the ``click`` extra. The commands are built from the one verb
table (:mod:`polaris_key.cli.verbs`), so they never diverge from the argparse front end, and draw
through the terminal kit (``--json``, ``--no-color``, ``--ascii`` on every verb). A consumer
attaches the group to their own app via ``app.add_command(polaris_click_group(...))``.

Verbs are grouped by owning service (license/devices/config/core) exactly as in the
argparse adapter — the help text names the owner so the CLI surface matches the SDK's.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional, Sequence, Union

import click
from click.formatting import wrap_text

from ..ui.core import Copy
from . import core, mount
from . import verbs as verbs_mod

def _common(bound: bool):
    """The integration options; bound to a client or config they are hidden and not required."""
    return [
        click.option("--product", required=not bound, default=None, hidden=bound, help="Product slug (the doc audience)."),
        click.option("--version", default=None, hidden=bound, help="This client's version (default: the installed polaris-key version)."),
        click.option("--base-url", default=None, hidden=bound, help="Override the control-plane base URL."),
        click.option("--config-dir", default=None, hidden=bound, help="Override the config dir."),
        click.option("--trust", multiple=True, metavar="kid=rawBase64url", hidden=bound, help="Trusted key (repeatable)."),
        click.option(
            "--service",
            multiple=True,
            metavar="SLUG",
            hidden=bound,
            help="A service this build expects the product to run (repeatable).",
        ),
    ]


def _with_common(f, bound: bool = False):
    for opt in reversed(_common(bound)):
        f = opt(f)
    return f


def _options(product, version, base_url, config_dir, trust, service, binding: Optional[mount.Binding] = None) -> core.ClientOptions:
    if binding is not None and binding.bound and binding.options is not None:
        from dataclasses import replace

        return replace(binding.options, config_dir=config_dir)
    try:
        parsed = core.parse_trust(trust)
        services = core.parse_services(list(service) if service else None)
    except ValueError as e:
        raise click.BadParameter(str(e))
    return core.ClientOptions(
        product=product,
        version=version or core.DEFAULT_VERSION,
        trust=parsed,
        base_url=base_url,
        config_dir=config_dir,
        expected_services=services,
    )


def _help(o: Any) -> Optional[str]:
    text = mount.option_help(o)
    return None if text == "==SUPPRESS==" else text


def _install_help(group: click.Group, plan: Any, product: str, namespace_row: bool, host_commands: bool = True) -> None:
    """The group's command list in the kit's order: the host's own commands, then one License section
    (the catalog's copy, the Node kit's task order and signatures; one entry under a namespace; an
    alias is not a command of its own)."""
    from ..ui.core import Copy

    def format_commands(ctx: click.Context, formatter: click.HelpFormatter) -> None:
        copy = Copy("en")
        own = set(plan.verbs) | ({plan.namespace} if plan.namespace and namespace_row else set())
        host = []
        for name in group.list_commands(ctx):
            cmd = group.get_command(ctx, name)
            if cmd is None or cmd.hidden or name in own or not host_commands:
                continue
            host.append((name, cmd.get_short_help_str(limit=max(45, formatter.width - 40))))
        if host:
            with formatter.section("Commands"):
                formatter.write_dl(host)
        if namespace_row:
            rows = [(plan.namespace, copy("cli.help.namespace"))]
        else:
            rows = [
                (mount.id_term(i), copy(mount.ID_COPY[i], product=product) if i in mount.ID_COPY else mount.verb_help(i.split(" ", 1)[0], [i], product))
                for i in mount.help_order(plan.ids)
            ]
        with formatter.section(copy("cli.help.group")):
            if formatter.width < 60:
                # Narrow: each command on a line of its own, its description stacked under it.
                for term, text in rows:
                    formatter.write(" " * formatter.current_indent + term + "\n")
                    formatter.write(wrap_text(text, width=max(10, formatter.width - 4), initial_indent="    ", subsequent_indent="    ") + "\n")
            else:
                formatter.write_dl(rows)

    group.format_commands = format_commands  # type: ignore[method-assign]


def register_click(
    host: click.Group,
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
    _nested: bool = False,
) -> click.Group:
    """Add the Polaris Key commands to ``host`` (a ``click.Group``), at its root or under
    ``namespace``. The options are :func:`polaris_key.cli.argparse_cli.register_argparse`'s:
    ``client=``/``config=`` with ``version=`` bind the mount and hide the integration options,
    ``verbs=`` picks the commands (default: the end-user set), ``on_collision`` decides what a
    host command with a verb's name does. The command the fix lines name is ``prog`` when given,
    else the one the person typed (click's root and the group path), never ``polaris-key``."""
    binding = mount.resolve_binding(client_factory, client=client, config=config, version=version)
    host_prog = prog or host.name or "mytool"
    plan = mount.plan_mount(list(host.commands), namespace=namespace, verbs=verbs, on_collision=on_collision, bound=binding.bound, prog=host_prog)
    if plan.skipped:
        (warn or (lambda m: click.echo(m, err=True)))(mount.skip_warning(plan.skipped, host_prog))
    shown = (f"{prog} {namespace}" if namespace else prog) if prog else None
    product = binding.product or host_prog
    target = host
    if namespace:
        target = click.Group(name=namespace, help=Copy("en")("cli.help.namespace"))
        host.add_command(target)

    def _emit(result: core.CommandResult) -> None:
        result.emit()
        raise SystemExit(result.code)

    by_name = {v.name: v for v in verbs_mod.VERBS}
    for name in plan.verbs:
        target.add_command(_click_verb(binding, by_name[name], _emit, theme, shown, plan.actions or None, product, plan.ids))
    _install_help(host, plan, product, namespace_row=bool(namespace), host_commands=True)
    if namespace:
        _install_help(target, plan, product, namespace_row=False, host_commands=False)
    if binding.bound:
        from .gate import GateTarget, bind_gate

        bind_gate(GateTarget(lambda: binding.factory(binding.options), binding.close, shown, plan.ids, theme, namespace or (host.name if _nested else None)))
    return host


def polaris_click_group(
    client_factory: Optional[core.ClientFactory] = None,
    name: str = "license",
    *,
    theme: Any = None,
    prog: Optional[str] = None,
    **mount_options: Any,
) -> click.Group:
    """Return a ``click.Group`` exposing the Polaris Key commands, named ``license`` unless you say
    otherwise.

    Mount it with ``app.add_command(polaris_click_group(...))``. ``client_factory``
    (default: build from the parsed options) lets a consumer pin trust keys / base URL;
    ``theme`` restyles the terminal kit and ``prog`` is the command its fix lines name (default:
    the one the person typed, ``tidewater license``). ``mount_options`` are :func:`register_click`'s
    ``client``, ``config``, ``version``, ``verbs``, ``on_collision`` and ``warn``. To mount at the
    root of your own group, use :func:`register_click`.
    """
    from ..ui.core import Copy as _Copy

    group = click.Group(name=name, help=_Copy("en")("cli.help.namespace"))
    register_click(group, client_factory, theme=theme, prog=prog, _nested=True, **mount_options)
    return group


def _click_verb(
    binding: mount.Binding,
    verb: "verbs_mod.Verb",
    emit,  # noqa: ANN001
    theme: Any = None,
    prog: Optional[str] = None,
    actions: Any = None,
    product_name: str = "",
    ids: Sequence[str] = (),
) -> click.Command:
    def callback(product, version, base_url, config_dir, trust, service, words=(), **values):  # noqa: ANN001
        opts = _options(product, version, base_url, config_dir, trust, service, binding)
        shown = prog or mount.runtime_prog(in_verb=True) or "polaris-key"
        if verb.arg:
            value = values.pop(verb.arg, None)
            words = (value,) if value else ()
        ns = verbs_mod.namespace(verb, list(words), values)
        emit(verbs_mod.run(binding.factory, opts, verb, ns, theme=theme, prog=shown, close=binding.close, actions=actions))

    params = []
    if verb.arg:
        params.append(click.Argument([verb.arg], required=False, default=None))
    elif verb.words:
        params.append(click.Argument(["words"], nargs=-1))
    for o in verb.opts + verbs_mod.UI_OPTS:
        if o.kind == "flag":
            params.append(click.Option([f"--{o.name}"], is_flag=True, default=False, help=_help(o), hidden=o.help.startswith("Accepted for compatibility")))
        else:
            hide = bool(actions) and o.name == "to" and "download" not in (actions.get(verb.name) or ("download",))
            params.append(click.Option([f"--{o.name}"], type=int if o.kind == "int" else str, default=o.default, help=_help(o), hidden=hide))
    alias = verb.name in mount.ALIASES
    cmd = click.Command(
        name=verb.name,
        callback=callback,
        params=params,
        help=mount.verb_help(verb.name, ids, product_name),
        hidden=alias,
    )
    return _with_common(cmd, binding.bound)


# Standalone entry point (``python -m polaris_key.cli.click_cli``).
cli = polaris_click_group(name="cli", prog="polaris-key", verbs="all")


if __name__ == "__main__":
    cli()
