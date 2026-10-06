"""A product CLI that mounts the Polaris Key verb set next to its own commands.

    python mytool.py run            # your command, gated by the licence
    python mytool.py sign-in        # Polaris Key's verbs: sign-in, status, devices, update, ...

Replace PRODUCT, VERSION and TRUST with your product's values (`pkey sdk --lang python` prints
them). The client is built once per invocation by ``client_factory``.
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional, Sequence

import polaris_key
from polaris_key.cli import register_argparse

PRODUCT = "mytool"
VERSION = "1.0.0"
# kid -> raw Ed25519 public key (base64url). PLACEHOLDERS: substitute your product's real pins.
TRUST = {"<your-signing-key-id>": "<your-product-signing-key-b64url>"}


def client_factory(_opts: object) -> polaris_key.PolarisKeyClient:
    return polaris_key.create(product_slug=PRODUCT, version=VERSION, trust=TRUST)


def run(_args: argparse.Namespace) -> int:
    client = client_factory(None)
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
    register_argparse(sub, client_factory=client_factory)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
