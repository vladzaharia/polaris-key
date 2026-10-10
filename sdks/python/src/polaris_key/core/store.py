"""The persistence CONTRACT — cache record shape + the store protocol (§4.1).

The concrete stores live with the device principal that owns the files
(:mod:`polaris_key.devices.store`); this module declares only the shape, so a host can supply
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
* ``bundle`` holds an offline activation bundle verbatim (§7), re-verified on every load;
* ``CACHE_FORMAT_VERSION`` is ``3``, and a record carrying any other value is DISCARDED,
  never migrated — one network round trip is the correct price for not carrying poisoned
  state forward, and an air-gapped install re-imports its bundle.

WIRE v4 (plans/P3-01.md §2.6) adds two optional slices, ``feeds`` (the committed channel
feeds, keyed by each feed's own canonical ``channel`` claim) and ``releaseRecords`` (verified
release records, keyed by lowercase hex SHA-256). The change is additive, so the version stays
3: a v3 loader ignores them and a record without them has no ``seq`` floor yet. Both hold
signed JWSs verbatim and nothing else; the floors are derived on load, never stored.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Protocol, runtime_checkable

from .models import AllowedRange, BlockedState

__all__ = [
    "CACHE_FORMAT_VERSION",
    "CacheRecord",
    "Store",
    "STORE_BACKENDS",
    "STORE_DEGRADED_REASONS",
    "StoreDegraded",
    "StoreStatus",
]

#: Bumped whenever the on-disk shape changes. A record carrying any other value is
#: dropped on read rather than migrated (§4.1).
CACHE_FORMAT_VERSION = 3


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
    #: The offline activation bundle (``pkey-bundle+jws``) imported on this install, verbatim
    #: (§7). Re-verified on every load; ``activation="bundle"`` is derived from it, never
    #: from an unsigned marker.
    bundle: Optional[str] = None
    #: WIRE-CONTRACT-V4 §4.1: the evidence for each tombstoned pinned key, ``kid`` -> the
    #: revoking ``pkey-trust+jws``, verbatim. Re-verified on load. Security state, not a grant:
    #: it survives a bundle import, a deactivation and a device-id re-binding.
    pinRevocations: Dict[str, str] = field(default_factory=dict)
    #: A recorded hard 401 — the offline revocation signal (§4.3).
    lastSyncUnauthorized: bool = False
    #: The last 403 version/channel block from ``GET /<p>/license/document``.
    blocked: Optional[BlockedState] = None
    #: WIRE-CONTRACT-V4 §4: committed ``pkey-feed+jws`` documents, verbatim, keyed by the
    #: CANONICAL channel (each feed's own ``channel`` claim; ``latest`` is stored under
    #: ``stable``). Re-verified on load; each survivor derives its channel's ``seq`` floor.
    feeds: Dict[str, str] = field(default_factory=dict)
    #: WIRE-CONTRACT-V4 §4: verified ``pkey-release+jws`` records, verbatim, keyed by their
    #: lowercase hex SHA-256; kept only while a committed feed pins the hash.
    releaseRecords: Dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "v": CACHE_FORMAT_VERSION,
            "docs": {k: v for k, v in self.docs.items() if v},
            "etags": {k: v for k, v in self.etags.items() if v},
            "lastSyncUnauthorized": self.lastSyncUnauthorized,
        }
        if self.trustJws is not None:
            out["trustJws"] = self.trustJws
        if self.bundle is not None:
            out["bundle"] = self.bundle
        if self.blocked is not None:
            b: Dict[str, Any] = {"reason": self.blocked.reason}
            if self.blocked.allowedRange is not None:
                b["allowedRange"] = self.blocked.allowedRange.to_dict()
            out["blocked"] = b
        if self.feeds:
            out["feeds"] = dict(self.feeds)
        if self.releaseRecords:
            out["releaseRecords"] = dict(self.releaseRecords)
        if self.pinRevocations:
            out["pinRevocations"] = dict(self.pinRevocations)
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
        def string_entries(key: str) -> Dict[str, str]:
            # A slice read from disk: its string-valued entries, nothing else (unverified
            # here; the update client re-verifies every one before use).
            raw = d.get(key)
            if not isinstance(raw, dict):
                return {}
            return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str)}

        trust_jws = d.get("trustJws")
        bundle = d.get("bundle")
        return CacheRecord(
            docs=slice_map("docs"),
            etags=slice_map("etags"),
            trustJws=trust_jws if isinstance(trust_jws, str) else None,
            bundle=bundle if isinstance(bundle, str) else None,
            lastSyncUnauthorized=d.get("lastSyncUnauthorized") is True,
            blocked=blocked,
            feeds=string_entries("feeds"),
            releaseRecords=string_entries("releaseRecords"),
            pinRevocations=string_entries("pinRevocations"),
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

    # NOT part of the protocol: ``status()`` is optional (P1b-09). The Protocol is
    # ``runtime_checkable``, so adding it here would make every existing host store fail
    # ``isinstance(store, Store)``. A store that reports adds ``status() -> StoreStatus`` and
    # the client finds it with ``getattr``.


# ── Store status (P1b-09 plan §2.3) ─────────────────────────────────────────────────────
#: Where a token store keeps the token. Stable identifiers, shared with every SDK.
STORE_BACKENDS = (
    "keyring",  # an OS credential store through the `keyring` package
    "keychain",  # the Apple Keychain through Security.framework
    "keystore",  # an Android Keystore key wrapping the token
    "file",  # a 0600 file
    "memory",  # nothing persists (tests)
    "indexeddb",  # browser storage (Godot web)
    "custom",  # a host store that fits none of these
)

#: Why a store is weaker than this platform's best option. Stable identifiers.
STORE_DEGRADED_REASONS = (
    "keyring-unavailable",  # the OS keyring cannot be loaded, or its backend is fail/null
    "keyring-error",  # the keyring loaded but an operation failed, now or in the write that fell back
    "legacy-keychain",  # macOS: no data-protection keychain entitlement
    "not-persistent",  # storage may be evicted or not survive a restart
)


@dataclass(frozen=True)
class StoreDegraded:
    reason: str
    #: Human text; never contains the token.
    detail: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"reason": self.reason}
        if self.detail is not None:
            out["detail"] = self.detail
        return out


@dataclass(frozen=True)
class StoreStatus:
    """What a store's optional ``status()`` reports: where the token lives now, and why if
    that is weaker than this platform's best option."""

    backend: str
    degraded: Optional[StoreDegraded] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"backend": self.backend}
        if self.degraded is not None:
            out["degraded"] = self.degraded.to_dict()
        return out
