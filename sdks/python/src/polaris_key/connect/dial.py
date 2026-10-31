"""Dialling several learned addresses for one device (WIRE-CONTRACT-V5 §15.4.1, RFC 8305). The code lives
in :mod:`polaris_key.core.peer_dial`, so the nearby requester loads without this package; this module keeps
the names Connect code and tests import."""

from __future__ import annotations

from ..core.peer_dial import (
    DIAL_MAX_IN_FLIGHT,
    DIAL_STAGGER_SECONDS,
    Connector,
    DialRefused,
    dial_race,
    sockaddr_of,
)

__all__ = ["DIAL_MAX_IN_FLIGHT", "DIAL_STAGGER_SECONDS", "Connector", "DialRefused", "dial_race", "sockaddr_of"]
