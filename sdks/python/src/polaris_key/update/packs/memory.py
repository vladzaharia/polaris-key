"""In-memory pack storage and state store (a port of client-core's ``packs/memory.ts``): the
``PackStorage`` and ``PackStateStore`` a test or a corpus harness runs the engine over. Nothing
survives the process; ``client.update.packs`` uses :class:`DirPackStorage`.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, List, Optional, Tuple

from ...constants_generated import MAX_CHUNK_INDEX_BYTES
from .engine import InstalledPayload, PackOutput
from .files import tree_digest
from .ports import InstalledFile, MemorySource, slice_source

__all__ = [
    "MemoryChunkIndexStore",
    "MemoryRunJournal",
    "MemoryPackStorage",
    "MemoryPackStateStore",
    "memory_pack_storage",
    "memory_pack_state_store",
]


class _Staged:
    def __init__(self, objects: Dict[str, bytearray], sha256: str) -> None:
        self._objects = objects
        self._sha = sha256

    def size(self) -> int:
        return len(self._objects.get(self._sha, b""))

    def source(self) -> MemorySource:
        return MemorySource(bytes(self._objects.get(self._sha, b"")))

    def append(self, data: bytes) -> None:
        self._objects.setdefault(self._sha, bytearray()).extend(data)

    def reset(self) -> None:
        self._objects.pop(self._sha, None)


class _Out:
    def __init__(self) -> None:
        self.container = bytearray()
        self.tree: Dict[str, bytes] = {}

    def write(self, offset: int, data: bytes) -> None:
        end = offset + len(data)
        if len(self.container) < end:
            self.container.extend(b"\0" * (end - len(self.container)))
        self.container[offset:end] = data

    def write_file(self, path: str, data: bytes) -> None:
        self.tree[path] = bytes(data)

    def read(self, offset: int, length: int) -> bytes:
        return bytes(self.container[offset : offset + max(0, length)])


class MemoryChunkIndexStore:
    """P4-11's seed-index store over a dict (``indexes``: SHA-256 → stored bytes)."""

    def __init__(self) -> None:
        self.indexes: Dict[str, bytes] = {}

    def get(self, sha256: str) -> Optional[bytes]:
        """The stored index; one over ``MAX_CHUNK_INDEX_BYTES`` is absent (and dropped)."""
        data = self.indexes.get(sha256)
        if data is not None and len(data) > MAX_CHUNK_INDEX_BYTES:
            del self.indexes[sha256]
            return None
        return data

    def put(self, sha256: str, data: bytes) -> None:
        self.indexes[sha256] = bytes(data)

    def list(self) -> List[str]:
        return sorted(self.indexes)

    def remove(self, sha256: str) -> None:
        self.indexes.pop(sha256, None)


class MemoryRunJournal:
    """P4-11's run journal over a dict (``journals``: plan id → text), dropped with staging."""

    def __init__(self) -> None:
        self.journals: Dict[str, str] = {}

    def read(self, plan_id: str) -> Optional[str]:
        return self.journals.get(plan_id)

    def write(self, plan_id: str, text: str) -> None:
        self.journals[plan_id] = text


class MemoryPackStorage:
    """``PackStorage`` over dicts. ``store`` holds payloads by location
    (``<packId>/<payloadSha256>``), each ``{"layout", "payload"|"tree", "index"}``; ``staging``
    holds staged objects by plan id, then SHA-256. ``free`` is what the planner is told."""

    def __init__(self, free_disk: int = 1 << 30) -> None:
        self.store: Dict[str, Dict[str, Any]] = {}
        self.staging: Dict[str, Dict[str, bytearray]] = {}
        self._outputs: Dict[str, _Out] = {}
        self.free = free_disk
        #: P4-11: the seed-index store and the chunk strategy's run journal.
        self.chunk_indexes = MemoryChunkIndexStore()
        self.run_journal = MemoryRunJournal()

    def staged_object(self, plan_id: str, sha256: str) -> _Staged:
        return _Staged(self.staging.setdefault(plan_id, {}), sha256)

    def output(self, plan_id: str, layout: str, resume: bool = False) -> PackOutput:
        o = self._outputs.get(plan_id) if resume and layout != "tree" else None
        if o is None:
            o = _Out()
            self._outputs[plan_id] = o
        return PackOutput(sink=o, tree=o, read=o.read)

    def commit(
        self, plan_id: str, pack_id: str, payload_sha256: str, layout: str, index: Optional[Dict[str, Any]]
    ) -> str:
        o = self._outputs.get(plan_id)
        if o is None:
            raise RuntimeError(f"no output for plan {plan_id}")
        location = f"{pack_id}/{payload_sha256}"
        if layout == "tree":
            self.store[location] = {"layout": layout, "tree": dict(o.tree), "index": index}
        else:
            self.store[location] = {"layout": layout, "payload": bytes(o.container), "index": index}
        del self._outputs[plan_id]
        return location

    def installed(self, install: Dict[str, Any]) -> Optional[InstalledPayload]:
        p = self.store.get(install["location"])
        if p is None:
            return None
        if p["layout"] == "tree":
            files = [
                InstalledFile(path, hashlib.sha256(b).hexdigest(), len(b), MemorySource(b))
                for path, b in (p.get("tree") or {}).items()
            ]
            return InstalledPayload(payload=None, files=files)
        whole = MemorySource(p.get("payload") or b"")
        idx = p.get("index")
        files2: Optional[List[InstalledFile]] = None
        if idx is not None:
            files2 = [
                InstalledFile(f["path"], f["sha256"], f["size"], slice_source(whole, f.get("offset", 0), f["size"]))
                for f in idx["files"]
            ]
        return InstalledPayload(payload=whole, files=files2)

    def verify(self, install: Dict[str, Any]) -> bool:
        p = self.store.get(install["location"])
        if p is None:
            return False
        if p["layout"] == "tree":
            files = [
                {"path": path, "size": len(b), "sha256": hashlib.sha256(b).hexdigest()}
                for path, b in (p.get("tree") or {}).items()
            ]
            return tree_digest(files) == install["payloadSha256"]
        return hashlib.sha256(p.get("payload") or b"").hexdigest() == install["payloadSha256"]

    def remove(self, location: str) -> None:
        self.store.pop(location, None)

    def remove_staging(self, plan_id: str) -> None:
        self.staging.pop(plan_id, None)
        self._outputs.pop(plan_id, None)
        self.run_journal.journals.pop(plan_id, None)

    def list(self) -> Tuple[List[str], List[str]]:
        return list(self.store.keys()), list(self.staging.keys())

    def free_disk(self) -> int:
        return self.free


class MemoryPackStateStore:
    """A ``PackStateStore`` over one string, with its quarantine in ``torn`` and the hold's
    snapshot in ``hold_list``."""

    def __init__(self, initial: Optional[str] = None) -> None:
        self.text = initial
        self.torn: Optional[str] = None
        self.hold_list: Optional[str] = None

    def read(self) -> Optional[str]:
        return self.text

    def replace(self, text: str) -> None:
        self.text = text

    def quarantine(self, text: str) -> None:
        if self.torn is None:
            self.torn = text

    def quarantined(self) -> bool:
        return self.torn is not None

    def clear_quarantine(self) -> None:
        self.torn = None
        self.hold_list = None

    def read_hold_list(self) -> Optional[str]:
        return self.hold_list

    def write_hold_list(self, text: str) -> None:
        if self.hold_list is None:
            self.hold_list = text


def memory_pack_storage(free_disk: int = 1 << 30) -> MemoryPackStorage:
    return MemoryPackStorage(free_disk)


def memory_pack_state_store(initial: Optional[str] = None) -> MemoryPackStateStore:
    return MemoryPackStateStore(initial)
