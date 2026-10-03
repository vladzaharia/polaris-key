"""The pack pipeline (CONTENT §10; plans/P4-01.md §2.6, §2.9), a port of client-core's
``packs/engine.ts``: preflight, journal, fetch, verify, commit, activate, confirm and resume, over
injected ports. ``client.update.packs`` is this engine with Python's transport, storage, zstd and
SHA-256.

For each pack id ``ensure`` asks for:

 1. the content stamp's pin (a host without a stamp has no packs, §2.8);
 2. the pinned pack record, fetched by hash and verified against the pinned release keys with
    ``pin: {kind: "pack", deliverable, version, seq}`` (V4 §3.5 steps 12–15);
 3. its type (a registered handler for ``type`` and ``formatVersion``), its entitlement,
    ``select_variant``;
 4. the target files index when the layout is ``tree`` or a release of the pack is installed;
    ``plan_target`` and ``plan``, with the host's free disk and memory budget;
 5. a journal, then each object fetched with ``Range``/``If-Range`` into staging, resumed from
    what is staged (re-hashed, never trusted), checkpointed;
 6. the applier; on a refusal, the next fallback (``full`` always last);
 7. commit (the payload moves into the store, then the state's pointer swap), activation (``hot``
    now; ``restart`` at the next boot), and garbage collection of what no root holds.

The engine is synchronous; every public call runs under one lock, one at a time (the TypeScript
engine's promise queue).
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from ...constants_generated import MAX_DELEGATIONS_PER_CHECK, MAX_FILES_INDEX_BYTES, ErrorCode
from ...core.errors import PolarisError
from ...core.jws import TrustSet
from ...core.models import ReleasePin
from ...core.pack_claims import variant_key
from ...core.release_record import (
    ReleaseRecordPin,
    VerifiedRevocation,
    delegation_hash_of,
    newer_revocation,
    record_hash,
    record_revoked,
    verify_release_record,
)
from .apply import ApplyPorts, ApplyResult, apply_delta, apply_file, apply_full
from .dataonly import (
    DataOnlyRefusalSeen,
    data_only_file_refusal,
    data_only_path_refusal,
    data_only_tree_sink,
)
from .files import parse_files_index
from .marker import match_embedded, verify_marker
from .plan import plan
from .provides import PackProvider, ProvidesFacts, ProvidesMemo, entitled, memo_key
from .revocations import (
    clear_relearn,
    empty_revocations,
    is_empty_revocations,
    parse_revocations,
    reload_revocations,
    serialize_revocations,
    store_revocation,
)
from .ports import (
    READ_CHUNK,
    ByteSink,
    ByteSource,
    InstalledFile,
    Sha256Port,
    TreeSink,
    ZstdPort,
    hashlib_sha256,
    read_all,
)
from .select import index_readable, plan_target, select_variant
from .sets import pack_set_id
from .state import (
    abandon_install,
    begin_install,
    checkpoint,
    commit_install,
    confirm_boot,
    gc_roots,
    parse_pack_state,
    reload_pack_state,
    rollback_install,
    serialize_pack_state,
)

__all__ = [
    "PackHandler",
    "PackPayload",
    "StagedPack",
    "FILES_TREE_HANDLER",
    "ObjectResponse",
    "StagedObject",
    "InstalledPayload",
    "PackOutput",
    "PackStorage",
    "EmbeddedBaseline",
    "PackProgress",
    "PackError",
    "PacksSnapshot",
    "PackEstimate",
    "RevocationsSnapshot",
    "PackEngine",
]


# ── Ports ────────────────────────────────────────────────────────────────────────────────────


class PackHandler:
    """A pack type's handler (CONTENT §4.1). ``files.tree`` is built in; P4-16 and games add more
    through ``register_handler``. A handler names its ``type``, the ``layout`` of the payloads it
    installs (``tree`` or ``container``), the ``activation`` when the record names none (``hot``
    or ``restart``) and which ``formatVersion`` it ``supports``; ``activate``, ``deactivate``
    and ``check`` are optional hooks.

    ``check(staged)`` (P4-16, CONTENT §4.1 ``verify``) runs over every newly staged payload after
    the engine's own verification (hashes, path rules, the delegated data-only rule) and before
    the state commit and activation, with a :class:`StagedPack`. It returns ``None`` (accepted)
    or a refusal mapping ``{"detail", "path"?, "message"?}``, which aborts the install with
    ``pack-type-check-failed``. It never runs on the ``noop`` reuse path (that payload already
    passed it) nor on an embedded baseline.

    ``activate(install)`` is called with the install alone, so one-argument callables keep
    working; a handler that sets ``reads_payload = True`` is called as
    ``activate(install, payload)`` with a lazy :class:`PackPayload` (``payload.read()`` gives the
    installed :class:`InstalledPayload`, or ``None``)."""

    #: Whether ``activate`` takes the installed payload as a second argument.
    reads_payload = False

    def __init__(
        self,
        type: str,
        layout: str,
        activation: str,
        supports: Callable[[int], bool],
        activate: Optional[Callable[..., None]] = None,
        deactivate: Optional[Callable[[Dict[str, Any]], None]] = None,
        check: Optional[Callable[["StagedPack"], Optional[Mapping[str, Any]]]] = None,
        reads_payload: Optional[bool] = None,
    ) -> None:
        self.type = type
        self.layout = layout
        self.activation = activation
        self.supports = supports
        self.activate = activate
        self.deactivate = deactivate
        self.check = check
        if reads_payload is not None:
            self.reads_payload = reads_payload


#: ``files.tree`` (CONTENT §4.2): a directory tree, hot (versioned directory plus pointer swap),
#: format version 1.
FILES_TREE_HANDLER = PackHandler(
    type="files.tree", layout="tree", activation="hot", supports=lambda fv: fv == 1
)


@dataclass
class ObjectResponse:
    """An object download as the engine reads it: ``status``, ``content_range`` (or ``None``)
    and the body's ``chunks`` (an iterable of ``bytes``; it may raise mid-way)."""

    status: int
    content_range: Optional[str]
    chunks: Iterable[bytes]


#: ``GET`` of one stored object by its SHA-256 from ``offset``; ``if_range`` is the strong ETag
#: (``"<sha256>"``) whenever ``offset > 0``: ``fetch_object(sha256, offset, if_range)``.
ObjectFetch = Callable[[str, int, Optional[str]], ObjectResponse]
#: ``GET`` of one release record by hash: ``{"ok": True, "body"}`` or ``{"ok": False, "code"}``.
RecordFetch = Callable[[str], Dict[str, Any]]


@dataclass
class StagedPack:
    """What a handler's ``check`` reads (P4-16): the pack id, the verified ``record``, the
    selected ``variant``, the staged payload's ``files`` (path, size, sha256 and a byte reader;
    ``None`` for a container without a kept index) and ``payload`` (a container's whole bytes),
    and its store ``location``."""

    pack_id: str
    record: Dict[str, Any]
    variant: Dict[str, Any]
    location: str
    files: Optional[List[InstalledFile]]
    payload: Optional[ByteSource]


class PackPayload:
    """A lazy view of an install's bytes, passed to ``activate`` of a handler that sets
    ``reads_payload``: ``read()`` asks the storage only when called."""

    def __init__(self, read: Callable[[], Optional["InstalledPayload"]]) -> None:
        self._read = read

    def read(self) -> Optional["InstalledPayload"]:
        return self._read()


class StagedObject:
    """One object being staged for a plan (a protocol): ``size()``, ``source()``,
    ``append(data)``, ``reset()``."""

    def size(self) -> int:  # pragma: no cover - protocol
        raise NotImplementedError

    def source(self) -> ByteSource:  # pragma: no cover - protocol
        raise NotImplementedError

    def append(self, data: bytes) -> None:  # pragma: no cover - protocol
        raise NotImplementedError

    def reset(self) -> None:  # pragma: no cover - protocol
        raise NotImplementedError


@dataclass
class InstalledPayload:
    """An install's bytes, for reuse as a delta base or a file seed: a container's whole
    ``payload``, and its ``files`` (from the index kept at install, or an embedded tree's
    listing)."""

    payload: Optional[ByteSource]
    files: Optional[List[InstalledFile]]


@dataclass
class PackOutput:
    """The plan's output area: a byte sink for a container, a tree sink for a tree."""

    sink: Optional[ByteSink] = None
    tree: Optional[TreeSink] = None


class PackStorage:
    """Where a host keeps staging and the store (a protocol; locations and plan ids are opaque
    to the engine): ``staged_object``, ``output``, ``commit``, ``installed``, ``verify``,
    ``remove``, ``remove_staging``, ``list`` (``(locations, plans)``; raises rather than answer a
    partial listing) and ``free_disk``."""


@dataclass
class EmbeddedBaseline:
    """An embedded baseline the host ships: its marker's text, its measured payload
    (``{"kind": "file", "sha256", "size"}`` or ``{"kind": "tree", "treeDigest"}``) and where its
    payload is."""

    marker: Any
    payload: Dict[str, Any]
    location: str


@dataclass
class PackProgress:
    """A progress event. ``state-issue`` is emitted once at ``load`` when the state document
    cannot be trusted (``pack_id`` empty, counts 0, ``issue`` ``torn`` or ``unreadable``)."""

    pack_id: str
    phase: str
    done: int
    total: int
    issue: Optional[str] = None


class PackError(PolarisError):
    """The error the pipeline raises when it cannot proceed. ``code`` is a registered client code
    (``conformance/parity/errors.json``); ``detail`` names a step, ``path`` a file."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        detail: Optional[str] = None,
        path: Optional[str] = None,
        pack_id: Optional[str] = None,
    ) -> None:
        super().__init__(code, message)
        self.detail = detail
        self.path = path
        self.pack_id = pack_id


@dataclass
class PacksSnapshot:
    """What ``state()`` reports. ``running`` is the pack releases activated in this process
    (``pack_set_id`` hashes this set); ``state_issue`` is why this load could not trust the state
    document (``torn``: held aside, GC waits for ``recover_state()``; ``unreadable``: nothing is
    written or installed this process), or ``None``."""

    active: Dict[str, Dict[str, Any]]
    previous: Dict[str, Dict[str, Any]]
    inflight: Dict[str, Dict[str, Any]]
    running: Dict[str, Dict[str, Any]]
    confirmed_boot_seq: int
    boot_seq: int
    state_issue: Optional[str]


@dataclass
class PackEstimate:
    """``estimate``'s answer: the bytes the chosen strategies would download over the packs not
    yet current, those packs, and the packs that cannot be planned with the code ``ensure``
    would raise."""

    bytes: int = 0
    packs: List[str] = field(default_factory=list)
    refused: List[Dict[str, str]] = field(default_factory=list)


@dataclass
class RevocationsSnapshot:
    """What ``revocations()`` reports (plans/P4-13.md §2.5)."""

    #: Revoked target hash → the stored winner (persisted, or this process's only).
    revoked: Dict[str, Dict[str, Any]]
    #: The verified revocation of every revoked target, replacement included.
    verified: Dict[str, VerifiedRevocation]
    #: Packs whose embedded baselines are refused until a fresh feed re-teaches them.
    relearn: List[str]
    #: ``torn`` (quarantined and replaced), ``unreadable`` (nothing is written this process), or
    #: ``None``.
    issue: Optional[str]


#: SHA-256 of the empty string: an empty object is legitimately zero bytes long.
_EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
_RANGE_RE = re.compile(r"bytes (\d+)-\d+/\d+")
#: A check refusal's ``detail`` token; anything else reads as ``check``.
_CHECK_DETAIL_RE = re.compile(r"[a-z][a-z0-9-]{0,31}")


def _range_starts_at(content_range: Optional[str], offset: int) -> bool:
    if content_range is None:
        return False
    m = _RANGE_RE.fullmatch(content_range.strip())
    return m is not None and int(m.group(1)) == offset


def _looks_like_state(text: str) -> bool:
    """Whether stored text is at least a version-1 state document's shape."""
    try:
        d = json.loads(text)
    except Exception:
        return False
    return isinstance(d, dict) and d.get("v") == 1 and not isinstance(d.get("v"), bool)


def _activation_of(record: Mapping[str, Any], handler: Optional[PackHandler]) -> str:
    """A record's activation, else its handler's default."""
    h = record.get("handler")
    a = h.get("activation") if isinstance(h, dict) else None
    if a in ("hot", "restart"):
        return a  # type: ignore[return-value]
    return handler.activation if handler is not None else "restart"


@dataclass
class _Plan:
    body: str
    record_sha256: str
    record: Dict[str, Any]
    variant: Dict[str, Any]
    installs: List[Dict[str, Any]]
    seeds: Dict[str, InstalledPayload]
    plan_id: str
    index: Optional[Dict[str, Any]]
    plan: Dict[str, Any]
    #: The delegation's compact JWS when a content key signed the record (plans/P4-19.md §2.3).
    delegation: Optional[str] = None


# ── The engine ───────────────────────────────────────────────────────────────────────────────


class PackEngine:
    """The pipeline. Construct it with the host's ports, call :meth:`load` once, then
    :meth:`ensure`."""

    def __init__(
        self,
        *,
        product: str,
        release_keys: TrustSet,
        product_trust: Callable[[], TrustSet],
        stamp: Optional[Dict[str, Any]],
        prefs: Mapping[str, Any],
        zstd: ZstdPort,
        storage: Any,
        state: Any,
        fetch_record: RecordFetch,
        fetch_object: ObjectFetch,
        now: Callable[[], int],
        new_plan_id: Callable[[], str],
        patch_methods: Sequence[str] = (),
        mem_budget: int = 256 * 1024 * 1024,
        sha256: Sha256Port = hashlib_sha256,
        strategies: Optional[Sequence[str]] = None,
        transports: Optional[Sequence[str]] = None,
        entitlements: Optional[Callable[[], Optional[Set[str]]]] = None,
        handlers: Sequence[PackHandler] = (),
        checkpoint_bytes: int = 8 << 20,
        one_shot_budget: Optional[int] = None,
        revocations: Any = None,
    ) -> None:
        self._product = product
        self._release_keys = dict(release_keys)
        self._product_trust = product_trust
        self._stamp = stamp
        self._prefs = prefs
        self._zstd = zstd
        self._sha256 = sha256
        self._patch_methods = list(patch_methods)
        self._mem_budget = mem_budget
        self._strategies = list(strategies) if strategies is not None else ["delta", "file", "full"]
        self._transports = list(transports) if transports is not None else ["pkey-cdn"]
        self._storage = storage
        self._state = state
        #: The sibling ``revocations.json`` (plans/P4-13.md §2.5): the same store seam with a
        #: second key, its own atomic replace and quarantine. ``None``: revocations live in
        #: memory for the life of the process only. Never created empty.
        self._revocations = revocations
        self._fetch_record = fetch_record
        self._fetch_object = fetch_object
        self._entitlements = entitlements
        self._now = now
        self._new_plan_id = new_plan_id
        self._checkpoint_bytes = checkpoint_bytes
        self._one_shot_budget = one_shot_budget

        from .handlers import DataJsonHandler, L10nTableHandler

        # files.tree, data.json and l10n.table are built in (P4-16); ml.model needs the host's
        # budget, so the host registers a configured MlModelHandler.
        self._handlers: Dict[str, PackHandler] = {FILES_TREE_HANDLER.type: FILES_TREE_HANDLER}
        for builtin in (DataJsonHandler(), L10nTableHandler()):
            self._handlers[builtin.type] = builtin
        for h in handlers:
            self._handlers[h.type] = h
        self._listeners: List[Callable[[PackProgress], None]] = []
        self._embedded: Dict[str, Dict[str, Any]] = {}
        self._running: Dict[str, Dict[str, Any]] = {}
        #: Locations whose payload could not be read at load: kept out of use and out of GC.
        self._unverifiable: Set[str] = set()
        #: Stored installs whose payload check raised: kept in the written document, out of use.
        self._deferred: Dict[str, Dict[str, Dict[str, Any]]] = {"active": {}, "previous": {}}
        self._state_issue: Optional[str] = None
        #: No garbage collection while a torn document is held or the state is unreadable.
        self._gc_hold = False
        #: While a torn document is held: what existed when the hold started, never collected.
        self._hold_snapshot: Optional[Tuple[Set[str], Set[str]]] = None
        #: Packs whose ``previous`` was carried over from an entry whose check could not run.
        self._unverified_previous: Set[str] = set()
        self._doc: Optional[Dict[str, Any]] = None
        #: Plan ids ``estimate`` staged an index under, reused by the next ``ensure``.
        self._preflight_plans: Dict[str, Tuple[str, str]] = {}
        # plans/P4-13.md §2.5: the sibling document as loaded and updated; every revocation
        # verified in this process (loaded or learned), by target; the JWS of each learned in
        # this process; the document's issue; whether the file exists (never created empty).
        self._rev_doc: Dict[str, Any] = empty_revocations()
        self._rev_verified: Dict[str, VerifiedRevocation] = {}
        self._rev_jws: Dict[str, str] = {}
        self._rev_issue: Optional[str] = None
        self._rev_file = False
        #: P4-20: ``provides_facts`` of verified records, by ``memo_key`` (pack id and record hash).
        self._provides = ProvidesMemo()
        # plans/P4-19.md §2.3: delegation records fetched in this process, by hash (each bound to
        # its hash and re-verified at every use against the current trust inputs); the distinct
        # delegations this call may still fetch; the delegated releases verified in this process
        # (record hash -> pack and delegation hash).
        self._delegation_bodies: Dict[str, str] = {}
        self._delegation_budget = MAX_DELEGATIONS_PER_CHECK
        self._delegated_known: Dict[str, Dict[str, str]] = {}
        self._lock = threading.RLock()

    # ── Public surface ─────────────────────────────────────────────────────────────────────

    def register_handler(self, handler: Any) -> None:
        """Add or replace a handler for a pack type (CONTENT §4.1 custom types)."""
        if (
            handler is None
            or not isinstance(getattr(handler, "type", None), str)
            or not callable(getattr(handler, "supports", None))
            or getattr(handler, "layout", None) not in ("tree", "container")
            or getattr(handler, "activation", None) not in ("hot", "restart")
        ):
            raise PackError(
                ErrorCode.INVALID_OPTIONS,
                "register_handler needs {type, layout, activation, supports}.",
            )
        self._handlers[handler.type] = handler

    def on(self, listener: Callable[[PackProgress], None]) -> Callable[[], None]:
        """Progress events; returns the unsubscribe function."""
        self._listeners.append(listener)

        def off() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return off

    def load(self, embedded: Sequence[EmbeddedBaseline] = ()) -> Dict[str, Any]:
        """Load the state (re-verifying every entry), register the host's embedded baselines,
        activate what this boot runs, persist the document and collect garbage. Run once, before
        ``ensure``. Returns ``{"refused": [{"location", "step"}]}``."""
        with self._lock:
            refused: List[Dict[str, str]] = []
            for baseline in embedded:
                r = self._verify_embedded(baseline)
                if not r[0]:
                    refused.append({"location": baseline.location, "step": r[1]})
                else:
                    self._embedded[r[1]["packId"]] = r[1]
            # `read` is None only for "no document"; anything it raises means the document is
            # unknown, so nothing may be written over it or collected this process.
            text: Optional[str] = None
            unreadable = False
            try:
                text = self._state.read()
            except Exception:
                unreadable = True
            torn = (
                not unreadable
                and text is not None
                and text.strip() != ""
                and not _looks_like_state(text)
            )
            st = self._state
            can_quarantine = all(
                callable(getattr(st, m, None))
                for m in ("quarantine", "quarantined", "clear_quarantine")
            )
            if torn:
                # A store that cannot keep the torn text aside is treated as unreadable.
                if not can_quarantine:
                    unreadable = True
                else:
                    try:
                        st.quarantine(text)
                    except Exception:
                        unreadable = True
            held = False
            if not unreadable:
                if torn:
                    held = True
                elif can_quarantine:
                    try:
                        held = bool(st.quarantined())
                    except Exception:
                        held = True
            self._state_issue = "unreadable" if unreadable else ("torn" if held else None)
            self._gc_hold = unreadable
            if held:
                listed = self._hold_list(st)
                if listed is None:
                    self._gc_hold = True
                else:
                    self._hold_snapshot = (set(listed[0]), set(listed[1]))
            if self._state_issue is not None:
                self._emit(PackProgress("", "state-issue", 0, 0, self._state_issue))
            parsed = parse_pack_state(None if torn else text)
            deferred: List[Dict[str, Any]] = []

            def verify_install(i: Dict[str, Any]) -> bool:
                if not self._verify_stored_record(
                    i["record"], i["recordSha256"], i["packId"], i, i.get("delegation")
                ):
                    return False
                try:
                    return bool(self._storage.verify(i))
                except Exception:
                    # The payload could not be read (an I/O error, not a mismatch): kept in the
                    # document and out of GC, but out of the running set and the planner.
                    self._unverifiable.add(i["location"])
                    deferred.append(i)
                    return False

            def verify_journal(j: Dict[str, Any]) -> bool:
                return self._verify_stored_record(
                    j["record"], j["recordSha256"], j["packId"], None, j.get("delegation")
                )

            doc = reload_pack_state(parsed, verify_install, verify_journal)
            for slot in ("active", "previous"):
                for pid, i in parsed[slot].items():
                    if any(i is d for d in deferred):
                        self._deferred[slot][pid] = i
            self._doc = doc
            # plans/P4-13.md §2.5: the sibling revocations, before anything mounts.
            self._load_revocations(unreadable)
            # This boot's set: every active install, else the embedded baseline. A revoked
            # release never activates or mounts (`pack-revoked`).
            for i in list(doc["active"].values()):
                if not self._install_revoked(i):
                    self._activate(i)
            for pid, emb in self._embedded.items():
                if pid not in self._running and not self._embedded_refused(emb):
                    self._running[pid] = emb
            if not unreadable:
                self._persist()
            self._collect()
            return {"refused": refused}

    def state(self) -> PacksSnapshot:
        """The install state and this process's running set."""
        with self._lock:
            doc = self._require_loaded()
            inflight = {
                pid: {
                    "planId": j["planId"],
                    "strategy": j["strategy"],
                    "done": sum(o["done"] for o in j["objects"]),
                    "total": sum(o["bytes"] for o in j["objects"]),
                }
                for pid, j in doc["inflight"].items()
            }
            return PacksSnapshot(
                active=dict(doc["active"]),
                previous=dict(doc["previous"]),
                inflight=inflight,
                running=dict(self._running),
                confirmed_boot_seq=doc["confirmedBootSeq"],
                boot_seq=doc["bootSeq"],
                state_issue=self._state_issue,
            )

    def open(self, pack_id: str) -> Optional[InstalledPayload]:
        """The bytes of a pack's running install, or ``None``."""
        i = self._running.get(pack_id)
        return self._storage.installed(i) if i is not None else None

    def pack_set_id(self) -> Optional[str]:
        """``pack_set_id`` of the running set (plans/P4-01.md §2.9), for ``devices/report``."""
        return pack_set_id(
            [{"packId": i["packId"], "releaseSha256": i["recordSha256"]} for i in self._running.values()]
        )

    def is_available(self, content_id: str) -> bool:
        """Save compatibility (P4-20, CONTENT §6.7 item 8): whether a pack release in the ACTIVE
        set provides ``content_id`` (its record's ``provides``, ``provides.py``). The active set
        is the running set: restart packs mounted at this boot, hot packs active, embedded
        baselines included; a revoked release is never in it. A pack whose ``entitlement`` the
        licence lacks never answers."""
        with self._lock:
            self._require_loaded()
            granted = self._entitlements() if self._entitlements is not None else None
            for i in self._running.values():
                f = self._provides.facts_of(memo_key(i["packId"], i["recordSha256"]), i["record"])
                if content_id in f.provides and entitled(f, granted):
                    return True
            return False

    def pack_for(
        self, content_id: str, targets: Optional[Sequence[Any]] = None
    ) -> Optional[PackProvider]:
        """The pack whose TARGET release provides ``content_id``, so a game can ``estimate`` and
        ``ensure`` it. The target set is ``targets`` (a ``packs`` decision's install list) or, by
        default, the content stamp's pins; each target's record is the verified record of an
        install or embedded baseline with its hash, else fetched by hash and verified as
        ``ensure`` verifies it. The first target, in list order, that provides the id answers. A
        target that cannot be fetched or verified, a revoked one and an unentitled one (CONTENT
        §6.7 item 9) never answer. ``None`` when no target provides it."""
        with self._lock:
            self._require_loaded()
            self._delegation_budget = MAX_DELEGATIONS_PER_CHECK
            items = (
                [_target(t) for t in targets]
                if targets is not None
                else [_target(p) for p in ((self._stamp or {}).get("pins") or ())]
            )
            granted = self._entitlements() if self._entitlements is not None else None
            delegated = self.delegated_releases()
            for pack_id, release in items:
                # A revoked record, or one signed under a revoked delegation (checked here too,
                # because a memo hit skips `_fetch_verified`'s own check).
                d = delegated.get(release["sha256"])
                if self.revoked_by(release["sha256"], d["delegation"] if d else None) is not None:
                    continue
                f = self._target_facts(pack_id, release)
                if f is not None and content_id in f.provides and entitled(f, granted):
                    return PackProvider(
                        pack_id=pack_id,
                        release=ReleasePin(
                            sha256=release["sha256"], seq=release["seq"], version=release["version"]
                        ),
                    )
            return None

    def confirm(self) -> None:
        """Mark this boot healthy (CONTENT §10 step 7)."""
        with self._lock:
            self._refuse_unreadable()
            self._doc = confirm_boot(self._require_loaded())
            self._persist()

    def rollback(self, pack_id: str) -> bool:
        """Re-point a pack at ``previous``. A hot pack switches now; a restart pack at the next
        boot."""
        with self._lock:
            self._refuse_unreadable()
            doc = self._require_loaded()
            before = doc["active"].get(pack_id)
            prev = doc["previous"].get(pack_id)
            # plans/P4-13.md §2.5: never back to a revoked release.
            if prev is not None and self._install_revoked(prev):
                return False
            if prev is not None and pack_id in self._unverified_previous:
                # Carried over from an entry whose check could not run: verify it now.
                try:
                    ok = self._verify_stored_record(
                        prev["record"], prev["recordSha256"], pack_id, prev, prev.get("delegation")
                    ) and bool(self._storage.verify(prev))
                except Exception:
                    ok = False
                if not ok:
                    return False
                self._unverified_previous.discard(pack_id)
            new_doc, rolled = rollback_install(doc, pack_id)
            if not rolled:
                return False
            self._doc = new_doc
            self._persist()
            now = new_doc["active"][pack_id]
            h = self._handlers.get(now["type"])
            if now["activation"] == "hot":
                if before is not None and h is not None and h.deactivate is not None:
                    h.deactivate(before)
                self._activate(now)
            return True

    def ensure(self, pack_ids: Sequence[str]) -> List[Dict[str, Any]]:
        """Install the pinned release of each pack, in order. Returns the installs
        (already-current packs included); raises a :class:`PackError` for the first pack that
        cannot be installed."""
        with self._lock:
            self._refuse_unreadable()
            self._delegation_budget = MAX_DELEGATIONS_PER_CHECK
            return [self._ensure_one(pid) for pid in pack_ids]

    def ensure_releases(self, targets: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
        """Install exact releases (a ``packs`` decision's ``install``, plans/P4-13.md §2.6):
        each target is ``{"pack", "release": {"sha256", "seq", "version"}}`` (or a
        ``PackTarget``), verified against the pinned release keys with that pin instead of the
        stamp's. Raises ``pack-revoked`` for a release a verified revocation names."""
        with self._lock:
            self._refuse_unreadable()
            self._delegation_budget = MAX_DELEGATIONS_PER_CHECK
            return [self._ensure_one(*_target(t)) for t in targets]

    def estimate(self, pack_ids: Sequence[str]) -> PackEstimate:
        """Preflight each pack (record, type, entitlement, variant, index, plan) without
        downloading the payload, and sum the chosen strategies' bytes: the size a consent dialog
        discloses. The index each tree stages is reused by ``ensure``."""
        return self._estimate_all([(pid, None) for pid in pack_ids])

    def estimate_releases(self, targets: Sequence[Mapping[str, Any]]) -> PackEstimate:
        """``estimate`` for exact releases (a ``packs`` decision's ``install``, plans/P4-13.md
        §2.6)."""
        return self._estimate_all([_target(t) for t in targets])

    def _estimate_all(self, items: Sequence[Tuple[str, Optional[Dict[str, Any]]]]) -> PackEstimate:
        with self._lock:
            self._refuse_unreadable()
            self._delegation_budget = MAX_DELEGATIONS_PER_CHECK
            out = PackEstimate()
            for pid, release in items:
                try:
                    pre = self._preflight(pid, release)
                    if not isinstance(pre, _Plan):
                        continue
                    if pre.plan["strategy"] == "noop":
                        continue
                    out.packs.append(pid)
                    if "bytes" in pre.plan:
                        out.bytes += pre.plan["bytes"]
                except PolarisError as e:
                    out.refused.append({"packId": pid, "code": str(e.code)})
                except Exception:
                    out.refused.append({"packId": pid, "code": ErrorCode.NETWORK_ERROR})
            return out

    def recover_state(self) -> None:
        """Operator recovery after a torn state document: drop the copy held aside and resume
        garbage collection, which then removes the payloads no install names."""
        with self._lock:
            self._require_loaded()
            if self._state_issue == "unreadable":
                raise PackError(
                    ErrorCode.PACK_STATE_UNREADABLE,
                    "The pack state could not be read; restart once the store is readable.",
                )
            clear = getattr(self._state, "clear_quarantine", None)
            if callable(clear):
                clear()
            self._state_issue = None
            self._gc_hold = False
            self._hold_snapshot = None
            # plans/P4-13.md §2.5: `relearn` is cleared wholesale and a quarantined
            # `revocations.json` released; revocations are re-learned from the next feed.
            rs = self._revocations
            if rs is not None and self._rev_issue != "unreadable":
                clear_rev = getattr(rs, "clear_quarantine", None)
                if callable(clear_rev):
                    clear_rev()
                if self._rev_doc["relearn"]:
                    self._rev_doc = {**self._rev_doc, "relearn": []}
                    if self._rev_file:
                        rs.replace(serialize_revocations(self._rev_doc))
                if self._rev_issue == "torn":
                    self._rev_issue = None
            self._collect()

    # ── Revocations (plans/P4-13.md §2.5) ──────────────────────────────────────────────────

    def revocations(self) -> RevocationsSnapshot:
        """The stored and this process's verified revocations."""
        with self._lock:
            revoked: Dict[str, Dict[str, Any]] = dict(self._rev_doc["revoked"])
            for t, r in self._rev_verified.items():
                if t not in revoked:
                    revoked[t] = {
                        "jws": self._rev_jws.get(t, ""),
                        "pack": r.pack,
                        "version": r.version,
                        "seq": r.seq,
                        "record": r.record,
                        "issuedAt": r.issuedAt,
                    }
            return RevocationsSnapshot(
                revoked=revoked,
                verified=dict(self._rev_verified),
                relearn=list(self._rev_doc["relearn"]),
                issue=self._rev_issue,
            )

    def record_revocations(
        self, learned: Sequence[Any], relearn_cleared: Sequence[str] = ()
    ) -> None:
        """Keep revocations a fresh check verified (plans/P4-13.md §2.5 step 11): each
        ``learned`` entry has ``revocation`` and ``jws`` (``LearnedRevocation``) and is stored
        when its target is new, or when ``newer_revocation`` ranks it above the stored one.
        ``relearn_cleared`` names the packs a fresh, network-verified feed with a usable
        ``revocations`` member re-taught. A revoked install stops running at once (a ``hot``
        handler is deactivated; a ``restart`` pack is not mounted at the next boot). Writes
        ``state.json``'s ``revocationsStored`` before the sibling file the first time; writes
        nothing while either document is unreadable (the revocations still apply for the life
        of the process)."""
        with self._lock:
            self._require_loaded()
            nxt = self._rev_doc
            changed = False
            for item in learned:
                revocation = item.revocation if hasattr(item, "revocation") else item["revocation"]
                jws = item.jws if hasattr(item, "jws") else item["jws"]
                t = revocation.target
                prev = self._rev_verified.get(t)
                if prev is None or newer_revocation(revocation, prev) is revocation:
                    self._rev_verified[t] = revocation
                    self._rev_jws[t] = jws
                nxt, c = store_revocation(
                    nxt, revocation, jws, lambda target, t=t, prev=prev: prev if target == t else None
                )
                changed = changed or c
            nxt, c = clear_relearn(nxt, list(relearn_cleared))
            changed = changed or c
            # The cap may have dropped a target: it is forgotten here too.
            for t in list(self._rev_verified):
                if t not in nxt["revoked"] and t in self._rev_doc["revoked"]:
                    del self._rev_verified[t]
            self._rev_doc = nxt
            try:
                if changed:
                    self._persist_revocations()
            finally:
                # A failed write never keeps a revoked release running.
                self._unmount_revoked()

    def is_revoked(self, record_sha256: str) -> bool:
        """Whether a release is revoked (stored, or verified in this process)."""
        return record_sha256 in self._rev_doc["revoked"] or record_sha256 in self._rev_verified

    def revoked_by(self, record_sha256: str, delegation_sha256: Optional[str]) -> Optional[str]:
        """Why a release is revoked (plans/P4-19.md §2.3 ``record_revoked``): ``record`` when its
        own hash is a target, ``delegation`` when the delegation it was signed under is, else
        ``None``."""
        targets = set(self._rev_doc["revoked"]) | set(self._rev_verified)
        return record_revoked(record_sha256, delegation_sha256, targets)

    def _install_revoked(self, i: Mapping[str, Any]) -> bool:
        """Whether an install is revoked: its record, or the delegation it was signed under."""
        return self.revoked_by(i["recordSha256"], _install_delegation(i)) is not None

    def delegated_releases(self) -> Dict[str, Dict[str, str]]:
        """The delegated releases this engine knows (plans/P4-19.md §2.7): every stored or
        running install signed by a content key, and every delegated feed target verified in
        this process, as record hash -> ``{"pack", "delegation"}``. The update check adds a
        decision revocation for each one whose delegation is revoked, and treats a delegation
        entry naming one of these delegations as relevant (step 11)."""
        with self._lock:
            out: Dict[str, Dict[str, str]] = {k: dict(v) for k, v in self._delegated_known.items()}
            doc = self._doc or {}
            installs = (
                list((doc.get("active") or {}).values())
                + list((doc.get("previous") or {}).values())
                + list(self._running.values())
            )
            for i in installs:
                h = _install_delegation(i)
                if h is not None:
                    out[i["recordSha256"]] = {"pack": i["packId"], "delegation": h}
            return out

    def _embedded_refused(self, e: Mapping[str, Any]) -> bool:
        """The embedded-baseline refusals (plans/P4-13.md §2.5): a revoked release; a pack in
        ``relearn``; with an unreadable ``revocations.json`` and ``revocationsStored`` set,
        every pack the stamp pins or the host embeds. These apply at every boot and every
        mount, online or offline, until a fresh feed clears ``relearn`` (or
        ``recover_state()``); online, the pack is fetched instead. A product with no
        revocations refuses nothing."""
        if self.is_revoked(e["recordSha256"]):
            return True
        if e["packId"] in self._rev_doc["relearn"]:
            return True
        if (
            self._rev_issue == "unreadable"
            and self._doc is not None
            and self._doc.get("revocationsStored") is True
            and (e["packId"] in self._stamp_packs() or e["packId"] in self._embedded)
        ):
            return True
        return False

    def _stamp_packs(self) -> Set[str]:
        return {p["pack"] for p in ((self._stamp or {}).get("pins") or ())}

    def _load_revocations(self, state_unreadable: bool) -> None:
        """Load ``revocations.json`` (§2.5): absent is empty; unreadable writes nothing this
        process; torn is quarantined and replaced by a fresh document whose ``relearn`` holds
        the stamp's pinned and embedded packs; each entry is re-verified against the pinned
        release keys."""
        rs = self._revocations
        if rs is None:
            return
        try:
            text = rs.read()
        except Exception:
            self._rev_issue = "unreadable"
            return
        if text is None:
            return
        self._rev_file = True
        parsed = None if text.strip() == "" else parse_revocations(text)
        if parsed is None:
            # Torn: held aside, then a fresh document that re-learns the stamp's packs.
            quarantine = getattr(rs, "quarantine", None)
            try:
                if not callable(quarantine):
                    raise RuntimeError("no quarantine")
                quarantine(text)
            except Exception:
                self._rev_issue = "unreadable"
                return
            self._rev_issue = "torn"
            relearn = sorted(
                self._stamp_packs() | set(self._embedded),
                key=lambda s: s.encode("utf-8", "surrogatepass"),
            )
            self._rev_doc = {**empty_revocations(), "relearn": relearn}
            if not state_unreadable:
                self._write_revocations()
            return
        r = reload_revocations(
            parsed,
            release_keys=self._release_keys,
            product_trust=self._product_trust(),
            expected_aud=self._product,
        )
        self._rev_doc = r.doc
        self._rev_verified.update(r.verified)
        if r.changed and not state_unreadable:
            self._write_revocations()
        elif (
            not state_unreadable
            and not is_empty_revocations(self._rev_doc)
            and self._require_loaded().get("revocationsStored") is not True
        ):
            # A torn (or replaced) `state.json` lost the flag while the sibling file kept its
            # entries: set it again, so an unreadable `revocations.json` later still refuses. A
            # failed write leaves the flag unset in memory; the next sibling write retries it.
            try:
                self._persist_flag()
            except Exception:
                pass  # The load goes on: the sibling file is unchanged and still read.

    def _persist_revocations(self) -> None:
        """Persist the revocations: ``revocationsStored`` in ``state.json`` first, then the
        sibling file. Never creates an empty file; never writes while a document is
        unreadable."""
        if self._revocations is None:
            return
        if self._rev_issue == "unreadable" or self._state_issue == "unreadable":
            return
        if not self._rev_file and is_empty_revocations(self._rev_doc):
            return
        self._write_revocations()

    def _write_revocations(self) -> None:
        rs = self._revocations
        # Without the flag on disk the sibling file is not written: an unreadable file later must
        # never be read as "no revocations" while it holds some.
        if self._require_loaded().get("revocationsStored") is not True:
            self._persist_flag()
        rs.replace(serialize_revocations(self._rev_doc))
        self._rev_file = True

    def _persist_flag(self) -> None:
        """Write ``revocationsStored: true`` to ``state.json``. The in-memory document takes the
        flag only once the write succeeded, so a failed write (which raises) is retried before
        the next sibling write instead of being believed."""
        before = self._require_loaded()
        self._doc = {**before, "revocationsStored": True}
        try:
            self._persist()
        except BaseException:
            self._doc = before
            raise

    def _unmount_revoked(self) -> None:
        """Stop running every revoked release (a hot handler is deactivated)."""
        for pid, i in list(self._running.items()):
            if not self._install_revoked(i):
                continue
            h = self._handlers.get(i["type"])
            if i.get("activation") == "hot" and h is not None and h.deactivate is not None:
                try:
                    h.deactivate(i)
                except Exception:
                    pass  # A handler failure never keeps a revoked release running.
            del self._running[pid]

    # ── Internals ──────────────────────────────────────────────────────────────────────────

    def _require_loaded(self) -> Dict[str, Any]:
        if self._doc is None:
            raise PackError(ErrorCode.NOT_CONFIGURED, "Call load() before using packs.")
        return self._doc

    def _emit(self, e: PackProgress) -> None:
        for listener in list(self._listeners):
            try:
                listener(e)
            except Exception:
                pass  # A listener never fails an install.

    def _hold_list(self, st: Any) -> Optional[Tuple[List[str], List[str]]]:
        """The torn hold's snapshot: the saved one, else ``storage.list()`` now (saved when the
        store can keep it). ``None`` when it cannot be known."""
        read = getattr(st, "read_hold_list", None)
        if callable(read):
            try:
                saved = read()
            except Exception:
                return None
            if saved is not None:
                try:
                    d = json.loads(saved)
                    locs, plans = d.get("locations"), d.get("plans")
                    if (
                        isinstance(locs, list)
                        and isinstance(plans, list)
                        and all(isinstance(x, str) for x in locs + plans)
                    ):
                        return (locs, plans)
                except Exception:
                    pass  # Torn too: the full hold.
                return None
        try:
            locations, plans = self._storage.list()
        except Exception:
            return None
        write = getattr(st, "write_hold_list", None)
        if callable(write):
            try:
                write(json.dumps({"locations": list(locations), "plans": list(plans)}))
            except Exception:
                return None
        return (list(locations), list(plans))

    def _refuse_unreadable(self) -> None:
        self._require_loaded()
        if self._state_issue == "unreadable":
            raise PackError(
                ErrorCode.PACK_STATE_UNREADABLE,
                "The pack state could not be read, so nothing is fetched, written or installed "
                "this process.",
            )

    def _persist(self) -> None:
        if self._state_issue == "unreadable":
            raise PackError(
                ErrorCode.PACK_STATE_UNREADABLE,
                "The pack state could not be read, so nothing is written or installed this "
                "process.",
            )
        doc = self._require_loaded()
        out = dict(doc)
        out["active"] = {**self._deferred["active"], **doc["active"]}
        out["previous"] = {**self._deferred["previous"], **doc["previous"]}
        for pid in doc["active"]:
            p, a = out["previous"].get(pid), out["active"].get(pid)
            if p is not None and a is not None and p["recordSha256"] == a["recordSha256"]:
                del out["previous"][pid]
        self._state.replace(serialize_pack_state(out))

    def _activate(self, i: Dict[str, Any]) -> None:
        h = self._handlers.get(i["type"])
        if h is not None and h.activate is not None:
            if getattr(h, "reads_payload", False) is True:
                h.activate(i, PackPayload(lambda: self._storage.installed(i)))
            else:
                h.activate(i)
        self._running[i["packId"]] = i

    def _verify_stored_record(
        self,
        jws: str,
        sha256: str,
        pack_id: str,
        install: Optional[Dict[str, Any]] = None,
        delegation: Optional[str] = None,
    ) -> bool:
        """Steps 12–16 again over a stored record, with its own pack id as the pin; a delegated
        record through its stored delegation (plans/P4-19.md §2.4: an installed release stays
        valid after its window)."""
        r = verify_release_record(
            jws,
            release_keys=self._release_keys,
            product_trust=self._product_trust(),
            expected_aud=self._product,
            expected_hash=sha256,
            delegation=delegation if isinstance(delegation, str) else None,
        )
        if not r.ok or r.record is None:
            return False
        rec = r.record.to_dict()
        if rec.get("kind") != "pack" or rec.get("deliverable") != pack_id:
            return False
        if install is not None:
            if rec.get("version") != install["version"] or rec.get("seq") != install["seq"]:
                return False
            v = next(
                (x for x in rec["variants"] if variant_key(x["variant"]) == install["variant"]),
                None,
            )
            if v is None or v["payload"]["sha256"] != install["payloadSha256"]:
                return False
            if v["payload"]["size"] != install["payloadSize"] or rec.get("type") != install["type"]:
                return False
        return True

    def _verify_embedded(self, e: EmbeddedBaseline) -> Tuple[bool, Any]:
        m = verify_marker(
            e.marker,
            release_keys=self._release_keys,
            product_trust=self._product_trust(),
            expected_aud=self._product,
        )
        if not m.ok:
            return (False, m.step)
        match = match_embedded(m, e.payload, self._stamp)
        if not match["ok"]:
            return (False, match["step"])
        rec = m.record or {}
        v = rec["variants"][match["variant"]]
        install = {
            "packId": m.pack_id,
            "record": m.release,
            "recordSha256": m.record_sha256,
            "version": m.version,
            "seq": rec["seq"],
            "type": rec["type"],
            "variant": variant_key(v["variant"]),
            "layout": v["files"]["layout"],
            "payloadSha256": v["payload"]["sha256"],
            "payloadSize": v["payload"]["size"],
            "activation": _activation_of(rec, self._handlers.get(rec["type"])),
            "location": e.location,
            "embedded": True,
            "installedAt": rec["issuedAt"],
        }
        return (True, install)

    def _installs_of(self, pack_id: str) -> List[Dict[str, Any]]:
        """The installs of a pack the planner can reuse: active, the embedded copy, previous."""
        doc = self._require_loaded()
        out: List[Dict[str, Any]] = []
        seen: Set[str] = set()
        for i in (doc["active"].get(pack_id), self._embedded.get(pack_id), doc["previous"].get(pack_id)):
            if i is not None and i["location"] not in seen:
                seen.add(i["location"])
                out.append(i)
        return out

    def _preflight(self, pack_id: str, release: Optional[Mapping[str, Any]] = None) -> Any:
        """Steps 1–4 for one pack: the install that is already current, or a :class:`_Plan`.
        ``release`` (``{"sha256", "seq", "version"}``) replaces the stamp's pin: a ``packs``
        decision's exact release (plans/P4-13.md §2.6)."""
        doc = self._require_loaded()
        stamp = self._stamp
        if stamp is None:
            raise PackError(
                ErrorCode.NOT_CONFIGURED,
                "This build ships no content stamp, so it has no packs.",
                pack_id=pack_id,
            )
        stamp_pin = next((p for p in stamp["pins"] if p["pack"] == pack_id), None)
        pin = {"pack": pack_id, "release": dict(release)} if release is not None else stamp_pin
        if pin is None:
            raise PackError(
                ErrorCode.PACK_NOT_PINNED,
                f"The content stamp pins no release of {pack_id}.",
                pack_id=pack_id,
            )
        want = pin["release"]["sha256"]
        # plans/P4-13.md §2.5: a revoked release is never installed, activated or mounted.
        if self.is_revoked(want):
            raise PackError(
                ErrorCode.PACK_REVOKED,
                f"{pack_id}@{pin['release']['version']} was revoked by its developer.",
                pack_id=pack_id,
            )
        current = doc["active"].get(pack_id)
        if current is not None and current["recordSha256"] == want:
            # plans/P4-19.md §2.6: a release under a revoked delegation is refused like a revoked
            # one.
            if self._install_revoked(current):
                raise PackError(
                    ErrorCode.PACK_REVOKED,
                    f"{pack_id}@{pin['release']['version']} was signed under a delegation its "
                    "developer revoked.",
                    pack_id=pack_id,
                    detail="delegation",
                )
            return current
        emb = self._embedded.get(pack_id)
        if (
            emb is not None
            and emb["recordSha256"] == want
            and current is None
            and not self._embedded_refused(emb)
        ):
            return emb

        # 2. The pinned record, by hash, against the pinned release keys.
        body, record, delegated = self._fetch_verified(pack_id, pin["release"])

        # 3. Type, entitlement, variant.
        handler = self._handlers.get(record["type"])
        if handler is None or not handler.supports(record["formatVersion"]) or not self._known_activation(record):
            raise PackError(
                ErrorCode.PACK_TYPE_UNSUPPORTED,
                f"{pack_id} is a {record['type']} v{record['formatVersion']} pack, which this SDK "
                "cannot hold"
                + (
                    " until the host registers an MlModelHandler with its budget."
                    if handler is None and record["type"] == "ml.model"
                    else "."
                ),
                pack_id=pack_id,
            )
        granted = self._entitlements() if self._entitlements is not None else None
        if "entitlement" in record and granted is not None and record["entitlement"] not in granted:
            raise PackError(
                ErrorCode.PACK_NOT_ENTITLED,
                f"{pack_id} needs the {record['entitlement']} entitlement.",
                pack_id=pack_id,
            )
        sel = select_variant(record["variants"], self._prefs)
        if "error" in sel:
            raise PackError(
                ErrorCode.PACK_NO_VARIANT,
                f"No variant of {pack_id} is eligible here.",
                pack_id=pack_id,
            )
        variant = record["variants"][sel["index"]]
        if variant["files"]["layout"] != handler.layout:
            raise PackError(
                ErrorCode.PACK_TYPE_UNSUPPORTED,
                f"{pack_id}'s variant is a {variant['files']['layout']}, not a {handler.layout}.",
                pack_id=pack_id,
            )

        # 4. The index, the target, the plan. Only installs whose bytes can be opened count.
        seeds: Dict[str, InstalledPayload] = {}
        installs: List[Dict[str, Any]] = []
        for i in self._installs_of(pack_id):
            seed: Optional[InstalledPayload]
            try:
                seed = self._storage.installed(i)
            except Exception:
                seed = None
            if seed is not None:
                seeds[i["location"]] = seed
                installs.append(i)
        prior = doc["inflight"].get(pack_id)
        early = self._preflight_plans.get(pack_id)
        if prior is not None and prior["recordSha256"] == want and prior["variant"] == variant_key(
            variant["variant"]
        ):
            plan_id = prior["planId"]
        elif early is not None and early[1] == want:
            plan_id = early[0]
        else:
            plan_id = self._new_plan_id()
        self._preflight_plans[pack_id] = (plan_id, want)
        index: Optional[Dict[str, Any]] = None
        files = variant["files"]
        need_index = files["layout"] == "tree" or any(s.files is not None for s in seeds.values())
        # Bound the index before a byte of it is staged (plans/P4-01.md §2.7 step 1).
        index_ok = index_readable(files) and files["bytes"] <= MAX_FILES_INDEX_BYTES
        if need_index and not index_ok and files["layout"] == "tree":
            raise PackError(
                ErrorCode.FILES_INDEX_INVALID,
                f"{pack_id}'s files index is unreadable here or over the size limit.",
                pack_id=pack_id,
            )
        if need_index and index_ok:
            ok = self._download(plan_id, pack_id, files["sha256"], files["bytes"], None)
            if ok:
                staged = self._storage.staged_object(plan_id, files["sha256"])
                r = parse_files_index(
                    read_all(staged.source()), files, variant, decode=self._zstd.decode
                )
                if r.ok:
                    index = r.index
                elif files["layout"] == "tree":
                    raise PackError(
                        r.error or ErrorCode.FILES_INDEX_INVALID,
                        f"{pack_id}'s files index was refused.",
                        pack_id=pack_id,
                        path=r.path,
                    )
            elif files["layout"] == "tree":
                raise PackError(
                    ErrorCode.NETWORK_ERROR,
                    f"Fetching {pack_id}'s files index failed.",
                    pack_id=pack_id,
                )
        # plans/P4-19.md §2.5: a delegated release's extension rule over the files index, before
        # any payload object is fetched.
        if delegated is not None:
            if index is None:
                raise PackError(
                    ErrorCode.FILES_INDEX_INVALID,
                    f"{pack_id}'s files index is required for a delegated release.",
                    pack_id=pack_id,
                )
            for f in index["files"]:
                if data_only_path_refusal(f["path"]) is not None:
                    raise PackError(
                        ErrorCode.PACK_NOT_DATA_ONLY,
                        f"{pack_id} holds {f['path']}, which a delegated content key may not ship.",
                        pack_id=pack_id,
                        path=f["path"],
                        detail="extension",
                    )
        target = plan_target(variant, want, index)
        budget = self._one_shot_budget
        full = variant["full"]
        streams = getattr(self._zstd, "decode_stream", None) is not None
        if (
            budget is not None
            and target["full"] is not None
            and not (full["codec"] == "zstd" and streams)
            and full["bytes"] + full["size"] > budget
        ):
            target["full"] = None
        planner_installed = [
            {
                "release": i["recordSha256"],
                "payloadSha256": i["payloadSha256"],
                "files": (
                    [f.sha256 for f in seeds[i["location"]].files]  # type: ignore[union-attr]
                    if seeds[i["location"]].files is not None
                    else None
                ),
            }
            for i in installs
        ]
        try:
            free = int(self._storage.free_disk())
        except Exception:
            free = 0
        caps = {
            "strategies": self._strategies,
            "patchMethods": self._patch_methods,
            "transports": self._transports,
            "memBudget": self._mem_budget,
            "freeDisk": free,
        }
        p = plan({"target": target, "installed": planner_installed, "caps": caps})
        if "error" in p:
            raise PackError(p["error"], f"No way to install {pack_id}: {p['error']}.", pack_id=pack_id)
        return _Plan(
            body=body,
            record_sha256=want,
            record=record,
            variant=variant,
            installs=installs,
            seeds=seeds,
            plan_id=plan_id,
            index=index,
            plan=p,
            delegation=delegated,
        )

    def _target_facts(self, pack_id: str, release: Mapping[str, Any]) -> Optional[ProvidesFacts]:
        """A target's facts (P4-20): from an install or embedded baseline of that release, else
        its record fetched and verified (``_fetch_verified``); ``None`` when that fails."""
        sha256 = release["sha256"]
        key = memo_key(pack_id, sha256)
        hit = self._provides.get(key)
        if hit is not None:
            return hit
        doc = self._require_loaded()
        for i in (
            doc["active"].get(pack_id),
            doc["previous"].get(pack_id),
            self._running.get(pack_id),
            self._embedded.get(pack_id),
        ):
            if i is not None and i["recordSha256"] == sha256 and i["packId"] == pack_id:
                return self._provides.facts_of(key, i["record"])
        try:
            body, _, _ = self._fetch_verified(pack_id, release)
        except Exception:
            return None
        return self._provides.facts_of(key, body)

    def _fetch_verified(
        self, pack_id: str, release: Mapping[str, Any]
    ) -> Tuple[str, Dict[str, Any], Optional[str]]:
        """Step 2 for one pin: the record fetched by hash and verified against the pinned release
        keys, a delegated one through its delegation (plans/P4-19.md §2.3). Returns
        ``(body, record, delegation)``, the delegation's compact JWS or ``None``; raises a
        :class:`PackError`. ``_preflight`` and ``pack_for`` (P4-20) share it, as client-core's
        ``fetchVerified``."""
        want = release["sha256"]
        got = self._fetch_record(want)
        if not got.get("ok"):
            code = got.get("code") or ErrorCode.NETWORK_ERROR
            raise PackError(code, f"Fetching {pack_id}'s record failed ({code}).", pack_id=pack_id)
        # plans/P4-19.md §2.3, §2.4: a `pkd1-` kid names its delegation, fetched by hash, only on
        # the delegated surface (a feed target that is neither the stamp's pin or hold for this
        # pack nor a stored revocation's replacement). Elsewhere step 13 refuses it at `jws`.
        delegation_hash = delegation_hash_of(got["body"])
        delegation: Optional[str] = (
            self._fetch_delegation(pack_id, delegation_hash)
            if delegation_hash is not None and self._delegated_allowed(pack_id, want)
            else None
        )
        v = verify_release_record(
            got["body"],
            release_keys=self._release_keys,
            product_trust=self._product_trust(),
            expected_aud=self._product,
            expected_hash=want,
            pin=ReleaseRecordPin(
                kind="pack",
                deliverable=pack_id,
                version=release["version"],
                seq=release["seq"],
            ),
            delegation=delegation,
        )
        if not v.ok or v.record is None:
            if v.step == "cross-check":
                raise PackError(
                    ErrorCode.RECORD_MISMATCH,
                    f"{pack_id}'s record is not the pinned release.",
                    pack_id=pack_id,
                )
            raise PackError(
                ErrorCode.RECORD_REJECTED,
                f"{pack_id}'s record was refused at {v.step}.",
                pack_id=pack_id,
                detail=v.step,
            )
        if v.delegation is not None:
            self._delegated_known[want] = {"pack": pack_id, "delegation": v.delegation.sha256}
            if self.revoked_by(want, v.delegation.sha256) is not None:
                raise PackError(
                    ErrorCode.PACK_REVOKED,
                    f"{pack_id}@{release['version']} was signed under a delegation its "
                    "developer revoked.",
                    pack_id=pack_id,
                    detail="delegation",
                )
        return got["body"], v.record.to_dict(), (delegation if v.delegation is not None else None)

    def _delegated_allowed(self, pack_id: str, sha256: str) -> bool:
        """§2.4's delegated surface: never the stamp's pin or hold for the pack, never a stored
        revocation's replacement (release-key surfaces vouch for exact bytes)."""
        stamp = self._stamp or {}
        for p in stamp.get("pins") or ():
            if p.get("pack") == pack_id and (p.get("release") or {}).get("sha256") == sha256:
                return False
        holds = stamp.get("holds")
        if isinstance(holds, list):
            for h in holds:
                if (
                    isinstance(h, dict)
                    and h.get("pack") == pack_id
                    and isinstance(h.get("release"), dict)
                    and h["release"].get("sha256") == sha256
                ):
                    return False
        for r in self._rev_verified.values():
            if r.replacement is not None and r.replacement.sha256 == sha256:
                return False
        return True

    def _fetch_delegation(self, pack_id: str, h: str) -> str:
        """A delegation record by hash: this process's copy, else fetched (at most
        ``MAX_DELEGATIONS_PER_CHECK`` distinct ones per call; a target beyond that waits)."""
        have = self._delegation_bodies.get(h)
        if have is not None:
            return have
        if self._delegation_budget <= 0:
            raise PackError(
                ErrorCode.NETWORK_ERROR,
                f"{pack_id}'s delegation was not fetched: this call reached its delegation bound; "
                "the next one retries.",
                pack_id=pack_id,
                detail="delegation",
            )
        self._delegation_budget -= 1
        got = self._fetch_record(h)
        if not got.get("ok"):
            code = got.get("code") or ErrorCode.NETWORK_ERROR
            raise PackError(
                code,
                f"Fetching {pack_id}'s delegation failed ({code}).",
                pack_id=pack_id,
                detail="delegation",
            )
        body = got["body"]
        # Kept only when it is the record the hash names; `verify_release_record` checks it again.
        if isinstance(body, str) and record_hash(body) == h:
            self._delegation_bodies[h] = body
        return body

    def _ensure_one(
        self, pack_id: str, target: Optional[Mapping[str, Any]] = None
    ) -> Dict[str, Any]:
        try:
            return self._ensure_one_inner(pack_id, target)
        except PackError as e:
            # plans/P4-13.md §2.5: when the only copy is an embedded baseline refused for
            # `relearn` (or for `revocationsStored` with an unreadable `revocations.json`) and the
            # fetch cannot proceed, the typed refusal is `pack-revoked` with detail `relearn`.
            want = target["sha256"] if target is not None else next(
                (
                    p["release"]["sha256"]
                    for p in ((self._stamp or {}).get("pins") or ())
                    if p["pack"] == pack_id
                ),
                None,
            )
            emb = self._embedded.get(pack_id)
            if (
                e.code != ErrorCode.PACK_REVOKED
                and emb is not None
                and emb["recordSha256"] == want
                and not self.is_revoked(emb["recordSha256"])
                and self._embedded_refused(emb)
            ):
                raise PackError(
                    ErrorCode.PACK_REVOKED,
                    f"{pack_id}'s embedded copy is refused until a fresh feed re-teaches its "
                    f"revocations, and it cannot be fetched ({e.code}).",
                    pack_id=pack_id,
                    detail="relearn",
                ) from e
            raise

    def _ensure_one_inner(
        self, pack_id: str, target: Optional[Mapping[str, Any]] = None
    ) -> Dict[str, Any]:
        pre = self._preflight(pack_id, target)
        if not isinstance(pre, _Plan):
            current = pre
            if (
                current.get("embedded") is not True
                and pack_id not in self._running
                and current["activation"] == "hot"
            ):
                self._activate(current)
            return current
        record, variant, seeds, plan_id, index = (
            pre.record,
            pre.variant,
            pre.seeds,
            pre.plan_id,
            pre.index,
        )
        p = pre.plan
        self._preflight_plans.pop(pack_id, None)
        delegation = pre.delegation
        if p["strategy"] == "noop":
            same = next(i for i in pre.installs if i["payloadSha256"] == variant["payload"]["sha256"])
            # plans/P4-19.md Amendment A1: a delegated release that reuses an install holding the
            # same payload re-sniffs that install's files, so the data-only rule holds whatever
            # admitted the bytes first.
            if delegation is not None:
                seed = seeds.get(same["location"])
                files = seed.files if seed is not None else None
                if files is None:
                    raise PackError(
                        ErrorCode.PACK_NOT_DATA_ONLY,
                        f"{pack_id}'s reused install cannot be re-checked by the data-only rule.",
                        pack_id=pack_id,
                        detail="content",
                    )
                for f in files:
                    rule = data_only_file_refusal(f.path, read_all(f.source))
                    if rule is not None:
                        raise PackError(
                            ErrorCode.PACK_NOT_DATA_ONLY,
                            f"{pack_id} holds {f.path}, which a delegated content key may not "
                            f"ship ({rule}).",
                            pack_id=pack_id,
                            path=f.path,
                            detail=rule,
                        )
            return self._commit(
                pack_id,
                pre.body,
                pre.record_sha256,
                record,
                variant,
                same["location"],
                plan_id,
                True,
                delegation,
            )
        if p["strategy"] == "platform":
            raise PackError(
                ErrorCode.PLAN_TRANSPORT_UNSUPPORTED, f"{pack_id} is platform-bound.", pack_id=pack_id
            )

        first_failure: Optional[PackError] = None
        for cand in [p] + list(p["fallbacks"]):
            objects = self._objects_for(cand["strategy"], cand.get("delta"), variant, index, seeds)
            if objects is None:
                continue
            journal: Dict[str, Any] = {
                "planId": plan_id,
                "packId": pack_id,
                "record": pre.body,
                "recordSha256": pre.record_sha256,
                "variant": variant_key(variant["variant"]),
                "strategy": cand["strategy"],
            }
            if cand.get("delta") is not None:
                journal["delta"] = cand["delta"]
            journal["objects"] = [{"sha256": s, "bytes": b, "done": 0} for s, b in objects]
            journal["startedAt"] = self._now()
            if delegation is not None:
                journal["delegation"] = delegation
            self._doc = begin_install(self._require_loaded(), journal)
            self._persist()
            total = sum(b for _, b in objects)
            progress = {"done": 0, "total": total}
            self._emit(PackProgress(pack_id, "download", 0, total))
            for s, b in objects:
                if not self._download(plan_id, pack_id, s, b, progress):
                    # The journal and what is staged stay for the next `ensure`, which resumes.
                    raise PackError(
                        ErrorCode.NETWORK_ERROR,
                        f"Fetching {pack_id}'s objects failed; the next ensure resumes.",
                        pack_id=pack_id,
                    )
            self._emit(PackProgress(pack_id, "apply", total, total))
            # plans/P4-19.md §2.5: every file a delegated install writes passes the data-only rule.
            seen: Dict[str, Optional[DataOnlyRefusalSeen]] = {"refusal": None}
            result = self._apply(
                plan_id,
                pack_id,
                cand["strategy"],
                cand.get("delta"),
                variant,
                seeds,
                seen if delegation is not None else None,
            )
            refusal = seen["refusal"]
            if refusal is not None:
                # A refusal aborts the plan: no fallback, staging discarded.
                self._doc = abandon_install(self._require_loaded(), pack_id)
                self._persist()
                self._quiet(lambda: self._storage.remove_staging(plan_id))
                raise PackError(
                    ErrorCode.PACK_NOT_DATA_ONLY,
                    f"{pack_id} holds {refusal.path}, which a delegated content key may not ship "
                    f"({refusal.rule}).",
                    pack_id=pack_id,
                    path=refusal.path,
                    detail=refusal.rule,
                )
            if result.verdict.get("ok"):
                location = self._storage.commit(
                    plan_id,
                    pack_id,
                    variant["payload"]["sha256"],
                    variant["files"]["layout"],
                    result.index if result.index is not None else index,
                )
                self._type_check(pack_id, record, variant, location, plan_id, delegation)
                install = self._commit(
                    pack_id,
                    pre.body,
                    pre.record_sha256,
                    record,
                    variant,
                    location,
                    plan_id,
                    False,
                    delegation,
                )
                self._emit(PackProgress(pack_id, "done", total, total))
                return install
            f = result.verdict
            if first_failure is None:
                first_failure = PackError(
                    f["error"],
                    f"Installing {pack_id} by {cand['strategy']} failed: {f['error']}.",
                    pack_id=pack_id,
                    path=f.get("path"),
                    detail=cand["strategy"],
                )
            self._quiet(lambda: self._storage.remove_staging(plan_id))
        self._doc = abandon_install(self._require_loaded(), pack_id)
        self._persist()
        self._quiet(lambda: self._storage.remove_staging(plan_id))
        raise first_failure or PackError(
            ErrorCode.PLAN_NO_STRATEGY, f"No way to install {pack_id}.", pack_id=pack_id
        )

    def _type_check(
        self,
        pack_id: str,
        record: Dict[str, Any],
        variant: Dict[str, Any],
        location: str,
        plan_id: str,
        delegation: Optional[str],
    ) -> None:
        """The handler's ``check`` over a newly staged payload, now in the store at ``location``
        but not yet in the state (CONTENT §4.1 ``verify``; P4-16). A refusal abandons the
        install, discards staging, collects the stored payload (no root holds it) and raises
        ``pack-type-check-failed``. A check that raises refuses (``check``); a payload the
        storage cannot read back refuses (``unreadable``)."""
        h = self._handlers.get(record["type"])
        if h is None:
            return
        # The payload is read back for every handler, with a check or not, so a store that
        # cannot return what it just committed refuses the same way in every SDK (Swift cannot
        # tell whether a handler implements its check).
        check = getattr(h, "check", None)
        provisional: Dict[str, Any] = {
            "packId": pack_id,
            "record": "",
            "recordSha256": "",
            "version": record["version"],
            "seq": record["seq"],
            "type": record["type"],
            "variant": variant_key(variant["variant"]),
            "layout": variant["files"]["layout"],
            "payloadSha256": variant["payload"]["sha256"],
            "payloadSize": variant["payload"]["size"],
            "activation": _activation_of(record, h),
            "location": location,
            "installedAt": self._now(),
        }
        if delegation is not None:
            provisional["delegation"] = delegation
        refusal: Any
        try:
            got = self._storage.installed(provisional)
            if got is None:
                refusal = {"detail": "unreadable", "message": "the stored payload cannot be read back"}
            elif check is None:
                refusal = None
            else:
                refusal = check(
                    StagedPack(
                        pack_id=pack_id,
                        record=dict(record),
                        variant=dict(variant),
                        location=location,
                        # Index (path byte) order, whatever order the storage lists them in, so
                        # every SDK names the same first refused file.
                        files=sorted(got.files or [], key=lambda f: f.path.encode("utf-8", "surrogatepass")),
                        payload=got.payload,
                    )
                )
        except Exception as e:
            refusal = {"detail": "check", "message": str(e)}
        if refusal is None:
            return
        get = refusal.get if isinstance(refusal, Mapping) else (lambda k: getattr(refusal, k, None))
        raw_detail, raw_path, message = get("detail"), get("path"), get("message")
        detail = raw_detail if isinstance(raw_detail, str) and _CHECK_DETAIL_RE.fullmatch(raw_detail) else "check"
        path = raw_path if isinstance(raw_path, str) else None
        self._doc = abandon_install(self._require_loaded(), pack_id)
        self._persist()
        self._quiet(lambda: self._storage.remove_staging(plan_id))
        self._collect()
        raise PackError(
            ErrorCode.PACK_TYPE_CHECK_FAILED,
            f"{pack_id} failed its {record['type']} check ({detail}"
            + (f", {path}" if path is not None else "")
            + ")"
            + (f": {message}" if isinstance(message, str) else "."),
            pack_id=pack_id,
            detail=detail,
            path=path,
        )

    @staticmethod
    def _quiet(fn: Callable[[], Any]) -> None:
        try:
            fn()
        except Exception:
            pass

    @staticmethod
    def _known_activation(record: Mapping[str, Any]) -> bool:
        h = record.get("handler")
        a = h.get("activation") if isinstance(h, dict) else None
        return a is None or a in ("hot", "restart")

    def _objects_for(
        self,
        strategy: str,
        delta: Optional[str],
        variant: Mapping[str, Any],
        index: Optional[Mapping[str, Any]],
        seeds: Mapping[str, InstalledPayload],
    ) -> Optional[List[Tuple[str, int]]]:
        """The objects a strategy fetches, in order; ``None`` when it cannot run here."""
        files = variant["files"]
        idx = (files["sha256"], files["bytes"])
        gaps = (
            [(files["gaps"]["sha256"], files["gaps"]["bytes"])]
            if files["layout"] == "container" and files.get("gaps")
            else []
        )
        full = variant["full"]
        if strategy == "full":
            return [idx, (full["sha256"], full["bytes"])] if files["layout"] == "tree" else [
                (full["sha256"], full["bytes"])
            ]
        if strategy == "delta":
            d = self._find_delta(variant, delta)
            if d is None:
                return None
            if d["scope"] == "payload":
                return [(d["artifact"]["sha256"], d["artifact"]["bytes"])]
            return [idx] + gaps + [
                (d["patch"]["sha256"], d["patch"]["bytes"]),
                (d["data"]["sha256"], d["data"]["bytes"]),
            ]
        if strategy == "file":
            if index is None:
                return None
            held: Set[str] = set()
            for s in seeds.values():
                for f in s.files or []:
                    held.add(f.sha256)
            blobs: Dict[str, int] = {}
            for f in index["files"]:
                if f["sha256"] not in held and f["blob"]["sha256"] not in blobs:
                    blobs[f["blob"]["sha256"]] = f["blob"]["bytes"]
            return [idx] + gaps + list(blobs.items())
        return None

    @staticmethod
    def _find_delta(variant: Mapping[str, Any], delta: Optional[str]) -> Optional[Dict[str, Any]]:
        for x in variant.get("deltas") or []:
            if x.get("scope") == "payload" and x["artifact"]["sha256"] == delta:
                return x
            if x.get("scope") == "files" and x["patch"]["sha256"] == delta:
                return x
        return None

    def _apply(
        self,
        plan_id: str,
        pack_id: str,
        strategy: str,
        delta: Optional[str],
        variant: Mapping[str, Any],
        seeds: Mapping[str, InstalledPayload],
        data_only: Optional[Dict[str, Optional[DataOnlyRefusalSeen]]] = None,
    ) -> ApplyResult:
        storage = self._storage

        def objects(sha256: str) -> Optional[ByteSource]:
            o = storage.staged_object(plan_id, sha256)
            return o.source() if o.size() > 0 or sha256 == _EMPTY_SHA256 else None

        out = storage.output(plan_id, variant["files"]["layout"])
        tree = out.tree
        if data_only is not None and tree is not None:
            tree = data_only_tree_sink(tree, data_only)
        ports = ApplyPorts(
            objects=objects, zstd=self._zstd, sha256=self._sha256, sink=out.sink, tree=tree
        )
        if strategy == "full":
            return apply_full(variant, ports)
        installed: List[InstalledFile] = []
        for s in seeds.values():
            installed.extend(s.files or [])
        if strategy == "file":
            return apply_file(variant, None, installed, ports)
        deltas = variant.get("deltas") or []
        k = next(
            (
                n
                for n, x in enumerate(deltas)
                if (x.get("scope") == "payload" and x["artifact"]["sha256"] == delta)
                or (x.get("scope") == "files" and x["patch"]["sha256"] == delta)
            ),
            -1,
        )
        d = deltas[k]
        if d["scope"] == "files":
            return apply_file(variant, k, installed, ports)
        base: Optional[ByteSource] = None
        for i in self._installs_of(pack_id):
            held = seeds.get(i["location"])
            if base is None and i["payloadSha256"] == d["from"] and held is not None and held.payload is not None:
                base = held.payload
        if base is None:
            return ApplyResult(verdict={"ok": False, "error": ErrorCode.DELTA_BASE_MISMATCH})
        return apply_delta(variant, k, base, ports)

    def _commit(
        self,
        pack_id: str,
        record_jws: str,
        record_sha256: str,
        record: Mapping[str, Any],
        variant: Mapping[str, Any],
        location: str,
        staging_plan: str,
        reused: bool,
        delegation: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Commit: the pointer swap, activation, garbage collection."""
        install: Dict[str, Any] = {
            "packId": pack_id,
            "record": record_jws,
            "recordSha256": record_sha256,
            "version": record["version"],
            "seq": record["seq"],
            "type": record["type"],
            "variant": variant_key(variant["variant"]),
            "layout": variant["files"]["layout"],
            "payloadSha256": variant["payload"]["sha256"],
            "payloadSize": variant["payload"]["size"],
            "activation": _activation_of(record, self._handlers.get(record["type"])),
            "location": location,
        }
        emb = self._embedded.get(pack_id)
        if emb is not None and emb["location"] == location:
            install["embedded"] = True
        install["installedAt"] = self._now()
        if delegation is not None:
            install["delegation"] = delegation
        # A fresh commit supersedes this pack's entries whose check could not run; an active one
        # becomes `previous`, re-verified before a rollback uses it.
        carried = self._deferred["active"].pop(pack_id, None)
        self._deferred["previous"].pop(pack_id, None)
        before = self._running.get(pack_id)
        self._doc = commit_install(self._require_loaded(), install)
        if carried is not None and carried["recordSha256"] != install["recordSha256"]:
            doc = dict(self._doc)
            doc["previous"] = dict(doc["previous"])
            doc["previous"][pack_id] = carried
            self._doc = doc
            self._unverified_previous.add(pack_id)
        else:
            self._unverified_previous.discard(pack_id)
        self._persist()
        if not reused:
            self._quiet(lambda: self._storage.remove_staging(staging_plan))
        h = self._handlers.get(record["type"])
        if install["activation"] == "hot":
            if before is not None and before["location"] != location and h is not None and h.deactivate is not None:
                h.deactivate(before)
            self._activate(install)
        self._collect()
        return install

    def _collect(self) -> None:
        """Remove every stored location and staging area no root holds."""
        if self._gc_hold:
            return
        locations, plans = gc_roots(
            self._require_loaded(), list(self._embedded.values()) + list(self._running.values())
        )
        locations |= self._unverifiable
        try:
            listed_locations, listed_plans = self._storage.list()
        except Exception:
            listed_locations, listed_plans = [], []
        held = self._hold_snapshot
        for loc in listed_locations:
            if loc not in locations and not (held is not None and loc in held[0]):
                self._quiet(lambda loc=loc: self._storage.remove(loc))  # type: ignore[misc]
        for pid in listed_plans:
            if pid not in plans and not (held is not None and pid in held[1]):
                self._quiet(lambda pid=pid: self._storage.remove_staging(pid))  # type: ignore[misc]

    def _download(
        self,
        plan_id: str,
        pack_id: str,
        sha256: str,
        nbytes: int,
        progress: Optional[Dict[str, int]],
    ) -> bool:
        """Stage one object: resume from what is staged (its bytes re-hashed, never trusted),
        fetch the rest with ``Range`` and ``If-Range``, checkpoint the journal. True when the
        staged object then has the ref's length and SHA-256; a mismatch resets it and refetches
        once from the start."""
        staged = self._storage.staged_object(plan_id, sha256)
        for _attempt in range(2):
            have = staged.size()
            if have > nbytes:
                staged.reset()
                have = 0
            hasher = self._sha256()
            if have > 0:
                src = staged.source()
                at = 0
                while at < have:
                    chunk = src.read(at, min(READ_CHUNK, have - at))
                    if not chunk:
                        break
                    hasher.update(chunk)
                    at += len(chunk)
            counted = have if progress is not None else 0
            if progress is not None:
                progress["done"] += counted
                self._emit(PackProgress(pack_id, "download", progress["done"], progress["total"]))
            if have < nbytes:
                try:
                    res = self._fetch_object(sha256, have, f'"{sha256}"' if have > 0 else None)
                except Exception:
                    return False
                if res.status == 200 and have > 0:
                    # The validator moved, so the server sent the whole object: start over.
                    if progress is not None:
                        progress["done"] -= counted
                    staged.reset()
                    outcome = self._fetch_into(staged, res, sha256, nbytes, self._sha256(), 0, plan_id, pack_id, progress)
                elif res.status == 206 and have > 0 and _range_starts_at(res.content_range, have):
                    outcome = self._fetch_into(staged, res, sha256, nbytes, hasher, have, plan_id, pack_id, progress)
                elif res.status == 200:
                    outcome = self._fetch_into(staged, res, sha256, nbytes, hasher, 0, plan_id, pack_id, progress)
                else:
                    _close(res)
                    return False
            else:
                outcome = "ok" if hasher.hexdigest() == sha256 else "mismatch"
            if outcome == "ok":
                return True
            if outcome == "interrupted":
                return False
            if progress is not None:
                progress["done"] -= min(staged.size(), nbytes)
            staged.reset()
        return False

    def _fetch_into(
        self,
        staged: Any,
        res: ObjectResponse,
        sha256: str,
        nbytes: int,
        hasher: Any,
        start: int,
        plan_id: str,
        pack_id: str,
        progress: Optional[Dict[str, int]],
    ) -> str:
        have = start
        since = 0

        def save() -> None:
            doc = self._doc
            j = doc["inflight"].get(pack_id) if doc is not None else None
            if j is None or j["planId"] != plan_id:
                return
            self._doc = checkpoint(doc, pack_id, sha256, have)  # type: ignore[arg-type]
            self._persist()

        try:
            for chunk in res.chunks:
                if have + len(chunk) > nbytes:
                    _close(res)
                    return "mismatch"
                hasher.update(chunk)
                staged.append(chunk)
                have += len(chunk)
                since += len(chunk)
                if progress is not None:
                    progress["done"] += len(chunk)
                    self._emit(PackProgress(pack_id, "download", progress["done"], progress["total"]))
                if since >= self._checkpoint_bytes:
                    since = 0
                    save()
        except Exception:
            try:
                save()
            except Exception:
                pass
            return "interrupted"
        save()
        return "ok" if have == nbytes and hasher.hexdigest() == sha256 else "mismatch"


def _close(res: ObjectResponse) -> None:
    close = getattr(res.chunks, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


def _target(t: Any) -> Tuple[str, Dict[str, Any]]:
    """A ``packs`` install entry as ``(pack, {"sha256", "seq", "version"})``: a mapping or a
    ``PackTarget``."""
    if isinstance(t, Mapping):
        pack, release = t["pack"], t["release"]
    else:
        pack, release = t.pack, t.release
    if not isinstance(release, Mapping):
        release = {"sha256": release.sha256, "seq": release.seq, "version": release.version}
    return pack, {"sha256": release["sha256"], "seq": release["seq"], "version": release["version"]}


def _install_delegation(i: Mapping[str, Any]) -> Optional[str]:
    """The delegation hash of a delegated install (its stored delegation and the record's kid),
    or ``None`` for a release-signed one."""
    return delegation_hash_of(i.get("record")) if isinstance(i.get("delegation"), str) else None
