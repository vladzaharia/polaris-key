"""tidewater: the Qt Quick kit sample (UK-12).

Tidewater Studio by Harbor Audio, a small PySide6 app that gates itself with the kit:
``run_gate(client, window)``. It runs against the terminal sample's fixture adapter
(``../terminal-python/tidewater_fixtures.py``, no Worker); ``--live`` talks to a real one.

    pip install "polaris-key[qt]"
    python tidewater_qt.py                    # the fixtures: the gate opens on Welcome (a key or Sign in)
    python tidewater_qt.py --scheme light --platform windows
    python tidewater_qt.py --live --product your-slug --trust kid=base64key
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "terminal-python"))

from polaris_key.ui.core.theme import Theme  # noqa: E402


def make_client(args: argparse.Namespace) -> Any:
    if args.live:
        from polaris_key.client import PolarisKeyClient

        pins = dict(pair.split("=", 1) for pair in args.trust)
        return PolarisKeyClient.create(product_slug=args.product, version="1.0.0", pinned_keys=pins, base_url=args.base_url)
    import tidewater_fixtures

    return tidewater_fixtures.FixtureClient()


def build(client: Any, theme: Theme, window: Any = None) -> Any:
    """The gate for ``client`` over ``window``; the host keeps the returned controller."""
    from polaris_key.ui.qt import run_gate

    return run_gate(client, window, theme=theme)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="tidewater_qt", description="Tidewater Studio, gated by the Qt kit")
    parser.add_argument("--live", action="store_true", help="talk to a real Worker, not the fixtures")
    parser.add_argument("--product", default="tidewater")
    parser.add_argument("--trust", action="append", default=[], metavar="KID=KEY")
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--scheme", choices=("system", "dark", "light"), default="dark")
    parser.add_argument("--platform", choices=("auto", "macos", "windows", "linux"), default="auto")
    args = parser.parse_args(argv)

    from PySide6.QtWidgets import QApplication, QLabel, QMainWindow

    app = QApplication.instance() or QApplication([])
    window = QMainWindow()
    window.setWindowTitle("Tidewater Studio")
    window.setCentralWidget(QLabel("Tidewater Studio is licensed."))
    window.resize(520, 640)
    window.show()
    gate = build(make_client(args), Theme(color_scheme=args.scheme, platform=args.platform), window)
    return int(app.exec()) if gate is not None else 0


if __name__ == "__main__":
    raise SystemExit(main())
