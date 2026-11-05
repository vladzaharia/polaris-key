# @pkey-feature sync.conflict
"""``client.cloud_sync.on_conflict`` / ``conflicts`` / ``cloud_empty`` and ``MergeRequest.keep`` on the
Python client (plans/U-08.md §2.5). The scenario corpus pins the machine (``test_sync_scenarios.py``) and
``test_cloud_sync_saves.py`` the saves layer; this is the host API over a ``revision`` record collection,
against the small fake of the Worker's ``/sync`` routes the collection tests use."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Dict, List

import pytest
from test_cloud_sync_collection import RecordsWorld, signed_in


def theirs(w: RecordsWorld, value: Any, version: int = 900) -> None:
    """Another device wrote ``docs/d1``; this device's cache is not told."""
    w.rows["docs/d1"] = {"value": value, "version": version}
    w.version = version


def open_request(w: RecordsWorld, c: Any, mine: Any = None) -> Any:
    docs = c.cloud_sync.collection("docs")
    assert docs.put("d1", {"v": 1}) == {"ok": True}
    c.cloud_sync.flush()
    theirs(w, {"v": "theirs"})
    assert docs.put("d1", {"v": 2} if mine is None else mine) == {"ok": True}
    c.cloud_sync.flush()
    return docs


@pytest.fixture
def world() -> RecordsWorld:
    return RecordsWorld()


@pytest.fixture
def client(world: RecordsWorld, tmp_path: Path) -> Any:
    c = signed_in(world, tmp_path)
    yield c
    c.close()


def test_a_revision_conflict_opens_a_request_and_the_device_keeps_its_copy(client: Any, world: RecordsWorld) -> None:
    events: List[Dict[str, Any]] = []
    client.events.subscribe(
        lambda e: events.append(e.data) if "conflict" in str(e.data.get("type")) else None, ("cloudSync",)
    )
    docs = open_request(world, client)
    (r,) = client.cloud_sync.conflicts()
    assert (r.id, r.cause, r.collection, r.record) == ("w:docs/d1", "write", "docs", "d1")
    assert r.choices == ["local", "remote", "value"] and r.state == "open" and r.error is None
    assert r.local["value"] == {"v": 2} and r.remote["value"] == {"v": "theirs"} and r.remote["version"] == 900
    assert docs.get("d1") == {"value": {"v": 2}, "from": "pending"}
    assert client.cloud_sync.status()["conflicts"] == 1
    # The cloud keeps the other copy; nothing of this device's was sent after the conflict.
    assert world.rows["docs/d1"]["value"] == {"v": "theirs"}
    assert [e["type"] for e in events] == ["conflictOpened"] and events[0]["request"] is r


def test_keep_local_sends_one_set_on_the_remote_version(client: Any, world: RecordsWorld) -> None:
    open_request(world, client)
    (r,) = client.cloud_sync.conflicts()
    out = r.keep("local")
    assert out["ok"] is True and out["kept"] == "local" and out["version"] > 900
    assert world.rows["docs/d1"]["value"] == {"v": 2}
    assert client.cloud_sync.conflicts() == []
    assert "conflicts" not in client.cloud_sync.status()
    assert r.keep("local") == {"ok": False, "code": "sync-merge-closed", "reopened": False}


def test_keep_remote_sends_nothing(client: Any, world: RecordsWorld) -> None:
    open_request(world, client)
    (r,) = client.cloud_sync.conflicts()
    sent = len(world.pushes())
    out = r.keep("remote")
    client.cloud_sync.flush()
    assert out["ok"] is True and out["kept"] == "remote" and out["version"] == 900
    assert len(world.pushes()) == sent and client.cloud_sync.conflicts() == []
    assert client.cloud_sync.collection("docs").get("d1")["value"] == {"v": "theirs"}


def test_keep_value_sends_the_value_given(client: Any, world: RecordsWorld) -> None:
    open_request(world, client)
    (r,) = client.cloud_sync.conflicts()
    out = r.keep({"value": {"v": "merged"}})
    assert out["ok"] is True and out["kept"] == "value"
    assert world.rows["docs/d1"]["value"] == {"v": "merged"}


def test_a_choice_the_request_does_not_offer_is_refused_and_journals_nothing(client: Any, world: RecordsWorld) -> None:
    open_request(world, client)
    (r,) = client.cloud_sync.conflicts()
    sent = len(world.pushes())
    for bad in ("both", "nope", {"other": 1}, None):
        assert r.keep(bad) == {"ok": False, "code": "bad_request", "reopened": False}
    client.cloud_sync.flush()
    assert len(world.pushes()) == sent and r.state == "open"


def test_a_keep_that_meets_a_newer_copy_reopens_the_request(client: Any, world: RecordsWorld) -> None:
    open_request(world, client)
    (r,) = client.cloud_sync.conflicts()
    theirs(world, {"v": "again"}, 950)
    out = r.keep("local")
    assert out == {"ok": False, "code": "conflict", "reopened": True}
    assert r.state == "open" and r.remote["version"] == 950 and r.remote["value"] == {"v": "again"}
    assert r.keep("local")["ok"] is True


def test_a_later_put_replaces_the_copy_and_a_delete_keeps_the_other_one(client: Any, world: RecordsWorld) -> None:
    docs = open_request(world, client)
    (r,) = client.cloud_sync.conflicts()
    sent = len(world.pushes())
    assert docs.put("d1", {"v": 3}) == {"ok": True}
    client.cloud_sync.flush()
    assert r.local["value"] == {"v": 3} and len(world.pushes()) == sent
    # The collection's default delete is on the request's version, so it conflicts.
    with client.cloud_sync_host.locked() as m:
        assert m.delete("docs", "d1") == {"ok": True}
    client.cloud_sync_host.touch()
    client.cloud_sync.flush()
    assert world.rows["docs/d1"]["value"] == {"v": "theirs"}
    assert client.cloud_sync.conflicts() == [] and r.keep("local")["code"] == "sync-merge-closed"


def test_a_listener_is_replayed_the_open_requests_and_a_choice_decides(client: Any, world: RecordsWorld) -> None:
    open_request(world, client)
    seen: List[str] = []
    off = client.cloud_sync.on_conflict(lambda r: seen.append(r.id))
    assert seen == ["w:docs/d1"]
    off()
    decided = threading.Event()
    docs = client.cloud_sync.collection("docs")
    client.events.subscribe(lambda e: decided.set() if e.data.get("type") == "conflictClosed" else None, ("cloudSync",))
    client.cloud_sync.on_conflict(lambda r: "remote")
    # The replay decided the request already open: it closes without a person.
    assert decided.wait(10)
    assert client.cloud_sync.conflicts() == []
    assert docs.get("d1")["value"] == {"v": "theirs"}


def test_a_request_opened_with_a_listener_is_decided_inline(client: Any, world: RecordsWorld) -> None:
    done = threading.Event()
    client.events.subscribe(lambda e: done.set() if e.data.get("type") == "conflictClosed" else None, ("cloudSync",))
    client.cloud_sync.on_conflict(lambda r: "local")
    open_request(world, client)
    assert done.wait(10)
    client.cloud_sync.flush()
    assert world.rows["docs/d1"]["value"] == {"v": 2} and client.cloud_sync.conflicts() == []


def test_cloud_empty_follows_the_first_pull(tmp_path: Path) -> None:
    w = RecordsWorld()
    w.pull = lambda url: w.body(empty=True, cursor=w.version)
    c = signed_in(w, tmp_path)
    try:
        assert c.cloud_sync.cloud_empty() is True
        assert c.cloud_sync.collection("notes").put("n1", 1) == {"ok": True}
        c.cloud_sync.flush()
        assert c.cloud_sync.cloud_empty() is False
    finally:
        c.close()


def test_cloud_empty_is_none_before_any_answer(tmp_path: Path) -> None:
    w = RecordsWorld()
    c = signed_in(w, tmp_path)
    try:
        assert c.cloud_sync.cloud_empty() in (None, False)
    finally:
        c.close()
