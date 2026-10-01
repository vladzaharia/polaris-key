"""Persistence: per-device token, stable device id, offline-first verified cache.

Mirrors ``@polaris-key/node``'s ``core/store.ts``. These live under ``devices`` because the files
they own belong to the DEVICE principal — the credential, the device id, and the record
keyed by it. The SHAPE they persist (``CacheRecord``, ``Store``) is Core's contract and
lives in :mod:`polaris_key.core.store`; a host supplying its own backing store implements that
protocol and never imports a keyring.

The default :class:`KeyringStore` stores tokens in the OS keyring when the optional
``keyring`` extra is installed and falls back to :class:`FileStore`, and its ``status()``
says which. Its service tag is
``pkey:<product>`` (§8) — stable across the wire-contract revisions; the ``plrs:`` spelling
proposed by the interim suite design and withdrawn by Amendment A1 is neither written nor
read.

CACHE INTEGRITY (§4.1). The record persists **only signed artifacts**: the compact JWS of
each per-service document and of the trust manifest, verbatim. Every piece of security
state — the trust set, the per-type anti-replay floors, ``lastVerifiedAt``, the monotonic
clock floor — is *derived* by re-verifying those artifacts against the host application's
**pinned** keys on every load. A record from any other cache version is **discarded, not
migrated** (§4.1).
"""

from __future__ import annotations

import errno
import json
import os
from typing import Any, Callable, Optional, Tuple

from ..core.store import (
    CACHE_FORMAT_VERSION,
    CacheRecord,
    Store,
    StoreDegraded,
    StoreStatus,
)
from .deviceid import derive_device_id

__all__ = [
    "CACHE_FORMAT_VERSION",
    "SYMLINK_GUARD",
    "CacheRecord",
    "Store",
    "InMemoryStore",
    "FileStore",
    "KeyringStore",
    "KEYRING_SERVICE_PREFIX",
]

#: §8: the OS keyring service tag is ``pkey:<product>``.
KEYRING_SERVICE_PREFIX = "pkey:"


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

    def status(self) -> StoreStatus:
        return StoreStatus("memory")


_O_NOFOLLOW: Optional[int] = getattr(os, "O_NOFOLLOW", None)

#: How the symlink guard in :func:`_write_secure` is enforced on this platform.
#:
#: ``"O_NOFOLLOW"``     the kernel refuses the ``open(2)`` atomically — POSIX.
#: ``"lstat-precheck"`` ``os.O_NOFOLLOW`` does not exist (Windows). We ``lstat`` the
#:   target and refuse to write through a link before opening. This is a **best-effort,
#:   TOCTOU-racy** check, not the atomic guarantee POSIX gives — but it is an explicit,
#:   documented degradation. The previous code did ``flags |= getattr(os, "O_NOFOLLOW", 0)``,
#:   which silently OR-ed in a zero and left the docstring promising a protection that was
#:   not there (R4-10). Callers can read this value (and surface it in a `doctor`-style
#:   command) to know which guarantee they actually have.
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

    def status(self) -> StoreStatus:
        """The host chose a file, so it is not degraded."""
        return StoreStatus("file")


def _load_keyring() -> Any:
    """Import the optional ``keyring`` package; raise when it is missing."""
    import keyring  # type: ignore[import-not-found]

    return keyring


#: ``keyring`` backends that store nothing: ``fail`` raises on every call and ``null``
#: silently swallows writes (after which the old code deleted the file copy and lost the
#: token). Both count as an unavailable keyring.
_UNUSABLE_BACKEND_MODULES = ("keyring.backends.fail", "keyring.backends.null")


class KeyringStore:
    """OS-keyring token store with an explicit 0600 file fallback, and a ``status()`` that
    says which one holds the token (P1b-09 plan §5.5, security finding R4-11).

    THE INVARIANT: the 0600 token file exists only when the last token write fell back,
    because a VERIFIED keyring write (set, then read back) removes it. So reads are
    file-first, a fallen-back write also deletes the keyring entry (best effort), and
    ``status()`` reports ``file`` exactly when :meth:`get_token` would return the file's token
    or the keyring cannot be read.
    """

    def __init__(
        self,
        product_slug: str,
        config_dir: str,
        *,
        load_keyring: Optional[Callable[[], Any]] = None,
    ) -> None:
        self._files = FileStore(product_slug, config_dir)
        self._token_path = os.path.join(config_dir, product_slug, "token")
        self._service = f"{KEYRING_SERVICE_PREFIX}{product_slug}"
        self._account = "device-token"
        self._load = load_keyring or _load_keyring

    @property
    def service(self) -> str:
        return self._service

    def _access(self) -> Tuple[Any, Optional[str]]:
        """``(keyring, None)`` when usable, else ``(None, why)``. Never raises."""
        try:
            keyring = self._load()
        except Exception as exc:  # noqa: BLE001 — ImportError, or a broken install
            return None, f"the optional `keyring` package is not installed ({exc})"
        if keyring is None:
            return None, "the optional `keyring` package is not installed"
        try:
            backend = keyring.get_keyring()
        except Exception as exc:  # noqa: BLE001
            return None, f"no keyring backend could be selected ({exc})"
        module = type(backend).__module__
        if module in _UNUSABLE_BACKEND_MODULES:
            return None, f"the keyring backend is {module}.{type(backend).__name__}, which stores nothing"
        return keyring, None

    def _remove_token_file(self) -> bool:
        """``FileStore.clear_token`` swallows every ``OSError``; this counts only a missing
        file as success."""
        try:
            os.remove(self._token_path)
        except FileNotFoundError:
            return True
        except OSError:
            return False
        return True

    def get_token(self) -> Optional[str]:
        from_file = self._files.get_token()
        if from_file:
            return from_file
        keyring, _ = self._access()
        if keyring is None:
            return None
        try:
            return keyring.get_password(self._service, self._account) or None
        except Exception:
            return None

    def set_token(self, token: str) -> None:
        keyring, _ = self._access()
        if keyring is not None:
            try:
                keyring.set_password(self._service, self._account, token)
                verified = keyring.get_password(self._service, self._account) == token
            except Exception:
                verified = False
            if verified:
                if not self._remove_token_file():
                    # A surviving file must never hold an OLDER token than the keyring.
                    self._files.set_token(token)
                return
        # Raises on failure, as before: losing the token silently is worse than an error.
        self._files.set_token(token)
        if keyring is not None:
            try:
                keyring.delete_password(self._service, self._account)
            except Exception:
                pass  # best effort: the file is the newer copy, and reads are file-first

    def clear_token(self) -> None:
        keyring, _ = self._access()
        if keyring is not None:
            try:
                keyring.delete_password(self._service, self._account)
            except Exception:
                pass
        self._files.clear_token()

    def status(self) -> StoreStatus:
        try:
            keyring, why = self._access()
            if keyring is None:
                return StoreStatus("file", StoreDegraded("keyring-unavailable", why))
            try:
                keyring.get_password(self._service, self._account)
            except Exception as exc:  # noqa: BLE001
                return StoreStatus("file", StoreDegraded("keyring-error", str(exc) or type(exc).__name__))
            if self._files.get_token():
                return StoreStatus(
                    "file",
                    StoreDegraded(
                        "keyring-error",
                        "an earlier write fell back to this file; the next token write moves it to the keyring",
                    ),
                )
            return StoreStatus("keyring")
        except Exception as exc:  # noqa: BLE001 — status() never raises
            return StoreStatus("file", StoreDegraded("keyring-error", str(exc) or type(exc).__name__))

    def get_device_id(self) -> str:
        return self._files.get_device_id()

    def read_cache(self) -> Optional[CacheRecord]:
        return self._files.read_cache()

    def write_cache(self, rec: CacheRecord) -> None:
        self._files.write_cache(rec)

    def clear_cache(self) -> None:
        self._files.clear_cache()
