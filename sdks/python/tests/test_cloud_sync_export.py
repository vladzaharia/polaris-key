# @pkey-feature sync.export
"""``client.cloud_sync.export()`` on the Python client (U-51.5; WIRE-CONTRACT-V5 §13.12): the host around the
export core, against a small fake of the Worker's sync and file routes (server mode). The corpus rows replay
in ``test_sync_crypto_conformance.py``; this file pins what the host adds: the precondition refusals, the
pulls and their bounds, ``Range`` reads, the destination rules (``0600`` at creation, exclusive create, no
symlink, a stale partial removed, the old destination surviving every failure), cancel and a full disk."""

from __future__ import annotations

import asyncio
import errno
import json
import os
import re
import stat
import threading
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import httpx
import pytest
from export_fixtures import read_zip
from helpers import PRODUCT, TOKEN, make_client
from test_cloud_sync_saves import SavesWorld, data, sha, signed_in

from polaris_key.cloud_sync import export_host
from polaris_key.cloud_sync.export import ZipStoreWriter
from polaris_key.cloud_sync.export_host import SyncExportError
from polaris_key.constants_generated import (
    SYNC_EXPORT_MAX_PULLS,
    SYNC_EXPORT_MAX_WAIT_MS,
    ErrorCode,
)
from polaris_key.core import sync_crypto as sc
from polaris_key.core.errors import PolarisError
from polaris_key.devices.store import InMemoryStore
from polaris_key.keyring.client import _GuardedFileCodec


class ExportWorld(SavesWorld):
    """SavesWorld plus the file ``GET`` of a named version, the revisions route and knobs for the pull."""

    def __init__(self) -> None:
        super().__init__()
        #: Every version a record ever held: ``{id: {version: (bytes, pointer)}}``.
        self.history: Dict[str, Dict[int, Any]] = {}
        self.ranges: List[str] = []
        self.pull_hook: Optional[Callable[[], Optional[httpx.Response]]] = None
        self.pulls = 0
        self.file_hook: Optional[Callable[[httpx.Request], Optional[httpx.Response]]] = None

    def add(self, id: str, versions: List[bytes]) -> None:
        """A record whose file went through ``versions`` (oldest first); the last is live."""
        self.history[id] = {}
        for blob in versions:
            self.version += 1
            ptr = {"version": self.version, "size": len(blob), "sha256": sha(blob), "format": "whole"}
            self.history[id][self.version] = (blob, ptr)
            self.stored[self.version] = blob
            self.rows[id] = {"value": {"name": id}, "version": self.version, "file": ptr}

    def __call__(self, r: httpx.Request) -> httpx.Response:
        path = r.url.path
        if path == f"/{PRODUCT}/sync" and r.method == "GET":
            self.pulls += 1
            if self.pull_hook is not None:
                hooked = self.pull_hook()
                if hooked is not None:
                    self.seen.append(r)
                    return hooked
        m = re.fullmatch(rf"/{PRODUCT}/sync/files/saves/([^/]+)(/revisions)?", path)
        if m and r.method == "GET" and m.group(1) in self.history:
            self.seen.append(r)
            if self.file_hook is not None:
                hooked = self.file_hook(r)
                if hooked is not None:
                    return hooked
            versions = self.history[m.group(1)]
            if m.group(2):
                revs = [ptr for _blob, ptr in versions.values()]
                return httpx.Response(200, json={"revisions": sorted(revs, key=lambda p: -p["version"])})
            q = r.url.params.get("version")
            version = int(q) if q is not None else max(versions)
            if version not in versions:
                return httpx.Response(404, json={"error": {"code": "not_found"}})
            blob = versions[version][0]
            self.ranges.append(r.headers.get("range", ""))
            rng = re.match(r"bytes=(\d+)-(\d+)", r.headers.get("range", ""))
            if not rng:
                return httpx.Response(200, content=blob)
            a, b = int(rng.group(1)), int(rng.group(2))
            return httpx.Response(206, content=blob[a : b + 1], headers={"content-range": f"bytes {a}-{b}/{len(blob)}"})
        return super().__call__(r)


def rig(tmp_path: Path, w: Optional[ExportWorld] = None) -> Any:
    w = w or ExportWorld()
    c = signed_in(w, tmp_path / "state")
    return w, c


def exported(path: Path) -> Dict[str, bytes]:
    return dict(read_zip(path.read_bytes()))


def data_json(entries: Dict[str, bytes]) -> Dict[str, Any]:
    out = json.loads(entries["data.json"])
    assert isinstance(out, dict)
    return out


def test_a_readable_zip_of_the_synced_files(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    blob = data(3000)
    w.add("slot-1", [blob])
    dest = tmp_path / "out.zip"
    result = c.cloud_sync.export(str(dest))
    entries = exported(dest)
    assert zipfile.ZipFile(dest).testzip() is None
    assert entries["stores/sync.cloudSync/files/0.bin"] == blob
    assert result["path"] == str(dest) and result["bytes"] == dest.stat().st_size
    assert (result["entries"], result["records"], result["files"], result["settings"]) == (len(entries), 1, 1, 0)
    assert result["skipped"] == [] and result["unsynced"] == 0
    d = data_json(entries)
    assert d["schema"] == "pkey-sync-export/1" and d["encryption"] == "server" and d["product"] == PRODUCT
    # The partial is gone and nothing else was left beside the archive.
    assert sorted(p.name for p in tmp_path.iterdir() if p.name != "state") == ["out.zip"]
    c.close()


def test_the_partial_is_created_exclusively_at_0600_without_following_links(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(100)])
    opened: List[Any] = []
    real = os.open

    def spy(path: Any, flags: int, mode: int = 0o777, **kw: Any) -> int:
        if str(path).endswith(".partial"):
            opened.append((flags, mode))
        return real(path, flags, mode, **kw)

    old = os.umask(0)
    try:
        export_host.os.open = spy  # type: ignore[attr-defined]
        try:
            c.cloud_sync.export(str(tmp_path / "out.zip"))
        finally:
            export_host.os.open = real  # type: ignore[attr-defined]
        assert stat.S_IMODE((tmp_path / "out.zip").stat().st_mode) == 0o600
    finally:
        os.umask(old)
    ((flags, mode),) = opened
    assert mode == 0o600 and flags & os.O_CREAT and flags & os.O_EXCL
    assert flags & getattr(os, "O_NOFOLLOW", 0) == getattr(os, "O_NOFOLLOW", 0)
    c.close()


def test_a_stale_partial_is_removed_at_the_start(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(100)])
    dest = tmp_path / "out.zip"
    stale = Path(str(dest) + ".partial")
    stale.write_bytes(b"left by a crash")
    c.cloud_sync.export(str(dest))
    assert not stale.exists() and zipfile.ZipFile(dest).testzip() is None
    c.close()


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symlinks")
def test_a_planted_partial_symlink_is_refused_and_its_target_untouched(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(100)])
    dest = tmp_path / "out.zip"
    target = tmp_path / "victim.txt"
    target.write_text("keep me")
    os.symlink(target, str(dest) + ".partial")
    with pytest.raises(SyncExportError) as e:
        c.cloud_sync.export(str(dest))
    assert e.value.code == ErrorCode.SYNC_EXPORT_FAILED and e.value.reason == "destination"
    assert target.read_text() == "keep me" and not dest.exists()
    assert os.path.islink(str(dest) + ".partial")
    c.close()


def test_a_destination_that_is_not_a_regular_file_is_refused(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(100)])
    d = tmp_path / "dir"
    d.mkdir()
    with pytest.raises(SyncExportError) as e:
        c.cloud_sync.export(str(d))
    assert e.value.reason == "destination" and d.is_dir() and not Path(str(d) + ".partial").exists()
    with pytest.raises(SyncExportError) as e2:
        c.cloud_sync.export(str(tmp_path / "missing-dir" / "out.zip"))
    assert e2.value.reason == "destination"
    c.close()


def test_a_full_disk_is_a_destination_failure_and_the_old_file_survives(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(5000)])
    dest = tmp_path / "out.zip"
    dest.write_bytes(b"the earlier export")
    real = export_host._PartialFile._open

    class Full:
        def __init__(self, f: Any) -> None:
            self.f = f
            self.n = 0

        def write(self, b: bytes) -> int:
            self.n += len(b)
            if self.n > 2000:
                raise OSError(errno.ENOSPC, "No space left on device")
            return int(self.f.write(b))

        def __getattr__(self, name: str) -> Any:
            return getattr(self.f, name)

    export_host._PartialFile._open = lambda self: Full(real(self))  # type: ignore[method-assign]
    try:
        with pytest.raises(SyncExportError) as e:
            c.cloud_sync.export(str(dest))
    finally:
        export_host._PartialFile._open = real  # type: ignore[method-assign]
    assert e.value.reason == "destination" and ErrorCode.SYNC_EXPORT_FAILED == e.value.code
    assert dest.read_bytes() == b"the earlier export" and not Path(str(dest) + ".partial").exists()
    c.close()


def test_a_cancel_removes_the_partial_and_leaves_the_old_destination(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(3000)])
    dest = tmp_path / "out.zip"
    dest.write_bytes(b"the earlier export")
    cancel = threading.Event()
    seen: List[Dict[str, Any]] = []

    def progress(p: Dict[str, Any]) -> None:
        seen.append(p)
        cancel.set()

    with pytest.raises(PolarisError) as e:
        c.cloud_sync.export(str(dest), on_progress=progress, cancel=cancel)
    assert e.value.code == ErrorCode.CANCELLED and seen and seen[0]["total"] == 3000
    assert dest.read_bytes() == b"the earlier export" and not Path(str(dest) + ".partial").exists()
    # Cancelled before it starts: nothing is read and nothing is created.
    before = len(w.seen)
    pre = threading.Event()
    pre.set()
    with pytest.raises(PolarisError) as e2:
        c.cloud_sync.export(str(tmp_path / "other.zip"), cancel=pre)
    assert e2.value.code == ErrorCode.CANCELLED and len(w.seen) == before and not (tmp_path / "other.zip").exists()
    c.close()


def test_nothing_is_created_when_the_plan_is_refused(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(100)])
    from polaris_key.cloud_sync import export as core

    real = core.SYNC_EXPORT_MAX_BYTES
    core.SYNC_EXPORT_MAX_BYTES = 10  # type: ignore[misc]
    try:
        with pytest.raises(PolarisError) as e:
            c.cloud_sync.export(str(tmp_path / "out.zip"))
    finally:
        core.SYNC_EXPORT_MAX_BYTES = real  # type: ignore[misc]
    assert e.value.code == ErrorCode.SYNC_EXPORT_TOO_LARGE
    assert sorted(p.name for p in tmp_path.iterdir() if p.name != "state") == []
    c.close()


def test_files_are_read_in_ranges_and_revisions_follow_the_live_file(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    old, new = data(2500, 3), data(2200, 5)
    w.add("slot-1", [old, new])
    real = export_host.DOWNLOAD_RANGE_BYTES
    export_host.DOWNLOAD_RANGE_BYTES = 1000
    try:
        dest = tmp_path / "out.zip"
        c.cloud_sync.export(str(dest), include_revisions=True)
    finally:
        export_host.DOWNLOAD_RANGE_BYTES = real
    entries = exported(dest)
    assert entries["stores/sync.cloudSync/files/0.bin"] == new
    assert entries["stores/sync.cloudSync/files/1.bin"] == old
    items = json.loads(entries["stores/sync.cloudSync/files.json"])
    assert [(i["live"], i["size"]) for i in items] == [(True, 2200), (False, 2500)]
    assert set(w.ranges) >= {"bytes=0-999", "bytes=1000-1999", "bytes=2000-2199", "bytes=2000-2499"}
    c.close()


def test_a_revision_the_worker_no_longer_has_is_listed_partial_never_dropped(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(500, 1), data(600, 2)])
    first = min(w.history["slot-1"])
    gone = httpx.Response(404, json={"error": {"code": "not_found"}})
    w.file_hook = lambda r: gone if r.url.params.get("version") == str(first) else None
    dest = tmp_path / "out.zip"
    result = c.cloud_sync.export(str(dest), include_revisions=True)
    assert [s["partial"] for s in result["skipped"] if s["kind"] == "file"] == [True]
    items = json.loads(exported(dest)["stores/sync.cloudSync/files.json"])
    assert items[1]["partial"] is True and items[1]["size"] == 0 and items[1]["expectedSize"] == 500
    c.close()


def test_a_worker_that_answers_a_range_with_another_range_ends_the_file_short(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(3000)])
    w.file_hook = lambda r: (
        httpx.Response(206, content=b"x" * 10, headers={"content-range": "bytes 5-14/3000"})
        if r.headers.get("range")
        else None
    )
    dest = tmp_path / "out.zip"
    result = c.cloud_sync.export(str(dest))
    assert [(s["kind"], s["code"], s["partial"]) for s in result["skipped"]] == [("file", "sync-file-invalid", True)]
    assert exported(dest)["stores/sync.cloudSync/files/0.bin"] == b""
    c.close()


def test_a_pull_that_never_ends_fails_as_network_after_the_bound(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(100)])
    page = {"n": 0}

    def endless() -> httpx.Response:
        page["n"] += 1
        return httpx.Response(200, json=w.body(cursor=1000 + page["n"], more=True, changes=[]))

    w.pull_hook = endless
    base = w.pulls
    with pytest.raises(SyncExportError) as e:
        c.cloud_sync.export(str(tmp_path / "out.zip"))
    assert e.value.reason == "network" and w.pulls - base >= SYNC_EXPORT_MAX_PULLS
    assert not (tmp_path / "out.zip").exists()
    c.close()


def test_the_waits_add_up_to_a_bound_and_a_cancel_ends_one(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(100)])
    limited = {"error": {"code": "rate_limited"}}
    w.pull_hook = lambda: httpx.Response(429, headers={"retry-after": "100000"}, json=limited)
    waits: List[float] = []
    exporter = c.cloud_sync._exporter
    exporter._sleep = lambda seconds, cancel: waits.append(seconds)
    with pytest.raises(SyncExportError) as e:
        c.cloud_sync.export(str(tmp_path / "out.zip"))
    assert e.value.reason == "network"
    # One wait is cut to the Retry-After bound, and the sum never passes the total bound.
    assert waits and max(waits) == 900 and sum(waits) * 1000 <= SYNC_EXPORT_MAX_WAIT_MS

    def cancelling(seconds: float, cancel: threading.Event) -> None:
        cancel.set()

    exporter._sleep = cancelling
    with pytest.raises(PolarisError) as e2:
        c.cloud_sync.export(str(tmp_path / "out.zip"))
    assert e2.value.code == ErrorCode.CANCELLED
    c.close()


def test_one_export_at_a_time(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(100)])
    exporter = c.cloud_sync._exporter
    assert exporter._busy.acquire(blocking=False)
    try:
        with pytest.raises(SyncExportError) as e:
            c.cloud_sync.export(str(tmp_path / "out.zip"))
        assert e.value.reason == "busy"
    finally:
        exporter._busy.release()
    c.cloud_sync.export(str(tmp_path / "out.zip"))
    c.close()


def test_no_session_is_account_required_and_reads_nothing(tmp_path: Path) -> None:
    w = ExportWorld()
    store = InMemoryStore(PRODUCT, device_id="DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB")
    store.set_token(TOKEN)
    c = make_client(
        w,
        store=store,
        state_dir=str(tmp_path / "state"),
        expected_services=["license", "config", "sync"],
        cloud_sync={"encryption": "server"},
    )
    before = len(w.sync_reqs)
    with pytest.raises(PolarisError) as e:
        c.cloud_sync.export(str(tmp_path / "out.zip"))
    assert e.value.code == ErrorCode.ACCOUNT_REQUIRED and len(w.sync_reqs) == before
    c.close()


def test_a_product_without_sync_gets_the_typed_na(tmp_path: Path) -> None:
    w = ExportWorld()
    c = make_client(w, state_dir=str(tmp_path / "state"), expected_services=["license", "config"])
    with pytest.raises(PolarisError) as e:
        c.cloud_sync.export(str(tmp_path / "out.zip"))
    assert getattr(e.value, "reason", None) == "product"
    c.close()


def test_the_async_client_cancels_and_cleans_up(tmp_path: Path) -> None:
    w, c = rig(tmp_path)
    w.add("slot-1", [data(3000)])
    dest = tmp_path / "out.zip"
    from polaris_key.aio import AsyncPolarisKeyClient

    async def main() -> None:
        a = AsyncPolarisKeyClient(c)
        started = threading.Event()
        gate = threading.Event()

        def hold(p: Dict[str, Any]) -> None:
            started.set()
            gate.wait(5)

        cancel = threading.Event()
        task = asyncio.ensure_future(a.cloud_sync.export(str(dest), on_progress=hold, cancel=cancel))
        while not started.is_set():
            await asyncio.sleep(0.01)
        task.cancel()
        # The export is held in its progress callback until the task's cancellation has reached it.
        while not cancel.is_set():
            await asyncio.sleep(0.01)
        gate.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not dest.exists() and not Path(str(dest) + ".partial").exists()
        # A normal export awaits to the result.
        assert (await a.cloud_sync.export(str(dest)))["files"] == 1

    asyncio.run(main())
    assert zipfile.ZipFile(dest).testzip() is None
    c.close()


def test_the_zip_writer_refuses_past_zip32_before_writing_and_lists_the_order_it_is_given() -> None:
    class Collect:
        def __init__(self) -> None:
            self.parts: List[bytes] = []

        def write(self, b: bytes) -> None:
            self.parts.append(b)

    sink = Collect()
    z = ZipStoreWriter(sink, limit=400)
    z.add_bytes("b", b"B" * 10)
    z.add_bytes("a", b"A" * 10)
    z.finish(["a", "b"])
    import io

    zf = zipfile.ZipFile(io.BytesIO(b"".join(sink.parts)))
    assert [i.filename for i in zf.infolist()] == ["a", "b"] and zf.testzip() is None
    tight = Collect()
    w = ZipStoreWriter(tight, limit=150)
    w.begin("x")
    wrote = len(tight.parts)
    with pytest.raises(PolarisError) as e:
        w.write(b"y" * 200)
    assert e.value.code == ErrorCode.SYNC_EXPORT_TOO_LARGE and len(tight.parts) == wrote


def test_an_e2e_file_codec_stops_planned_reads_when_the_root_goes() -> None:
    from polaris_key.cloud_sync.transfer_codec import E2eFileCodec

    root = bytes(range(32))
    held = {"live": True}
    codec = _GuardedFileCodec(E2eFileCodec(root, "saves"), lambda: held["live"])
    plain = data(2_500_000)
    stored = sc_seal(root, plain)
    pieces = codec.open_planned([stored[:70000], stored[70000:]], len(plain))
    assert next(pieces) == plain[:1_048_576]
    held["live"] = False
    with pytest.raises(Exception) as e:
        next(pieces)
    assert getattr(e.value, "code", None) == ErrorCode.SYNC_LOCKED


def sc_seal(root: bytes, plain: bytes) -> bytes:
    from polaris_key.core import sync_files as sf

    return sf.seal_file(sc.derive_coll_key(root, "saves"), sc.derive_kid(root), plain)


