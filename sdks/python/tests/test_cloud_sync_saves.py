# @pkey-feature sync.saves sync.files
"""``client.cloud_sync.saves`` on the Python client (U-22.5). Mirrors ``cloudSyncSaves.test.ts``.

List, read, write and delete a save over the machine's records binding and the file transport, against a
small fake of the Worker's sync and file routes (server mode, whole-file uploads). It pins the order (file
first, then the metadata ``set`` at the version ``finalize`` answered), the transfer events, ``transfers()``,
a conflict that reports the server copy, and the journal and chunk cache going with the person.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from pathlib import Path
from typing import Any, Dict, List

import httpx
import pytest
from helpers import PRODUCT, TOKEN, make_client
from test_cloud_sync_host import SUBJECT, World

from polaris_key.constants_generated import TransferEvent
from polaris_key.devices.store import InMemoryStore


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class SavesWorld(World):
    """The Worker's saves, as far as a whole-file save needs."""

    def __init__(self) -> None:
        super().__init__()
        self.rows: Dict[str, Dict[str, Any]] = {}
        self.stored: Dict[int, bytes] = {}
        self.uploads: Dict[str, Dict[str, Any]] = {}
        self.files: List[str] = []
        #: Rewrites the finalize answer (the stored file is untouched).
        self.finalize_answer: Any = None
        self.pull = lambda url: self.body(
            cursor=self.version, changes=[self._change(i, r) for i, r in self.rows.items()]
        )
        self.push = self._push

    def body(self, **over: Any) -> Dict[str, Any]:
        return super().body(**{"encryption": "server", **over})

    @staticmethod
    def _change(id: str, r: Dict[str, Any]) -> Dict[str, Any]:
        out: Dict[str, Any] = {"record": ["saves", id], "version": r["version"]}
        if r.get("value") is not None:
            out["value"] = r["value"]
        if r.get("file"):
            out["file"] = r["file"]
        return out

    def _push(self, body: Dict[str, Any]) -> Dict[str, Any]:
        results: List[Dict[str, Any]] = []
        changes: List[Dict[str, Any]] = []
        tombstones: List[Dict[str, Any]] = []
        for m in body["mutations"]:
            id = m["target"]["record"][1]
            row = self.rows.get(id)
            base = m["baseVersion"]
            stale = (row is not None) if base == "*" else (row is None or row["version"] != base)
            if stale:
                results.append(
                    {
                        "mutationId": m["mutationId"],
                        "status": "conflict",
                        "server": self._change(id, row) if row else {"version": self.version},
                    }
                )
                continue
            self.version += 1
            if m["op"] == "delete":
                self.rows.pop(id, None)
                tombstones.append({"record": ["saves", id], "version": self.version})
            else:
                nxt = {"value": m["value"], "version": self.version, "file": row.get("file") if row else None}
                self.rows[id] = nxt
                changes.append(self._change(id, nxt))
            results.append({"mutationId": m["mutationId"], "status": "ok", "version": self.version})
        return self.body(cursor=self.version, results=results, changes=changes, tombstones=tombstones)

    def __call__(self, r: httpx.Request) -> httpx.Response:
        prefix = f"/{PRODUCT}/sync/files/saves/"
        if not r.url.path.startswith(prefix):
            return super().__call__(r)
        self.seen.append(r)
        id, *rest = r.url.path[len(prefix) :].split("/")
        self.files.append(f"{r.method} {'/'.join(rest) or '-'}")
        if r.method == "POST" and rest[:1] == ["begin"]:
            base = json.loads(r.content)["baseVersion"]
            row = self.rows.get(id)
            if (row is not None) if base == "*" else (row is None or row["version"] != base):
                return httpx.Response(
                    409,
                    json={"error": {"code": "revision_conflict"}, "server": {"version": row["version"] if row else 0}},
                )
            up = f"up_{len(self.uploads) + 1}"
            self.uploads[up] = {"id": id}
            return httpx.Response(200, json={"uploadId": up, "mode": "single", "expiresAt": 1_700_086_400_000})
        if r.method == "PUT" and rest[:1] == ["upload"]:
            self.uploads[rest[1]]["bytes"] = r.content
            return httpx.Response(204)
        if r.method == "GET" and rest[:1] == ["upload"]:
            return httpx.Response(
                200, json={"mode": "single", "size": 0, "received": [1], "expiresAt": 1_700_086_400_000}
            )
        if r.method == "POST" and rest[:1] == ["finalize"]:
            up = self.uploads[json.loads(r.content)["uploadId"]]
            self.version += 1
            data: bytes = up["bytes"]
            file = {"version": self.version, "size": len(data), "sha256": sha(data), "format": "whole"}
            self.stored[self.version] = data
            self.rows[id] = {"value": None, "version": self.version, "file": file}
            return httpx.Response(200, json=self.finalize_answer(file) if self.finalize_answer else file)
        if r.method == "GET" and not rest:
            row = self.rows.get(id)
            data = self.stored.get(row["file"]["version"]) if row and row.get("file") else None
            if data is None:
                return httpx.Response(404, json={"error": {"code": "not_found"}})
            m = re.match(r"bytes=(\d+)-(\d+)", r.headers.get("range", ""))
            if not m:
                return httpx.Response(200, content=data)
            a, b = int(m.group(1)), int(m.group(2))
            return httpx.Response(
                206, content=data[a : b + 1], headers={"content-range": f"bytes {a}-{b}/{len(data)}"}
            )
        return httpx.Response(404, json={"error": {"code": "not_found"}})


def signed_in(w: World, tmp_path: Path) -> Any:
    store = InMemoryStore(PRODUCT, device_id="DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB")
    store.set_token(TOKEN)
    c = make_client(
        w,
        store=store,
        state_dir=str(tmp_path),
        expected_services=["license", "config", "sync"],
        cloud_sync={"encryption": "server", "saves": {"delta": False}},
    )
    c.cloud_sync_host.start()
    c.events.emit("identity", change="signed_in", subject=SUBJECT)
    c.cloud_sync.flush()
    return c


def bare(meta: Dict[str, Any]) -> Dict[str, Any]:
    """The app's metadata, without the SDK's own savedAt / deviceLabel stamps."""
    return {k: v for k, v in meta.items() if k not in ("savedAt", "deviceLabel")}


def data(n: int, seed: int = 7) -> bytes:
    return bytes((i * 31 + seed) & 0xFF for i in range(n))


def test_write_then_metadata_at_the_finalize_version_and_read_back(tmp_path: Path) -> None:
    w = SavesWorld()
    c = signed_in(w, tmp_path)
    events: List[Dict[str, Any]] = []
    c.events.subscribe(lambda e: events.append(e.data) if "id" in e.data else None, ("cloudSync",))
    payload = data(3000)
    t = c.cloud_sync.saves.write("slot-1", payload, {"chapter": "one"})
    out = t.wait(10)
    assert out["state"] == "done" and out["id"] == "slot-1"
    assert w.files[:3] == ["POST begin", "PUT upload/up_1", "POST finalize"]
    row = w.rows["slot-1"]
    assert bare(row["value"]) == {"chapter": "one"} and row["file"]["sha256"] == sha(payload)
    assert c.cloud_sync.transfers() == []
    assert any(e["type"] == TransferEvent.TRANSFERPROGRESS for e in events)
    assert events[-1]["type"] == TransferEvent.TRANSFERDONE and events[-1]["state"] == "done"

    listed = c.cloud_sync.saves.list()
    assert [(s["id"], bare(s["metadata"]), s["file"]["size"]) for s in listed] == [("slot-1", {"chapter": "one"}, 3000)]
    read = c.cloud_sync.saves.read("slot-1")
    assert read["ok"] and read["metadata"] == {"chapter": "one"} and read["bytes"] == payload
    c.close()


def test_a_finalize_answer_naming_another_file_fails_the_write_and_adopts_nothing(tmp_path: Path) -> None:
    w = SavesWorld()
    c = signed_in(w, tmp_path)
    first = data(3000)
    other = data(3000, seed=9)
    assert c.cloud_sync.saves.write("a", first, {"n": 1}).wait(10)["state"] == "done"
    assert c.cloud_sync.saves.write("b", other, {"n": 2}).wait(10)["state"] == "done"
    theirs = dict(w.rows["b"]["file"])
    listed_before = [s for s in c.cloud_sync.saves.list() if s["id"] == "a"]
    w.finalize_answer = lambda f: {**theirs, "version": f["version"]}
    out = c.cloud_sync.saves.write("a", data(3000, seed=11), {"n": 3}, base_version=w.rows["a"]["version"]).wait(10)
    assert out["state"] == "failed"
    # No metadata was pushed for the refused file.
    assert w.rows["a"]["value"] != {"n": 3}
    assert [s for s in c.cloud_sync.saves.list() if s["id"] == "a"] == listed_before
    c.close()


@pytest.mark.parametrize("bad", ["slot\n", "slot\n\n", "a" * 128 + "\n"])
def test_a_save_id_with_a_trailing_newline_is_refused(tmp_path: Path, bad: str) -> None:
    from polaris_key.cloud_sync.saves import SavesError

    w = SavesWorld()
    c = signed_in(w, tmp_path)
    for call in (
        lambda: c.cloud_sync.saves.read(bad),
        lambda: c.cloud_sync.saves.revisions(bad),
        lambda: c.cloud_sync.saves.delete(bad),
    ):
        with pytest.raises(SavesError) as ei:
            call()
        assert ei.value.code == "invalid-save"
    c.close()


def test_the_new_file_is_listed_at_once_with_no_echo_of_the_record_in_the_push_reply(tmp_path: Path) -> None:
    w = SavesWorld()
    push = w.push

    def no_echo(body: Dict[str, Any]) -> Dict[str, Any]:
        return {**push(body), "changes": []}

    w.push = no_echo
    c = signed_in(w, tmp_path)
    first = data(300, 1)
    out1 = c.cloud_sync.saves.write("slot-1", first, {"chapter": "one"}).wait(10)
    assert out1["state"] == "done"
    listed = c.cloud_sync.saves.list()
    assert [(s["id"], s["file"]["size"], s["file"]["sha256"]) for s in listed] == [("slot-1", 300, sha(first))]
    second = data(500, 2)
    out2 = c.cloud_sync.saves.write("slot-1", second, {"chapter": "two"}, base_version=out1["version"]).wait(10)
    assert out2["state"] == "done"
    read = c.cloud_sync.saves.read("slot-1")
    assert read["ok"] and bare(read["metadata"]) == {"chapter": "two"} and read["bytes"] == second
    c.close()


def test_a_stale_write_is_a_conflict_that_carries_the_server_copy(tmp_path: Path) -> None:
    w = SavesWorld()
    w.rows["slot-1"] = {
        "value": {"chapter": "two"},
        "version": 7,
        "file": {"version": 7, "size": 5, "sha256": "a" * 64, "format": "whole"},
    }
    w.version = 7
    c = signed_in(w, tmp_path)
    out = c.cloud_sync.saves.write("slot-1", data(500), {"chapter": "mine"}, base_version=5).wait(10)
    assert out["state"] == "conflict"
    assert out["conflict"]["remote"]["metadata"] == {"chapter": "two"}
    assert out["conflict"]["serverVersion"] == 7
    c.close()


def test_a_conflict_describes_the_server_version_not_the_cached_copy(tmp_path: Path) -> None:
    w = SavesWorld()
    c = signed_in(w, tmp_path)
    first = c.cloud_sync.saves.write("slot-1", data(300, 1), {"chapter": "one"}).wait(10)
    assert first["state"] == "done"
    # Another device writes version 400 and this device's cache is not told.
    w.rows["slot-1"] = {
        "value": {"chapter": "theirs"},
        "version": 400,
        "file": {"version": 400, "size": 5, "sha256": "a" * 64, "format": "whole"},
    }
    w.version = 400
    cache = c.cloud_sync.saves._records
    stale = cache.get("slot-1")
    cache.get = lambda _id: stale  # type: ignore[method-assign]
    mine = data(500, 2)
    out = c.cloud_sync.saves.write("slot-1", mine, {"chapter": "mine"}, base_version=first["version"]).wait(10)
    assert out["state"] == "conflict"
    assert out["conflict"]["serverVersion"] == 400
    assert out["conflict"]["remote"]["version"] == 400
    # Keep this device's version succeeds, and a later write does not repeat the conflict.
    kept = c.cloud_sync.saves.resolve(out["conflict"], "local", mine).wait(10)
    assert kept["state"] == "done"
    del cache.get
    assert c.cloud_sync.saves.write("slot-1", data(4000, 3), {"chapter": "again"}).wait(10)["state"] == "done"
    c.close()


def test_a_conflict_and_keeping_the_other_version_pull_first_and_saves_record_when_and_where(tmp_path: Path) -> None:
    w = SavesWorld()
    c = signed_in(w, tmp_path)
    first = c.cloud_sync.saves.write("slot-1", data(300, 1), {"chapter": "one"}).wait(10)
    assert first["state"] == "done"
    meta = c.cloud_sync.saves.read("slot-1")["metadata"]
    assert meta["chapter"] == "one" and isinstance(meta["savedAt"], int) and meta["savedAt"] > 0
    # Another device writes version 40; this device's cache is not told.
    w.rows["slot-1"] = {
        "value": {"chapter": "theirs", "savedAt": 5},
        "version": 40,
        "file": {"version": 40, "size": 5, "sha256": "a" * 64, "format": "whole"},
    }
    w.version = 40
    assert c.cloud_sync.saves.list()[0]["version"] == first["version"]
    out = c.cloud_sync.saves.write("slot-1", data(500, 2), {"chapter": "mine"}, base_version=first["version"]).wait(10)
    assert out["state"] == "conflict"
    # The pull made the cards real: the server's metadata, and this device's own stamps.
    assert out["conflict"]["remote"]["metadata"] == {"chapter": "theirs", "savedAt": 5}
    assert out["conflict"]["local"]["metadata"]["savedAt"] >= meta["savedAt"]
    kept = c.cloud_sync.saves.resolve(out["conflict"], "remote", b"").wait(10)
    assert kept["state"] == "done" and kept["kept"] == "remote" and kept["version"] == 40
    assert c.cloud_sync.saves.list()[0]["metadata"]["chapter"] == "theirs"
    c.close()


def test_a_save_deleted_elsewhere_is_a_conflict_with_no_remote_and_keep_mine_succeeds(tmp_path: Path) -> None:
    w = SavesWorld()
    c = signed_in(w, tmp_path)
    first = c.cloud_sync.saves.write("slot-1", data(300, 1), {"chapter": "one"}).wait(10)
    assert first["state"] == "done"
    del w.rows["slot-1"]
    cache = c.cloud_sync.saves._records
    stale = cache.get("slot-1")
    cache.get = lambda _id: stale  # type: ignore[method-assign]
    mine = data(500, 2)
    out = c.cloud_sync.saves.write("slot-1", mine, {"chapter": "mine"}, base_version=first["version"]).wait(10)
    assert out["state"] == "conflict"
    assert out["conflict"]["remote"] is None and out["conflict"]["serverVersion"] == 0
    kept = c.cloud_sync.saves.resolve(out["conflict"], "local", mine).wait(10)
    assert kept["state"] == "done"
    assert bare(w.rows["slot-1"]["value"]) == {"chapter": "mine"}
    c.close()


def test_delete_a_save_at_its_version(tmp_path: Path) -> None:
    w = SavesWorld()
    w.rows["slot-1"] = {
        "value": {"chapter": "one"},
        "version": 3,
        "file": {"version": 3, "size": 5, "sha256": "a" * 64, "format": "whole"},
    }
    w.version = 3
    c = signed_in(w, tmp_path)
    assert c.cloud_sync.saves.delete("slot-1")["ok"] is True
    assert "slot-1" not in w.rows
    assert c.cloud_sync.saves.list() == []
    c.close()


def test_a_record_with_a_file_and_no_value_is_listed(tmp_path: Path) -> None:
    w = SavesWorld()
    w.rows["slot-9"] = {
        "value": None,
        "version": 4,
        "file": {"version": 4, "size": 9, "sha256": "b" * 64, "format": "whole"},
    }
    w.version = 4
    c = signed_in(w, tmp_path)
    listed = c.cloud_sync.saves.list()
    assert [(s["id"], bare(s["metadata"]), s["file"]["size"]) for s in listed] == [("slot-9", {}, 9)]
    c.close()


def test_the_transfer_journal_goes_with_the_person(tmp_path: Path) -> None:
    w = SavesWorld()
    c = signed_in(w, tmp_path)

    def dirs() -> List[str]:
        return sorted({p.name for p in tmp_path.rglob("cloud-sync-*") if p.is_dir()})

    c.cloud_sync.saves.write("slot-1", data(100), {}).wait(10)
    assert "cloud-sync-transfers" in dirs()
    c._cloud_sync_api.before_sign_out()
    assert dirs() == []
    c.close()


def test_cancel_settles_a_write_that_waits_for_its_metadata_outcome(tmp_path: Path) -> None:
    w = SavesWorld()
    gate = threading.Event()
    pushed = threading.Event()
    push = w.push

    def hang(body: Dict[str, Any]) -> Dict[str, Any]:
        pushed.set()
        gate.wait(10)
        return push(body)

    w.push = hang
    c = signed_in(w, tmp_path)
    t = c.cloud_sync.saves.write("slot-1", data(100), {})
    assert pushed.wait(10)
    t.cancel()
    assert t.wait(10) == {"state": "cancelled"}
    assert c.cloud_sync.transfers() == []
    gate.set()
    c.close()


def test_a_file_codec_refuses_once_the_ring_is_locked(tmp_path: Path) -> None:
    from test_cloud_sync_host import Rig

    r = Rig(World(), tmp_path, keys=True)
    r.client.keyring.create()
    codec = r.client.keyring.file_codec("saves")
    plain = b"abc"
    cid = codec.chunk_id(plain)
    assert len(codec.seal_chunk(cid, plain)) > 3
    r.client.keyring.lock()
    for call in (
        lambda: codec.seal_chunk(cid, plain),
        lambda: codec.chunk_id(plain),
        lambda: codec.seal_manifest(plain),
        lambda: next(iter(codec.seal_stream([plain]))),
    ):
        with pytest.raises(Exception) as e:
            call()
        assert getattr(e.value, "code", "") == "sync-locked"
    r.client.close()


def test_the_save_transfers_are_purged_before_the_ring_is_forgotten(tmp_path: Path) -> None:
    w = SavesWorld()
    c = signed_in(w, tmp_path)
    c.cloud_sync.saves.write("slot-1", data(100), {}).wait(10)
    seen: List[bool] = []
    forget = c.keyring.forget

    def spy() -> None:
        seen.append(not any(p.name == "cloud-sync-transfers" for p in tmp_path.rglob("*")))
        forget()

    c.keyring.forget = spy  # type: ignore[method-assign]
    c._cloud_sync_api.before_sign_out()
    assert seen and all(seen)
    c.close()
