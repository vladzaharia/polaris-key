"""DL7's shared delayed-loading rule for Python UI view models."""

from __future__ import annotations

from typing import Any

__all__ = ["DELAYED_LOADING_STATES", "LOADING_DELAY_MS", "LOADING_DELAY_WINDOW", "loading_visible"]

LOADING_DELAY_WINDOW = {"min": 250, "max": 300}
LOADING_DELAY_MS = LOADING_DELAY_WINDOW["min"]
DELAYED_LOADING_STATES = frozenset(
    (
        "PolarisKeyGate.booting",
        "LicenseChoice.loading",
        "Devices.loading",
        "ReleaseNotes.loading",
        "AccountAndLicense.loading",
        "Settings.loading",
        "Paywall.loading",
        "EntitlementGate.loading",
    )
)


def loading_visible(elapsed_ms: Any, delay_ms: int = LOADING_DELAY_MS) -> bool:
    """Whether delayed content is visible; absent elapsed time means the delay elapsed."""
    if elapsed_ms is None:
        return True
    return isinstance(elapsed_ms, (int, float)) and not isinstance(elapsed_ms, bool) and elapsed_ms >= delay_ms
