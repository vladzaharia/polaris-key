"""The Python device key store (CC-26.3; plans/CC-01.md R-5): custody of one device's Ed25519
signing key and X25519 agreement key behind :class:`~polaris_key.core.device_keys.DeviceKeyPort`.
Keys are made on first need and never leave the port: callers get public halves, signatures and
shared secrets. Mirrors the Node store (``packages/sdk-node/src/devices/deviceKeys.ts``) and the
Kotlin JVM store (``FileDeviceKeyStorage`` + ``DeviceKeyStore``).

Rules this store keeps:

* a record that exists but cannot be used is an ERROR (:class:`DeviceKeysUnreadableError`), never
  replaced: only ``wipe()`` resets it, so the device identity never changes silently;
* a backend that cannot do Ed25519 or X25519 is :class:`DeviceKeyUnsupportedError`, never "unreadable";
* an I/O fault, a refused path or a lock timeout raises :class:`DeviceKeyStoreError` and never reads
  as "no record" (a glitch must not cost the keys or make a second pair);
* ``ensure``, ``rotate`` and ``wipe`` run under an operating-system file lock (``fcntl.flock`` on
  POSIX, ``msvcrt.locking`` on Windows), so two processes cannot both create a pair or repeat a
  generation. The lock file is never removed, and the OS drops the lock when its holder dies, so
  there is no stale lock to reclaim;
* the file is ``0600`` in a ``0700`` directory. A directory or file owned by someone else, a
  directory or file with any group or other bit, a symlink, and an ancestor (up to the home
  directory) that others may write without the sticky bit are refused. Files are opened with
  ``O_NOFOLLOW`` and checked through the open descriptor, the record is replaced with ``os.replace``
  from a temporary file made owner-only before its first byte, and the directory is fsynced;
* on Windows the owner and mode checks, ``O_NOFOLLOW`` and the directory fsync are skipped (the user
  profile's ACL is the protection) and ``os.replace`` is retried when a scanner holds the file;
* every temporary file is overwritten with zeros before it is deleted, and stale ones are swept;
* the private halves are held in zeroable buffers for one operation and are in no return value,
  ``repr``, log or error text. (CPython cannot promise to erase every copy of a secret from memory;
  the zeroing here is best effort and the file is the protected place.)

Keep the state directory on a local disk: ``flock`` is not reliable on every network file system.
"""

from __future__ import annotations

import errno
import json
import os
import re
import secrets
import stat
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Union

from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

from ..core.b64url import b64url_decode, b64url_encode
from ..core.device_keys import (
    DeviceKeyError,
    DeviceKeyPort,
    DeviceKeyStoreError,
    DeviceKeysUnreadableError,
    DeviceKeyUnsupportedError,
    DevicePublicKeys,
)
from ..core.device_proof import is_x25519_low_order
from ..core.dirs import resolve_dirs

__all__ = [
    "DeviceKeyStorage",
    "InMemoryDeviceKeyStorage",
    "FileDeviceKeyStorage",
    "DeviceKeyStore",
    "create_device_key_store",
    "DEVICE_KEYS_FILE",
]

#: The record's file name under the product's state directory.
DEVICE_KEYS_FILE = "device-keys.json"

_MAX_BYTES = 64 * 1024
_MAX_ZERO_BYTES = 16 * 1024 * 1024
_LOCK_TIMEOUT_S = 10.0
_IS_WINDOWS = os.name == "nt"
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_O_BINARY = getattr(os, "O_BINARY", 0)
_O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)

#: The record's storage. ``update`` is a read-modify-write under the storage lock.
_Transform = Callable[[Optional[bytearray]], Union[bytes, bytearray, None]]


def _fault(what: str, path: str, e: BaseException) -> DeviceKeyStoreError:
    """A store error that names the operation, the path and the errno, never a byte of content."""
    code = getattr(e, "errno", None)
    name = os.strerror(code) if isinstance(code, int) else type(e).__name__
    return DeviceKeyStoreError(f"device keys: could not {what} {path} ({name})")


def _zero(b: Union[bytearray, bytes, None]) -> None:
    if isinstance(b, bytearray):
        for i in range(len(b)):
            b[i] = 0


class DeviceKeyStorage:
    """Holds the one record of a key store. Implementations make ``update`` atomic (across
    processes where the storage is shared)."""

    #: ``"durable"`` or ``"memory"``.
    persistence: str = "durable"

    def get(self) -> Optional[bytearray]:  # pragma: no cover - interface
        """The record, ``None`` when there is none. A fault raises :class:`DeviceKeyStoreError`."""
        raise NotImplementedError

    def update(self, transform: _Transform) -> bool:  # pragma: no cover - interface
        """Runs ``transform`` on the current record (``None`` when none) under the lock; the bytes it
        answers are written, ``None`` leaves the record alone. ``True`` when it wrote. A raise from
        ``transform`` writes nothing."""
        raise NotImplementedError

    def clear(self) -> None:  # pragma: no cover - interface
        """Overwrites the record with zeros and removes it."""
        raise NotImplementedError


class InMemoryDeviceKeyStorage(DeviceKeyStorage):
    """Process memory only: the keys die with the process."""

    persistence = "memory"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._record: Optional[bytearray] = None

    def get(self) -> Optional[bytearray]:
        with self._lock:
            return bytearray(self._record) if self._record is not None else None

    def update(self, transform: _Transform) -> bool:
        with self._lock:
            current = bytearray(self._record) if self._record is not None else None
            try:
                nxt = transform(current)
            finally:
                _zero(current)
            if nxt is None:
                return False
            _zero(self._record)
            self._record = bytearray(nxt)
            _zero(nxt)
            return True

    def clear(self) -> None:
        with self._lock:
            _zero(self._record)
            self._record = None

    def __repr__(self) -> str:
        return "InMemoryDeviceKeyStorage()"


_PATH_LOCKS: Dict[str, threading.Lock] = {}
_PATH_LOCKS_GUARD = threading.Lock()


def _path_lock(key: str) -> threading.Lock:
    with _PATH_LOCKS_GUARD:
        lock = _PATH_LOCKS.get(key)
        if lock is None:
            lock = _PATH_LOCKS[key] = threading.Lock()
        return lock


class _Dir:
    """An open, checked state directory. On POSIX every operation goes through the directory's
    descriptor, so a swapped path component cannot redirect it; Windows uses paths."""

    def __init__(self, path: str, fd: Optional[int]) -> None:
        self.path = path
        self.fd = fd

    def _p(self, name: str) -> str:
        return os.path.join(self.path, name)

    def open(self, name: str, flags: int, mode: int = 0o600) -> int:
        flags |= _O_NOFOLLOW | _O_CLOEXEC | _O_BINARY
        if self.fd is not None:
            return os.open(name, flags, mode, dir_fd=self.fd)
        return os.open(self._p(name), flags, mode)

    def lstat(self, name: str) -> Optional[os.stat_result]:
        try:
            if self.fd is not None:
                return os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            return os.lstat(self._p(name))
        except FileNotFoundError:
            return None

    def unlink(self, name: str) -> None:
        if self.fd is not None:
            os.unlink(name, dir_fd=self.fd)
        else:
            os.unlink(self._p(name))

    def replace(self, src: str, dst: str) -> None:
        if self.fd is not None:
            os.replace(src, dst, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            return
        for i in range(6):  # a scanner may hold the file for a moment
            try:
                os.replace(self._p(src), self._p(dst))
                return
            except PermissionError:
                if i >= 5:
                    raise
                time.sleep(0.02 * (i + 1))

    def listdir(self) -> List[str]:
        return os.listdir(self.fd if self.fd is not None else self.path)

    def fsync(self) -> None:
        if self.fd is None:
            return
        try:
            os.fsync(self.fd)
        except OSError:
            pass  # not every file system lets a directory be synced

    def close(self) -> None:
        if self.fd is not None:
            try:
                os.close(self.fd)
            finally:
                self.fd = None


def _lock_fd(fd: int) -> bool:
    """One non-blocking attempt at the exclusive lock; ``False`` when another holder has it."""
    try:
        if _IS_WINDOWS:
            import msvcrt

            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)  # type: ignore[attr-defined]
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except (BlockingIOError, PermissionError):
        return False
    except OSError as e:
        # Windows reports a busy region as a plain OSError (EACCES/EDEADLK); POSIX flock EWOULDBLOCK
        # is BlockingIOError above. Anything else is a real fault.
        if _IS_WINDOWS and getattr(e, "errno", None) in (13, 36):
            return False
        raise


def _unlock_fd(fd: int) -> None:
    try:
        if _IS_WINDOWS:
            import msvcrt

            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)  # type: ignore[attr-defined]
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass  # closing the descriptor drops the lock anyway


class FileDeviceKeyStorage(DeviceKeyStorage):
    """The record in one file, ``0600`` in a ``0700`` directory, replaced atomically (a temporary file
    made owner-only before its first byte, fsynced, then moved over with ``os.replace``). An OS file
    lock serialises ``get``/``update``/``clear`` between processes and threads."""

    persistence = "durable"

    def __init__(self, file: str) -> None:
        self._file = os.path.abspath(file)
        self._dir_path = os.path.dirname(self._file)
        self._name = os.path.basename(self._file)
        if not self._name:
            raise DeviceKeyStoreError("device keys: a file path is needed")
        self._lock_name = f".{self._name}.lock"

    def __repr__(self) -> str:
        return f"FileDeviceKeyStorage({self._file!r})"

    # ---- public --------------------------------------------------------------------------------

    def get(self) -> Optional[bytearray]:
        with self._locked() as d:
            return self._read(d)

    def update(self, transform: _Transform) -> bool:
        with self._locked() as d:
            current = self._read(d)
            try:
                nxt = transform(current)
            finally:
                _zero(current)
            if nxt is None:
                return False
            try:
                self._write(d, nxt)
            finally:
                _zero(nxt)
            return True

    def clear(self) -> None:
        with self._locked() as d:
            st = d.lstat(self._name)
            if st is not None:
                self._refuse_non_regular(self._name, st)
                self._zero_and_delete(d, self._name)
            self._sweep(d)

    # ---- the directory -------------------------------------------------------------------------

    def _locked(self) -> "_Locked":
        return _Locked(self)

    def _open_dir(self) -> _Dir:
        path = self._dir_path
        created = False
        try:
            if not os.path.lexists(path):
                os.makedirs(path, mode=0o700, exist_ok=True)
                created = True
        except OSError as e:
            raise _fault("create", path, e) from e
        if _IS_WINDOWS:
            if os.path.islink(path) or not os.path.isdir(path):
                raise DeviceKeyStoreError(f"device keys: {path} is not a directory")
            return _Dir(path, None)
        try:
            fd = os.open(path, os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW | _O_CLOEXEC)
        except OSError as e:
            why = os.strerror(e.errno or 0)
            raise DeviceKeyStoreError(f"device keys: {path} is not a usable directory ({why})") from e
        d = _Dir(path, fd)
        try:
            if created:
                os.fchmod(fd, 0o700)  # a umask may have cut the leaf; never widen an existing one
            st = os.fstat(fd)
            if not stat.S_ISDIR(st.st_mode):
                raise DeviceKeyStoreError(f"device keys: {path} is not a directory")
            if st.st_uid != os.geteuid():
                raise DeviceKeyStoreError(f"device keys: refusing a directory owned by another user: {path}")
            if st.st_mode & 0o077:
                raise DeviceKeyStoreError(f"device keys: refusing a directory others may access: {path}")
            self._check_ancestors(path)
        except BaseException:
            d.close()
            raise
        return d

    @staticmethod
    def _check_ancestors(path: str) -> None:
        """Refuses a group- or world-writable ancestor without the sticky bit, from the real path of
        the directory up to the home directory (or the root): someone who can write there can swap
        the directory out."""
        try:
            real = os.path.realpath(path)
        except OSError as e:
            raise _fault("resolve", path, e) from e
        try:
            home: Optional[str] = os.path.realpath(os.path.expanduser("~"))
        except OSError:
            home = None
        p = os.path.dirname(real)
        while True:
            if p == home:
                return
            try:
                st = os.lstat(p)
            except OSError as e:
                raise _fault("examine", p, e) from e
            if (st.st_mode & 0o022) and not (st.st_mode & stat.S_ISVTX):
                raise DeviceKeyStoreError(f"device keys: refusing a directory under one others may write: {p}")
            parent = os.path.dirname(p)
            if parent == p:
                return
            p = parent

    @staticmethod
    def _refuse_non_regular(name: str, st: os.stat_result) -> None:
        if not stat.S_ISREG(st.st_mode):
            raise DeviceKeyStoreError(f"device keys: refusing a path that is not a regular file: {name}")

    def _check_file(self, name: str, st: os.stat_result) -> None:
        """Owner and mode of an open file (from its descriptor): refuse a foreign or loose one."""
        self._refuse_non_regular(name, st)
        if _IS_WINDOWS:
            return
        if st.st_uid != os.geteuid():
            raise DeviceKeyStoreError(f"device keys: refusing a file owned by another user: {name}")
        if st.st_mode & 0o077:
            raise DeviceKeyStoreError(f"device keys: refusing a file others may access: {name}")

    # ---- the lock ------------------------------------------------------------------------------

    def _acquire(self, d: _Dir) -> int:
        deadline = time.monotonic() + _LOCK_TIMEOUT_S
        while True:
            try:
                try:
                    fd = d.open(self._lock_name, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
                    if not _IS_WINDOWS:
                        os.fchmod(fd, 0o600)  # a restrictive umask may have cut it
                except FileExistsError:
                    fd = d.open(self._lock_name, os.O_RDWR)
            except OSError as e:
                raise _fault("open the lock", self._lock_name, e) from e
            try:
                self._check_file(self._lock_name, os.fstat(fd))
                while not _lock_fd(fd):
                    if time.monotonic() > deadline:
                        raise DeviceKeyStoreError("device keys: the lock is busy")
                    time.sleep(0.015 + secrets.randbelow(25) / 1000.0)
                # The lock file is never removed by us; if it was swapped while we waited, take
                # the lock on the one that is there now.
                here = d.lstat(self._lock_name)
                mine = os.fstat(fd)
                if here is not None and (here.st_ino, here.st_dev) == (mine.st_ino, mine.st_dev):
                    return fd
            except BaseException:
                _unlock_fd(fd)
                os.close(fd)
                raise
            _unlock_fd(fd)
            os.close(fd)

    # ---- read and write ------------------------------------------------------------------------

    def _read(self, d: _Dir) -> Optional[bytearray]:
        try:
            fd = d.open(self._name, os.O_RDONLY)
        except FileNotFoundError:
            return None
        except OSError as e:
            if getattr(e, "errno", None) == errno.ELOOP:
                raise DeviceKeyStoreError(f"device keys: refusing a symlink: {self._file}") from e
            raise _fault("read", self._file, e) from e
        try:
            st = os.fstat(fd)
            self._check_file(self._name, st)
            if st.st_size > _MAX_BYTES:
                raise DeviceKeysUnreadableError("device keys: the record is not one of ours")
            buf = bytearray()
            while len(buf) <= _MAX_BYTES:
                chunk = os.read(fd, _MAX_BYTES + 1 - len(buf))
                if not chunk:
                    break
                buf += chunk
            if len(buf) > _MAX_BYTES:
                _zero(buf)
                raise DeviceKeysUnreadableError("device keys: the record is not one of ours")
            return buf
        except OSError as e:
            raise _fault("read", self._file, e) from e
        finally:
            os.close(fd)

    def _write(self, d: _Dir, data: Union[bytes, bytearray]) -> None:
        st = d.lstat(self._name)
        if st is not None:
            self._refuse_non_regular(self._name, st)
        self._sweep(d)
        tmp = f".{self._name}.{secrets.token_hex(8)}.tmp"
        try:
            fd = d.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                if not _IS_WINDOWS:
                    os.fchmod(fd, 0o600)  # before the first key byte
                view = memoryview(data)
                off = 0
                while off < len(view):
                    off += os.write(fd, view[off:])
                os.fsync(fd)
            finally:
                os.close(fd)
            d.replace(tmp, self._name)
            d.fsync()
        except BaseException as e:
            self._zero_and_delete(d, tmp, quiet=True)
            if isinstance(e, OSError):
                raise _fault("write", self._file, e) from e
            raise

    def _sweep(self, d: _Dir) -> None:
        """Removes stale temporary files (a crashed write); the lock is held, so none is in use."""
        try:
            names = d.listdir()
        except OSError as e:
            raise _fault("list", self._dir_path, e) from e
        prefix = f".{self._name}."
        for n in names:
            if n.startswith(prefix) and n.endswith(".tmp"):
                self._zero_and_delete(d, n)

    def _zero_and_delete(self, d: _Dir, name: str, quiet: bool = False) -> None:
        """Overwrites a regular file we own with zeros, then deletes it. The overwrite is best effort."""
        try:
            fd = d.open(name, os.O_RDWR)
            try:
                st = os.fstat(fd)
                if stat.S_ISREG(st.st_mode) and (_IS_WINDOWS or st.st_uid == os.geteuid()):
                    remaining = min(st.st_size, _MAX_ZERO_BYTES)
                    os.lseek(fd, 0, os.SEEK_SET)
                    while remaining > 0:
                        n = min(remaining, 65536)
                        os.write(fd, bytes(n))
                        remaining -= n
                    os.fsync(fd)
            finally:
                os.close(fd)
        except OSError:
            pass  # a file we cannot open is still removed below when it is ours to remove
        try:
            d.unlink(name)
        except FileNotFoundError:
            pass
        except OSError as e:
            if not quiet:
                raise _fault("delete", name, e) from e


class _Locked:
    """Context manager: the thread lock, the checked directory and the OS lock, in that order."""

    def __init__(self, storage: FileDeviceKeyStorage) -> None:
        self._s = storage
        self._thread = _path_lock(storage._file)
        self._dir: Optional[_Dir] = None
        self._lock_fd: Optional[int] = None

    def __enter__(self) -> _Dir:
        self._thread.acquire()
        try:
            self._dir = self._s._open_dir()
            self._lock_fd = self._s._acquire(self._dir)
            return self._dir
        except BaseException:
            self._release()
            raise

    def __exit__(self, *exc: Any) -> None:
        self._release()

    def _release(self) -> None:
        try:
            if self._lock_fd is not None:
                _unlock_fd(self._lock_fd)
                os.close(self._lock_fd)
                self._lock_fd = None
        finally:
            try:
                if self._dir is not None:
                    self._dir.close()
                    self._dir = None
            finally:
                self._thread.release()


# ---- the key store -----------------------------------------------------------------------------

class _Record:
    """One decoded record. The private halves are ``bytearray`` so they can be zeroed; ``repr`` shows
    nothing."""

    __slots__ = ("generation", "seed", "sign_pub", "agree_priv", "agree_pub")

    def __init__(self, generation: int, seed: bytearray, sign_pub: bytes, agree_priv: bytearray, agree_pub: bytes):
        self.generation = generation
        self.seed = seed
        self.sign_pub = sign_pub
        self.agree_priv = agree_priv
        self.agree_pub = agree_pub

    def __repr__(self) -> str:
        return "<device key record>"

    def public(self) -> DevicePublicKeys:
        return DevicePublicKeys(b64url_encode(self.sign_pub), b64url_encode(self.agree_pub), self.generation)

    def zero(self) -> None:
        _zero(self.seed)
        _zero(self.agree_priv)


def _unsupported(e: BaseException) -> DeviceKeyUnsupportedError:
    return DeviceKeyUnsupportedError(f"no Ed25519 or X25519 here ({type(e).__name__})")


def _ed_public(seed: bytes) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def _x_public(priv: bytes) -> bytes:
    return X25519PrivateKey.from_private_bytes(priv).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def _consistent(r: _Record) -> bool:
    """The public halves belong to the private halves. An unavailable backend is "unsupported here",
    never "this record is bad"."""
    try:
        return _ed_public(bytes(r.seed)) == r.sign_pub and _x_public(bytes(r.agree_priv)) == r.agree_pub
    except UnsupportedAlgorithm as e:
        raise _unsupported(e) from e
    except ValueError:
        return False


def _generate(generation: int) -> _Record:
    try:
        ed = Ed25519PrivateKey.generate()
        seed = bytearray(ed.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()))
        sign_pub = ed.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        xk = X25519PrivateKey.generate()
        priv = bytearray(xk.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()))
        agree_pub = xk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    except UnsupportedAlgorithm as e:
        raise _unsupported(e) from e
    rec = _Record(generation, seed, sign_pub, priv, agree_pub)
    if is_x25519_low_order(agree_pub) or not _consistent(rec):
        rec.zero()
        raise DeviceKeyUnsupportedError("the curve backend is inconsistent")
    return rec


def _encode(r: _Record) -> bytearray:
    text = json.dumps(
        {
            "v": 1,
            "generation": r.generation,
            "sign": {"seed": b64url_encode(bytes(r.seed)), "pub": b64url_encode(r.sign_pub)},
            "agree": {"priv": b64url_encode(bytes(r.agree_priv)), "pub": b64url_encode(r.agree_pub)},
        },
        separators=(",", ":"),
    )
    return bytearray(text.encode("ascii"))


def _decode_key(v: Any) -> Optional[bytes]:
    if not isinstance(v, str) or len(v) != 43:
        return None
    try:
        b = b64url_decode(v)  # canonical only: the same text comes back out
    except ValueError:
        return None
    return b if len(b) == 32 else None


def _parse(raw: Union[bytes, bytearray]) -> Optional[_Record]:
    """The record, or ``None`` when it is not one of ours. Never surfaces the parser's message."""
    try:
        o = json.loads(bytes(raw).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, RecursionError):
        return None
    if not isinstance(o, dict) or o.get("v") != 1 or isinstance(o.get("v"), bool):
        return None
    gen = o.get("generation")
    if not isinstance(gen, int) or isinstance(gen, bool) or gen < 1 or gen > 2**53 - 1:
        return None
    sign, agree = o.get("sign"), o.get("agree")
    if not isinstance(sign, dict) or not isinstance(agree, dict):
        return None
    seed, sign_pub = _decode_key(sign.get("seed")), _decode_key(sign.get("pub"))
    priv, agree_pub = _decode_key(agree.get("priv")), _decode_key(agree.get("pub"))
    if seed is None or sign_pub is None or priv is None or agree_pub is None:
        return None
    rec = _Record(gen, bytearray(seed), sign_pub, bytearray(priv), agree_pub)
    if not _consistent(rec):
        rec.zero()
        return None
    return rec


class DeviceKeyStore:
    """The key store: generation, rotation and wipe over a :class:`DeviceKeyStorage`, with the private
    halves held only for the length of one operation. Implements
    :class:`~polaris_key.core.device_keys.DeviceKeyPort`.

    The record is JSON ``{"v":1,"generation":n,"sign":{"seed","pub"},"agree":{"priv","pub"}}``, every
    key canonical base64url (the Node and Kotlin stores write the same record). A record that does not
    parse, or whose public halves do not match its private halves, is unreadable: every member except
    :meth:`wipe` raises :class:`DeviceKeysUnreadableError` and the record is kept.
    """

    def __init__(self, storage: DeviceKeyStorage) -> None:
        self._storage = storage
        # One operation at a time within this process; the storage's lock covers other processes.
        self._op = threading.RLock()

    def __repr__(self) -> str:
        return f"DeviceKeyStore({self._storage!r})"

    def persistence(self) -> str:
        return self._storage.persistence

    def _load(self) -> Optional[_Record]:
        raw = self._storage.get()
        if raw is None:
            return None
        try:
            r = _parse(raw)
            if r is None:
                raise DeviceKeysUnreadableError()
            return r
        finally:
            _zero(raw)

    def public_keys(self) -> Optional[DevicePublicKeys]:
        with self._op:
            r = self._load()
            if r is None:
                return None
            try:
                return r.public()
            finally:
                r.zero()

    def ensure(self) -> DevicePublicKeys:
        with self._op:
            result: List[DevicePublicKeys] = []

            # Under the storage lock: an existing record is returned (an unreadable one raises); only
            # an absent one is created, so two processes can never each make a pair.
            def transform(current: Optional[bytearray]) -> Optional[bytearray]:
                if current is not None:
                    r = _parse(current)
                    if r is None:
                        raise DeviceKeysUnreadableError()
                    result.append(r.public())
                    r.zero()
                    return None
                fresh = _generate(1)
                result.append(fresh.public())
                out = _encode(fresh)
                fresh.zero()
                return out

            self._storage.update(transform)
            return result[0]

    def sign(self, message: bytes) -> bytes:
        with self._op:
            r = self._load()
            if r is None:
                raise DeviceKeyError("device keys: none yet")
            try:
                return Ed25519PrivateKey.from_private_bytes(bytes(r.seed)).sign(bytes(message))
            except UnsupportedAlgorithm as e:
                raise _unsupported(e) from e
            finally:
                r.zero()

    def dh(self, peer_public: bytes) -> Optional[bytes]:
        with self._op:
            peer = bytes(peer_public)
            if len(peer) != 32 or is_x25519_low_order(peer):
                return None
            r = self._load()
            if r is None:
                return None
            try:
                secret = X25519PrivateKey.from_private_bytes(bytes(r.agree_priv)).exchange(
                    X25519PublicKey.from_public_bytes(peer)
                )
            except UnsupportedAlgorithm as e:
                raise _unsupported(e) from e
            except ValueError:
                return None
            finally:
                r.zero()
            if not any(secret):
                return None
            return secret

    def rotate(self) -> DevicePublicKeys:
        with self._op:
            result: List[DevicePublicKeys] = []

            # The generation is read and its successor written under the storage lock, so a concurrent
            # rotate (another process) is neither lost nor repeats a generation.
            def transform(current: Optional[bytearray]) -> bytearray:
                prev: Optional[_Record] = None
                if current is not None:
                    prev = _parse(current)
                    if prev is None:
                        raise DeviceKeysUnreadableError()
                gen = (prev.generation if prev is not None else 0) + 1
                if prev is not None:
                    prev.zero()
                fresh = _generate(gen)
                result.append(fresh.public())
                out = _encode(fresh)
                fresh.zero()
                return out

            self._storage.update(transform)
            return result[0]

    def wipe(self) -> None:
        with self._op:
            self._storage.clear()


_PRODUCT = re.compile(r"[A-Za-z0-9][A-Za-z0-9@._-]{0,127}\Z")


def create_device_key_store(
    *,
    product: Optional[str] = None,
    state_dir: Optional[str] = None,
    memory: bool = False,
    storage: Optional[DeviceKeyStorage] = None,
) -> DeviceKeyStore:
    """A key store. By default the record lives in ``<state dir>/device-keys.json`` (``0600`` in a
    ``0700`` directory); ``memory=True`` holds the keys in process memory only, and such a store
    refuses to register keys. ``storage`` overrides both (a test seam, or a host's own custody)."""
    if storage is None:
        if memory:
            storage = InMemoryDeviceKeyStorage()
        else:
            if not product or _PRODUCT.match(product) is None or ".." in product:
                raise DeviceKeyStoreError("device keys: a product or a storage is needed")
            dirs = resolve_dirs(product, state_dir=state_dir)
            storage = FileDeviceKeyStorage(os.path.join(dirs.state, DEVICE_KEYS_FILE))
    return DeviceKeyStore(storage)


def _port_check(s: DeviceKeyStore) -> DeviceKeyPort:  # pragma: no cover - typing aid
    return s
