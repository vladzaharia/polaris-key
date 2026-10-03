"""The v3 pack-type handlers (CONTENT §4.1, §4.2; P4-16; a port of client-core's
``packs/handlers``): ``data.json`` and ``l10n.table`` (built in) and ``ml.model`` (the host
registers a configured one). Each handler's ``check`` runs over a newly staged payload after the
engine's own verification and before it commits (a refusal is ``pack-type-check-failed`` with
``detail`` and ``path``); ``activate`` re-reads the installed payload (``reads_payload``).

Every byte is parsed, never evaluated, and judged by content, never by name: every file of a
``data.json`` or ``l10n.table`` payload is parsed whatever its extension. Paths are looked up
exactly as the files index names them (the engine's path rules already refused anything not
normalised); a descriptor's ``file`` must be exactly an index path.

A ``formatVersion`` the handler does not list stays ``pack-type-unsupported`` (``supports``).
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from .engine import InstalledPayload, PackHandler, PackPayload, StagedPack
from .l10n import L10nTable, bcp47_canonical, parse_l10n_table, strict_json_value
from .ports import InstalledFile, read_all

__all__ = [
    "DEFAULT_MAX_FILE_BYTES",
    "MAX_DESCRIPTOR_BYTES",
    "DataJsonHandler",
    "L10nTableHandler",
    "MlModel",
    "MlModelCandidate",
    "MlModelHandler",
]

#: The largest file a ``data.json`` or ``l10n.table`` handler parses by default: 16 MiB.
DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
#: The largest ``model.json`` (or ``bank.json``) a handler reads.
MAX_DESCRIPTOR_BYTES = 65536
_TOKEN = re.compile(r"[a-z][a-z0-9-]{0,31}")
_MAX_WIRE_INTEGER = 2**53 - 1


def _refusal(detail: str, path: Optional[str], message: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {"detail": detail, "message": message}
    if path is not None:
        out["path"] = path
    return out


def _sorted_files(files: Optional[Sequence[InstalledFile]]) -> List[InstalledFile]:
    return sorted(files or [], key=lambda f: f.path.encode("utf-8"))


def _ascii_lower(s: str) -> str:
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def _files_of(payload: Optional[PackPayload]) -> List[InstalledFile]:
    p: Optional[InstalledPayload] = payload.read() if payload is not None else None
    return _sorted_files(p.files if p is not None else None)


# ── data.json ───────────────────────────────────────────────────────────────────────────────


class DataJsonHandler(PackHandler):
    """``data.json`` (CONTENT §4.2): strict-JSON documents (balance tables, event definitions),
    hot. Each file is one JSON object (V4 §1.2's strict parser reads objects only). ``documents(pack_id)`` is the active release's ``{path: value}`` in index order. Tiny,
    frequently tuned values belong in managed config, not a pack."""

    reads_payload = True

    def __init__(
        self,
        *,
        format_versions: Sequence[int] = (1,),
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
        on_activate: Optional[Callable[[str, Dict[str, Any]], None]] = None,
        on_deactivate: Optional[Callable[[str], None]] = None,
    ) -> None:
        versions = list(format_versions)
        super().__init__(type="data.json", layout="tree", activation="hot", supports=lambda fv: fv in versions)
        self.format_versions = versions
        self.max_file_bytes = max_file_bytes
        self._on_activate = on_activate
        self._on_deactivate = on_deactivate
        self._documents: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self.activate = self._activate  # type: ignore[assignment]
        self.deactivate = self._deactivate  # type: ignore[assignment]
        self.check = self._check  # type: ignore[assignment]

    def _check(self, staged: StagedPack) -> Optional[Dict[str, Any]]:
        for f in _sorted_files(staged.files):
            if f.size > self.max_file_bytes:
                return _refusal("size", f.path, f"{f.path} is above {self.max_file_bytes} bytes.")
            ok, value = strict_json_value(read_all(f.source))
            if not ok or not isinstance(value, dict):
                return _refusal("json", f.path, f"{f.path} is not a strict JSON object.")
        return None

    def _activate(self, install: Dict[str, Any], payload: Optional[PackPayload] = None) -> None:
        docs: Dict[str, Any] = {}
        for f in _files_of(payload):
            ok, value = strict_json_value(read_all(f.source))
            if not ok or not isinstance(value, dict):
                raise ValueError(f"{install['packId']}: {f.path} is no longer a strict JSON object.")
            docs[f.path] = value
        with self._lock:
            self._documents[install["packId"]] = docs
        if self._on_activate is not None:
            self._on_activate(install["packId"], docs)

    def _deactivate(self, install: Dict[str, Any]) -> None:
        with self._lock:
            self._documents.pop(install["packId"], None)
        if self._on_deactivate is not None:
            self._on_deactivate(install["packId"])

    def documents(self, pack_id: str) -> Optional[Dict[str, Any]]:
        """The active release's documents by path, or ``None``."""
        with self._lock:
            d = self._documents.get(pack_id)
            return dict(d) if d is not None else None


# ── l10n.table ──────────────────────────────────────────────────────────────────────────────


def check_l10n_files(
    files: Optional[Sequence[InstalledFile]], variant: Mapping[str, Any], max_file_bytes: int
) -> Any:
    """The ``l10n.table`` check over a payload's files: the tables (canonical locales), or a
    refusal dict. Shared by the handler's ``check`` and ``activate``."""
    axes = variant.get("variant") if isinstance(variant.get("variant"), dict) else {}
    want = axes.get("locale") if isinstance(axes, dict) else None
    tables: List[L10nTable] = []
    for f in _sorted_files(files):
        if f.size > max_file_bytes:
            return _refusal("size", f.path, f"{f.path} is above {max_file_bytes} bytes.")
        parsed = parse_l10n_table(f.path, read_all(f.source))
        if not parsed.ok:
            return _refusal("table", f.path, f"{f.path} is not a PO, CSV or JSON table.")
        for t in parsed.tables:
            canonical = bcp47_canonical(t.locale)
            if canonical is None:
                return _refusal("locale", f.path, f"{f.path} names {t.locale!r}, not a BCP-47 tag.")
            if isinstance(want, str) and _ascii_lower(canonical) != _ascii_lower(want.replace("_", "-")):
                return _refusal("locale", f.path, f"{f.path} is a {canonical} table; the variant is {want}.")
            t.locale = canonical
            tables.append(t)
    return tables


class L10nTableHandler(PackHandler):
    """``l10n.table`` (CONTENT §4.2): PO, CSV or JSON tables read by plain parsers, each locale a
    well-formed BCP-47 tag matching the variant's ``locale``; hot. ``tables(pack_id)`` is the
    active release's tables. A ``.translation`` resource is never loaded."""

    reads_payload = True

    def __init__(
        self,
        *,
        format_versions: Sequence[int] = (1,),
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
        on_activate: Optional[Callable[[str, List[L10nTable]], None]] = None,
        on_deactivate: Optional[Callable[[str, List[L10nTable]], None]] = None,
    ) -> None:
        versions = list(format_versions)
        super().__init__(type="l10n.table", layout="tree", activation="hot", supports=lambda fv: fv in versions)
        self.format_versions = versions
        self.max_file_bytes = max_file_bytes
        self._on_activate = on_activate
        self._on_deactivate = on_deactivate
        self._tables: Dict[str, List[L10nTable]] = {}
        self._lock = threading.Lock()
        self.activate = self._activate  # type: ignore[assignment]
        self.deactivate = self._deactivate  # type: ignore[assignment]
        self.check = self._check  # type: ignore[assignment]

    def _check(self, staged: StagedPack) -> Optional[Dict[str, Any]]:
        r = check_l10n_files(staged.files, staged.variant, self.max_file_bytes)
        return r if isinstance(r, dict) else None

    def _activate(self, install: Dict[str, Any], payload: Optional[PackPayload] = None) -> None:
        p = payload.read() if payload is not None else None
        r = check_l10n_files(p.files if p is not None else None, {"variant": {}}, self.max_file_bytes)
        if not isinstance(r, list):
            raise ValueError(f"{install['packId']}: its tables no longer parse ({r['detail']}).")
        tables: List[L10nTable] = r
        with self._lock:
            self._tables[install["packId"]] = tables
        if self._on_activate is not None:
            self._on_activate(install["packId"], list(tables))

    def _deactivate(self, install: Dict[str, Any]) -> None:
        with self._lock:
            tables = self._tables.pop(install["packId"], [])
        if self._on_deactivate is not None:
            self._on_deactivate(install["packId"], tables)

    def tables(self, pack_id: str) -> Optional[List[L10nTable]]:
        """The active release's tables, or ``None``."""
        with self._lock:
            t = self._tables.get(pack_id)
            return list(t) if t is not None else None


# ── ml.model ────────────────────────────────────────────────────────────────────────────────


@dataclass
class MlModel:
    """The active model of a pack: its ``pack_id``, the install ``location``, the index ``path``
    of the model file and its ``descriptor`` (``model.json``)."""

    pack_id: str
    location: str
    path: str
    descriptor: Dict[str, Any]


@dataclass
class MlModelCandidate:
    """What the host's load test receives."""

    pack_id: str
    location: str
    file: InstalledFile
    descriptor: Dict[str, Any]


def _wire_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= _MAX_WIRE_INTEGER


def _token(v: Any) -> bool:
    return isinstance(v, str) and _TOKEN.fullmatch(v) is not None


def read_model_descriptor(files: Sequence[InstalledFile]) -> Optional[Dict[str, Any]]:
    """``model.json``'s members when it is a valid descriptor naming another index path, else
    ``None``."""
    by_path = {f.path: f for f in files}
    d = by_path.get("model.json")
    if d is None or d.size > MAX_DESCRIPTOR_BYTES:
        return None
    ok, v = strict_json_value(read_all(d.source))
    if not ok or not isinstance(v, dict):
        return None
    if not _token(v.get("runtime")) or not _wire_int(v.get("memBytes")):
        return None
    if "vramBytes" in v and not _wire_int(v["vramBytes"]):
        return None
    if "quantization" in v and not _token(v["quantization"]):
        return None
    f = v.get("file")
    if not isinstance(f, str) or f == "model.json" or f not in by_path:
        return None
    return v


class MlModelHandler(PackHandler):
    """``ml.model`` (CONTENT §4.2): a tree with ``model.json`` (``runtime``, ``file``,
    ``memBytes``, optional ``vramBytes`` and ``quantization``) plus the model file(s). The check
    refuses a runtime the host cannot run, a quantisation it does not list, a model whose RAM or
    VRAM need is above the host's budget, and one its ``load_test`` refuses; only then does the
    path swap (``model(pack_id)``). Not built in: the host registers one with its budget."""

    reads_payload = True

    def __init__(
        self,
        *,
        runtimes: Sequence[str],
        ram_bytes: int,
        vram_bytes: int = 0,
        quantizations: Optional[Sequence[str]] = None,
        load_test: Optional[Callable[[MlModelCandidate], bool]] = None,
        on_activate: Optional[Callable[[MlModel], None]] = None,
        on_deactivate: Optional[Callable[[str], None]] = None,
        format_versions: Sequence[int] = (1,),
    ) -> None:
        if (
            isinstance(runtimes, str)
            or not list(runtimes)
            or not _wire_int(ram_bytes)
            or not _wire_int(vram_bytes)
        ):
            raise TypeError(
                "MlModelHandler needs runtimes (a non-empty list), ram_bytes and vram_bytes "
                "(non-negative integers)."
            )
        versions = list(format_versions)
        super().__init__(type="ml.model", layout="tree", activation="hot", supports=lambda fv: fv in versions)
        self.runtimes = list(runtimes)
        self.ram_bytes = ram_bytes
        self.vram_bytes = vram_bytes
        self.quantizations = list(quantizations) if quantizations is not None else None
        self.load_test = load_test
        self.format_versions = versions
        self._on_activate = on_activate
        self._on_deactivate = on_deactivate
        self._models: Dict[str, MlModel] = {}
        self._lock = threading.Lock()
        self.activate = self._activate  # type: ignore[assignment]
        self.deactivate = self._deactivate  # type: ignore[assignment]
        self.check = self._check  # type: ignore[assignment]

    def _check(self, staged: StagedPack) -> Optional[Dict[str, Any]]:
        files = list(staged.files or [])
        d = read_model_descriptor(files)
        if d is None:
            return _refusal("descriptor", "model.json", "model.json is missing or not a model descriptor.")
        if d["runtime"] not in self.runtimes:
            return _refusal("runtime", "model.json", f"this host cannot run {d['runtime']} models.")
        if self.quantizations is not None and d.get("quantization") not in self.quantizations:
            return _refusal("quantization", "model.json", f"this host does not take {d.get('quantization')!r}.")
        if d["memBytes"] > self.ram_bytes or d.get("vramBytes", 0) > self.vram_bytes:
            return _refusal("memory", "model.json", "the model needs more memory than this host's budget.")
        if self.load_test is not None:
            model_file = next(f for f in files if f.path == d["file"])
            try:
                passed = self.load_test(MlModelCandidate(staged.pack_id, staged.location, model_file, d)) is True
            except Exception:
                passed = False
            if not passed:
                return _refusal("load-test", d["file"], "the host's load test refused the model.")
        return None

    def _activate(self, install: Dict[str, Any], payload: Optional[PackPayload] = None) -> None:
        d = read_model_descriptor(_files_of(payload))
        if d is None:
            raise ValueError(f"{install['packId']}: its model.json no longer reads.")
        model = MlModel(install["packId"], install["location"], d["file"], d)
        with self._lock:
            self._models[install["packId"]] = model
        if self._on_activate is not None:
            self._on_activate(model)

    def _deactivate(self, install: Dict[str, Any]) -> None:
        with self._lock:
            self._models.pop(install["packId"], None)
        if self._on_deactivate is not None:
            self._on_deactivate(install["packId"])

    def model(self, pack_id: str) -> Optional[MlModel]:
        """The active release's model, or ``None``."""
        with self._lock:
            return self._models.get(pack_id)
