"""``client.update.packs`` — the Python pack facet (plans/P4-01.md §2.6–§2.9, §5; CONTENT §10,
§13; P4-07), a port of ``@polaris-key/node``'s ``packs/client.ts``. It is :class:`PackEngine` with
Python's ports:

  transport  the pinned pack record from discovery's ``release.endpoints.record``, objects from
             ``distribution.endpoints.blobs`` (``{sha256}``) with ``Range``/``If-Range`` over
             httpx streaming, the device bearer sent only to the control plane's own origin; any
             answer but 200/206 (a 403 ``delivery_gate_missing`` or ``not_entitled`` included) is
             a failed fetch;
  storage    :class:`DirPackStorage` under the platform data directory (P1b-09), excluded from
             backups: a versioned directory per tree payload and an atomic pointer swap in
             ``state.json``;
  zstd       ``compression.zstd`` on 3.14+, ``zstandard`` below (:func:`select_python_zstd`);
  SHA-256    ``hashlib``, streaming.

The running build's pins come from its content stamp (``content_stamp``, a file among the app's
own read-only resources, never a user-writable path): a host without a stamp has no packs.
Embedded baselines are verified once — marker, bytes, stamp pin — and then count as installed.
The active set's ``packSetId`` rides on ``devices/report`` as ``content``.
"""

from __future__ import annotations

import os
import secrets
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Set, Union
from urllib.parse import quote, urljoin, urlsplit

from ...constants_generated import MAX_RECORD_JWS_BYTES, ErrorCode, Feature
from ...core.dirs import exclude_from_backup
from ...discovery import service_endpoint
from .boot import boot_pack_options, run_boot_fetch
from .engine import (
    EmbeddedBaseline,
    ObjectResponse,
    PackEngine,
    PackError,
    PackHandler,
    PackProgress,
    PacksSnapshot,
    RevocationsSnapshot,
)
from .provides import PackProvider
from .sets import parse_content_stamp, stamp_holds
from .storage import DirPackStorage, directory_tree_digest, measure_file
from .zstd import ZstdInfo, select_python_zstd

__all__ = ["PacksOptions", "EmbeddedPack", "PacksClient"]

_DEFAULT_MEM_BUDGET = 256 * 1024 * 1024


@dataclass(frozen=True)
class EmbeddedPack:
    """One embedded baseline the host ships: a single payload file (its marker beside it as
    ``<file>.pkey.json``) or a tree directory (its marker inside as ``.pkey/pack.json``)."""

    path: str
    #: The marker file, when it is not at the conventional place.
    marker: Optional[str] = None


@dataclass(frozen=True)
class PacksOptions:
    """``update.packs`` options (``UpdateClientOptions(packs=...)``)."""

    #: The content stamp (``pkey-content.json``): a path among the app's own read-only resources,
    #: or its bytes. Without one the client has no packs (``ensure`` raises ``not-configured``).
    content_stamp: Optional[Union[str, bytes]] = None
    #: Embedded baselines, verified once at load and then used as installed state.
    embedded: Sequence[Union[EmbeddedPack, str]] = ()
    #: Variant preferences, per axis, in preference order (``{"locale": ["fr", "en"]}``).
    axes: Mapping[str, Sequence[str]] = field(default_factory=dict)
    #: ``godot-<major>.<minor>`` for a host that runs Godot packs; ``None`` otherwise.
    engine: Optional[str] = None
    #: The most memory one delta frame may take (``memBytes``). Default 256 MiB.
    mem_budget: int = _DEFAULT_MEM_BUDGET
    #: Where staging, the store and ``state.json`` live. Default ``<data dir>/packs``.
    dir: Optional[str] = None
    #: Extra handlers (P4-16 types, game-registered ``custom.*``). ``files.tree`` is built in.
    handlers: Sequence[PackHandler] = ()
    #: ``auto`` (the default) prefers ``compression.zstd``, else ``zstandard``; ``stdlib`` and
    #: ``zstandard`` force one.
    zstd: str = "auto"
    #: Exclude the store from backups when it is first created (P1b-09). Default true.
    exclude_from_backup: bool = True


def _detached(args: Sequence[str]) -> None:
    """``tmutil`` can take seconds, so it runs detached and never blocks a boot."""
    subprocess.Popen(  # noqa: S603 - fixed argv
        list(args),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _exclude_once(root: str) -> None:
    """Mark the store excluded from backups the first time it exists (its ``CACHEDIR.TAG`` is
    the record)."""
    if os.path.exists(os.path.join(root, "CACHEDIR.TAG")):
        return
    exclude_from_backup(root, run=_detached)


def _origin(url: str) -> tuple:
    parts = urlsplit(url)
    return (parts.scheme.lower(), parts.netloc.lower())


class _Body:
    """An object body that holds its httpx stream open until it is read through or closed."""

    def __init__(self, res: Any) -> None:
        self._res = res

    def __iter__(self) -> Iterator[bytes]:
        try:
            for chunk in self._res.iter_bytes():
                if chunk:
                    yield chunk
        finally:
            self._res.close()

    def close(self) -> None:
        self._res.close()


class PacksClient:
    """The pack facet: ``ensure``, ``ensure_releases``, ``state``, ``path``,
    ``register_handler``, ``on``, ``pack_set_id``, ``confirm``, ``recover_state``, ``rollback``,
    ``boot_options``, ``boot_fetch``, ``revocations``, ``content_input``,
    ``record_revocations``, ``zstd`` and ``refused_embedded``."""

    def __init__(
        self,
        ctx: Any,
        tokens: Any,
        discovery: Callable[[], Optional[Dict[str, Any]]],
        *,
        release_keys: Callable[[], Dict[str, str]],
        discover: Optional[Callable[[], Any]] = None,
        cache: Any = None,
        trust: Any = None,
        options: Optional[PacksOptions] = None,
        feed_deltas: Optional[Callable[[], Optional[Mapping[str, Any]]]] = None,
        load_feed_deltas: Optional[Callable[[], None]] = None,
    ) -> None:
        self._ctx = ctx
        #: plans/P4-29.md §2.4 step 1: the committed feed's delta menu (fresh or stale), and the
        #: read of it from the cache before the engine first plans.
        self._feed_deltas = feed_deltas
        self._load_feed_deltas = load_feed_deltas
        self._tokens = tokens
        self._discovery = discovery
        self._discover = discover
        self._cache = cache
        self._trust = trust
        self._release_keys = release_keys
        self._opts = options if options is not None else PacksOptions()
        self._engine: Optional[PackEngine] = None
        self._building: Optional[PackEngine] = None
        self._pending_handlers: List[PackHandler] = []
        self._listeners: List[Callable[[PackProgress], None]] = []
        self._zstd_info: Optional[ZstdInfo] = None
        self._refused: List[Dict[str, str]] = []
        self._lock = threading.RLock()

    @property
    def configured(self) -> bool:
        """Whether the host configured a content stamp (and so may have packs)."""
        return self._opts.content_stamp is not None

    def ensure(self, pack_ids: Sequence[str]) -> List[Dict[str, Any]]:
        """Install the pinned release of each pack (CONTENT §10): already-current packs return at
        once; others are fetched, verified, committed and (for ``hot`` types) activated. Raises a
        :class:`PackError` (``not-configured``, ``pack-not-pinned``, ``record-rejected``,
        ``record-mismatch``, ``pack-type-unsupported``, ``pack-not-entitled``,
        ``pack-no-variant``, a ``plan-*`` or applier code, or ``network-error``, after which the
        next ``ensure`` resumes the download)."""
        self._ctx.require_service("release", Feature.PACKS_STATE)
        return self._start().ensure(pack_ids)

    def ensure_releases(self, targets: Sequence[Any]) -> List[Dict[str, Any]]:
        """Install exact releases: a ``packs`` decision's ``install`` list (plans/P4-13.md §2.6).
        Raises ``pack-revoked`` for a release a verified revocation names."""
        self._ctx.require_service("release", Feature.PACKS_STATE)
        return self._start().ensure_releases(targets)

    def revocations(self) -> RevocationsSnapshot:
        """The stored and this process's verified revocations, and ``relearn`` (plans/P4-13.md
        §2.5)."""
        return self._start().revocations()

    def content_input(self) -> Optional[Any]:
        """The update check's content input (plans/P4-13.md §2.5, §2.6): the stamp and its
        holds, the running releases (embedded baselines included), the variant preferences and
        the stored revocations. ``None`` when the host configured no content stamp."""
        from ...core.check import UpdateCheckContent
        from ...core.models import ReleasePin

        if not self.configured:
            return None
        engine = self._start()
        stamp = self._read_stamp()
        if stamp is None:
            return None
        active = {
            pid: ReleasePin(sha256=i["recordSha256"], seq=i["seq"], version=i["version"])
            for pid, i in engine.state().running.items()
        }
        revs = engine.revocations()
        return UpdateCheckContent(
            stamp=stamp,
            holds=stamp_holds(self._stamp_bytes()),
            active=active,
            engine=self._opts.engine,
            axes={k: list(v) for k, v in self._opts.axes.items()},
            revoked=revs.verified,
            relearn=revs.relearn,
            # plans/P4-19.md §2.7: the delegated releases the engine knows.
            delegated=engine.delegated_releases(),
        )

    def record_revocations(self, revocations: Any) -> None:
        """Keep the revocations an update check verified (the engine's
        ``record_revocations``): ``revocations`` is ``UpdateCheckResult.revocations``."""
        self._start().record_revocations(
            revocations.learned, relearn_cleared=revocations.relearn_cleared
        )

    def state(self) -> PacksSnapshot:
        """The install state and this process's running set."""
        return self._start().state()

    def path(self, pack_id: str) -> Optional[str]:
        """The directory of a pack's running tree payload, or ``None`` when it is not running."""
        i = self.state().running.get(pack_id)
        return i["location"] if i is not None and i["layout"] == "tree" else None

    def register_handler(self, handler: PackHandler) -> None:
        """Add a handler for a pack type (CONTENT §4.1)."""
        engine = self._engine or self._building
        if engine is not None:
            engine.register_handler(handler)
        else:
            self._pending_handlers.append(handler)

    def on(self, listener: Callable[[PackProgress], None]) -> Callable[[], None]:
        """Progress events (``download``, ``apply``, ``done``, ``state-issue``); returns the
        unsubscribe function."""
        self._listeners.append(listener)

        def off() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return off

    def pack_set_id(self) -> Optional[str]:
        """The running set's ``packSetId`` (plans/P4-01.md §2.9); ``None`` without packs."""
        if not self.configured:
            return None
        try:
            return self._start().pack_set_id()
        except Exception:
            return None

    def is_available(self, content_id: str) -> bool:
        """Save compatibility (P4-20, CONTENT §6.7 item 8): whether a pack release in the
        running set (restart packs mounted at this boot, hot packs active in this process,
        embedded baselines included) provides ``content_id`` in its record's ``provides``.
        ``False`` without a content stamp."""
        if not self.configured:
            return False
        return self._start().is_available(content_id)

    def pack_for(self, content_id: str, targets: Optional[Sequence[Any]] = None) -> Optional[PackProvider]:
        """The pack whose target release provides ``content_id`` (the stamp's pins, or
        ``targets``: a ``packs`` decision's install list), to ``estimate`` and ``ensure`` before a
        save that needs it. Reads only records (fetched by hash and verified); ``None`` when no
        target provides it or without a content stamp."""
        if not self.configured:
            return None
        return self._start().pack_for(content_id, targets)

    def confirm(self) -> None:
        """Mark this boot healthy (CONTENT §10 step 7)."""
        self._start().confirm()

    def recover_state(self) -> None:
        """Operator recovery after a torn ``state.json`` (held aside as ``state.json.torn``;
        garbage collection waits until this is called). See ``state().state_issue``."""
        self._start().recover_state()

    def rollback(self, pack_id: str) -> bool:
        """Re-point a pack at the install it replaced."""
        return self._start().rollback(pack_id)

    def boot_options(self) -> Dict[str, List[str]]:
        """The boot stage machine's pack options from the content stamp (plans/P4-01.md §2.10):
        ``requiredPacks`` and ``essentialPacks``, for ``initial_boot_state``."""
        return boot_pack_options(self._read_stamp())

    def boot_fetch(
        self,
        send: Callable[[Dict[str, Any]], None],
        *,
        consent: str = "metered",
        metered: bool = False,
        answer: Optional[Callable[[int, bool], bool]] = None,
        install: Optional[Sequence[Any]] = None,
    ) -> Dict[str, Any]:
        """The boot's FETCH stage (the stage machine's host side): estimate the required and
        essential packs, send ``fetch.consent`` when the policy asks, download with
        ``fetch.progress``, and send ``fetch.done {result, installed}`` through ``send``.
        ``install`` is a ``packs`` decision's list (plans/P4-13.md §2.5): its required and
        essential entries install here; the rest come back in ``background``."""
        engine = self._start()
        return run_boot_fetch(
            engine,
            stamp=self._read_stamp(),
            send=send,
            consent=consent,
            metered=metered,
            answer=answer,
            install=install,
        )

    def zstd(self) -> ZstdInfo:
        """Which library decodes frames, and whether ``zstd-patch-from`` passed the probe."""
        self._start()
        assert self._zstd_info is not None
        return self._zstd_info

    def refused_embedded(self) -> List[Dict[str, str]]:
        """The embedded baselines ``load`` refused, by marker step."""
        self._start()
        return list(self._refused)

    # ── Internals ──────────────────────────────────────────────────────────────────────────

    def _start(self) -> PackEngine:
        with self._lock:
            if self._engine is not None:
                return self._engine
            try:
                self._engine = self._boot()
            finally:
                self._building = None
            return self._engine

    def _boot(self) -> PackEngine:
        ctx = self._ctx
        stamp = self._read_stamp()
        zstd, info = select_python_zstd(self._opts.zstd)
        self._zstd_info = info
        root = self._opts.dir if self._opts.dir is not None else os.path.join(ctx.dirs.data, "packs")
        storage = DirPackStorage(root)
        storage.free_disk()  # creates the root
        if self._opts.exclude_from_backup:
            _exclude_once(storage.root)
        # plans/P4-19.md §2.4: the engine sees the stamp's holds, so a hold's release never takes
        # the delegated path. Unusable stamp holds (`stamp_holds` gives None) are treated as no
        # holds: the record hash a decision names still binds the bytes.
        holds = stamp_holds(self._stamp_bytes()) if stamp is not None else None
        engine = PackEngine(
            product=ctx.product,
            release_keys=self._release_keys(),
            product_trust=lambda: self._trust.effective if self._trust is not None else ctx.pinned_trust,
            stamp={**stamp, "holds": holds} if stamp is not None and holds else stamp,
            prefs={"engine": self._opts.engine, "axes": dict(self._opts.axes)},
            zstd=zstd,
            patch_methods=info.patch_methods,
            mem_budget=self._opts.mem_budget,
            storage=storage,
            state=storage.state_store(),
            revocations=storage.revocation_store(),
            fetch_record=self._fetch_record,
            fetch_object=self._fetch_object,
            supports_range=True,
            entitlements=self._entitlements,
            now=lambda: ctx.now(),
            new_plan_id=lambda: secrets.token_hex(12),
            handlers=list(self._opts.handlers) + list(self._pending_handlers),
            feed_deltas=self._feed_deltas,
        )
        if self._load_feed_deltas is not None:
            try:
                self._load_feed_deltas()
            except Exception:
                pass
        engine.on(self._forward)
        # A handler registered while the engine loads goes straight to it.
        self._building = engine
        embedded = self._embedded_baselines()
        self._refused.extend(engine.load(embedded)["refused"])
        return engine

    def _forward(self, e: PackProgress) -> None:
        for listener in list(self._listeners):
            try:
                listener(e)
            except Exception:
                pass  # A listener never fails an install.

    def _stamp_bytes(self) -> bytes:
        src = self._opts.content_stamp
        if isinstance(src, (bytes, bytearray)):
            return bytes(src)
        try:
            with open(src, "rb") as f:  # type: ignore[arg-type]
                return f.read()
        except Exception:
            raise PackError(
                ErrorCode.CONTENT_STAMP_INVALID, "The content stamp cannot be read."
            ) from None

    def _read_stamp(self) -> Optional[Dict[str, Any]]:
        if self._opts.content_stamp is None:
            return None
        data = self._stamp_bytes()
        r = parse_content_stamp(data)
        if not r.ok:
            raise PackError(
                ErrorCode.CONTENT_STAMP_INVALID,
                "The content stamp is not a valid pkey-content/1 document.",
            )
        return r.content

    def _embedded_baselines(self) -> List[EmbeddedBaseline]:
        out: List[EmbeddedBaseline] = []
        for e in self._opts.embedded:
            pack = EmbeddedPack(path=e) if isinstance(e, str) else e
            try:
                is_dir = os.path.isdir(pack.path)
                marker_path = pack.marker or (
                    os.path.join(pack.path, ".pkey", "pack.json") if is_dir else pack.path + ".pkey.json"
                )
                with open(marker_path, "rb") as f:
                    marker = f.read()
                if is_dir:
                    payload: Dict[str, Any] = {"kind": "tree", "treeDigest": directory_tree_digest(pack.path)}
                else:
                    payload = {"kind": "file", **measure_file(pack.path)}
                out.append(EmbeddedBaseline(marker=marker, payload=payload, location=pack.path))
            except Exception:
                self._refused.append({"location": pack.path, "step": "format"})
        return out

    def _entitlements(self) -> Optional[Set[str]]:
        """The licence's granted boolean flags, or ``None`` when the product runs no License."""
        if not self._ctx.enabled("license"):
            return None
        granted: Set[str] = set()
        doc = self._cache.license_doc() if self._cache is not None else None
        if doc is not None:
            for k, v in doc.entitlements.items():
                if getattr(v, "value", None) is True:
                    granted.add(k)
        return granted

    def _template(self, service: str, name: str) -> Optional[str]:
        doc = self._discovery()
        if doc is None and self._discover is not None:
            try:
                self._discover()
            except Exception:
                pass  # Discovery unreachable: the fetch fails as a transport failure.
            doc = self._discovery()
        return service_endpoint(doc, service, name)

    def _expand(self, template: str, sha256: str) -> str:
        url = template.replace("{sha256}", quote(sha256, safe="-_.!~*'()"))
        return urljoin(self._ctx.base_url.rstrip("/") + "/", url)

    def _auth(self, url: str) -> Dict[str, str]:
        token = self._tokens.current
        if token and _origin(url) == _origin(self._ctx.base_url):
            return {"authorization": f"Bearer {token}"}
        return {}

    def _fetch_record(self, sha256: str) -> Dict[str, Any]:
        t = self._template("release", "record")
        if t is None:
            return {"ok": False, "code": ErrorCode.SERVICE_UNAVAILABLE}
        try:
            url = self._expand(t, sha256)
            headers = {"accept": "application/jose", **self._auth(url)}
            with self._ctx.http().stream(
                "GET", url, headers=self._ctx.headers(headers), timeout=self._ctx.timeout
            ) as res:
                if not res.is_success:
                    return {"ok": False, "code": ErrorCode.NETWORK_ERROR}
                # A record over the bound is refused at step `hash` without hashing; never
                # buffer more than one byte past it.
                limit = MAX_RECORD_JWS_BYTES + 1
                chunks: List[bytes] = []
                total = 0
                for chunk in res.iter_bytes():
                    chunks.append(chunk)
                    total += len(chunk)
                    if total >= limit:
                        break
                data = b"".join(chunks)[:limit]
            return {"ok": True, "body": data.decode("utf-8", errors="replace")}
        except Exception:
            return {"ok": False, "code": ErrorCode.NETWORK_ERROR}

    def _fetch_object(
        self, sha256: str, offset: int, if_range: Optional[str], length: Optional[int] = None
    ) -> ObjectResponse:
        """One object by hash. httpx's read timeout applies per read, so it is an idle timeout:
        a large payload is never cut off for taking longer than one request may. With ``length``
        (P4-11's chunk runs) the request is the single bounded range ``bytes=<o>-<o+length-1>``
        with ``Accept-Encoding: identity`` (a compressed answer would break the byte range), never
        a multi-range. Redirects are never followed, so the bearer never reaches another host."""
        t = self._template("distribution", "blobs")
        if t is None:
            raise PackError(ErrorCode.SERVICE_UNAVAILABLE, "Discovery names no blob endpoint.")
        url = self._expand(t, sha256)
        headers = dict(self._auth(url))
        if length is not None:
            if not isinstance(length, int) or isinstance(length, bool) or length < 1 or offset < 0:
                raise PackError(ErrorCode.INVALID_OPTIONS, "A ranged object fetch needs a length of at least 1.")
            headers["range"] = f"bytes={offset}-{offset + length - 1}"
            headers["accept-encoding"] = "identity"
        elif offset > 0:
            headers["range"] = f"bytes={offset}-"
        if if_range is not None:
            headers["if-range"] = if_range
        client = self._ctx.http()
        req = client.build_request("GET", url, headers=self._ctx.headers(headers), timeout=self._ctx.timeout)
        res = client.send(req, stream=True, follow_redirects=False)
        return ObjectResponse(
            status=res.status_code,
            content_range=res.headers.get("content-range"),
            chunks=_Body(res),
            etag=res.headers.get("etag"),
        )
