"""A product CLI that mounts the Polaris Key verb set next to its own commands.

    python mytool.py run            # your command, gated by the license (exit 4 without one)
    python mytool.py sign-in        # Polaris Key's verbs: sign-in, status, devices, update, ...

Replace PRODUCT, VERSION and TRUST with your product's values (`pkey sdk --lang python` prints
them). ``config=`` builds the client for every Polaris Key verb, so none of them takes --product,
--trust or --base-url, and ``mytool --help`` lists only the verbs people need.
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional, Sequence

import polaris_key
from polaris_key.cli import register_argparse, require_license

PRODUCT = "mytool"
VERSION = "1.0.0"
# kid -> raw Ed25519 public key (base64url). PLACEHOLDERS: substitute your product's real pins.
TRUST = {"<your-signing-key-id>": "<your-product-signing-key-b64url>"}


CONFIG = {"product_slug": PRODUCT, "trust": TRUST}


@require_license
def run(_args: argparse.Namespace) -> int:
    client = polaris_key.create(**CONFIG, version=VERSION)
    try:
        outcome = client.boot(on_stage=lambda state, _emits: print("·", state.stage, file=sys.stderr))
        if not outcome.ready:
            print("Not activated: run `mytool sign-in` or `mytool activate`.", file=sys.stderr)
            return 2
        print("Working with", client.config.get_config("run.concurrency", 4), "workers")
        return 0
    finally:
        client.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mytool")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run", help="Do the work.").set_defaults(func=run)
    register_argparse(sub, config=CONFIG, version=VERSION)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
