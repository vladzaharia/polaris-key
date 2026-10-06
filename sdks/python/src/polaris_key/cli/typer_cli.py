"""Optional ``typer`` adapter + injectable hook over the shared command core.

Importing this module requires the ``typer`` extra. Like the click adapter, every command
is a thin wrapper over :mod:`polaris_key.cli.core`. A consumer mounts the app via
``app.add_typer(polaris_typer_app(...), name="polaris")``.
"""

from __future__ import annotations

import inspect
from typing import Any, List, Optional

import typer

from . import core, verbs


def _options(product, version, base_url, config_dir, trust, service) -> core.ClientOptions:
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
        expected_services=core.parse_services(list(service) if service else None),
    )


def polaris_typer_app(
    client_factory: Optional[core.ClientFactory] = None,
) -> typer.Typer:
    """Return a ``typer.Typer`` exposing the Polaris Key commands.

    Mount it with ``app.add_typer(polaris_typer_app(...), name="polaris")``.
    ``client_factory`` (default: build from the parsed options) lets a consumer pin trust
    keys / base URL.
    """
    factory = client_factory or core.default_client_factory
    app = typer.Typer(help="Polaris Key client.")

    def _emit(result: core.CommandResult) -> None:
        result.emit()
        raise typer.Exit(code=result.code)

    # ── license ─────────────────────────────────────────────────────────────────────
    @app.command(help="[license] Activate this device with a license key.")
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
        service: List[str] = typer.Option([], help="Expected service slug (repeatable)."),
        key_file: Optional[str] = typer.Option(None, help="Read the key from a file."),
        key_stdin: bool = typer.Option(False, help="Read the key from stdin."),
    ) -> None:
        opts = _options(product, version, base_url, config_dir, trust, service)
        try:
            resolved = core.resolve_activation_key(
                key, key_file=key_file, key_stdin=key_stdin
            )
        except (ValueError, OSError) as e:
            raise typer.BadParameter(str(e))
        _emit(core.run_command(factory, opts, lambda c: core.activate(c, resolved)))

    @app.command(help="[license] Obtain a license with no key and no sign-in.")
    def enroll(
        product: str = typer.Option(..., help="Product slug."),
        version: str = typer.Option(core.DEFAULT_VERSION),
        base_url: Optional[str] = typer.Option(None),
        config_dir: Optional[str] = typer.Option(None),
        trust: List[str] = typer.Option([]),
        service: List[str] = typer.Option([]),
    ) -> None:
        opts = _options(product, version, base_url, config_dir, trust, service)
        _emit(core.run_command(factory, opts, core.enroll))

    @app.command(help="[license] Deauthorize + wipe local credentials.")
    def deactivate(
        product: str = typer.Option(..., help="Product slug."),
        version: str = typer.Option(core.DEFAULT_VERSION),
        base_url: Optional[str] = typer.Option(None),
        config_dir: Optional[str] = typer.Option(None),
        trust: List[str] = typer.Option([]),
        service: List[str] = typer.Option([]),
    ) -> None:
        opts = _options(product, version, base_url, config_dir, trust, service)
        _emit(core.run_command(factory, opts, core.deactivate))

    @app.command(help="[license] Show the current gate status.")
    def status(
        product: str = typer.Option(..., help="Product slug."),
        version: str = typer.Option(core.DEFAULT_VERSION),
        base_url: Optional[str] = typer.Option(None),
        config_dir: Optional[str] = typer.Option(None),
        trust: List[str] = typer.Option([]),
        service: List[str] = typer.Option([]),
    ) -> None:
        opts = _options(product, version, base_url, config_dir, trust, service)
        _emit(core.run_command(factory, opts, core.status))

    # ── devices ─────────────────────────────────────────────────────────────────────
    @app.command(help="[devices] Register this device keylessly.")
    def register(
        product: str = typer.Option(..., help="Product slug."),
        version: str = typer.Option(core.DEFAULT_VERSION),
        base_url: Optional[str] = typer.Option(None),
        config_dir: Optional[str] = typer.Option(None),
        trust: List[str] = typer.Option([]),
        service: List[str] = typer.Option([]),
    ) -> None:
        opts = _options(product, version, base_url, config_dir, trust, service)
        _emit(core.run_command(factory, opts, core.register))

    # ── core ────────────────────────────────────────────────────────────────────────
    @app.command(
        name="import-bundle", help="[core] Import an offline activation bundle."
    )
    def import_bundle(
        bundle: str,
        product: str = typer.Option(..., help="Product slug."),
        version: str = typer.Option(core.DEFAULT_VERSION),
        base_url: Optional[str] = typer.Option(None),
        config_dir: Optional[str] = typer.Option(None),
        trust: List[str] = typer.Option([]),
        service: List[str] = typer.Option([]),
    ) -> None:
        opts = _options(product, version, base_url, config_dir, trust, service)
        try:
            jws = core.read_bundle_file(bundle)
        except (ValueError, OSError) as e:
            raise typer.BadParameter(str(e))
        _emit(core.run_command(factory, opts, lambda c: core.import_bundle(c, jws)))

    # ── the full verb set (cli/verbs.py) ────────────────────────────────────────────
    for verb in verbs.VERBS:
        app.command(name=verb.name, help=f"[{verb.group}] {verb.help}")(_typer_verb(factory, verb, _emit))

    return app


def _typer_verb(factory: core.ClientFactory, verb: "verbs.Verb", emit):  # noqa: ANN001
    """A function whose signature typer reads: the common options, the free words and the
    verb's options, all from the one table."""
    P = inspect.Parameter
    params = [
        P("product", P.KEYWORD_ONLY, default=typer.Option(..., help="Product slug."), annotation=str),
        P("version", P.KEYWORD_ONLY, default=typer.Option(core.DEFAULT_VERSION), annotation=str),
        P("base_url", P.KEYWORD_ONLY, default=typer.Option(None), annotation=Optional[str]),
        P("config_dir", P.KEYWORD_ONLY, default=typer.Option(None), annotation=Optional[str]),
        P("trust", P.KEYWORD_ONLY, default=typer.Option([]), annotation=List[str]),
        P("service", P.KEYWORD_ONLY, default=typer.Option([]), annotation=List[str]),
    ]
    if verb.words:
        params.insert(0, P("words", P.POSITIONAL_OR_KEYWORD, default=typer.Argument(None), annotation=Optional[List[str]]))
    for o in verb.opts:
        ann: Any = bool if o.kind == "flag" else (Optional[int] if o.kind == "int" else Optional[str])
        default = typer.Option(False if o.kind == "flag" else o.default, f"--{o.name}", help=o.help)
        params.append(P(verbs.option_dest(o.name), P.KEYWORD_ONLY, default=default, annotation=ann))

    def run(**kw: Any) -> None:
        opts = _options(kw.pop("product"), kw.pop("version"), kw.pop("base_url"), kw.pop("config_dir"),
                        kw.pop("trust"), kw.pop("service"))
        words = kw.pop("words", None) or []
        ns = verbs.namespace(verb, words, kw)
        emit(core.run_command(factory, opts, lambda c: verb.run(c, ns)))

    run.__signature__ = inspect.Signature(params)  # type: ignore[attr-defined]
    run.__name__ = verb.name.replace("-", "_")
    return run


# Standalone entry point (``python -m polaris_key.cli.typer_cli``).
app = polaris_typer_app()


if __name__ == "__main__":
    app()
