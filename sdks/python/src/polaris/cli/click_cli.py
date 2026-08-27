"""Optional ``click`` adapter + injectable hook over the shared command core.

Importing this module requires the ``click`` extra. The commands are thin wrappers over
:mod:`polaris_key.cli.core`, so they never diverge from the argparse front end. A consumer
attaches the group to their own app via ``app.add_command(polaris_click_group(...))``.
"""

from __future__ import annotations

from typing import Optional

import click

from . import core

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
]


def _with_common(f):
    for opt in reversed(_common):
        f = opt(f)
    return f


def _options(product, version, base_url, config_dir, trust) -> core.ClientOptions:
    try:
        parsed = core.parse_trust(trust)
    except ValueError as e:
        raise click.BadParameter(str(e))
    return core.ClientOptions(
        product=product,
        version=version,
        trust=parsed,
        base_url=base_url,
        config_dir=config_dir,
    )


def polaris_click_group(
    client_factory: Optional[core.ClientFactory] = None,
    name: str = "polaris-key",
) -> click.Group:
    """Return a ``click.Group`` exposing the Polaris Key commands.

    Mount it with ``app.add_command(polaris_click_group(...))``. ``client_factory``
    (default: build from the parsed options) lets a consumer pin trust keys / base URL.
    """
    factory = client_factory or core.default_client_factory

    @click.group(name=name, help="Polaris Key client.")
    def group() -> None:
        pass

    def _emit(result: core.CommandResult) -> None:
        result.emit()
        raise SystemExit(result.code)

    @group.command()
    @_with_common
    # Optional positional + non-argv sources. argv is visible in shell history and `ps`
    # (R12-13 / R4-16), so the documented path is --key-stdin / --key-file / the env var.
    @click.argument("key", required=False, default=None)
    @click.option("--key-file", default=None, help="Read the license key from a file.")
    @click.option(
        "--key-stdin", is_flag=True, help="Read the license key from stdin."
    )
    def activate(  # noqa: ANN001
        product, version, base_url, config_dir, trust, key, key_file, key_stdin
    ):
        opts = _options(product, version, base_url, config_dir, trust)
        try:
            resolved = core.resolve_activation_key(
                key, key_file=key_file, key_stdin=key_stdin
            )
        except (ValueError, OSError) as e:
            raise click.UsageError(str(e))
        _emit(core.run_command(factory, opts, lambda c: core.activate(c, resolved)))

    @group.command()
    @_with_common
    def deactivate(product, version, base_url, config_dir, trust):  # noqa: ANN001
        opts = _options(product, version, base_url, config_dir, trust)
        _emit(core.run_command(factory, opts, core.deactivate))

    @group.command()
    @_with_common
    def status(product, version, base_url, config_dir, trust):  # noqa: ANN001
        opts = _options(product, version, base_url, config_dir, trust)
        _emit(core.run_command(factory, opts, core.status))

    @group.command()
    @_with_common
    @click.argument("key")
    @click.option("--fallback", default=None, help="Value if the key is unset.")
    def config(product, version, base_url, config_dir, trust, key, fallback):  # noqa: ANN001
        opts = _options(product, version, base_url, config_dir, trust)
        _emit(core.run_command(factory, opts, lambda c: core.config(c, key, fallback)))

    return group


# Standalone entry point (``python -m polaris_key.cli.click_cli``).
cli = polaris_click_group(name="cli")


if __name__ == "__main__":
    cli()
