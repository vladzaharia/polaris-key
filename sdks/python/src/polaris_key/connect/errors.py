"""The Cloud Connect error taxonomy (CC-10.4; WIRE-CONTRACT-V5 §15.7, §15.9). Mirrors
``packages/sdk-node/src/connect/session.ts`` (``LanError``) and ``relay.ts`` (``RelayError``): a typed
``reason`` for the host to branch on, and a registered ``code`` from ``conformance/parity/errors.json``
(never a new one here). Both are :class:`~polaris_key.core.errors.PolarisError`, so ``except
PolarisError`` catches them."""

from __future__ import annotations

from typing import Any, Dict, Optional

from ..constants_generated import ErrorCode
from ..core.errors import PolarisError

__all__ = ["LAN_CODE", "LanError", "RELAY_CODE", "RELAY_PROTOCOL", "RelayError"]

#: The WebSocket subprotocol this client speaks (§15.7).
RELAY_PROTOCOL = "pkey-relay.1"

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
}

#: The registered code of each relay reason: the Worker's own for the four it answers with.
RELAY_CODE: Dict[str, str] = {
    "disabled": ErrorCode.RELAY_DISABLED,
    "paused": ErrorCode.RELAY_PAUSED,
    "quota": ErrorCode.RELAY_QUOTA_EXCEEDED,
    "ticket_invalid": ErrorCode.RELAY_TICKET_INVALID,
    "rate_limited": ErrorCode.RATE_LIMITED,
    "busy": ErrorCode.RATE_LIMITED,
    "unavailable": ErrorCode.NETWORK_ERROR,
    "not_connected": ErrorCode.CONNECT_UNAVAILABLE,
    "not_member": ErrorCode.PEER_CERT_INVALID,
    "handshake_failed": ErrorCode.PEER_CERT_INVALID,
    "wrong_peer": ErrorCode.PEER_CERT_INVALID,
    "unknown_peer": ErrorCode.INVALID_ARGUMENT,
    "mode_not_allowed": ErrorCode.INVALID_ARGUMENT,
    "replaced": ErrorCode.CANCELLED,
    "stopped": ErrorCode.CANCELLED,
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


class RelayError(PolarisError):
    """A relay-side refusal. ``reason`` is one of ``RELAY_CODE``'s keys. ``retry_after_seconds`` and
    ``status`` come from the ticket route's answer; ``scope`` (``person`` or ``product``) says which
    quota is spent."""

    def __init__(
        self,
        reason: str,
        message: str,
        *,
        retry_after_seconds: Optional[int] = None,
        scope: Optional[str] = None,
        close_code: Optional[Any] = None,
        status: Optional[int] = None,
    ) -> None:
        if reason not in RELAY_CODE:
            raise ValueError("unknown relay error reason")
        super().__init__(RELAY_CODE[reason], message, status=status)
        self.reason = reason
        self.retry_after_seconds = retry_after_seconds
        self.scope = scope
        self.close_code = close_code

    def __reduce__(self) -> Any:
        return (
            _make_relay,
            (self.reason, self.message, self.retry_after_seconds, self.scope, self.close_code, self.status),
        )


def _make_lan(reason: str, message: str, close_code: Optional[str]) -> LanError:
    return LanError(reason, message, close_code=close_code)


def _make_relay(
    reason: str,
    message: str,
    retry_after_seconds: Optional[int],
    scope: Optional[str],
    close_code: Optional[Any],
    status: Optional[int],
) -> RelayError:
    return RelayError(
        reason,
        message,
        retry_after_seconds=retry_after_seconds,
        scope=scope,
        close_code=close_code,
        status=status,
    )
