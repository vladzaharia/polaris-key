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
) -> click.Group:
    """Add the Polaris Key commands to ``host`` (a ``click.Group``), at its root or under
    ``namespace``. The options are :func:`polaris_key.cli.argparse_cli.register_argparse`'s:
    ``client=``/``config=`` with ``version=`` bind the mount and hide the integration options,
    ``verbs=`` picks the commands (default: the end-user set), ``on_collision`` decides what a
    host command with a verb's name does."""
    binding = mount.resolve_binding(client_factory, client=client, config=config, version=version)
    host_prog = prog or host.name or "polaris-key"
    plan = mount.plan_mount(list(host.commands), namespace=namespace, verbs=verbs, on_collision=on_collision, bound=binding.bound, prog=host_prog)
    if plan.skipped:
        (warn or (lambda m: click.echo(m, err=True)))(mount.skip_warning(plan.skipped, host_prog))
    shown = f"{host_prog} {namespace}" if namespace else host_prog
    target = host
    if namespace:
        target = click.Group(name=namespace, help=f"{binding.product or host_prog} license and updates")
        host.add_command(target)

    def _emit(result: core.CommandResult) -> None:
        result.emit()
        raise SystemExit(result.code)

    by_name = {v.name: v for v in verbs_mod.VERBS}
    for name in plan.verbs:
        target.add_command(_click_verb(binding, by_name[name], _emit, theme, shown, plan.actions or None))
    if binding.bound:
        from .gate import GateTarget, bind_gate

        bind_gate(GateTarget(lambda: binding.factory(binding.options), binding.close, shown, plan.ids, theme))
    return host


def polaris_click_group(
    client_factory: Optional[core.ClientFactory] = None,
    name: str = "polaris",
    *,
    theme: Any = None,
    prog: Optional[str] = None,
    **mount_options: Any,
) -> click.Group:
    """Return a ``click.Group`` exposing the Polaris Key commands.

    Mount it with ``app.add_command(polaris_click_group(...))``. ``client_factory``
    (default: build from the parsed options) lets a consumer pin trust keys / base URL;
    ``theme`` restyles the terminal kit and ``prog`` is the command its fix lines name.
    ``mount_options`` are :func:`register_click`'s ``client``, ``config``, ``version``, ``verbs``,
    ``on_collision`` and ``warn``. To mount at the root of your own group, use :func:`register_click`.
    """
    group = click.Group(name=name, help="Polaris Key client.")
    register_click(group, client_factory, theme=theme, prog=prog or "polaris-key", **mount_options)
    return group


def _click_verb(
    binding: mount.Binding, verb: "verbs_mod.Verb", emit, theme: Any = None, prog: str = "polaris-key", actions: Any = None
) -> click.Command:  # noqa: ANN001
    def callback(product, version, base_url, config_dir, trust, service, words=(), **values):  # noqa: ANN001
        opts = _options(product, version, base_url, config_dir, trust, service, binding)
        if verb.arg:
            value = values.pop(verb.arg, None)
            words = (value,) if value else ()
        ns = verbs_mod.namespace(verb, list(words), values)
        emit(verbs_mod.run(binding.factory, opts, verb, ns, theme=theme, prog=prog, close=binding.close, actions=actions))

    params = []
    if verb.arg:
        params.append(click.Argument([verb.arg], required=False, default=None))
    elif verb.words:
        params.append(click.Argument(["words"], nargs=-1))
    for o in verb.opts + verbs_mod.UI_OPTS:
        if o.kind == "flag":
            params.append(click.Option([f"--{o.name}"], is_flag=True, default=False, help=o.help))
        else:
            params.append(click.Option([f"--{o.name}"], type=int if o.kind == "int" else str, default=o.default, help=o.help))
    cmd = click.Command(name=verb.name, callback=callback, params=params, help=f"[{verb.group}] {verb.help}")
    return _with_common(cmd, binding.bound)


# Standalone entry point (``python -m polaris_key.cli.click_cli``).
cli = polaris_click_group(name="cli", verbs="all")


if __name__ == "__main__":
    cli()
