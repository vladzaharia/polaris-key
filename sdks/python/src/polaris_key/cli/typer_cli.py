"""Optional ``typer`` adapter over the shared command core.

Importing this module requires the ``typer`` extra. Like the click adapter, every command
is a thin wrapper over :mod:`polaris_key.cli.core`.
"""

from __future__ import annotations

from typing import Dict, List, Optional

import typer

from . import core

app = typer.Typer(help="Polaris Key client.")


def _parse_trust(pairs: List[str]) -> Dict[str, str]:
    trust: Dict[str, str] = {}
    for p in pairs:
        if "=" not in p:
            raise typer.BadParameter(f"--trust expects kid=rawBase64url, got: {p}")
        kid, raw = p.split("=", 1)
        trust[kid] = raw
    return trust


def _run(result: core.CommandResult) -> None:
    result.emit()
    raise typer.Exit(code=result.code)


@app.command()
def activate(
    key: str,
    product: str = typer.Option(..., help="Product slug (the doc audience)."),
    version: str = typer.Option("0.0.0-dev", help="This client's version."),
    base_url: Optional[str] = typer.Option(None, help="Override the base URL."),
    config_dir: Optional[str] = typer.Option(None, help="Override the config dir."),
    trust: List[str] = typer.Option([], help="Trusted key kid=rawBase64url (repeatable)."),
) -> None:
    client = core.build_client(
        product=product,
        version=version,
        trust=_parse_trust(trust),
        base_url=base_url,
        config_dir=config_dir,
    )
    try:
        _run(core.activate(client, key))
    finally:
        client.close()


@app.command()
def deactivate(
    product: str = typer.Option(..., help="Product slug."),
    version: str = typer.Option("0.0.0-dev"),
    base_url: Optional[str] = typer.Option(None),
    config_dir: Optional[str] = typer.Option(None),
    trust: List[str] = typer.Option([]),
) -> None:
    client = core.build_client(
        product=product,
        version=version,
        trust=_parse_trust(trust),
        base_url=base_url,
        config_dir=config_dir,
    )
    try:
        _run(core.deactivate(client))
    finally:
        client.close()


@app.command()
def status(
    product: str = typer.Option(..., help="Product slug."),
    version: str = typer.Option("0.0.0-dev"),
    base_url: Optional[str] = typer.Option(None),
    config_dir: Optional[str] = typer.Option(None),
    trust: List[str] = typer.Option([]),
) -> None:
    client = core.build_client(
        product=product,
        version=version,
        trust=_parse_trust(trust),
        base_url=base_url,
        config_dir=config_dir,
    )
    try:
        _run(core.status(client))
    finally:
        client.close()


if __name__ == "__main__":
    app()
