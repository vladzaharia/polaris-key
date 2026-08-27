"""``python -m polaris_key`` -> the argparse CLI (the same entry point the ``polaris``
console script uses)."""

from __future__ import annotations

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
