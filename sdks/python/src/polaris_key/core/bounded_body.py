"""A response body read under a byte cap (SEC-SYNC-HOST 5; mirrors ``sdk-node/src/core/boundedBody.ts``).

``content-length`` is checked first; the stream is then read with a running count of decoded BYTES
(not string length) and abandoned the moment it passes the cap, so a hostile server cannot make the
client buffer more than ``max_bytes``. Call it on a response opened with ``client.stream(...)``.
"""

from __future__ import annotations

from typing import Any, List, Optional

__all__ = ["MAX_BODY_BYTES", "read_capped_bytes", "read_capped_text"]

#: The most bytes the SDK reads from a Cloud Sync or catalog answer.
MAX_BODY_BYTES = 8 * 1024 * 1024


def read_capped_bytes(res: Any, max_bytes: int = MAX_BODY_BYTES) -> Optional[bytes]:
    """The (decoded) body, or ``None`` when it is larger than ``max_bytes``."""
    declared = res.headers.get("content-length")
    if declared is not None and declared.strip().isdigit() and int(declared) > max_bytes:
        return None
    parts: List[bytes] = []
    total = 0
    for chunk in res.iter_bytes():
        total += len(chunk)
        if total > max_bytes:
            return None
        parts.append(chunk)
    return b"".join(parts)


def read_capped_text(res: Any, max_bytes: int = MAX_BODY_BYTES) -> Optional[str]:
    """The body as UTF-8 text, or ``None`` when it is too large or is not UTF-8."""
    raw = read_capped_bytes(res, max_bytes)
    if raw is None:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
