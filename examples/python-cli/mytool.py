"""A product CLI that mounts the Polaris Key verb set next to its own commands.

    python mytool.py run            # your command, gated by the license (exit 4 without one)
    python mytool.py login          # Polaris Key's verbs: login, status, devices, update, ...

Replace PRODUCT, VERSION and TRUST with your product's values (`pkey sdk --lang python` prints
them). ``config=`` builds the client for every Polaris Key verb, so none of them takes --product,
--trust or --base-url, and ``mytool --help`` lists only the verbs people need.
"""

from __future__ import annotations

import argparse
from typing import Optional, Sequence

import polaris_key
from polaris_key.cli import register_argparse, require_license
from polaris_key.cli.argparse_cli import GroupedHelpParser

PRODUCT = "mytool"
VERSION = "1.0.0"
# kid -> raw Ed25519 public key (base64url). PLACEHOLDERS: the mount refuses them (polaris-bad-config)
# until you substitute your product's real pins; `pkey sdk --lang python --write` writes them.
TRUST = {"<your-signing-key-id>": "<your-product-signing-key-b64url>"}


CONFIG = {"product_slug": PRODUCT, "trust": TRUST}


@require_license
def run(_args: argparse.Namespace) -> int:
    client = polaris_key.create(**CONFIG, version=VERSION)
    try:
        # @require_license has already refused an unlicensed run (exit 4), so the work starts here.
        client.boot()
        print("Working with", client.config.get_config("run.concurrency", 4), "workers")
        return 0
    finally:
        client.close()


def build_parser() -> argparse.ArgumentParser:
    # GroupedHelpParser lists your commands first, then the license verbs under one heading.
    parser = GroupedHelpParser(prog="mytool", description="mytool")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run", help="Do the work.", group="Commands").set_defaults(func=run)
    register_argparse(sub, config=CONFIG, version=VERSION)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
