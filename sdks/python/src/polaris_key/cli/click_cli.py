"""Optional ``click`` adapter + injectable hook over the shared command core.

Importing this module requires the ``click`` extra. The commands are built from the one verb
table (:mod:`polaris_key.cli.verbs`), so they never diverge from the argparse front end, and draw
through the terminal kit (``--json``, ``--no-color``, ``--ascii`` on every verb). A consumer
attaches the group to their own app via ``app.add_command(polaris_click_group(...))``.

Verbs are grouped by owning service (license/devices/config/core) exactly as in the
argparse adapter — the help text names the owner so the CLI surface matches the SDK's.
"""

from __future__ import annotations

from typing import Any, Optional

import click

from . import core, verbs

_common = [
    click.option("--product", required=True, help="Product slug (the doc audience)."),
    click.option(
        "--version", default=core.DEFAULT_VERSION, help="This client's version."
    ),
    click.option("--base-url", default=None, help="Override the control-plane base URL."),
    click.option("--config-dir", default=None, help="Override the config dir."),
    click.option(
        "--trust", multiple=True, metavar="kid=rawBase64url", help="Trusted key (repeatable)."
    ),
    click.option(
        "--service",
        multiple=True,
        metavar="SLUG",
        help="A service this build expects the product to run (repeatable).",
    ),
]


def _with_common(f):
    for opt in reversed(_common):
        f = opt(f)
    return f


def _options(product, version, base_url, config_dir, trust, service) -> core.ClientOptions:
    try:
        parsed = core.parse_trust(trust)
        services = core.parse_services(list(service) if service else None)
    except ValueError as e:
        raise click.BadParameter(str(e))
    return core.ClientOptions(
        product=product,
        version=version,
        trust=parsed,
        base_url=base_url,
        config_dir=config_dir,
        expected_services=services,
    )


def polaris_click_group(
    client_factory: Optional[core.ClientFactory] = None,
    name: str = "polaris",
    *,
    theme: Any = None,
    prog: Optional[str] = None,
) -> click.Group:
    """Return a ``click.Group`` exposing the Polaris Key commands.

    Mount it with ``app.add_command(polaris_click_group(...))``. ``client_factory``
    (default: build from the parsed options) lets a consumer pin trust keys / base URL;
    ``theme`` restyles the terminal kit and ``prog`` is the command its fix lines name.
    """
    factory = client_factory or core.default_client_factory

    @click.group(name=name, help="Polaris Key client.")
    def group() -> None:
        pass

    def _emit(result: core.CommandResult) -> None:
        result.emit()
        raise SystemExit(result.code)

    # Every verb from the one table (cli/verbs.py), so the front ends never diverge.
    for verb in verbs.VERBS:
        group.add_command(_click_verb(factory, verb, _emit, theme, prog or "polaris-key"))

    return group


def _click_verb(factory: core.ClientFactory, verb: "verbs.Verb", emit, theme: Any = None, prog: str = "polaris-key") -> click.Command:  # noqa: ANN001
    def callback(product, version, base_url, config_dir, trust, service, words=(), **values):  # noqa: ANN001
        opts = _options(product, version, base_url, config_dir, trust, service)
        if verb.arg:
            value = values.pop(verb.arg, None)
            words = (value,) if value else ()
        ns = verbs.namespace(verb, list(words), values)
        emit(verbs.run(factory, opts, verb, ns, theme=theme, prog=prog))

    params = []
    if verb.arg:
        params.append(click.Argument([verb.arg], required=False, default=None))
    elif verb.words:
        params.append(click.Argument(["words"], nargs=-1))
    for o in verb.opts + verbs.UI_OPTS:
        if o.kind == "flag":
            params.append(click.Option([f"--{o.name}"], is_flag=True, default=False, help=o.help))
        else:
            params.append(click.Option([f"--{o.name}"], type=int if o.kind == "int" else str, default=o.default, help=o.help))
    cmd = click.Command(name=verb.name, callback=callback, params=params, help=f"[{verb.group}] {verb.help}")
    return _with_common(cmd)


# Standalone entry point (``python -m polaris_key.cli.click_cli``).
cli = polaris_click_group(name="cli")


if __name__ == "__main__":
    cli()
