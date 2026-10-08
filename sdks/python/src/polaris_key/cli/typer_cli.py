"""Optional ``typer`` adapter + injectable hook over the shared command core.

Importing this module requires the ``typer`` extra. Like the click adapter, every command is
built from the one verb table (:mod:`polaris_key.cli.verbs`) and draws through the terminal kit. A consumer mounts the app via
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
        services = core.parse_services(list(service) if service else None)
    except ValueError as e:
        raise typer.BadParameter(str(e))
    return core.ClientOptions(
        product=product,
        version=version,
        trust=parsed,
        base_url=base_url,
        config_dir=config_dir,
        expected_services=services,
    )


def polaris_typer_app(
    client_factory: Optional[core.ClientFactory] = None,
    *,
    theme: Any = None,
    prog: Optional[str] = None,
) -> typer.Typer:
    """Return a ``typer.Typer`` exposing the Polaris Key commands.

    Mount it with ``app.add_typer(polaris_typer_app(...), name="polaris")``.
    ``client_factory`` (default: build from the parsed options) lets a consumer pin trust
    keys / base URL; ``theme`` restyles the terminal kit and ``prog`` is the command its fix
    lines name.
    """
    factory = client_factory or core.default_client_factory
    app = typer.Typer(help="Polaris Key client.")

    def _emit(result: core.CommandResult) -> None:
        result.emit()
        raise typer.Exit(code=result.code)

    # Every verb from the one table (cli/verbs.py), so the front ends never diverge.
    for verb in verbs.VERBS:
        app.command(name=verb.name, help=f"[{verb.group}] {verb.help}")(
            _typer_verb(factory, verb, _emit, theme, prog or "polaris-key")
        )

    return app


def _typer_verb(factory: core.ClientFactory, verb: "verbs.Verb", emit, theme: Any = None, prog: str = "polaris-key"):  # noqa: ANN001
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
    if verb.arg:
        params.insert(0, P(verb.arg, P.POSITIONAL_OR_KEYWORD, default=typer.Argument(None), annotation=Optional[str]))
    elif verb.words:
        params.insert(0, P("words", P.POSITIONAL_OR_KEYWORD, default=typer.Argument(None), annotation=Optional[List[str]]))
    for o in verb.opts + verbs.UI_OPTS:
        ann: Any = bool if o.kind == "flag" else (Optional[int] if o.kind == "int" else Optional[str])
        default = typer.Option(False if o.kind == "flag" else o.default, f"--{o.name}", help=o.help)
        params.append(P(verbs.option_dest(o.name), P.KEYWORD_ONLY, default=default, annotation=ann))

    def run(**kw: Any) -> None:
        opts = _options(kw.pop("product"), kw.pop("version"), kw.pop("base_url"), kw.pop("config_dir"),
                        kw.pop("trust"), kw.pop("service"))
        if verb.arg:
            value = kw.pop(verb.arg, None)
            words = [value] if value else []
        else:
            words = kw.pop("words", None) or []
        ns = verbs.namespace(verb, words, kw)
        emit(verbs.run(factory, opts, verb, ns, theme=theme, prog=prog))

    run.__signature__ = inspect.Signature(params)  # type: ignore[attr-defined]
    run.__name__ = verb.name.replace("-", "_")
    return run


# Standalone entry point (``python -m polaris_key.cli.typer_cli``).
app = polaris_typer_app()


if __name__ == "__main__":
    app()
