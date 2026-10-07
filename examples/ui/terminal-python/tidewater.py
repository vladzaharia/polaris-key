"""tidewater: the Python terminal kit's demo CLI (UI-KITS §6.1).

A product's own CLI with the Polaris Key verbs mounted under its name, drawn by the terminal kit:

    python tidewater.py --help
    python tidewater.py status
    python tidewater.py activate          # masked prompt; try a key ending LIMITS
    python tidewater.py login             # browser, or a code over SSH (--device-code)
    python tidewater.py devices
    python tidewater.py changelog --json

It runs against the fixture adapter (``tidewater_fixtures.py``: Tidewater Studio by Harbor Audio,
no Worker). ``--live`` talks to a real Worker instead; pass your own ``--product`` and
``--trust kid=key`` with it. ``--tui`` opens the Textual account view (``polaris-key[tui]``).
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from polaris_key.cli import core  # noqa: E402
from polaris_key.cli.argparse_cli import GroupedHelpParser, register_argparse  # noqa: E402

import tidewater_fixtures  # noqa: E402


def factory(live: bool) -> core.ClientFactory:
    if live:
        return core.default_client_factory
    return lambda opts: tidewater_fixtures.FixtureClient()


def build_parser(live: bool = False) -> argparse.ArgumentParser:
    parser = GroupedHelpParser(prog="tidewater", description="Tidewater Studio license and updates")
    sub = parser.add_subparsers(dest="command", required=True)
    register_argparse(sub, client_factory=factory(live), prog="tidewater")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    live = "--live" in args
    args = [a for a in args if a != "--live"]
    if "--tui" in args:
        from polaris_key.ui.terminal.textual_app import run_app

        run_app(tidewater_fixtures.FixtureClient(), manage_url=tidewater_fixtures.MANAGE_URL)
        return 0
    # The demo's product is Tidewater; a real CLI bakes its slug and trust keys into its factory.
    if args and not args[0].startswith("-") and "--product" not in args:
        args += ["--product", "tidewater"]
    parsed = build_parser(live).parse_args(args)
    try:
        return int(parsed.func(parsed))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
