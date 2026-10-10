"""The program the real-process stdin rows run (test_cli_contract.py, the ``cli`` family's ``stdin``
rows of ui-matrix.json): ``polaris-key activate`` with no key, through the verb table, on this
process's own stdin and stdout, over a stub client. The descriptor kind (file, FIFO, socket,
character device), the bound and the process's exit are the real ones. It prints the result: exit
code, error code, whether the key it got is ``PKEY_EXPECT_KEY`` (``key``, ``other`` or ``none``)
and how long the verb took in milliseconds."""

from __future__ import annotations

import os
import sys
import time
from typing import Any, Optional

from polaris_key.cli import core, verbs
from polaris_key.license.endpoints import ActivationOk


class _License:
    received: Optional[str] = None

    def activate_with_key(self, key: str) -> Any:
        _License.received = key
        return ActivationOk(token="pkeyt_secret")


class _Client:
    product = "tidewater"

    def __init__(self) -> None:
        self.license = _License()

    def status(self) -> Any:
        return type("S", (), {"status": "ok"})()

    def close(self) -> None:
        pass


def main() -> int:
    verb = next(v for v in verbs.VERBS if v.name == "activate")
    ns = verbs.namespace(verb, [], {})
    t0 = time.monotonic()
    result = verbs.run(lambda _opts: _Client(), core.ClientOptions(product="tidewater"), verb, ns, prog="tidewater")
    ms = int((time.monotonic() - t0) * 1000)
    result.emit()
    got = "none" if _License.received is None else ("key" if _License.received == os.environ.get("PKEY_EXPECT_KEY") else "other")
    sys.stdout.write(f"\nRESULT {result.code} - {result.data.get('error') or '-'} {got} {ms}\n")
    sys.stdout.flush()
    return result.code


if __name__ == "__main__":
    raise SystemExit(main())
