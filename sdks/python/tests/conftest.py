"""Session-wide pytest hooks for the Python SDK suite.

The version banner (P1b-05, PARITY §4.3): every run names the interpreter, the two libraries
the SDK verifies and talks through, and the zstd libraries packs decode with (3.14's
``compression.zstd``, ``zstandard`` below it), so a failure on one leg of the CI matrix
(CPython 3.9 and 3.14 on Linux, the current CPython on macOS) is attributable to the build that
produced it.
``cryptography`` carries its OpenSSL, which is what actually checks every Ed25519 signature.

pytest prints report-header lines only when the session header is shown, and ``-q`` (the green
gate's invocation) hides it; the banner is written either way.
"""

from __future__ import annotations

import platform
import sys
from typing import List

import pytest


def _banner() -> List[str]:
    import cryptography
    import httpx
    from cryptography.hazmat.backends.openssl.backend import backend

    from polaris_key.update.packs.zstd import _backends

    zstd = ", ".join(f"{b.name} {b.version}" for b in _backends("auto")) or "none"
    return [
        f"polaris-key: python {sys.version.splitlines()[0]} ({platform.platform()})",
        f"polaris-key: cryptography {cryptography.__version__}"
        f" ({backend.openssl_version_text()}) · httpx {httpx.__version__}",
        f"polaris-key: zstd {zstd}",
    ]


def pytest_report_header(config: pytest.Config) -> List[str]:
    return _banner()


@pytest.hookimpl(trylast=True)
def pytest_sessionstart(session: pytest.Session) -> None:
    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    if reporter is None or reporter.showheader:
        return  # shown as a report header with the session header
    for line in _banner():
        reporter.write_line(line)
