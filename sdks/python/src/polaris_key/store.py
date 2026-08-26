"""Persistence: per-device token, stable device id, offline-first config cache.

Mirrors ``store.ts``. The default :class:`KeyringStore` stores tokens in the OS keyring
when the optional ``keyring`` extra is installed and falls back to :class:`FileStore`.

CACHE INTEGRITY (wire contract v2 §4). The record persists **only signed artifacts**:
the compact JWS of the config document and of the trust manifest, verbatim. Every piece
of security state — the trust set, ``lastAcceptedIssuedAt``, ``lastTrustIssuedAt``,
``lastVerifiedAt``, the monotonic clock floor — is *derived* by re-verifying those two
JWS against the host application's **pinned** keys on every load.

The v1 record stored the decoded document, a bare ``kid -> key`` map, and three
plaintext counters. Those were unsigned fields that security decisions read, which is
the whole of R2-01/02/03 and R4-01/02/03: one write to ``managed.json`` substituted the
bytes behind a pinned kid, replayed an arbitrary document, and pinned the anti-replay
counter into the far future so genuine revocations could never land. A ``v: 1`` record
is therefore **discarded, not migrated** (§7.3) — one network round trip is the correct
price for not carrying poisoned state forward.
"""

from __future__ import annotations

import errno
import json
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional, Protocol, runtime_checkable

from .deviceid import derive_device_id
from .license import BlockedState
from .models import AllowedRange

__all__ = [
    "CACHE_FORMAT_VERSION",
    "SYMLINK_GUARD",
    "CacheRecord",
    "Store",
    "InMemoryStore",
    "FileStore",
    "KeyringStore",
]

# Bumped whenever the on-disk shape changes. A record carrying any other value is
# dropped on read rather than migrated.
CACHE_FORMAT_VERSION = 2


@dataclass
class CacheRecord:
    """The offline-first cache: two signed artifacts + fail-CLOSED sync hints.

    ``configJws``/``trustJws`` are compact JWS strings exactly as received. Both may be
    ``None`` — when only bookkeeping (a 401/403 outcome) has been recorded before any
    document was ever applied, the gate tolerates a doc-less cache.

    ``blocked`` and ``lastSyncUnauthorized`` stay unsigned deliberately: they only ever
    make the gate *stricter*, so clearing them gains an attacker nothing they could not
    achieve by deleting the file. ``etag`` is a non-security transport hint.
    """

    configJws: Optional[str] = None
    trustJws: Optional[str] = None
    etag: Optional[str] = None
    lastSyncUnauthorized: bool = False
    blocked: Optional[BlockedState] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "v": CACHE_FORMAT_VERSION,
            "configJws": self.configJws,
            "trustJws": self.trustJws,
            "lastSyncUnauthorized": self.lastSyncUnauthorized,
        }
        if self.etag is not None:
            out["etag"] = self.etag
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
        return out

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "CacheRecord":
        """Decode a record, refusing anything that is not a current-format v2 record."""
        if not isinstance(d, dict):
            raise ValueError("cache record must be an object")
        if d.get("v") != CACHE_FORMAT_VERSION:
            raise ValueError(f"unsupported cache format {d.get('v')!r}")
        blocked_raw = d.get("blocked")
        blocked = None
        if isinstance(blocked_raw, dict) and blocked_raw.get("reason"):
            blocked = BlockedState(
                reason=blocked_raw["reason"],
                allowedRange=AllowedRange.from_dict(blocked_raw.get("allowedRange")),
            )
        config_jws = d.get("configJws")
        trust_jws = d.get("trustJws")
        return CacheRecord(
            configJws=config_jws if isinstance(config_jws, str) else None,
            trustJws=trust_jws if isinstance(trust_jws, str) else None,
            etag=d.get("etag") if isinstance(d.get("etag"), str) else None,
            lastSyncUnauthorized=d.get("lastSyncUnauthorized") is True,
            blocked=blocked,
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


_O_NOFOLLOW: Optional[int] = getattr(os, "O_NOFOLLOW", None)

#: How the symlink guard in :func:`_write_secure` is enforced on this platform.
#:
#: ``"O_NOFOLLOW"``   the kernel refuses the ``open(2)`` atomically — POSIX.
#: ``"lstat-precheck"`` ``os.O_NOFOLLOW`` does not exist (Windows). We ``lstat`` the
#:   target and refuse to write through a link before opening. This is a **best-effort,
#:   TOCTOU-racy** check, not the atomic guarantee POSIX gives — but it is an explicit,
#:   documented degradation. The previous code did ``flags |= getattr(os, "O_NOFOLLOW", 0)``,
#:   which silently OR-ed in a zero and left the docstring promising a protection that was
#:   not there (audit finding R4-10). Callers can read this value (and surface it in a
#:   `doctor`-style command) to know which guarantee they actually have.
SYMLINK_GUARD = "O_NOFOLLOW" if _O_NOFOLLOW is not None else "lstat-precheck"


def _write_secure(path: str, data: str) -> None:
    """Write 0600, refusing to follow a planted symlink at the target.

    See :data:`SYMLINK_GUARD` for the per-platform strength of that refusal. Raises
    ``OSError`` (``ELOOP``) rather than writing through a link.
    """
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if _O_NOFOLLOW is not None:
        flags |= _O_NOFOLLOW
    elif os.path.islink(path):
        raise OSError(errno.ELOOP, "refusing to write through a symlink", path)
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
