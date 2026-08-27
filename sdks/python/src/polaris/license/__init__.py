"""``polaris.license`` — the License service's client surface.

Activation (``activate``/``enroll``/``token``/``deauthorize`` under ``/license/*``), the
signed grant document, and the gate. Mirrors ``@plrs/node/license``.
"""

from __future__ import annotations

from .client import LicenseAcquiredListener, LicenseClient
from .endpoints import (
    LICENSE_DOCUMENT_PATH,
    ActivationDeviceLimit,
    ActivationEnrollDisabled,
    ActivationError,
    ActivationFingerprintRequired,
    ActivationHardwareMismatch,
    ActivationOk,
    ActivationResult,
    ActivationUnauthorized,
    activate_with_key,
    deauthorize,
    enroll,
    fetch_license_document,
    reacquire_token,
)
from .gate import AllowedRange, BlockedState, LicenseState, is_usable, license_state

__all__ = [
    "LicenseClient",
    "LicenseAcquiredListener",
    "LICENSE_DOCUMENT_PATH",
    "activate_with_key",
    "enroll",
    "reacquire_token",
    "deauthorize",
    "fetch_license_document",
    "ActivationResult",
    "ActivationOk",
    "ActivationDeviceLimit",
    "ActivationUnauthorized",
    "ActivationFingerprintRequired",
    "ActivationHardwareMismatch",
    "ActivationEnrollDisabled",
    "ActivationError",
    "license_state",
    "is_usable",
    "LicenseState",
    "BlockedState",
    "AllowedRange",
]
