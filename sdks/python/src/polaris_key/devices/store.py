"""Persistence: per-device token, stable device id, offline-first verified cache.

Mirrors ``@polaris-key/node``'s ``core/store.ts``. These live under ``devices`` because the files
they own belong to the DEVICE principal — the credential, the device id, and the record
keyed by it. The SHAPE they persist (``CacheRecord``, ``Store``) is Core's contract and
lives in :mod:`polaris_key.core.store`; a host supplying its own backing store implements that
protocol and never imports a keyring.

The default :class:`KeyringStore` stores tokens in the OS keyring when the optional
``keyring`` extra is installed and falls back to :class:`FileStore`. Its service tag is
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
import stat
from typing import Any, Optional

from ..core.store import CACHE_FORMAT_VERSION, CacheRecord, Store
from .deviceid import derive_device_id

__all__ = [
    "CACHE_FORMAT_VERSION",
    "MAX_STATE_FILE_BYTES",
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


_O_NOFOLLOW: Optional[int] = getattr(os, "O_NOFOLLOW", None)
#: ``O_CLOEXEC`` is POSIX-only; on Windows there is nothing to add and ``0`` is the honest
#: spelling of that. Keeps a forked helper from inheriting the descriptor mid-read.
_O_CLOEXEC: int = getattr(os, "O_CLOEXEC", 0)

#: Largest on-disk state file :func:`_read_secure` will read, in bytes.
#:
#: Mode 0600 was applied only AT CREATION and the read was a plain ``open()`` — so a symlink
#: planted at the path redirected the read to a file the attacker chose, and a huge file at the
#: path was read whole into this process (B1-04/B1-07). This constant bounds the second half.
#:
#: Three files live under the product directory: the ``pkeyt_`` token, a 32-char device id, and
#: ``managed.json``. The record is at most three compact JWSs plus a few unsigned hints — a
#: signed document's payload is capped at ``MAX_DOC_BYTES`` (64 KiB), which base64url-encodes
#: to ~87 KiB, so a legitimate record sits well under 300 KiB with trust, licence and config
#: all at the cap. ``MAX_BUNDLE_BYTES`` (256 KiB) does **not** apply: ``importedBundle``
#: persists a marker — ``bundleId`` plus a timestamp — never the bundle JWS. 1 MiB is the same
#: number Swift's ``KeychainStore.maxCacheBytes`` and the Node SDK's ``MAX_STATE_FILE_BYTES``
#: use, chosen the same way: several times any legitimate record, nowhere near "read the
#: attacker's 8 GiB file".
MAX_STATE_FILE_BYTES = 1024 * 1024

#: How the symlink guard in :func:`_write_secure` and :func:`_read_secure` is enforced on
#: this platform.
#:
#: ``"O_NOFOLLOW"``     the kernel refuses the ``open(2)`` atomically — POSIX.
#: ``"lstat-precheck"`` ``os.O_NOFOLLOW`` does not exist (Windows). We ``lstat`` the
#:   target and refuse to read or write through a link before opening. This is a
#:   **best-effort, TOCTOU-racy** check, not the atomic guarantee POSIX gives — but it is an
#:   explicit, documented degradation. The previous code did
#:   ``flags |= getattr(os, "O_NOFOLLOW", 0)``, which silently OR-ed in a zero and left the
#:   docstring promising a protection that was not there (R4-10). Callers can read this value
#:   (and surface it in a `doctor`-style command) to know which guarantee they actually have.
SYMLINK_GUARD = "O_NOFOLLOW" if _O_NOFOLLOW is not None else "lstat-precheck"


def _write_secure(path: str, data: str) -> None:
    """Write 0600, refusing to follow a planted symlink at the target.

    See :data:`SYMLINK_GUARD` for the per-platform strength of that refusal. Raises
    ``OSError`` (``ELOOP``) rather than writing through a link.
    """
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | _O_CLOEXEC
    if _O_NOFOLLOW is not None:
        flags |= _O_NOFOLLOW
    elif os.path.islink(path):
        raise OSError(errno.ELOOP, "refusing to write through a symlink", path)
    fd = os.open(path, flags, 0o600)
    try:
        # The creation mode applies only to a NEW file; repair a pre-existing loose one, as
        # Swift's `writeSecure` does. Failing to TIGHTEN a mode (Windows, some network
        # filesystems) must not fail the write that was going to happen anyway.
        try:
            os.fchmod(fd, 0o600)
        except (AttributeError, OSError):
            pass
        os.write(fd, data.encode("utf-8"))
    finally:
        os.close(fd)


def _read_secure(path: str) -> Optional[str]:
    """Read ``path``, refusing to follow a symlink and bounding the read at
    :data:`MAX_STATE_FILE_BYTES`.

    Every refusal — absent, symlinked (``ELOOP``/``EMLINK``), not a regular file, over the
    cap, unreadable, not UTF-8 — returns ``None``, which is this store's single spelling of
    **ABSENT**. That is the standing convention (§4.1: a missing, unreadable or unparseable
    cache is "no cache", which Core treats as needs-activation), and it is what keeps a
    planted file from being either trusted *or* fatal.
    """
    flags = os.O_RDONLY | _O_CLOEXEC
    if _O_NOFOLLOW is not None:
        flags |= _O_NOFOLLOW
    elif os.path.islink(path):
        return None
    try:
        fd = os.open(path, flags)
    except OSError:
        return None
    handle = None
    try:
        st = os.fstat(fd)
        # A directory, FIFO or device node at this path is not the file we wrote.
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_STATE_FILE_BYTES:
            return None
        handle = os.fdopen(fd, "r", encoding="utf-8")
        fd = -1  # ownership transferred to `handle`
        # Bounded a second time in case the file grew between fstat and read.
        return handle.read(MAX_STATE_FILE_BYTES)
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    finally:
        if handle is not None:
            handle.close()
        elif fd >= 0:
            os.close(fd)


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
        raw = _read_secure(self._token_path)
        return raw.strip() if raw and raw.strip() else None

    def set_token(self, token: str) -> None:
        _write_secure(self._token_path, token)

    def clear_token(self) -> None:
        try:
            os.remove(self._token_path)
        except OSError:
            pass

    def get_device_id(self) -> str:
        existing = _read_secure(self._device_path)
        if existing and existing.strip():
            return existing.strip()
        device_id = derive_device_id(self._product_slug)
        _write_secure(self._device_path, device_id)
        return device_id

    def read_cache(self) -> Optional[CacheRecord]:
        raw = _read_secure(self._cache_path)
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
    """OS-keyring token store with :class:`FileStore` fallback for cache/device id."""

    def __init__(self, product_slug: str, config_dir: str) -> None:
        self._files = FileStore(product_slug, config_dir)
        self._service = f"{KEYRING_SERVICE_PREFIX}{product_slug}"
        self._account = "device-token"

    @property
    def service(self) -> str:
        return self._service

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
