"""The Cloud Sync host's state file: ``<state_dir>/cloud-sync.json``, owner-only (0600) and atomic.

A port of ``packages/sdk-node/src/cloudSync/state.ts``. It holds the machine's journal
(``CloudSyncMachine.persist()``), the catalog last served by ``/config/schema`` (so a relaunch routes
settings before the first fetch) and the names of the person's open settings (so a blinded tombstone can
be mapped back).

The file holds the WHOLE opened snapshot of the signed-in person's settings, not only the pending edits.
Whoever signs out, or loses the account, must purge it (:meth:`CloudSyncStateFile.remove`); until then it
is as sensitive as the settings themselves. The root is never written: the key ring keeps it in memory.

A write creates its temporary file exclusively (``O_EXCL``, so a planted symlink or file is refused) with
mode 0600, flushes it to disk, then renames it over the file.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
from typing import Any, Dict, List, Optional

__all__ = [
    "CLOUD_SYNC_FILE",
    "CLOUD_SYNC_IMPORTED_FILE",
    "OPEN_KEYS_MAX",
    "CloudSyncFile",
    "CloudSyncStateFile",
    "is_catalog_shape",
    "write_bytes_atomic",
    "write_json_atomic",
]

CLOUD_SYNC_FILE = "cloud-sync.json"
#: Holds no data: it says the legacy ``local-config.json`` was offered to the machine once.
CLOUD_SYNC_IMPORTED_FILE = "cloud-sync-imported.json"
#: Open-setting names kept for tombstone mapping; past this the oldest are dropped.
OPEN_KEYS_MAX = 4096

CloudSyncFile = Dict[str, Any]


def is_catalog_shape(v: Any) -> bool:
    """The catalog's outer shape; the host derives routes from it with ``synced_settings``."""
    return (
        isinstance(v, dict)
        and isinstance(v.get("schemaVersion"), (int, float))
        and not isinstance(v.get("schemaVersion"), bool)
        and isinstance(v.get("entries"), list)
    )


def write_bytes_atomic(path: str, data: bytes) -> None:
    """Write ``data`` to ``path``: temp file (exclusive, 0600) in the same directory, fsync, rename. The
    directory is created (0700) when needed."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, mode=0o700, exist_ok=True)
    tmp = f"{path}.{secrets.token_hex(12)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(tmp, flags, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:  # best effort: make the rename itself durable
        dfd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def write_json_atomic(path: str, value: Any) -> None:
    """Write ``value`` to ``path`` as compact JSON, atomically (:func:`write_bytes_atomic`)."""
    write_bytes_atomic(path, json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8"))


def _read_json(path: str) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError, RecursionError):
        return None


class CloudSyncStateFile:
    def __init__(self, state_dir: str, product: str) -> None:
        self.path = os.path.join(state_dir, CLOUD_SYNC_FILE)
        self.imported_path = os.path.join(state_dir, CLOUD_SYNC_IMPORTED_FILE)
        self._product = product
        #: Writes and removals are serialised, so a slow one never lands after a newer one.
        self._lock = threading.Lock()

    def remove(self) -> None:
        """Delete the file (after any write in progress). Raises if it stays."""
        with self._lock:
            try:
                os.unlink(self.path)
            except FileNotFoundError:
                pass

    def imported(self) -> bool:
        return _read_json(self.imported_path) is not None

    def mark_imported(self) -> None:
        write_json_atomic(self.imported_path, {"v": 1})

    def load(self) -> CloudSyncFile:
        """The saved file, or an empty one when it is missing, corrupt or another product's."""
        empty: CloudSyncFile = {
            "v": 1,
            "product": self._product,
            "persisted": None,
            "catalog": None,
            "openKeys": [],
        }
        raw = _read_json(self.path)
        if not isinstance(raw, dict) or raw.get("v") != 1 or raw.get("product") != self._product:
            return empty
        p = raw.get("persisted")
        persisted: Optional[Dict[str, Any]] = (
            p
            if isinstance(p, dict)
            and isinstance(p.get("partitions"), dict)
            and isinstance(p.get("hlc"), list)
            and isinstance(p.get("contacted"), bool)
            else None
        )
        keys = raw.get("openKeys")
        open_keys: List[str] = [k for k in keys if isinstance(k, str)] if isinstance(keys, list) else []
        return {
            **empty,
            "persisted": persisted,
            "catalog": raw.get("catalog") if is_catalog_shape(raw.get("catalog")) else None,
            "openKeys": open_keys[-OPEN_KEYS_MAX:],
        }

    def save(self, file: CloudSyncFile) -> None:
        with self._lock:
            write_json_atomic(self.path, file)
