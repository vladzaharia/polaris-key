"""Which peer addresses the LAN adapter dials and accepts (WIRE-CONTRACT-V5 §15.4.1). The code lives in
:mod:`polaris_key.core.peer_lan_judge`, so the nearby approver and requester load without this package;
this module keeps the names Connect code and tests import."""

from __future__ import annotations

from ..core.peer_lan_judge import (
    LimiterKeys,
    PendingLimiter,
    limiter_keys,
    socket_text,
    socket_verdict,
    text_verdict,
)

__all__ = [
    "LimiterKeys",
    "PendingLimiter",
    "limiter_keys",
    "socket_text",
    "socket_verdict",
    "text_verdict",
]
