"""Optional ``click`` adapter over the shared command core.

Importing this module requires the ``click`` extra. The commands are thin wrappers over
:mod:`polaris_key.cli.core`, so they never diverge from the argparse front end.
"""

from __future__ import annotations

from typing import Dict, List

import click

from . import core


def _parse_trust(pairs: List[str]) -> Dict[str, str]:
    trust: Dict[str, str] = {}
    for p in pairs:
        if "=" not in p:
            raise click.BadParameter(f"--trust expects kid=rawBase64url, got: {p}")
        kid, raw = p.split("=", 1)
        trust[kid] = raw
    return trust


_common = [
    click.option("--product", required=True, help="Product slug (the doc audience)."),
    click.option("--version", default="0.0.0-dev", help="This client's version."),
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


@click.group()
def cli() -> None:
    """Polaris Key client."""


@cli.command()
@_with_common
@click.argument("key")
def activate(product, version, base_url, config_dir, trust, key):  # noqa: ANN001
    client = core.build_client(
        product=product,
        version=version,
        trust=_parse_trust(list(trust)),
        base_url=base_url,
        config_dir=config_dir,
    )
    try:
        result = core.activate(client, key)
    finally:
        client.close()
    result.emit()
    raise SystemExit(result.code)


@cli.command()
@_with_common
def deactivate(product, version, base_url, config_dir, trust):  # noqa: ANN001
    client = core.build_client(
        product=product,
        version=version,
        trust=_parse_trust(list(trust)),
        base_url=base_url,
        config_dir=config_dir,
    )
    try:
        result = core.deactivate(client)
    finally:
        client.close()
    result.emit()
    raise SystemExit(result.code)


@cli.command()
@_with_common
def status(product, version, base_url, config_dir, trust):  # noqa: ANN001
    client = core.build_client(
        product=product,
        version=version,
        trust=_parse_trust(list(trust)),
        base_url=base_url,
        config_dir=config_dir,
    )
    try:
        result = core.status(client)
    finally:
        client.close()
    result.emit()
    raise SystemExit(result.code)


if __name__ == "__main__":
    cli()
