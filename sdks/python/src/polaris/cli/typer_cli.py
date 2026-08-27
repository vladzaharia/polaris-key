"""Optional ``typer`` adapter + injectable hook over the shared command core.

Importing this module requires the ``typer`` extra. Like the click adapter, every command
is a thin wrapper over :mod:`polaris_key.cli.core`. A consumer mounts the app via
``app.add_typer(polaris_typer_app(...), name="key")``.
"""

from __future__ import annotations

from typing import List, Optional

import typer

from . import core


def _options(product, version, base_url, config_dir, trust) -> core.ClientOptions:
    try:
        parsed = core.parse_trust(trust)
    except ValueError as e:
        raise typer.BadParameter(str(e))
    return core.ClientOptions(
        product=product,
        version=version,
        trust=parsed,
        base_url=base_url,
        config_dir=config_dir,
    )


def polaris_typer_app(
    client_factory: Optional[core.ClientFactory] = None,
) -> typer.Typer:
    """Return a ``typer.Typer`` exposing the Polaris Key commands.

    Mount it with ``app.add_typer(polaris_typer_app(...), name="key")``. ``client_factory``
    (default: build from the parsed options) lets a consumer pin trust keys / base URL.
    """
    factory = client_factory or core.default_client_factory
    app = typer.Typer(help="Polaris Key client.")

    def _emit(result: core.CommandResult) -> None:
        result.emit()
        raise typer.Exit(code=result.code)

    @app.command()
    def activate(
        # Optional positional + non-argv sources. argv is visible in shell history and
        # `ps` (R12-13 / R4-16), so the documented path is --key-stdin / --key-file /
        # $POLARIS_KEY_ACTIVATION_KEY.
        key: Optional[str] = typer.Argument(None, help="The license key (DISCOURAGED)."),
        product: str = typer.Option(..., help="Product slug (the doc audience)."),
        version: str = typer.Option(core.DEFAULT_VERSION, help="This client's version."),
        base_url: Optional[str] = typer.Option(None, help="Override the base URL."),
        config_dir: Optional[str] = typer.Option(None, help="Override the config dir."),
        trust: List[str] = typer.Option([], help="Trusted key kid=rawBase64url (repeatable)."),
        key_file: Optional[str] = typer.Option(None, help="Read the key from a file."),
        key_stdin: bool = typer.Option(False, help="Read the key from stdin."),
    ) -> None:
        opts = _options(product, version, base_url, config_dir, trust)
        try:
            resolved = core.resolve_activation_key(
                key, key_file=key_file, key_stdin=key_stdin
            )
        except (ValueError, OSError) as e:
            raise typer.BadParameter(str(e))
        _emit(core.run_command(factory, opts, lambda c: core.activate(c, resolved)))

    @app.command()
    def deactivate(
        product: str = typer.Option(..., help="Product slug."),
        version: str = typer.Option(core.DEFAULT_VERSION),
        base_url: Optional[str] = typer.Option(None),
        config_dir: Optional[str] = typer.Option(None),
        trust: List[str] = typer.Option([]),
    ) -> None:
        opts = _options(product, version, base_url, config_dir, trust)
        _emit(core.run_command(factory, opts, core.deactivate))

    @app.command()
    def status(
        product: str = typer.Option(..., help="Product slug."),
        version: str = typer.Option(core.DEFAULT_VERSION),
        base_url: Optional[str] = typer.Option(None),
        config_dir: Optional[str] = typer.Option(None),
        trust: List[str] = typer.Option([]),
    ) -> None:
        opts = _options(product, version, base_url, config_dir, trust)
        _emit(core.run_command(factory, opts, core.status))

    @app.command()
    def config(
        key: str,
        product: str = typer.Option(..., help="Product slug."),
        version: str = typer.Option(core.DEFAULT_VERSION),
        base_url: Optional[str] = typer.Option(None),
        config_dir: Optional[str] = typer.Option(None),
        trust: List[str] = typer.Option([]),
        fallback: Optional[str] = typer.Option(None, help="Value if the key is unset."),
    ) -> None:
        opts = _options(product, version, base_url, config_dir, trust)
        _emit(core.run_command(factory, opts, lambda c: core.config(c, key, fallback)))

    return app


# Standalone entry point (``python -m polaris_key.cli.typer_cli``).
app = polaris_typer_app()


if __name__ == "__main__":
    app()
