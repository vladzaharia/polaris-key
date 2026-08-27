"""The dependency-free argparse front end + injectable hook for the ``polaris`` CLI.

Exposes the v3 verb set, grouped by owning service (see
:data:`polaris_key.cli.core.SERVICE_COMMANDS`)::

    license  activate · enroll · deactivate · status
    devices  register
    config   config <key>
    core     import-bundle

Trust keys are passed as repeated ``--trust kid=rawBase64url`` pairs so the CLI stays
product-agnostic (no pinned keys baked in). Used as ``python -m polaris_key`` and the
``polaris`` console script.

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
    p.add_argument(
        "--version",
        default=core.DEFAULT_VERSION,
        help=f"This client's version (default: {core.DEFAULT_VERSION}).",
    )
    p.add_argument("--base-url", default=None, help="Override the control-plane base URL.")
    p.add_argument("--config-dir", default=None, help="Override the config dir.")
    p.add_argument(
        "--trust",
        action="append",
        metavar="kid=rawBase64url",
        help="A trusted signing key (repeatable).",
    )
    p.add_argument(
        "--service",
        action="append",
        metavar="SLUG",
        help=(
            "A service this build expects the product to run (repeatable). The D-21 "
            "fail-closed fallback used until discovery has been fetched."
        ),
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
        expected_services=core.parse_services(getattr(args, "service", None)),
    )


def _add_key_source(p: argparse.ArgumentParser) -> None:
    """Register the licence-key inputs, non-argv first (R12-13 / R4-16).

    The positional stays for scripting compatibility but is OPTIONAL and warns; the
    documented path is ``--key-stdin`` / ``--key-file`` / ``$POLARIS_KEY_ACTIVATION_KEY``.
    """
    p.add_argument(
        "key",
        nargs="?",
        default=None,
        help="The license key (DISCOURAGED: argv is visible in shell history and `ps`).",
    )
    p.add_argument("--key-file", default=None, help="Read the license key from a file.")
    p.add_argument(
        "--key-stdin", action="store_true", help="Read the license key from stdin."
    )


def register_argparse(
    subparsers: "argparse._SubParsersAction",
    client_factory: Optional[core.ClientFactory] = None,
) -> "argparse._SubParsersAction":
    """Add the Polaris Key subcommands to an existing subparsers object.

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

    # ── license ─────────────────────────────────────────────────────────────────────
    p_act = subparsers.add_parser(
        "activate", help="[license] Activate this device with a license key."
    )
    _add_common(p_act)
    _add_key_source(p_act)
    p_act.set_defaults(func=lambda args: _activate(factory, args))

    p_en = subparsers.add_parser(
        "enroll", help="[license] Obtain a license with no key and no sign-in."
    )
    _add_common(p_en)
    p_en.set_defaults(func=_dispatch(core.enroll))

    p_de = subparsers.add_parser(
        "deactivate", help="[license] Deauthorize + wipe local credentials."
    )
    _add_common(p_de)
    p_de.set_defaults(func=_dispatch(core.deactivate))

    p_st = subparsers.add_parser("status", help="[license] Show the current gate status.")
    _add_common(p_st)
    p_st.set_defaults(func=_dispatch(core.status))

    # ── devices ─────────────────────────────────────────────────────────────────────
    p_reg = subparsers.add_parser(
        "register", help="[devices] Register this device keylessly (§6)."
    )
    _add_common(p_reg)
    p_reg.set_defaults(func=_dispatch(core.register))

    # ── config ──────────────────────────────────────────────────────────────────────
    p_cf = subparsers.add_parser(
        "config", help="[config] Resolve a single layered-config key."
    )
    _add_common(p_cf)
    p_cf.add_argument("key", help="The config key to resolve.")
    p_cf.add_argument("--fallback", default=None, help="Value if the key is unset.")
    p_cf.set_defaults(func=lambda args: _config(factory, args))

    # ── core ────────────────────────────────────────────────────────────────────────
    p_bundle = subparsers.add_parser(
        "import-bundle", help="[core] Import an offline activation bundle (§7)."
    )
    _add_common(p_bundle)
    p_bundle.add_argument("bundle", help="Path to the .pkeybundle file, or - for stdin.")
    p_bundle.set_defaults(func=lambda args: _import_bundle(factory, args))

    return subparsers


def _activate(factory: core.ClientFactory, args: argparse.Namespace) -> int:
    try:
        key = core.resolve_activation_key(
            args.key, key_file=args.key_file, key_stdin=args.key_stdin
        )
    except (ValueError, OSError) as e:
        raise SystemExit(str(e))
    result = core.run_command(factory, _options(args), lambda c: core.activate(c, key))
    result.emit()
    return result.code


def _config(factory: core.ClientFactory, args: argparse.Namespace) -> int:
    result = core.run_command(
        factory, _options(args), lambda c: core.config(c, args.key, args.fallback)
    )
    result.emit()
    return result.code


def _import_bundle(factory: core.ClientFactory, args: argparse.Namespace) -> int:
    try:
        jws = (
            sys.stdin.read().strip()
            if args.bundle == "-"
            else core.read_bundle_file(args.bundle)
        )
    except (ValueError, OSError) as e:
        raise SystemExit(str(e))
    if not jws:
        raise SystemExit("no bundle supplied on stdin")
    result = core.run_command(
        factory, _options(args), lambda c: core.import_bundle(c, jws)
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
