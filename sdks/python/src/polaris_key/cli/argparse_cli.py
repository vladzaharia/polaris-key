"""The dependency-free argparse front end + injectable hook for the polaris-key CLI.

Exposes ``activate`` / ``deactivate`` / ``status`` / ``config``. Trust keys are passed as
repeated ``--trust kid=rawBase64url`` pairs so the CLI stays product-agnostic (no pinned
keys baked in). Used as ``python -m polaris_key`` and the ``polaris-key`` console script.

Consumers can inject the same commands into their own argparse CLI via
:func:`register_argparse`, passing a ``client_factory`` to control how the client is built.
"""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from . import core


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--product", required=True, help="Product slug (the doc audience).")
    p.add_argument("--version", default="0.0.0-dev", help="This client's version.")
    p.add_argument("--base-url", default=None, help="Override the control-plane base URL.")
    p.add_argument("--config-dir", default=None, help="Override the config dir.")
    p.add_argument(
        "--trust",
        action="append",
        metavar="kid=rawBase64url",
        help="A trusted signing key (repeatable).",
    )


def _options(args: argparse.Namespace) -> core.ClientOptions:
    try:
        trust = core.parse_trust(args.trust)
    except ValueError as e:
        raise SystemExit(str(e))
    return core.ClientOptions(
        product=args.product,
        version=args.version,
        trust=trust,
        base_url=args.base_url,
        config_dir=args.config_dir,
    )


def register_argparse(
    subparsers: "argparse._SubParsersAction",
    client_factory: Optional[core.ClientFactory] = None,
) -> "argparse._SubParsersAction":
    """Add ``activate``/``deactivate``/``status``/``config`` to an existing subparsers.

    Each registered subcommand gets a ``func(args) -> int`` default so the host CLI can
    dispatch with ``args.func(args)``. ``client_factory`` (default: build from the parsed
    options) lets a consumer pin trust keys / base URL of their own.
    """
    factory = client_factory or core.default_client_factory

    def _dispatch(command):
        def _run(args: argparse.Namespace) -> int:
            result = core.run_command(factory, _options(args), command)
            result.emit()
            return result.code

        return _run

    p_act = subparsers.add_parser("activate", help="Enroll this device with a license key.")
    _add_common(p_act)
    p_act.add_argument("key", help="The license key.")
    p_act.set_defaults(func=lambda args: _activate(factory, args))

    p_de = subparsers.add_parser("deactivate", help="Deauthorize + wipe local credentials.")
    _add_common(p_de)
    p_de.set_defaults(func=_dispatch(core.deactivate))

    p_st = subparsers.add_parser("status", help="Show the current gate status.")
    _add_common(p_st)
    p_st.set_defaults(func=_dispatch(core.status))

    p_cf = subparsers.add_parser("config", help="Resolve a single layered-config key.")
    _add_common(p_cf)
    p_cf.add_argument("key", help="The config key to resolve.")
    p_cf.add_argument("--fallback", default=None, help="Value if the key is unset.")
    p_cf.set_defaults(func=lambda args: _config(factory, args))

    return subparsers


def _activate(factory: core.ClientFactory, args: argparse.Namespace) -> int:
    result = core.run_command(factory, _options(args), lambda c: core.activate(c, args.key))
    result.emit()
    return result.code


def _config(factory: core.ClientFactory, args: argparse.Namespace) -> int:
    result = core.run_command(
        factory, _options(args), lambda c: core.config(c, args.key, args.fallback)
    )
    result.emit()
    return result.code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="polaris-key", description="Polaris Key client.")
    sub = parser.add_subparsers(dest="command", required=True)
    register_argparse(sub)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv if argv is not None else sys.argv[1:])
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
