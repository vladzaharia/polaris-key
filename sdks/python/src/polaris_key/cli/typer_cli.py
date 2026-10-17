"""Optional ``typer`` adapter + injectable hook over the shared command core.

Importing this module requires the ``typer`` extra. Like the click adapter, every command is
built from the one verb table (:mod:`polaris_key.cli.verbs`) and draws through the terminal kit. A consumer mounts the app via
``app.add_typer(polaris_typer_app(...), name="polaris")``.
"""

from __future__ import annotations

import inspect
import sys
from typing import Any, Callable, List, Mapping, Optional, Sequence, Union

import typer

from ..ui.core import Copy
from . import core, mount
from . import verbs as verbs_mod


def _options(product, version, base_url, config_dir, trust, service, binding: Optional[mount.Binding] = None) -> core.ClientOptions:
    if binding is not None and binding.bound and binding.options is not None:
        from dataclasses import replace

        return replace(binding.options, config_dir=config_dir)
    try:
        parsed = core.parse_trust(trust)
        services = core.parse_services(list(service) if service else None)
    except ValueError as e:
        raise typer.BadParameter(str(e))
    return core.ClientOptions(
        product=product,
        version=version or core.DEFAULT_VERSION,
        trust=parsed,
        base_url=base_url,
        config_dir=config_dir,
        expected_services=services,
    )


def register_typer(
    host: typer.Typer,
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
    _nested_name: Optional[str] = None,
) -> typer.Typer:
    """Add the Polaris Key commands to ``host`` (a ``typer.Typer``), at its root or under
    ``namespace``. The options are :func:`polaris_key.cli.argparse_cli.register_argparse`'s:
    ``client=``/``config=`` with ``version=`` bind the mount and hide the integration options,
    ``verbs=`` picks the commands (default: the end-user set), ``on_collision`` decides what a
    host command with a verb's name does."""
    binding = mount.resolve_binding(client_factory, client=client, config=config, version=version)
    host_prog = prog or host.info.name or "mytool"
    names = [c.name or (c.callback.__name__.replace("_", "-") if c.callback else "") for c in host.registered_commands]
    names += [g.name or "" for g in host.registered_groups]
    plan = mount.plan_mount(names, namespace=namespace, verbs=verbs, on_collision=on_collision, bound=binding.bound, prog=host_prog)
    if plan.skipped:
        (warn or (lambda m: print(m, file=sys.stderr)))(mount.skip_warning(plan.skipped, host_prog))
    base = prog or host.info.name
    shown = (f"{base} {namespace}" if namespace else base) if base else None
    product = binding.product or host_prog
    heading = Copy("en")("cli.help.group")
    target = host
    if namespace:
        target = typer.Typer(help=Copy("en")("cli.help.namespace"))
        host.add_typer(target, name=namespace, help=Copy("en")("cli.help.namespace"), rich_help_panel=heading)

    def _emit(result: core.CommandResult) -> None:
        result.emit()
        raise typer.Exit(code=result.code)

    by_name = {v.name: v for v in verbs_mod.VERBS}
    for name in plan.verbs:
        verb = by_name[name]
        target.command(
            name=verb.name,
            help=mount.verb_help(verb.name, plan.ids, product),
            rich_help_panel=None if namespace else heading,
            hidden=verb.name in mount.ALIASES,
        )(_typer_verb(binding, verb, _emit, theme, shown, plan.actions or None))
    if binding.bound:
        from .gate import GateTarget, bind_gate

        bind_gate(GateTarget(lambda: binding.factory(binding.options), binding.close, shown, plan.ids, theme, namespace or (_nested_name if _nested else None)))
    return host


def polaris_typer_app(
    client_factory: Optional[core.ClientFactory] = None,
    *,
    theme: Any = None,
    prog: Optional[str] = None,
    name: str = "license",
    **mount_options: Any,
) -> typer.Typer:
    """Return a ``typer.Typer`` exposing the Polaris Key commands.

    Mount it with ``app.add_typer(polaris_typer_app(...), name="polaris")``.
    ``client_factory`` (default: build from the parsed options) lets a consumer pin trust
    keys / base URL; ``theme`` restyles the terminal kit and ``prog`` is the command its fix
    lines name (default: the one the person typed). ``name`` is the group it is mounted under
    (``license``). ``mount_options`` are :func:`register_typer`'s ``client``, ``config``, ``version``,
    ``verbs``, ``on_collision`` and ``warn``. To mount at the root of your own app, use
    :func:`register_typer`.
    """
    app = typer.Typer(help=Copy("en")("cli.help.namespace"))
    register_typer(app, client_factory, theme=theme, prog=prog, _nested=True, _nested_name=name, **mount_options)
    return app


def _typer_verb(
    binding: mount.Binding, verb: "verbs_mod.Verb", emit, theme: Any = None, prog: Optional[str] = None, actions: Any = None  # noqa: ANN001
):
    """A function whose signature typer reads: the common options, the free words and the
    verb's options, all from the one table."""
    P = inspect.Parameter
    hide = binding.bound
    params = [
        P("ctx", P.KEYWORD_ONLY, default=None, annotation=typer.Context),
        P("product", P.KEYWORD_ONLY, default=typer.Option(None if hide else ..., help="Product slug.", hidden=hide), annotation=Optional[str] if hide else str),
        P("version", P.KEYWORD_ONLY, default=typer.Option(None, hidden=hide), annotation=Optional[str]),
        P("base_url", P.KEYWORD_ONLY, default=typer.Option(None, hidden=hide), annotation=Optional[str]),
        P("config_dir", P.KEYWORD_ONLY, default=typer.Option(None, hidden=hide), annotation=Optional[str]),
        P("trust", P.KEYWORD_ONLY, default=typer.Option([], hidden=hide), annotation=List[str]),
        P("service", P.KEYWORD_ONLY, default=typer.Option([], hidden=hide), annotation=List[str]),
    ]
    if verb.arg:
        params.insert(0, P(verb.arg, P.POSITIONAL_OR_KEYWORD, default=typer.Argument(None), annotation=Optional[str]))
    elif verb.words:
        params.insert(0, P("words", P.POSITIONAL_OR_KEYWORD, default=typer.Argument(None), annotation=Optional[List[str]]))
    for o in verb.opts + verbs_mod.UI_OPTS:
        ann: Any = bool if o.kind == "flag" else (Optional[int] if o.kind == "int" else Optional[str])
        text = mount.option_help(o)
        default = typer.Option(
            False if o.kind == "flag" else o.default, f"--{o.name}", help=None if text == "==SUPPRESS==" else text, hidden=text == "==SUPPRESS=="
        )
        params.append(P(verbs_mod.option_dest(o.name), P.KEYWORD_ONLY, default=default, annotation=ann))

    def run(**kw: Any) -> None:
        ctx = kw.pop("ctx", None)
        opts = _options(kw.pop("product"), kw.pop("version"), kw.pop("base_url"), kw.pop("config_dir"),
                        kw.pop("trust"), kw.pop("service"), binding)
        if verb.arg:
            value = kw.pop(verb.arg, None)
            words = [value] if value else []
        else:
            words = kw.pop("words", None) or []
        ns = verbs_mod.namespace(verb, words, kw)
        emit(verbs_mod.run(binding.factory, opts, verb, ns, theme=theme, prog=prog or (ctx.command_path.rsplit(" ", 1)[0] if ctx is not None else mount.program_name()), close=binding.close, actions=actions))

    run.__signature__ = inspect.Signature(params)  # type: ignore[attr-defined]
    run.__name__ = verb.name.replace("-", "_")
    return run


# Standalone entry point (``python -m polaris_key.cli.typer_cli``).
app = polaris_typer_app(prog="polaris-key", verbs="all")


if __name__ == "__main__":
    app()
