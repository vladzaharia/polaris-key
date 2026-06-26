"""Persistence: per-device token, stable device id, offline-first config cache.

Mirrors ``store.ts``. The default :class:`KeyringStore` stores tokens in the OS keyring
when the optional ``keyring`` extra is installed and falls back to :class:`FileStore`.
The cache record round-trips the verified doc plus the sync bookkeeping the gate needs.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional, Protocol, runtime_checkable

from .deviceid import derive_device_id
from .license import BlockedState
from .models import AllowedRange, ManagedConfigDoc

__all__ = ["CacheRecord", "Store", "InMemoryStore", "FileStore", "KeyringStore"]


@dataclass
class CacheRecord:
    """The offline-first cache: the verified doc + sync bookkeeping.

    ``doc`` may be ``None`` when only bookkeeping (a 401/403 outcome) has been recorded
    before any doc was ever applied — the gate tolerates a doc-less cache.
    """

    doc: Optional[ManagedConfigDoc]
    lastAcceptedIssuedAt: int = 0
    etag: Optional[str] = None
    lastVerifiedAt: Optional[int] = None
    lastSyncUnauthorized: bool = False
    blocked: Optional[BlockedState] = None
    trustedKeys: Optional[Dict[str, str]] = None
    lastTrustIssuedAt: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "doc": self.doc.to_dict() if self.doc is not None else None,
            "lastAcceptedIssuedAt": self.lastAcceptedIssuedAt,
            "lastSyncUnauthorized": self.lastSyncUnauthorized,
        }
        if self.etag is not None:
            out["etag"] = self.etag
        if self.lastVerifiedAt is not None:
            out["lastVerifiedAt"] = self.lastVerifiedAt
        if self.blocked is not None:
            b: Dict[str, Any] = {"reason": self.blocked.reason}
            if self.blocked.allowedRange is not None:
                ar = self.blocked.allowedRange
                b["allowedRange"] = {
                    k: v
                    for k, v in (("min", ar.min), ("max", ar.max))
                    if v is not None
                }
            out["blocked"] = b
        if self.trustedKeys is not None:
            out["trustedKeys"] = self.trustedKeys
        if self.lastTrustIssuedAt is not None:
            out["lastTrustIssuedAt"] = self.lastTrustIssuedAt
        return out

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "CacheRecord":
        doc_raw = d.get("doc")
        blocked_raw = d.get("blocked")
        blocked = None
        if blocked_raw:
            blocked = BlockedState(
                reason=blocked_raw["reason"],
                allowedRange=AllowedRange.from_dict(blocked_raw.get("allowedRange")),
            )
        return CacheRecord(
            doc=ManagedConfigDoc.from_dict(doc_raw) if doc_raw else None,
            lastAcceptedIssuedAt=d.get("lastAcceptedIssuedAt", 0),
            etag=d.get("etag"),
            lastVerifiedAt=d.get("lastVerifiedAt"),
            lastSyncUnauthorized=d.get("lastSyncUnauthorized", False),
            blocked=blocked,
            trustedKeys=(
                d.get("trustedKeys") if isinstance(d.get("trustedKeys"), dict) else None
            ),
            lastTrustIssuedAt=d.get("lastTrustIssuedAt"),
        )


@runtime_checkable
class Store(Protocol):
    """The persistence contract the client drives."""

    def get_token(self) -> Optional[str]: ...
    def set_token(self, token: str) -> None: ...
    def clear_token(self) -> None: ...
    def get_device_id(self) -> str: ...
    def read_cache(self) -> Optional[CacheRecord]: ...
    def write_cache(self, rec: CacheRecord) -> None: ...
    def clear_cache(self) -> None: ...


class InMemoryStore:
    """In-memory store for tests."""

    def __init__(self, product_slug: str = "test") -> None:
        self._token: Optional[str] = None
        self._cache: Optional[CacheRecord] = None
        self._device_id = derive_device_id(product_slug)

    def get_token(self) -> Optional[str]:
        return self._token

    def set_token(self, token: str) -> None:
        self._token = token

    def clear_token(self) -> None:
        self._token = None

    def get_device_id(self) -> str:
        return self._device_id

    def read_cache(self) -> Optional[CacheRecord]:
        return self._cache

    def write_cache(self, rec: CacheRecord) -> None:
        self._cache = rec

    def clear_cache(self) -> None:
        self._cache = None


def _write_secure(path: str, data: str) -> None:
    """Write 0600, refusing to follow a planted symlink at the target (O_NOFOLLOW)."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        os.write(fd, data.encode("utf-8"))
    finally:
        os.close(fd)


def _read_maybe(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


class FileStore:
    """0600 file-backed store under ``<configDir>/<product>/``."""

    def __init__(self, product_slug: str, config_dir: str) -> None:
        self._product_slug = product_slug
        self._dir = os.path.join(config_dir, product_slug)
        os.makedirs(self._dir, mode=0o700, exist_ok=True)
        self._token_path = os.path.join(self._dir, "token")
        self._cache_path = os.path.join(self._dir, "managed.json")
        self._device_path = os.path.join(self._dir, "device")

    def get_token(self) -> Optional[str]:
        raw = _read_maybe(self._token_path)
        return raw.strip() if raw and raw.strip() else None

    def set_token(self, token: str) -> None:
        _write_secure(self._token_path, token)

    def clear_token(self) -> None:
        try:
            os.remove(self._token_path)
        except OSError:
            pass

    def get_device_id(self) -> str:
        existing = _read_maybe(self._device_path)
        if existing and existing.strip():
            return existing.strip()
        device_id = derive_device_id(self._product_slug)
        _write_secure(self._device_path, device_id)
        return device_id

    def read_cache(self) -> Optional[CacheRecord]:
        raw = _read_maybe(self._cache_path)
        if not raw:
            return None
        try:
            return CacheRecord.from_dict(json.loads(raw))
        except Exception:
            return None

    def write_cache(self, rec: CacheRecord) -> None:
        _write_secure(self._cache_path, json.dumps(rec.to_dict()))

    def clear_cache(self) -> None:
        try:
            os.remove(self._cache_path)
        except OSError:
            pass


def _load_keyring() -> Any:
    try:
        import keyring  # type: ignore[import-not-found]

        return keyring
    except Exception:
        return None


class KeyringStore:
    """OS-keyring token store with FileStore fallback for cache/device id."""

    def __init__(self, product_slug: str, config_dir: str) -> None:
        self._files = FileStore(product_slug, config_dir)
        self._service = f"pkey:{product_slug}"
        self._account = "device-token"

    def get_token(self) -> Optional[str]:
        keyring = _load_keyring()
        if keyring is not None:
            try:
                token = keyring.get_password(self._service, self._account)
                if token:
                    return token
            except Exception:
                pass
        return self._files.get_token()

    def set_token(self, token: str) -> None:
        keyring = _load_keyring()
        if keyring is not None:
            try:
                keyring.set_password(self._service, self._account, token)
                self._files.clear_token()
                return
            except Exception:
                pass
        self._files.set_token(token)

    def clear_token(self) -> None:
        keyring = _load_keyring()
        if keyring is not None:
            try:
                keyring.delete_password(self._service, self._account)
            except Exception:
                pass
        self._files.clear_token()

    def get_device_id(self) -> str:
        return self._files.get_device_id()

    def read_cache(self) -> Optional[CacheRecord]:
        return self._files.read_cache()

    def write_cache(self, rec: CacheRecord) -> None:
        self._files.write_cache(rec)

    def clear_cache(self) -> None:
        self._files.clear_cache()
