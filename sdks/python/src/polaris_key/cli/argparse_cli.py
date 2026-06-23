"""The dependency-free argparse front end for the polaris-key CLI.

Exposes ``activate`` / ``deactivate`` / ``status``. Trust keys are passed as repeated
``--trust kid=rawBase64url`` pairs so the CLI stays product-agnostic (no pinned keys
baked in). Used as ``python -m polaris_key`` and the ``polaris-key`` console script.
"""

from __future__ import annotations

import argparse
import sys
from typing import Dict, List, Optional

from . import core


def _parse_trust(pairs: Optional[List[str]]) -> Dict[str, str]:
    trust: Dict[str, str] = {}
    for p in pairs or []:
        if "=" not in p:
            raise SystemExit(f"--trust expects kid=rawBase64url, got: {p}")
        kid, raw = p.split("=", 1)
        trust[kid] = raw
    return trust


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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="polaris-key", description="Polaris Key client.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_act = sub.add_parser("activate", help="Enroll this device with a license key.")
    _add_common(p_act)
    p_act.add_argument("key", help="The license key.")

    p_de = sub.add_parser("deactivate", help="Deauthorize + wipe local credentials.")
    _add_common(p_de)

    p_st = sub.add_parser("status", help="Show the current gate status.")
    _add_common(p_st)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv if argv is not None else sys.argv[1:])
    trust = _parse_trust(args.trust)
    client = core.build_client(
        product=args.product,
        version=args.version,
        trust=trust,
        base_url=args.base_url,
        config_dir=args.config_dir,
    )
    try:
        if args.command == "activate":
            result = core.activate(client, args.key)
        elif args.command == "deactivate":
            result = core.deactivate(client)
        else:
            result = core.status(client)
    finally:
        client.close()
    result.emit()
    return result.code


if __name__ == "__main__":
    raise SystemExit(main())
