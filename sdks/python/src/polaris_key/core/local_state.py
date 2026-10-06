"""Small JSON state files beside the token store: the update-health journal, the boot-guard
slots, persisted config overrides and the "last seen" markers the kits read.

None of these is security-relevant: each is UNSIGNED, device-local state that can only change
what the device itself reports or shows (an event it has not sent yet, a setting the player
chose). Nothing here is ever read as a grant. A file that is missing, unreadable or not the
expected shape reads as empty and is rewritten on the next save, so a torn write costs at most
the last change.

Where the files live: the product's state directory (``CoreContext.dirs.state``) when the
client persists at all (a disk-backed store, or an explicit ``state_dir``); in memory
otherwise, so a test or a host with ``InMemoryStore`` never writes into the user's home.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from typing import Any, Callable, Optional

__all__ = ["JsonStateFile"]


class JsonStateFile:
    """One JSON document at ``path``, or in memory when ``path`` is ``None``.

    Writes are atomic (a temp file in the same directory, then ``os.replace``) and 0600. All
    I/O errors are swallowed: the state is a convenience, and failing to persist it must never
    fail the call that produced it.
    """

    def __init__(self, path: Optional[str], default: Callable[[], Any]) -> None:
        self.path = path
        self._default = default
        self._lock = threading.RLock()
        self._memory: Any = None
        self._loaded = False

    def load(self) -> Any:
        with self._lock:
            if self.path is None:
                if not self._loaded:
                    self._memory = self._default()
                    self._loaded = True
                return self._memory
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (OSError, ValueError):
                return self._default()

    def save(self, value: Any) -> bool:
        with self._lock:
            if self.path is None:
                self._memory = value
                self._loaded = True
                return True
            try:
                directory = os.path.dirname(self.path) or "."
                os.makedirs(directory, mode=0o700, exist_ok=True)
                fd, tmp = tempfile.mkstemp(prefix=".pkey-", dir=directory)
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as f:
                        json.dump(value, f, separators=(",", ":"), sort_keys=True)
                    os.chmod(tmp, 0o600)
                    os.replace(tmp, self.path)
                except BaseException:
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
                    raise
                return True
            except OSError:
                return False

    def update(self, fn: Callable[[Any], Any]) -> Any:
        """Read, transform and write under one lock; returns the new value."""
        with self._lock:
            value = fn(self.load())
            self.save(value)
            return value
