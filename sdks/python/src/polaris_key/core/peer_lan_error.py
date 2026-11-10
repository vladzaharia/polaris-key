"""The LAN error: a typed ``reason`` for the host to branch on and a registered ``code`` from
``conformance/parity/errors.json`` (never a new one here). Mirrors ``packages/sdk-node/src/connect/session.ts``
(``LanError``). It lives in core/ so the nearby approver and requester load without the Connect package;
``connect/errors.py`` re-exports it next to ``RelayError``. A :class:`~polaris_key.core.errors.PolarisError`,
so ``except PolarisError`` catches it."""

from __future__ import annotations

from typing import Any, Dict, Optional

from ..constants_generated import ErrorCode
from .errors import PolarisError

__all__ = ["LAN_CODE", "LanError"]

#: The registered client code of each LAN reason.
LAN_CODE: Dict[str, str] = {
    "no_identity": ErrorCode.NOT_CONFIGURED,
    "no_keys": ErrorCode.NOT_CONFIGURED,
    "not_started": ErrorCode.NOT_CONFIGURED,
    "unknown_peer": ErrorCode.INVALID_ARGUMENT,
    "not_listening": ErrorCode.CONNECT_UNAVAILABLE,
    "connect_failed": ErrorCode.NETWORK_ERROR,
    "handshake_failed": ErrorCode.PEER_CERT_INVALID,
    "wrong_peer": ErrorCode.PEER_CERT_INVALID,
    "closed": ErrorCode.NETWORK_ERROR,
    "too_large": ErrorCode.INVALID_ARGUMENT,
    "bad_type": ErrorCode.INVALID_ARGUMENT,
    "not_picked": ErrorCode.INVALID_ARGUMENT,
    #: A dial to a local link is held off for a moment after one that failed (§15.12).
    "busy": ErrorCode.PEER_BUSY,
    "bad_input": ErrorCode.INVALID_ARGUMENT,
}

class LanError(PolarisError):
    """A LAN-side refusal. ``reason`` is one of ``LAN_CODE``'s keys; ``close_code`` is why a session
    ended, when it did."""

    def __init__(self, reason: str, message: str, *, close_code: Optional[str] = None) -> None:
        if reason not in LAN_CODE:
            raise ValueError("unknown LAN error reason")
        super().__init__(LAN_CODE[reason], message)
        self.reason = reason
        self.close_code = close_code

    def __reduce__(self) -> Any:
        return (_make_lan, (self.reason, self.message, self.close_code))


def _make_lan(reason: str, message: str, close_code: Optional[str]) -> LanError:
    return LanError(reason, message, close_code=close_code)
