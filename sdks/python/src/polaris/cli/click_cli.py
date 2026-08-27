"""Optional ``click`` adapter + injectable hook over the shared command core.

Importing this module requires the ``click`` extra. The commands are thin wrappers over
:mod:`polaris.cli.core`, so they never diverge from the argparse front end. A consumer
attaches the group to their own app via ``app.add_command(polaris_click_group(...))``.

Verbs are grouped by owning service (license/devices/config/core) exactly as in the
argparse adapter — the help text names the owner so the CLI surface matches the SDK's.
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
    except ValueError as e:
        raise click.BadParameter(str(e))
    return core.ClientOptions(
        product=product,
        version=version,
        trust=parsed,
        base_url=base_url,
        config_dir=config_dir,
        expected_services=core.parse_services(list(service) if service else None),
    )


def polaris_click_group(
    client_factory: Optional[core.ClientFactory] = None,
    name: str = "polaris",
) -> click.Group:
    """Return a ``click.Group`` exposing the Polaris commands.

    Mount it with ``app.add_command(polaris_click_group(...))``. ``client_factory``
    (default: build from the parsed options) lets a consumer pin trust keys / base URL.
    """
    factory = client_factory or core.default_client_factory

    @click.group(name=name, help="Polaris suite client.")
    def group() -> None:
        pass

    def _emit(result: core.CommandResult) -> None:
        result.emit()
        raise SystemExit(result.code)

    # ── license ─────────────────────────────────────────────────────────────────────
    @group.command(help="[license] Activate this device with a license key.")
    @_with_common
    # Optional positional + non-argv sources. argv is visible in shell history and `ps`
    # (R12-13 / R4-16), so the documented path is --key-stdin / --key-file / the env var.
    @click.argument("key", required=False, default=None)
    @click.option("--key-file", default=None, help="Read the license key from a file.")
    @click.option("--key-stdin", is_flag=True, help="Read the license key from stdin.")
    def activate(  # noqa: ANN001
        product, version, base_url, config_dir, trust, service, key, key_file, key_stdin
    ):
        opts = _options(product, version, base_url, config_dir, trust, service)
        try:
            resolved = core.resolve_activation_key(
                key, key_file=key_file, key_stdin=key_stdin
            )
        except (ValueError, OSError) as e:
            raise click.UsageError(str(e))
        _emit(core.run_command(factory, opts, lambda c: core.activate(c, resolved)))

    @group.command(help="[license] Obtain a license with no key and no sign-in.")
    @_with_common
    def enroll(product, version, base_url, config_dir, trust, service):  # noqa: ANN001
        opts = _options(product, version, base_url, config_dir, trust, service)
        _emit(core.run_command(factory, opts, core.enroll))

    @group.command(help="[license] Deauthorize + wipe local credentials.")
    @_with_common
    def deactivate(product, version, base_url, config_dir, trust, service):  # noqa: ANN001
        opts = _options(product, version, base_url, config_dir, trust, service)
        _emit(core.run_command(factory, opts, core.deactivate))

    @group.command(help="[license] Show the current gate status.")
    @_with_common
    def status(product, version, base_url, config_dir, trust, service):  # noqa: ANN001
        opts = _options(product, version, base_url, config_dir, trust, service)
        _emit(core.run_command(factory, opts, core.status))

    # ── devices ─────────────────────────────────────────────────────────────────────
    @group.command(help="[devices] Register this device keylessly.")
    @_with_common
    def register(product, version, base_url, config_dir, trust, service):  # noqa: ANN001
        opts = _options(product, version, base_url, config_dir, trust, service)
        _emit(core.run_command(factory, opts, core.register))

    # ── config ──────────────────────────────────────────────────────────────────────
    @group.command(help="[config] Resolve a single layered-config key.")
    @_with_common
    @click.argument("key")
    @click.option("--fallback", default=None, help="Value if the key is unset.")
    def config(  # noqa: ANN001
        product, version, base_url, config_dir, trust, service, key, fallback
    ):
        opts = _options(product, version, base_url, config_dir, trust, service)
        _emit(core.run_command(factory, opts, lambda c: core.config(c, key, fallback)))

    # ── core ────────────────────────────────────────────────────────────────────────
    @group.command(name="import-bundle", help="[core] Import an offline activation bundle.")
    @_with_common
    @click.argument("bundle")
    def import_bundle(  # noqa: ANN001
        product, version, base_url, config_dir, trust, service, bundle
    ):
        opts = _options(product, version, base_url, config_dir, trust, service)
        try:
            jws = core.read_bundle_file(bundle)
        except (ValueError, OSError) as e:
            raise click.UsageError(str(e))
        _emit(core.run_command(factory, opts, lambda c: core.import_bundle(c, jws)))

    return group


# Standalone entry point (``python -m polaris.cli.click_cli``).
cli = polaris_click_group(name="cli")


if __name__ == "__main__":
    cli()
