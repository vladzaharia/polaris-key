"""The core of ``cloud_sync.export()`` (WIRE-CONTRACT-V5 §13.12, ``pkey-sync-export/1``): a readable, unencrypted
zip of what an app synced, made on the device. This module plans the archive, then streams it into a
:class:`ZipSink`; it speaks to no network and no file. The host (``export_host.py``) gives it

* the rows as the Worker served them (after a pull with ``more`` false),
* the host codec in end-to-end mode (``None`` in server mode) and a file-codec factory,
* an :class:`ExportFileSource` that fetches stored bytes and chunk objects (``Range`` resume, the hourly
  allowance, retries and their bounded wait are the source's), and
* a sink.

Everything the Worker served is untrusted. A row that does not open is dropped and listed; a file that does
not check is written as far as it checks and flagged ``partial``; nothing aborts the export but a bound
(``sync-export-too-large``, before the first byte), a source that raises, and a cancel.

Memory: the plan keeps, per row, the ids and sizes it needs (a row is opened again when its line is written),
the settings map, the manifests of the chunked files and the chunk records. A file is read one segment (1 MiB +
16) or one chunk at a time with an incremental SHA-256 and CRC-32; the source's own piece (a ``Range`` of up
to 8 MiB) is the other term of the ~8 MiB peak.

Order: the central directory lists the entries in the order of §13.12 (README, settings, records, files,
files.json, index.json, data.json). The bytes are written in the order the data is known: a record line cites
its file's size and SHA-256, so the files are streamed first. ``zipfile`` reads the central directory, so a
reader sees the §13.12 order.

The zip is written here, not by ``zipfile``: a STORED entry whose size is not known up front needs a data
descriptor, and the central directory has to list entries in a different order from the one they were written
in (``zipfile.ZipFile`` lists them as written). The layout is the one §13.12's overhead formula counts: a
30-byte local header, the data, a 16-byte descriptor and a 46-byte central record per entry, plus the end
record, with no extra field, no comment and no zip64.

Nothing here puts a value, an id or a path in an exception or a log line.
"""

from __future__ import annotations

import hashlib
import re
import struct
import threading
import zlib
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, Optional, Protocol, Sequence, Tuple

from ..constants_generated import (
    MAX_JSON_DEPTH,
    SYNC_EXPORT_FORMAT,
    SYNC_EXPORT_ITEM_RESERVE_BYTES,
    SYNC_EXPORT_MAX_BYTES,
    SYNC_EXPORT_MAX_CHUNKS,
    SYNC_EXPORT_MAX_ENTRIES,
    SYNC_EXPORT_STORE_DIR,
    SYNC_EXPORT_ZIP_END_BYTES,
    SYNC_EXPORT_ZIP_ENTRY_BYTES,
    SYNC_MAX_CHUNKS_PER_FILE,
    ErrorCode,
)
from ..core import sync_files as sf
from ..core.errors import PolarisError
from ..core.sync_crypto import _js_number, _json_string, _utf16_key
from .host_codec import open_pull
from .transfer_codec import SERVER_CHUNK_MAX_STORED_BYTES, FileCodec, ServerFileCodec

__all__ = [
    "SYNC_EXPORT_README",
    "ExportFileRef",
    "ExportFileSource",
    "ExportInput",
    "ZipSink",
    "ZipStoreWriter",
    "export_to_sink",
]

Obj = Dict[str, Any]

# ── input ────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ExportFileRef:
    """Names one stored file: the record's wire id (blinded in end-to-end mode) and a version. ``size`` is
    the pointer's size (already checked: a non-negative safe integer) and ``format`` ``"whole"`` or
    ``"chunks"``; a ``chunks`` ref names the manifest, so the source reads it unranged."""

    collection: str
    record: str
    version: Any
    format: str
    size: int


class ExportFileSource(Protocol):
    """Where a file's stored bytes come from. The host implements it over its transport. A source raises
    what its transport raises (a cancel, a network error after its bounded retries); the export never
    swallows that. A missing object is not a raise: ``stored`` yields nothing and ``chunk`` answers ``None``
    for what the Worker does not have, and the file is then written short and flagged partial."""

    def pointers(self, collection: str, record: str) -> Sequence[Mapping[str, Any]]:
        """Every kept version of a record's file, including the current one, in any order: dicts with
        ``version``, ``size``, ``sha256`` and ``format``, each as served."""
        ...

    def stored(self, ref: ExportFileRef) -> Iterable[bytes]:
        """The stored bytes of a version (a whole file, or the manifest of a chunked one) in pieces. The
        export stops reading (and closes the iterator) once it has what it plans for."""
        ...

    def chunk(self, collection: str, id_hex: str) -> Optional[bytes]:
        """A chunk object by its id (hex), or ``None``."""
        ...


class ZipSink(Protocol):
    """Where the archive goes: ``write`` is called in order. Committing (a rename) and discarding on a
    failure belong to the host, after :func:`export_to_sink` returns or raises."""

    def write(self, data: bytes) -> object: ...


@dataclass
class ExportInput:
    product: str
    #: The device clock, in milliseconds.
    exported_at: int
    #: Edits not yet pushed.
    unsynced: int
    include_revisions: bool
    #: The changes of the pull as served (sealed in end-to-end mode): settings and records.
    changes: Sequence[Any]
    #: The file source.
    files: ExportFileSource
    #: The host codec in end-to-end mode (``open``, ``open_any``, ``blind``, ``locked``); ``None`` is
    #: server mode.
    codec: Optional[Any] = None
    #: A collection's file codec; omitted, :class:`ServerFileCodec` (server mode).
    file_codec: Optional[Callable[[str], FileCodec]] = None
    #: Test and host overrides of the bounds; ``max_bytes`` is the zip32 total of §13.12.
    caps: Optional[Mapping[str, int]] = None
    cancel: Optional[threading.Event] = None
    #: ``(plaintext bytes written, planned plaintext bytes)`` after each piece of a file.
    on_progress: Optional[Callable[[int, int], None]] = None


@dataclass
class ExportSummary:
    #: Bytes sent to the sink.
    bytes: int
    #: The zip32 total the plan counted before the first byte.
    planned_bytes: int
    entries: int
    settings: int
    records: int
    files: int
    skipped: List[Obj] = field(default_factory=list)


# ── fixed text ───────────────────────────────────────────────────────────────────────────────────

SYNC_EXPORT_README = """This is a readable copy of data an app synced with Polaris Locker.

The app made it on this device. It is NOT encrypted: anyone who can open
this file can read everything in it. Keep it where you keep your other
private files, and delete it when you no longer need it. The time it was
made is "exportedAt" in data.json, in milliseconds since 1970-01-01 UTC.

Polaris Locker's own export of this data, from its website, uses the same
layout and holds the data as the app stored it: encrypted when the app
encrypts it.

data.json                              what this holds, and what could not be read
stores/sync.cloudSync/settings.json    the synced settings
stores/sync.cloudSync/records/         the synced records, one file a collection
stores/sync.cloudSync/index.json       which file holds which collection
stores/sync.cloudSync/files/           the synced files
stores/sync.cloudSync/files.json       which file belongs to which record

A file marked "partial" in data.json is incomplete or did not match what
the app stored. Do not rely on it.
"""

# ── the zip writer ───────────────────────────────────────────────────────────────────────────────

_MAX_U32 = 0xFFFF_FFFF
_MAX_ENTRIES = 0xFFFF
#: The fixed DOS time and date (1980-01-01 00:00:00): an archive never says when it was made.
_DOS_TIME = 0
_DOS_DATE = 0x0021
#: Bit 3: sizes and CRC follow the data. Bit 11: names are UTF-8.
_FLAGS = 0x0808
_VERSION = 20


def _too_large(what: str) -> PolarisError:
    return PolarisError(ErrorCode.SYNC_EXPORT_TOO_LARGE, "The export is too large: " + what)


def _cancelled() -> PolarisError:
    return PolarisError(ErrorCode.CANCELLED, "The export was cancelled")


def _check_cancel(cancel: Optional[threading.Event]) -> None:
    if cancel is not None and cancel.is_set():
        raise _cancelled()


class ZipStoreWriter:
    """A streaming STORED zip32 writer. Every entry is written as it arrives, with a data descriptor after
    its data, so memory is one piece of the caller's data and the central directory's records. A write that
    would take the archive past zip32 (4 GiB - 1 for data, descriptors, central directory and end record
    together, or 65,535 entries) raises ``sync-export-too-large`` before it reaches the sink."""

    def __init__(self, sink: ZipSink, limit: int = _MAX_U32) -> None:
        self._sink = sink
        self._limit = limit
        self._offset = 0
        self._done: List[Tuple[str, bytes, int, int, int]] = []
        self._names: "set[str]" = set()
        self._cur: Optional[List[Any]] = None
        self._finished = False
        # What the archive still needs after the data written so far: the central records of the entries
        # done, the open entry's descriptor and central record, and the end record.
        self._reserve = SYNC_EXPORT_ZIP_END_BYTES

    @property
    def bytes_written(self) -> int:
        return self._offset

    def _emit(self, b: bytes) -> None:
        self._offset += len(b)
        self._sink.write(b)

    def begin(self, name: str) -> None:
        if self._finished or self._cur is not None:
            raise RuntimeError("zip: an entry is open or the archive is finished")
        raw = name.encode("utf-8")
        if not raw or len(raw) > 0xFFFF:
            raise ValueError("zip: entry name length")
        if name in self._names:
            raise ValueError("zip: entry name repeats")
        if len(self._done) + 1 > _MAX_ENTRIES:
            raise _too_large("too many entries")
        need = 30 + len(raw) + (SYNC_EXPORT_ZIP_ENTRY_BYTES - 30) + len(raw)
        if self._offset + need + self._reserve > self._limit:
            raise _too_large("over the size limit")
        header = struct.pack(
            "<IHHHHHIIIHH", 0x04034B50, _VERSION, _FLAGS, 0, _DOS_TIME, _DOS_DATE, 0, 0, 0, len(raw), 0
        )
        self._reserve += 16 + 46 + len(raw)
        self._names.add(name)
        self._cur = [name, raw, self._offset, 0, 0]  # name, raw, offset, crc, size
        self._emit(header + raw)

    def write(self, data: bytes) -> None:
        c = self._cur
        if c is None:
            raise RuntimeError("zip: no entry is open")
        if not data:
            return
        if self._offset + len(data) + self._reserve > self._limit:
            raise _too_large("over the size limit")
        c[3] = zlib.crc32(data, c[3])
        c[4] += len(data)
        self._emit(data)

    def end(self) -> None:
        c = self._cur
        if c is None:
            raise RuntimeError("zip: no entry is open")
        name, raw, offset, crc, size = c
        # The descriptor's 16 bytes were reserved at ``begin``.
        self._reserve -= 16
        self._cur = None
        self._done.append((name, raw, offset, crc, size))
        self._emit(struct.pack("<IIII", 0x08074B50, crc, size, size))

    def add_bytes(self, name: str, data: bytes) -> None:
        self.begin(name)
        self.write(data)
        self.end()

    def finish(self, order: Optional[Sequence[str]] = None) -> int:
        """Writes the central directory (``order`` names every entry once; omitted, as written) and the end
        record. Returns the archive's size."""
        if self._finished or self._cur is not None:
            raise RuntimeError("zip: an entry is open or the archive is finished")
        by_name = {d[0]: d for d in self._done}
        names = [d[0] for d in self._done] if order is None else list(order)
        if len(names) != len(self._done) or len(set(names)) != len(names) or any(n not in by_name for n in names):
            raise ValueError("zip: the order does not name every entry once")
        listing = [by_name[n] for n in names]
        self._finished = True
        cd_offset = self._offset
        cd_size = 0
        for d in listing:
            _name, raw, offset, crc, size = d
            rec = struct.pack(
                "<IHHHHHHIIIHHHHHII",
                0x02014B50,
                _VERSION,
                _VERSION,
                _FLAGS,
                0,
                _DOS_TIME,
                _DOS_DATE,
                crc,
                size,
                size,
                len(raw),
                0,
                0,
                0,
                0,
                0,
                offset,
            )
            cd_size += len(rec) + len(raw)
            self._emit(rec + raw)
        end = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(listing), len(listing), cd_size, cd_offset, 0)
        self._emit(end)
        return self._offset


# ── helpers ──────────────────────────────────────────────────────────────────────────────────────

_HEX64 = re.compile(r"[0-9a-f]{64}")
_MAX_SAFE = 2**53 - 1


def _bytes(s: str) -> bytes:
    """UTF-8 as a JavaScript text encoder writes it: a lone surrogate is U+FFFD."""
    try:
        return s.encode("utf-8")
    except UnicodeEncodeError:
        return s.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace").encode("utf-8")


def _bytes_of(s: str) -> int:
    return len(_bytes(s))


def _is_obj(v: Any) -> bool:
    return isinstance(v, dict)


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _size_of(n: Any) -> Optional[int]:
    """A pointer's size when it is a non-negative safe integer (a JSON number), else ``None``."""
    if isinstance(n, bool) or not isinstance(n, (int, float)):
        return None
    if isinstance(n, float):
        if n != n or n in (float("inf"), float("-inf")) or not n.is_integer():
            return None
        n = int(n)
    return n if 0 <= n <= _MAX_SAFE else None


def _is_hex64(s: Any) -> bool:
    return isinstance(s, str) and _HEX64.fullmatch(s) is not None


class _Unserialisable(Exception):
    pass


def _canon(v: Any, max_depth: int) -> str:
    """Canonical JSON (§13.10.3) with the refusals the export meets: a number that is not finite (or an
    integer no JavaScript number holds), a string or key with a lone surrogate, and a nesting deeper than
    ``max_depth`` (0: no limit), counted from the outermost array or object as level 1. Keys sort by UTF-16
    code unit."""

    def emit(x: Any, level: int) -> str:
        if x is None:
            return "null"
        if isinstance(x, bool):
            return "true" if x else "false"
        if isinstance(x, int):
            if abs(x) > 2**53:
                raise _Unserialisable("integer")
            return str(x)
        if isinstance(x, float):
            if x != x or x in (float("inf"), float("-inf")):
                raise _Unserialisable("not finite")
            return _js_number(x)
        if isinstance(x, str):
            try:
                return _json_string(x)
            except ValueError:
                raise _Unserialisable("lone surrogate") from None
        if max_depth > 0 and level >= max_depth:
            raise _Unserialisable("depth")
        if isinstance(x, (list, tuple)):
            return "[" + ",".join(emit(i, level + 1) for i in x) + "]"
        if isinstance(x, dict):
            keys = sorted(x.keys(), key=_utf16_key)
            parts = []
            for k in keys:
                try:
                    key = _json_string(k)
                except (ValueError, AttributeError):
                    raise _Unserialisable("key") from None
                parts.append(key + ":" + emit(x[k], level + 1))
            return "{" + ",".join(parts) + "}"
        raise _Unserialisable("type")

    return emit(v, 0)


def _line_of(v: Any) -> str:
    return _canon(v, 0) + "\n"


def _serialisable(v: Any) -> bool:
    try:
        _canon(v, MAX_JSON_DEPTH)
        return True
    except (_Unserialisable, RecursionError):
        return False


# ── opening rows ─────────────────────────────────────────────────────────────────────────────────


@dataclass
class _Binding:
    sha256: str
    size: int
    format: str


@dataclass
class _Opened:
    id: str
    version: Any
    has_value: bool
    value: Any
    binding: Optional[_Binding]


def _pointer_of(c: Mapping[str, Any]) -> Optional[Obj]:
    f = c.get("file")
    if isinstance(f, dict) and _is_number(f.get("version")):
        return f
    return None


def _named_by(b: _Binding, f: Mapping[str, Any]) -> bool:
    """Whether the sealed ``$file`` binding names this pointer's file."""
    size = f.get("size")
    return (
        f.get("sha256") == b.sha256
        and _is_number(size)
        and size == b.size
        and f.get("format") == b.format
    )


def _binding_of(raw: Any) -> Optional[_Binding]:
    """The ``$file`` binding of a sealed value, or ``None`` when it names no file a reader can use."""
    if not _is_obj(raw):
        return None
    sha, size, fmt = raw.get("sha256"), _size_of(raw.get("size")), raw.get("format")
    if not _is_hex64(sha) or size is None or size == 0:
        return None
    if fmt not in ("whole", "chunks"):
        return None
    return _Binding(sha, size, fmt)


_FILE_ONLY = "file-only"
_OMIT = "omit"
_INVALID = "invalid"


class _Opener:
    def __init__(self, codec: Optional[Any]) -> None:
        self._codec = codec

    def _via_pull(self, c: Obj) -> Optional[Obj]:
        """An opened change as the host codec opens a pull, or ``None`` when it does not open."""
        body, opened = open_pull({"changes": [c]}, self._codec)
        rows = opened.get("changes") or []
        row = rows[0] if rows else None
        if not isinstance(row, dict) or row.get("sealed") is not True:
            return None
        e = body["changes"][0]
        return e if isinstance(e, dict) else None

    def setting(self, c: Obj) -> Optional[Tuple[str, Any]]:
        wire = c["setting"]
        if self._codec is None:
            members = c.get("members")
            if _is_obj(members):
                return wire, members
            return (wire, c["value"]) if "value" in c else None
        if "ct" not in c and not isinstance(c.get("members"), list):
            return None
        e = self._via_pull(c)
        if e is None or not isinstance(e.get("setting"), str) or "value" not in e:
            return None
        return e["setting"], e["value"]

    def record(self, collection: str, wire: str, c: Obj) -> Any:
        """An :class:`_Opened`, or one of ``"omit"``, ``"invalid"``, ``"file-only"``."""
        pointer = _pointer_of(c)
        if self._codec is None:
            return _Opened(wire, c.get("version"), "value" in c, c.get("value"), None)
        for shape in ("fields", "elements"):
            cells = c.get(shape)
            if isinstance(cells, list) and len(cells) == 0:
                return _OMIT
        sealed_shape = (
            isinstance(c.get("fields"), list) or isinstance(c.get("elements"), list) or isinstance(c.get("ct"), str)
        )
        if not sealed_shape:
            # A file and no value: nothing names the id, nothing binds the file.
            return _FILE_ONLY if "ct" not in c and pointer is not None else _INVALID
        e = self._via_pull(c)
        rec = e.get("record") if e is not None else None
        if e is None or not isinstance(rec, list) or len(rec) < 2:
            return _INVALID
        if rec[0] != collection or not isinstance(rec[1], str):
            return _INVALID
        if "value" not in e:
            return _INVALID
        value = e["value"]
        binding: Optional[_Binding] = None
        if isinstance(c.get("ct"), str) and _is_obj(value) and "$file" in value:
            raw = value["$file"]
            value = {k: v for k, v in value.items() if k != "$file"}
            binding = _binding_of(raw)
        return _Opened(rec[1], c.get("version"), True, value, binding)


# ── the plan ─────────────────────────────────────────────────────────────────────────────────────


@dataclass
class _Row:
    collection: str
    #: The wire id, which keys the row's files.
    wire: str
    id: str
    #: The change as served: the row is opened again when its line is written.
    change: Obj
    pointer: Optional[Obj]
    binding: Optional[_Binding]
    #: Bytes of the line without its ``file`` member.
    line_bytes: int


@dataclass
class _Manifest:
    records: List[sf.ManifestRecord]
    plain_sha256: bytes


@dataclass
class _Planned:
    row: _Row
    ref: ExportFileRef
    file: Obj
    live: bool
    planned: int
    manifest: Optional[_Manifest] = None


def _read_bounded(
    src: Iterable[bytes], limit: int, cancel: Optional[threading.Event]
) -> Tuple[bytes, bool]:
    """Reads a source's pieces up to ``limit`` bytes in all; ``over`` is true when it had more."""
    parts: List[bytes] = []
    n = 0
    it = iter(src)
    try:
        for piece in it:
            _check_cancel(cancel)
            if n + len(piece) > limit:
                return b"".join(parts), True
            parts.append(piece)
            n += len(piece)
    finally:
        _close(it)
    return b"".join(parts), False


def _close(it: Any) -> None:
    close = getattr(it, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 - the source is done with either way
            pass


def _entry_names(records: int, files: int) -> List[str]:
    d = SYNC_EXPORT_STORE_DIR
    return [
        "README.txt",
        d + "settings.json",
        *[f"{d}records/{i}.ndjson" for i in range(records)],
        *[f"{d}files/{i}.bin" for i in range(files)],
        d + "files.json",
        d + "index.json",
        "data.json",
    ]


def _line_text(r: _Opened, file: Optional[Obj], id: Optional[str] = None) -> str:
    o: Obj = {"id": r.id if id is None else id, "version": r.version}
    if r.has_value:
        o["value"] = r.value
    if file is not None:
        o["file"] = file
    return _line_of(o)


def _writable(r: _Opened) -> bool:
    return _serialisable(r.id) and _serialisable(r.version) and _serialisable(r.value if r.has_value else None)


def _by_bytes(s: str) -> bytes:
    return _bytes(s)


def export_to_sink(inp: ExportInput, sink: ZipSink) -> ExportSummary:
    """Plans the archive, refusing with ``sync-export-too-large`` before the first byte, then writes it to
    ``sink``. The caller commits (or discards) the sink's destination once this returns or raises."""
    e2e = inp.codec is not None
    opener = _Opener(inp.codec)
    encryption = "e2e" if e2e else "server"
    d = SYNC_EXPORT_STORE_DIR
    max_entries = (inp.caps or {}).get("maxEntries", SYNC_EXPORT_MAX_ENTRIES)
    max_bytes = (inp.caps or {}).get("maxBytes", SYNC_EXPORT_MAX_BYTES)
    reserve = SYNC_EXPORT_ITEM_RESERVE_BYTES
    setting_skips: List[Obj] = []
    record_skips: List[Obj] = []
    file_skips: List[Obj] = []
    partial_skips: List[Obj] = []
    cancel = inp.cancel
    codecs: Dict[str, FileCodec] = {}

    def codec_for(collection: str) -> FileCodec:
        c = codecs.get(collection)
        if c is None:
            c = inp.file_codec(collection) if inp.file_codec is not None else ServerFileCodec()
            codecs[collection] = c
        return c

    changes = [c for c in inp.changes if _is_obj(c)]

    # Settings, in the byte order of the name the Worker served.
    setting_changes = sorted(
        (c for c in changes if isinstance(c.get("setting"), str)), key=lambda c: _by_bytes(c["setting"])
    )
    settings: Obj = {}
    setting_count = 0
    for c in setting_changes:
        _check_cancel(cancel)
        got = opener.setting(c)
        if got is None or not _serialisable(got[0]) or not _serialisable(got[1]):
            setting_skips.append({"kind": "setting", "code": "invalid"})
        else:
            settings[got[0]] = got[1]
            setting_count += 1
    settings_line = _line_of(settings).encode("utf-8")

    # Records, a collection at a time, rows in the byte order of the wire id.
    def ref_of(c: Obj) -> Optional[Tuple[str, str]]:
        r = c.get("record")
        if isinstance(r, list) and len(r) >= 2 and isinstance(r[0], str) and isinstance(r[1], str):
            return r[0], r[1]
        return None

    record_changes = [c for c in changes if ref_of(c) is not None]
    collections = sorted({ref_of(c)[0] for c in record_changes}, key=_by_bytes)  # type: ignore[index]
    written: List[Tuple[str, List[_Row]]] = []
    file_only: Dict[str, List[Obj]] = {}
    for collection in collections:
        rows: List[_Row] = []
        mine = sorted((c for c in record_changes if ref_of(c)[0] == collection), key=lambda c: _by_bytes(ref_of(c)[1]))  # type: ignore[index]
        for c in mine:
            _check_cancel(cancel)
            wire = ref_of(c)[1]  # type: ignore[index]
            r = opener.record(collection, wire, c)
            if r == _OMIT:
                continue
            if r == _FILE_ONLY:
                file_only.setdefault(collection, []).append(c)
                continue
            if r == _INVALID or not _writable(r):
                record_skips.append({"kind": "record", "code": "invalid", "collection": collection})
                continue
            rows.append(
                _Row(
                    collection=collection,
                    wire=wire,
                    id=r.id,
                    change=c,
                    pointer=_pointer_of(c),
                    binding=r.binding,
                    line_bytes=_bytes_of(_line_text(r, None)),
                )
            )
        rows.sort(key=lambda row: _by_bytes(row.id))
        if rows:
            written.append((collection, rows))

    # The manifests of every chunked file are fetched and checked before anything else is read.
    chunk_total = 0
    #: The collection of every file pointer the machine holds that the plan met.
    pointer_collections: List[str] = []

    def validate(collection: str, ref: ExportFileRef, f: Obj) -> Optional[Tuple[int, Optional[_Manifest]]]:
        nonlocal chunk_total
        size = _size_of(f.get("size"))
        if size is None or not _is_hex64(f.get("sha256")):
            return None
        codec = codec_for(collection)
        fmt = f.get("format")
        if fmt == "whole":
            if not e2e:
                return size, None
            plain = codec.plain_size(size)
            return (None if plain is None else (plain, None))
        if fmt != "chunks":
            return None
        manifest_max = codec.stored_size(sf.MANIFEST_HEADER_BYTES + sf.MANIFEST_RECORD_BYTES * SYNC_MAX_CHUNKS_PER_FILE)
        got, over = _read_bounded(inp.files.stored(ref), manifest_max, cancel)
        if over:
            return None
        if hashlib.sha256(got).hexdigest() != f.get("sha256"):
            return None
        opened = codec.open_manifest(got)
        if not opened.ok:
            return None
        m = sf.parse_manifest(opened.plain)
        if not m.ok or m.manifest is None:
            return None
        if codec.stored_size(m.manifest.plain_size) != size:
            return None
        chunk_total += len(m.manifest.records)
        return m.manifest.plain_size, _Manifest(m.manifest.records, m.manifest.plain_sha256)

    # The plan: every file entry, live first and then the revisions, newest first.
    planned: List[_Planned] = []
    for collection in collections:

        def no_entry(collection: str = collection) -> None:
            pointer_collections.append(collection)
            file_skips.append({"kind": "file", "collection": collection, "code": "sync-file-invalid"})

        for _ in file_only.get(collection, []):
            no_entry()
        rows = next((w[1] for w in written if w[0] == collection), [])
        for row in rows:
            if row.pointer is None:
                continue
            _check_cancel(cancel)
            if e2e and row.binding is None:
                # A file the sealed value does not name is no readable file there (§13.10.4).
                no_entry()
                row.pointer = None
                continue
            current = row.pointer
            others: List[Obj] = [
                dict(f)
                for f in inp.files.pointers(collection, row.wire)
                if _is_obj(f) and _is_number(f.get("version")) and f.get("version") != current.get("version")
            ]
            older = sorted(others, key=lambda f: -f["version"])
            candidates: List[Obj] = [current, *older]
            pointer_collections.extend(collection for _ in candidates)
            binding = row.binding
            live: Optional[Obj] = None
            for f in candidates:
                if (f is current) if binding is None else _named_by(binding, f):
                    live = f
                    break

            def mark(f: Obj, is_live: bool, row: _Row = row, collection: str = collection) -> None:
                size = _size_of(f.get("size"))
                fmt = "chunks" if f.get("format") == "chunks" else "whole"
                ref = ExportFileRef(collection, row.wire, f.get("version"), fmt, size if size is not None else 0)
                v = None if chunk_total > SYNC_EXPORT_MAX_CHUNKS else validate(collection, ref, f)
                if v is None:
                    file_skips.append({"kind": "file", "collection": collection, "code": "sync-file-invalid"})
                    if is_live:
                        row.pointer = None
                    return
                planned.append(_Planned(row, ref, f, is_live, v[0], v[1]))

            # No candidate is the live file: the row has no readable file.
            if live is None:
                row.pointer = None
                file_skips.append({"kind": "file", "collection": collection, "code": "sync-file-invalid"})
                continue
            mark(live, True)
            if inp.include_revisions:
                for f in candidates:
                    if f is not live:
                        mark(f, False)

    # The bounds, all before the first byte.
    entry_count = 5 + len(written) + len(planned)
    if entry_count > max_entries:
        raise _too_large("too many entries")
    if chunk_total > SYNC_EXPORT_MAX_CHUNKS:
        raise _too_large("too many chunks")
    file_bytes = 0
    for p in planned:
        file_bytes += p.planned  # each term and the sum stay safe integers: stop at the cap
        if file_bytes > max_bytes:
            raise _too_large("files over the limit")

    live_rows = {id(p.row) for p in planned if p.live}

    def index_text(listing: Sequence[Tuple[str, List[_Row]]]) -> str:
        return _line_of(
            {
                "records": [
                    {"entry": f"{d}records/{i}.ndjson", "collection": c, "count": len(r)}
                    for i, (c, r) in enumerate(listing)
                ]
            }
        )

    known = _bytes_of(SYNC_EXPORT_README) + len(settings_line)
    known += _bytes_of(index_text(written))
    for _c, rows in written:
        for r in rows:
            known += r.line_bytes + (reserve if id(r) in live_rows else 0)
    # files.json and data.json depend on what the reads find: they count at their bound.
    known += 2 + len(planned)
    for p in planned:
        known += reserve + 6 * (_bytes_of(p.row.collection) + _bytes_of(p.row.id))
    known += reserve
    known += reserve * len(setting_changes)
    for c in record_changes:
        known += reserve + 6 * _bytes_of(ref_of(c)[0])  # type: ignore[index]
    for pc in pointer_collections:
        known += reserve + 6 * _bytes_of(pc)

    names = _entry_names(len(written), len(planned))
    overhead = sum(SYNC_EXPORT_ZIP_ENTRY_BYTES + 2 * _bytes_of(n) for n in names) + SYNC_EXPORT_ZIP_END_BYTES
    planned_bytes = file_bytes + known + overhead
    if planned_bytes > max_bytes:
        raise _too_large("over the size limit")

    # ── write ────────────────────────────────────────────────────────────────────────────────

    zip_ = ZipStoreWriter(sink)
    zip_.add_bytes("README.txt", SYNC_EXPORT_README.encode("utf-8"))
    zip_.add_bytes(d + "settings.json", settings_line)

    # The files, read one at a time, in plan order, at most the planned size each.
    file_index: List[Obj] = []
    line_file: Dict[int, Obj] = {}
    written_plain = 0

    def progress(n: int) -> None:
        nonlocal written_plain
        written_plain += n
        if inp.on_progress is not None:
            inp.on_progress(written_plain, file_bytes)

    for n, p in enumerate(planned):
        _check_cancel(cancel)
        entry = f"{d}files/{n}.bin"
        zip_.begin(entry)
        size, sha, partial = _read_file(p, zip_, inp.files, codec_for(p.row.collection), e2e, cancel, progress)
        zip_.end()
        if partial:
            partial_skips.append(
                {
                    "kind": "file",
                    "collection": p.row.collection,
                    "entry": entry,
                    "code": "sync-file-invalid",
                    "partial": True,
                }
            )
        # What the archive holds of this file, as the record's ``file`` member and as a files.json item.
        facts: Obj = {"entry": entry, "version": p.file.get("version"), "size": size, "sha256": sha}
        if partial:
            facts["partial"] = True
            facts["expectedSize"] = p.planned
        item: Obj = {**facts, "collection": p.row.collection, "id": p.row.id, "live": p.live}
        if e2e and not p.live:
            item["bound"] = False
        file_index.append(item)
        if p.live:
            line_file[id(p.row)] = facts

    # The record files, a line at a time: each row is opened again for its line.
    index_records: List[Obj] = []
    record_count = 0
    for i, (collection, rows) in enumerate(written):
        name = f"{d}records/{i}.ndjson"
        zip_.begin(name)
        for r in rows:
            _check_cancel(cancel)
            again = opener.record(collection, r.wire, r.change)
            if not isinstance(again, _Opened):
                raise PolarisError(ErrorCode.SYNC_EXPORT_FAILED, "A record changed while it was exported")
            zip_.write(_line_text(again, line_file.get(id(r)), r.id).encode("utf-8"))
            record_count += 1
        zip_.end()
        index_records.append({"entry": name, "collection": collection, "count": len(rows)})

    zip_.add_bytes(d + "files.json", _line_of(file_index).encode("utf-8"))
    zip_.add_bytes(d + "index.json", _line_of({"records": index_records}).encode("utf-8"))
    skipped = [*setting_skips, *record_skips, *file_skips, *partial_skips]
    data = {
        "schema": SYNC_EXPORT_FORMAT,
        "source": "device",
        "product": inp.product,
        "exportedAt": inp.exported_at,
        "encryption": encryption,
        "counts": {"settings": setting_count, "records": record_count, "files": len(planned)},
        "unsynced": inp.unsynced,
        "skipped": skipped,
    }
    zip_.add_bytes("data.json", _line_of(data).encode("utf-8"))
    total = zip_.finish(names)
    if total > planned_bytes:
        raise RuntimeError("the export plan undercounted the archive")
    return ExportSummary(
        bytes=total,
        planned_bytes=planned_bytes,
        entries=len(names),
        settings=setting_count,
        records=record_count,
        files=len(planned),
        skipped=[dict(s) for s in skipped],
    )


# ── reading one file ─────────────────────────────────────────────────────────────────────────────

#: A sink write is at most one segment: 1 MiB of plaintext.
_PIECE = 1_048_576


class _Limited:
    """A source that yields at most ``limit`` bytes in all, hashing what it yields."""

    def __init__(self, src: Iterable[bytes], limit: int, cancel: Optional[threading.Event]) -> None:
        self._it = iter(src)
        self._limit = limit
        self._cancel = cancel
        self.total = 0
        self.hash = hashlib.sha256()

    def pieces(self) -> Iterator[bytes]:
        while self.total < self._limit:
            _check_cancel(self._cancel)
            try:
                piece = next(self._it)
            except StopIteration:
                return
            room = self._limit - self.total
            if len(piece) > room:
                piece = piece[:room]
            if not piece:
                continue
            self.total += len(piece)
            self.hash.update(piece)
            yield piece

    def close(self) -> None:
        _close(self._it)


def _read_file(
    p: _Planned,
    zip_: ZipStoreWriter,
    files: ExportFileSource,
    codec: FileCodec,
    e2e: bool,
    cancel: Optional[threading.Event],
    progress: Callable[[int], None],
) -> Tuple[int, str, bool]:
    """Streams one planned file into the open entry; ``(bytes written, their SHA-256, partial)``."""
    written = hashlib.sha256()
    size = 0
    partial = False

    def put(b: bytes) -> None:
        nonlocal size
        if size + len(b) > p.planned:
            raise RuntimeError("read past the plan")
        written.update(b)
        size += len(b)
        zip_.write(b)
        progress(len(b))

    if p.file.get("format") == "chunks":
        m = p.manifest
        assert m is not None
        total = hashlib.sha256()
        for rec in m.records:
            _check_cancel(cancel)
            obj = files.chunk(p.row.collection, rec.id.hex())
            if obj is None or len(obj) > SERVER_CHUNK_MAX_STORED_BYTES:
                partial = True
                break
            o = codec.open_chunk(rec.id, obj)
            if not o.ok or len(o.plain) != rec.plain_len:
                partial = True
                break
            total.update(o.plain)
            put(o.plain)
        if not partial and total.digest() != m.plain_sha256:
            partial = True
        return size, written.hexdigest(), partial

    stored = int(_size_of(p.file.get("size")) or 0)
    src = _Limited(files.stored(p.ref), stored, cancel)
    try:
        if not e2e:
            # Server mode: the stored bytes are the plaintext.
            for piece in src.pieces():
                for at in range(0, len(piece), _PIECE):
                    put(piece[at : at + _PIECE])
            partial = src.total != stored or src.hash.hexdigest() != p.file.get("sha256")
            return size, written.hexdigest(), partial
        # End-to-end: a segment at a time, each authenticated, the last known from the plan.
        try:
            for plain in codec.open_planned(src.pieces(), p.planned):
                put(plain)
        except sf.FileStreamError:
            partial = True
        if not partial:
            partial = src.total != stored or src.hash.hexdigest() != p.file.get("sha256")
        return size, written.hexdigest(), partial
    finally:
        src.close()
