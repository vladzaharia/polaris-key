"""The persistence CONTRACT — cache record shape + the store protocol (§4.1).

The concrete stores live with the device principal that owns the files
(:mod:`polaris.devices.store`); this module declares only the shape, so a host can supply
its own backing store without importing a keyring.

CACHE v3. The record persists **signed artifacts only**: the compact JWS of each
per-service document and of the trust manifest, all re-verified (trust against the PINS,
documents against the effective set, ``check_freshness=False``) on every load. Nothing
decoded, no bare keys, no plaintext counters — the v1 record persisted the *decoded* doc,
a bare ``trustedKeys`` map, and three unsigned counters that security decisions read
directly, which is the whole of R2-01/R4-02 (substitute the key bytes behind a pinned
kid), R4-03 (pin the anti-replay counter into the far future) and R2-03/R4-01 (invent a
licence outright with no signature anywhere). Those counters are now DERIVED.

``blocked`` and ``lastSyncUnauthorized`` remain unsigned deliberately: they can only ever
make the gate STRICTER, so clearing them gains an attacker nothing that deleting the file
would not.

WHAT v3 CHANGED FROM v2

* ``configJws``/``etag`` become per-service SLICES (``docs``/``etags``), because license
  and config are now two independently-fetched, independently-ETagged documents;
* ``importedBundle`` records an offline activation (§7);
* ``CACHE_FORMAT_VERSION`` is ``3``, and a record carrying any other value is DISCARDED,
  never migrated — one network round trip is the correct price for not carrying poisoned
  state forward, and an air-gapped install re-imports its bundle.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Protocol, runtime_checkable

from .models import AllowedRange, BlockedState

__all__ = [
    "CACHE_FORMAT_VERSION",
    "ImportedBundle",
    "CacheRecord",
    "Store",
]

#: Bumped whenever the on-disk shape changes. A record carrying any other value is
#: dropped on read rather than migrated (§4.1).
CACHE_FORMAT_VERSION = 3


@dataclass(frozen=True)
class ImportedBundle:
    """Set by ``import_bundle`` (§7). Present WITH a verified licence document ⇒ the gate
    reads ``activation="bundle"``; a later online activation supersedes it with
    ``activation="token"``."""

    bundleId: str
    importedAt: int


@dataclass
class CacheRecord:
    """The offline-first cache — one Core-owned record per product."""

    #: Per-service signed documents, keyed ``"license"`` / ``"config"``. An absent slice
    #: means the service is unused by this product, or has not been fetched yet — never
    #: that it failed open.
    docs: Dict[str, str] = field(default_factory=dict)
    #: Non-security hints: the per-document conditional-request validators.
    etags: Dict[str, str] = field(default_factory=dict)
    #: The compact JWS of the trust manifest, verbatim.
    trustJws: Optional[str] = None
    importedBundle: Optional[ImportedBundle] = None
    #: A recorded hard 401 — the offline revocation signal (§4.3).
    lastSyncUnauthorized: bool = False
    #: The last 403 version/channel block from ``GET /<p>/license/document``.
    blocked: Optional[BlockedState] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "v": CACHE_FORMAT_VERSION,
            "docs": {k: v for k, v in self.docs.items() if v},
            "etags": {k: v for k, v in self.etags.items() if v},
            "lastSyncUnauthorized": self.lastSyncUnauthorized,
        }
        if self.trustJws is not None:
            out["trustJws"] = self.trustJws
        if self.importedBundle is not None:
            out["importedBundle"] = {
                "bundleId": self.importedBundle.bundleId,
                "importedAt": self.importedBundle.importedAt,
            }
        if self.blocked is not None:
            b: Dict[str, Any] = {"reason": self.blocked.reason}
            if self.blocked.allowedRange is not None:
                b["allowedRange"] = self.blocked.allowedRange.to_dict()
            out["blocked"] = b
        return out

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "CacheRecord":
        """Decode a record, refusing anything that is not a current-format v3 record.

        ``v`` is checked BEFORE any field is read, so a v1/v2 record's ``trustedKeys``
        and unsigned counters are never even looked at.
        """
        if not isinstance(d, dict):
            raise ValueError("cache record must be an object")
        if d.get("v") != CACHE_FORMAT_VERSION:
            raise ValueError(f"unsupported cache format {d.get('v')!r}")

        def slice_map(key: str) -> Dict[str, str]:
            raw = d.get(key)
            if not isinstance(raw, dict):
                return {}
            return {
                k: v
                for k, v in raw.items()
                if k in ("license", "config") and isinstance(v, str)
            }

        blocked_raw = d.get("blocked")
        blocked = None
        if isinstance(blocked_raw, dict) and blocked_raw.get("reason"):
            blocked = BlockedState(
                reason=blocked_raw["reason"],
                allowedRange=AllowedRange.from_dict(blocked_raw.get("allowedRange")),
            )
        imported_raw = d.get("importedBundle")
        imported = None
        if (
            isinstance(imported_raw, dict)
            and isinstance(imported_raw.get("bundleId"), str)
            and isinstance(imported_raw.get("importedAt"), int)
            and not isinstance(imported_raw.get("importedAt"), bool)
        ):
            imported = ImportedBundle(
                bundleId=imported_raw["bundleId"],
                importedAt=imported_raw["importedAt"],
            )
        trust_jws = d.get("trustJws")
        return CacheRecord(
            docs=slice_map("docs"),
            etags=slice_map("etags"),
            trustJws=trust_jws if isinstance(trust_jws, str) else None,
            importedBundle=imported,
            lastSyncUnauthorized=d.get("lastSyncUnauthorized") is True,
            blocked=blocked,
        )


@runtime_checkable
class Store(Protocol):
    """The credential + cache surface a host provides.

    Writes to the cache are Core-mediated read-modify-write of the WHOLE record; service
    modules never write it directly (§4.1).
    """

    def get_token(self) -> Optional[str]: ...
    def set_token(self, token: str) -> None: ...
    def clear_token(self) -> None: ...
    def get_device_id(self) -> str: ...
    def read_cache(self) -> Optional[CacheRecord]: ...
    def write_cache(self, rec: CacheRecord) -> None: ...
    def clear_cache(self) -> None: ...
