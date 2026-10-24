"""``client.entitlements``: what the verified licence grants (SP-35.20).

A thin view over the licence gate (``client.license``): it holds no state of its own, so a
revoked, expired, blocked or never-activated install answers the same here as it does for
``client.license.is_licensed()`` (S-19 G11).
"""

from typing import Any, Dict, Optional

from .client import LicenseClient

__all__ = ["EntitlementsClient"]


class EntitlementsClient:
    def __init__(self, license: LicenseClient) -> None:
        self._license = license

    def has(self, name: str, now: Optional[int] = None) -> bool:
        """Whether the licence grants the boolean flag ``name``.

        ``False`` whenever the gate is not usable (S-19 G11): a revoked, expired, blocked or
        never-activated install answers ``False`` even while a previously verified document
        still names the flag.
        """
        doc = self._license.doc
        if doc is None or not self._license.is_licensed(now):
            return False
        entry = doc.entitlements.get(name)
        return bool(entry is not None and entry.value is True)

    def value(self, name: str, now: Optional[int] = None) -> Any:
        """The raw value of entitlement ``name`` (a string, number, list or bool), or ``None``
        when the document does not carry it or the gate is not usable (S-19 G11)."""
        doc = self._license.doc
        if doc is None or not self._license.is_licensed(now):
            return None
        entry = doc.entitlements.get(name)
        return entry.value if entry is not None else None

    def all(self) -> Dict[str, Any]:
        """Every entitlement the verified document carries, name to raw value; ``{}`` without
        one. Read regardless of the gate, like ``license.license_info()``."""
        doc = self._license.doc
        if doc is None:
            return {}
        return {k: v.value for k, v in doc.entitlements.items()}
