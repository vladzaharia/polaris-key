# @pkey-feature sync.records
"""``client.cloud_sync.collection(name)`` on the Python client (C-26 / U-46). Mirrors
``cloudSyncCollection.test.ts`` and client-core's ``syncCollection.test.ts``.

The handle over the machine, against the small fake of the Worker's ``/sync`` routes the host tests use:
the catalog checks (a refused call is returned and sends nothing), each policy's verbs and the mutations
they queue, pattern collections, the change and outcome events, and the end-to-end seal of a merge field
and a union element on the wire.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Dict, List

import pytest
from helpers import PRODUCT, TOKEN, make_client
from test_cloud_sync_host import SUBJECT, World

from polaris_key.cloud_sync.collection import SyncCollection
from polaris_key.core.errors import PolarisError
from polaris_key.devices.keys import create_device_key_store
from polaris_key.devices.store import InMemoryStore

COLLECTIONS = [
    {"name": "notes", "conflict": "lastWrite"},
    {"name": "best", "conflict": "max"},
    {"name": "cards", "conflict": "merge"},
    {"name": "tags", "conflict": "union"},
    {"name": "docs", "conflict": "revision"},
    {"name": "session.*", "template": "session"},
    {"name": "session.main", "conflict": "union"},
]


class RecordsWorld(World):
    def __init__(self, encryption: str = "server") -> None:
        super().__init__()
        self.mode = encryption
        self.schema = {
            "schemaVersion": 1,
            "entries": [],
            "cloudSync": {"collections": COLLECTIONS, "encryption": encryption},
        }
        #: Served rows by ``collection/id``: the version and the row body.
        self.rows: Dict[str, Dict[str, Any]] = {}
        self.push = self._push

    def body(self, **over: Any) -> Dict[str, Any]:
        return super().body(**{"encryption": self.mode, **over})

    def _push(self, body: Dict[str, Any]) -> Dict[str, Any]:
        results: List[Dict[str, Any]] = []
        changes: Dict[str, Dict[str, Any]] = {}
        tombstones: List[Dict[str, Any]] = []
        for m in body["mutations"]:
            self.version += 1
            ref = m["target"]["record"]
            key = "/".join(ref)
            row = self.rows.get(key)
            base = m.get("baseVersion")
            if base is not None and ((row is not None) if base == "*" else (row is None or row["version"] != base)):
                results.append(
                    {
                        "mutationId": m["mutationId"],
                        "status": "conflict",
                        "server": {"value": row["value"], "version": row["version"]} if row else {"version": 0},
                    }
                )
                continue
            value = row["value"] if row else None
            op = m["op"]
            if op == "set":
                value = m["value"]
            elif op == "setField":
                value = {**(value or {}), m["field"]: m["value"]}
            elif op == "removeField":
                value = {k: v for k, v in (value or {}).items() if k != m["field"]}
            elif op == "add":
                value = [*(value or []), m["element"]]
            elif op == "remove":
                value = [x for x in (value or []) if x != m["element"]]
            if op == "delete":
                self.rows.pop(key, None)
                changes.pop(key, None)
                tombstones.append({"record": ref, "version": self.version})
            else:
                self.rows[key] = {"value": value, "version": self.version}
                changes[key] = {"record": ref, "value": value, "version": self.version}
            results.append({"mutationId": m["mutationId"], "status": "ok", "version": self.version})
        return self.body(
            results=results,
            cursor=self.version,
            lastMutationId=body["mutations"][-1]["mutationId"],
            changes=list(changes.values()),
            tombstones=tombstones,
        )


def signed_in(w: World, tmp_path: Path, **opts: Any) -> Any:
    store = InMemoryStore(PRODUCT, device_id="DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB")
    store.set_token(TOKEN)
    c = make_client(
        w,
        store=store,
        state_dir=str(tmp_path),
        expected_services=["license", "config", "sync"],
        device_keys=create_device_key_store(memory=True),
        cloud_sync={"catalog": w.schema, "encryption": getattr(w, "mode", "server"), **opts},
    )
    c.cloud_sync_host.start()
    c.events.emit("identity", change="signed_in", subject=SUBJECT)
    c.cloud_sync.flush()
    return c


@pytest.fixture
def world() -> RecordsWorld:
    return RecordsWorld()


@pytest.fixture
def client(world: RecordsWorld, tmp_path: Path) -> Any:
    c = signed_in(world, tmp_path)
    yield c
    c.close()


def offline(c: Any) -> None:
    with c.cloud_sync_host.locked() as m:
        m.set_network("offline")


def online(c: Any) -> None:
    with c.cloud_sync_host.locked() as m:
        m.set_network("online")
    c.cloud_sync_host.touch()


def pull_now(c: Any) -> None:
    c.cloud_sync_host.touch()
    with c.cloud_sync_host.locked() as m:
        m.set_network("offline")
        m.set_network("online")  # coming online pulls
    c.cloud_sync_host.touch()
    c.cloud_sync.flush()


def sent(w: World) -> List[Dict[str, Any]]:
    return [m for b in w.pushes() for m in b["mutations"]]


def test_the_catalog_reaches_the_machine_and_an_undeclared_name_is_refused(client: Any, world: World) -> None:
    c = client.cloud_sync.collection("nope")
    assert isinstance(c, SyncCollection) and c.policy is None
    for r in (
        c.put("a", 1),
        c.update("a", {"set": {"x": 1}}),
        c.add("a", 1),
        c.remove("a", 1),
        c.delete("a"),
    ):
        assert r == {"ok": False, "error": "collection_unknown"}
    assert c.get("a") is None and c.ids() == []
    client.cloud_sync.flush()
    assert sent(world) == []
    assert client.cloud_sync.collection("cards").policy == "merge"


def test_a_verb_the_policy_does_not_allow_is_refused_and_sends_nothing(client: Any, world: World) -> None:
    notes = client.cloud_sync.collection("notes")
    cards = client.cloud_sync.collection("cards")
    tags = client.cloud_sync.collection("tags")
    docs = client.cloud_sync.collection("docs")
    refused = {"ok": False, "error": "op_invalid_for_policy"}
    assert cards.put("a", {"x": 1}) == refused
    assert tags.put("a", 1) == refused
    assert notes.update("a", {"set": {"x": 1}}) == refused
    assert notes.add("a", 1) == refused and cards.remove("a", 1) == refused
    assert notes.put("a", 1, if_version=3) == refused
    assert notes.delete("a", if_version=3) == refused
    assert tags.delete("a", if_version=3) == refused
    assert docs.update("a", {"set": {"x": 1}}) == refused
    client.cloud_sync.flush()
    assert sent(world) == []


def test_values_over_a_cap_are_refused_with_value_invalid(client: Any, world: World) -> None:
    notes = client.cloud_sync.collection("notes")
    cards = client.cloud_sync.collection("cards")
    tags = client.cloud_sync.collection("tags")
    bad = {"ok": False, "error": "value_invalid"}
    assert notes.put("", 1) == bad
    assert cards.update("a", {}) == bad
    assert cards.update("a", {"set": {"": 1}}) == bad
    assert cards.update("a", {"set": {"x" * 1025: 1}}) == bad
    assert cards.update("a", {"set": {"x": 1}, "remove": ["x"]}) == bad
    assert tags.add("a", "x" * 1100) == bad
    assert tags.add("a", 2**60) == bad
    assert tags.add("a", "x" * 1000) == {"ok": True}
    assert cards.update("a", {"set": {"x" * 1024: 1}}) == {"ok": True}
    assert client.cloud_sync.collection("docs").put("a", 1, if_version="nope") == bad


def test_signed_out_is_returned_not_raised(tmp_path: Path) -> None:
    w = RecordsWorld()
    store = InMemoryStore(PRODUCT, device_id="DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB")
    store.set_token(TOKEN)
    c = make_client(
        w,
        store=store,
        state_dir=str(tmp_path),
        expected_services=["license", "config", "sync"],
        cloud_sync={"encryption": "server"},
    )
    try:
        c.cloud_sync_host.start()
        col = c.cloud_sync.collection("notes")
        # The catalog is served at the first exchange; until a person signs in nothing is held.
        assert col.put("a", 1)["error"] in ("signed_out", "collection_unknown")
        assert col.get("a") is None and col.ids() == []
        assert w.pushes() == []
    finally:
        c.close()


def test_a_product_without_the_sync_service_gets_the_typed_na(tmp_path: Path) -> None:
    store = InMemoryStore(PRODUCT, device_id="DEVICEBBBBBBBBBBBBBBBBBBBBBBBBBB")
    c = make_client(World(), store=store, state_dir=str(tmp_path), expected_services=["license", "config"])
    try:
        with pytest.raises(PolarisError) as e:
            c.cloud_sync.collection("notes")
        assert e.value.code == "service-unavailable"
    finally:
        c.close()


def test_last_write_put_reads_back_pending_then_cloud_and_is_sent_stamped(client: Any, world: World) -> None:
    notes = client.cloud_sync.collection("notes")
    offline(client)
    assert notes.put("n1", {"t": "hello", "extra": [1, 2]}) == {"ok": True}
    assert notes.get("n1") == {"value": {"t": "hello", "extra": [1, 2]}, "from": "pending"}
    assert notes.ids() == ["n1"]
    online(client)
    client.cloud_sync.flush()
    (m,) = sent(world)
    assert m["target"] == {"record": ["notes", "n1"]} and m["op"] == "set"
    assert m["value"] == {"t": "hello", "extra": [1, 2]} and isinstance(m["editedHlc"], str)
    assert notes.get("n1") == {"value": {"t": "hello", "extra": [1, 2]}, "from": "cloud"}
    assert notes.delete("n1") == {"ok": True}
    assert notes.get("n1") is None and notes.ids() == []
    client.cloud_sync.flush()
    last = sent(world)[-1]
    assert last["op"] == "delete" and isinstance(last["editedHlc"], str)


def test_ids_are_in_byte_order(client: Any) -> None:
    notes = client.cloud_sync.collection("notes")
    offline(client)
    for i in ("b", "B", "a", "_", "10", "9"):
        notes.put(i, 1)
    assert notes.ids() == sorted(["b", "B", "a", "_", "10", "9"], key=lambda s: s.encode("utf-8"))


def test_max_keeps_the_better_value_locally_and_sends_it(client: Any, world: World) -> None:
    best = client.cloud_sync.collection("best")
    assert best.put("score", 10) == {"ok": True}
    client.cloud_sync.flush()
    assert sent(world)[-1]["value"] == 10


def test_merge_update_sends_one_stamp_and_keeps_unknown_fields(client: Any, world: World) -> None:
    w: RecordsWorld = world  # type: ignore[assignment]
    w.pull = lambda url: w.body(
        cursor=w.version,
        changes=[{"record": ["cards", "c1"], "value": {"hp": 5, "future": {"a": [1]}}, "version": 3}],
    )
    cards = client.cloud_sync.collection("cards")
    pull_now(client)
    assert cards.get("c1") == {"value": {"hp": 5, "future": {"a": [1]}}, "from": "cloud"}
    offline(client)
    assert cards.update("c1", {"set": {"hp": 6, "mp": 2}, "remove": ["gone"]}) == {"ok": True}
    assert cards.get("c1")["value"] == {"hp": 6, "mp": 2, "future": {"a": [1]}}
    online(client)
    client.cloud_sync.flush()
    ms = [m for m in sent(w) if m["target"]["record"][0] == "cards"]
    assert sorted((m["op"], m["field"]) for m in ms) == [
        ("removeField", "gone"),
        ("setField", "hp"),
        ("setField", "mp"),
    ]
    assert len({m["editedHlc"] for m in ms}) == 1


def test_union_add_and_remove_are_sent_and_read_back(client: Any, world: World) -> None:
    tags = client.cloud_sync.collection("tags")
    offline(client)
    assert tags.add("t", "red") == {"ok": True}
    assert tags.add("t", {"b": 1, "a": 2}) == {"ok": True}
    assert tags.add("t", "red") == {"ok": True}
    assert tags.get("t")["value"] == ["red", {"b": 1, "a": 2}]
    assert tags.remove("t", "red") == {"ok": True}
    assert tags.get("t")["value"] == [{"b": 1, "a": 2}]
    online(client)
    client.cloud_sync.flush()
    ms = [m for m in sent(world) if m["target"]["record"][0] == "tags"]
    assert [m["op"] for m in ms] == ["add", "add", "add", "remove"]
    assert "observedSeq" in ms[-1] and "editedHlc" not in ms[0]
    assert tags.delete("t") == {"ok": True}
    client.cloud_sync.flush()
    last = sent(world)[-1]
    assert last["op"] == "delete" and "editedHlc" not in last


def test_a_pattern_collection_governs_its_concrete_names_and_an_exact_name_wins(client: Any, world: World) -> None:
    s1 = client.cloud_sync.collection("session.a")
    assert s1.policy == "lastWrite"
    assert s1.put("x", 1) == {"ok": True}
    assert client.cloud_sync.collection("session.main").policy == "union"
    assert client.cloud_sync.collection("session.").policy is None
    assert client.cloud_sync.collection("session").policy is None
    assert client.cloud_sync.collection("sessionx.a").policy is None
    client.cloud_sync.flush()
    assert sent(world)[-1]["target"] == {"record": ["session.a", "x"]}


def test_revision_put_if_version_reports_its_outcome_to_the_listener(client: Any, world: World) -> None:
    docs = client.cloud_sync.collection("docs")
    events: List[Dict[str, Any]] = []
    done = threading.Event()

    def listener(e: Dict[str, Any]) -> None:
        events.append(e)
        if e["type"] == "outcome":
            done.set()

    off = docs.on(listener)
    r = docs.put("d1", {"v": 1}, if_version="*")
    assert r["ok"] is True and isinstance(r["mutationId"], int)
    client.cloud_sync.flush()
    assert done.wait(5)
    outcome = next(e["outcome"] for e in events if e["type"] == "outcome")
    assert outcome["mutationId"] == r["mutationId"] and outcome["status"] == "ok"
    assert any(e["type"] == "change" and e["ids"] == ["d1"] and e["origin"] == "local" for e in events)
    # A stale base is a conflict, reported as the outcome.
    done.clear()
    stale = docs.put("d1", {"v": 2}, if_version=1)
    client.cloud_sync.flush()
    assert done.wait(5)
    got = [e["outcome"] for e in events if e["type"] == "outcome"]
    assert got[-1]["mutationId"] == stale["mutationId"] and got[-1]["status"] == "conflict"
    off()


def test_the_outcome_of_another_collections_call_is_not_told_to_this_listener(client: Any, world: World) -> None:
    docs = client.cloud_sync.collection("docs")
    other = client.cloud_sync.collection("docs")
    seen: List[Dict[str, Any]] = []
    other.on(seen.append)
    docs.put("d1", 1, if_version="*")
    client.cloud_sync.flush()
    assert [e for e in seen if e["type"] == "outcome"] == []


def test_change_events_name_the_ids_and_origin_and_stop_after_the_remover(client: Any, world: World) -> None:
    w: RecordsWorld = world  # type: ignore[assignment]
    notes = client.cloud_sync.collection("notes")
    seen: List[Dict[str, Any]] = []
    off = notes.on(seen.append)
    notes.put("a", 1)
    notes.put("b", 2)
    local = [e["ids"] for e in seen if e["type"] == "change" and e["origin"] == "local"]
    assert local == [["a"], ["b"]]
    n = len(seen)
    client.cloud_sync.collection("cards").update("c", {"set": {"x": 1}})
    assert len(seen) == n  # another collection's change is not this handle's
    w.pull = lambda url: w.body(
        cursor=w.version + 50, changes=[{"record": ["notes", "z"], "value": "remote", "version": 99}]
    )
    pull_now(client)
    remote = [e for e in seen if e["origin"] == "remote" and "z" in e["ids"]]
    assert remote
    off()
    n = len(seen)
    notes.put("c", 3)
    assert len(seen) == n


def test_a_listener_that_raises_does_not_reach_the_machine(client: Any) -> None:
    notes = client.cloud_sync.collection("notes")
    notes.on(lambda e: 1 / 0)
    assert notes.put("a", 1) == {"ok": True}
    assert notes.get("a")["value"] == 1


def test_the_handle_survives_a_rebuilt_machine(client: Any, world: World) -> None:
    notes = client.cloud_sync.collection("notes")
    seen: List[Dict[str, Any]] = []
    notes.on(seen.append)
    w: RecordsWorld = world  # type: ignore[assignment]
    w.schema = {**w.schema, "schemaVersion": 2, "cloudSync": {**w.schema["cloudSync"]}}
    host = client.cloud_sync_host
    with host.locked():
        host._rebuild_wanted = True
    host.touch()
    notes.put("after", 1)
    assert any(e["type"] == "change" and e["ids"] == ["after"] for e in seen)


# ── end-to-end: the wire holds no plaintext name or value of a record ─────────────────────────


def test_e2e_merge_fields_and_union_elements_are_sealed_and_blinded(tmp_path: Path) -> None:
    w = RecordsWorld("e2e")
    c = signed_in(w, tmp_path)
    try:
        c.keyring.create()
        c.cloud_sync_host.touch()
        cards = c.cloud_sync.collection("cards")
        tags = c.cloud_sync.collection("tags")
        assert cards.update("hero", {"set": {"hp": 6}, "remove": ["old"]}) == {"ok": True}
        assert tags.add("hero", "sword") == {"ok": True}
        assert tags.remove("hero", "sword") == {"ok": True}
        c.cloud_sync.flush()
        ms = sent(w)
        assert {m["op"] for m in ms} == {"setField", "removeField", "add", "remove"}
        wire = json.dumps(ms)
        for plain in ("hero", '"hp"', '"old"', "sword"):
            assert plain not in wire
        for m in ms:
            assert m["target"]["record"][0] in ("cards", "tags")
            assert m["target"]["record"][1].startswith("x:")
            name = m.get("field") or m.get("element")
            assert name.startswith("x:")
            assert ("ct" in m) == (m["op"] in ("setField", "add"))
    finally:
        c.close()


def test_e2e_a_sealed_pull_opens_for_a_merge_and_a_union_record(tmp_path: Path) -> None:
    w = RecordsWorld("e2e")
    c = signed_in(w, tmp_path)
    try:
        c.keyring.create()
        codec = c.keyring.codec
        from polaris_key.core.b64url import b64url_encode
        from polaris_key.core.sync_crypto import canonical_json

        def field_cell(rid: str, f: str, v: Any) -> Dict[str, Any]:
            return {
                "field": codec.blind("field", "cards", f),
                "ct": b64url_encode(codec.seal("cards", f"{rid}\0{f}", v)),
                "editedHlc": "0199c82cc000:0000",
            }

        def element_cell(rid: str, e: Any) -> Dict[str, Any]:
            n = canonical_json(e)
            return {
                "element": codec.blind("element", "tags", n),
                "ct": b64url_encode(codec.seal("tags", f"{rid}\0{n}", e)),
            }

        w.pull = lambda url: w.body(
            cursor=w.version + 5,
            changes=[
                {
                    "record": ["cards", codec.blind("record", "cards", "hero")],
                    "fields": [field_cell("hero", "hp", 9)],
                    "version": 7,
                },
                {
                    "record": ["tags", codec.blind("record", "tags", "hero")],
                    "elements": [element_cell("hero", "sword")],
                    "version": 8,
                },
            ],
        )
        pull_now(c)
        assert c.cloud_sync.collection("cards").get("hero") == {"value": {"hp": 9}, "from": "cloud"}
        assert c.cloud_sync.collection("tags").get("hero") == {"value": ["sword"], "from": "cloud"}
        assert c.cloud_sync.collection("cards").ids() == ["hero"]
    finally:
        c.close()


def test_e2e_ids_drop_a_row_that_has_no_name(tmp_path: Path) -> None:
    w = RecordsWorld("e2e")
    c = signed_in(w, tmp_path)
    try:
        c.keyring.create()
        blinded = c.keyring.codec.blind("record", "docs", "slot")
        w.pull = lambda url: w.body(
            cursor=w.version + 5,
            changes=[
                {
                    "record": ["docs", blinded],
                    "file": {"version": 3, "size": 1, "sha256": "a" * 64, "format": "whole"},
                    "version": 3,
                }
            ],
        )
        pull_now(c)
        with c.cloud_sync_host.locked() as m:
            assert m.record_ids("docs") == [blinded]  # the machine holds the row; it has no name to list
        assert c.cloud_sync.collection("docs").ids() == []
    finally:
        c.close()


# ── the async client ──────────────────────────────────────────────────────────────────────────


def test_the_async_client_mirrors_the_handle(tmp_path: Path) -> None:
    import asyncio

    from polaris_key.aio import AsyncPolarisKeyClient

    w = RecordsWorld()
    c = signed_in(w, tmp_path)

    async def run() -> None:
        a = AsyncPolarisKeyClient(c)
        col = await a.cloud_sync.collection("notes")
        assert await col.put("a", 1) == {"ok": True}
        assert (await col.get("a"))["value"] == 1
        assert await col.ids() == ["a"]
        assert col.on(lambda e: None) is not None  # synchronous
        assert (await a.cloud_sync.collection("nope")).policy is None

    try:
        asyncio.run(run())
    finally:
        c.close()


def test_what_cannot_be_sealed_is_refused_without_journalling_or_sending(client: Any, world: World) -> None:
    notes = client.cloud_sync.collection("notes")
    cards = client.cloud_sync.collection("cards")
    tags = client.cloud_sync.collection("tags")
    bad = {"ok": False, "error": "value_invalid"}
    assert notes.put("a\x00b", 1) == bad
    assert notes.put("n", float("nan")) == bad
    assert notes.put("n", 2**60) == bad
    assert notes.put("x" * 129, 1) == bad
    assert notes.put("a b", 1) == bad
    assert notes.put("x:" + "A" * 43, 1) == bad
    assert cards.update("c", {"set": {"f\x00": 1}}) == bad
    assert cards.update("c", {"set": {"f": float("inf")}}) == bad
    assert tags.add("t", float("nan")) == bad
    assert notes.delete("a\x00b") == bad
    client.cloud_sync.flush()
    assert sent(world) == []
    assert notes.ids() == [] and cards.ids() == []


def test_refusals_come_in_one_order(client: Any) -> None:
    assert client.cloud_sync.collection("nope").put("a\x00", 1) == {"ok": False, "error": "collection_unknown"}
    assert client.cloud_sync.collection("tags").put("a\x00", 1) == {"ok": False, "error": "op_invalid_for_policy"}
    with client.cloud_sync_host.locked() as m:
        m.sign_out(True)
    assert client.cloud_sync.collection("tags").put("a\x00", 1) == {"ok": False, "error": "signed_out"}


def test_there_is_no_implicit_saves_collection(client: Any) -> None:
    saves = client.cloud_sync.collection("saves")
    assert saves.policy is None
    assert saves.put("s", {"n": 1}) == {"ok": False, "error": "collection_unknown"}


def test_two_handles_on_one_collection_do_not_silence_each_other(client: Any) -> None:
    a = client.cloud_sync.collection("notes")
    b = client.cloud_sync.collection("notes")
    seen: List[Dict[str, Any]] = []
    a.on(seen.append)
    off_b = b.on(lambda _e: None)
    off_b()
    assert a.put("n1", 1) == {"ok": True}
    assert any(e["type"] == "change" and e["ids"] == ["n1"] for e in seen)


def test_a_record_tombstone_removes_the_held_record_in_e2e(tmp_path: Path) -> None:
    w = RecordsWorld("e2e")
    c = signed_in(w, tmp_path)
    try:
        c.keyring.create()
        from polaris_key.core.b64url import b64url_encode

        codec = c.keyring.codec
        wire = ["notes", codec.blind("record", "notes", "main")]
        # A sealed record is pulled: the machine holds it under its plain name.
        w.pull = lambda url: w.body(
            cursor=w.version + 5,
            changes=[{"record": wire, "ct": b64url_encode(codec.seal("notes", "main", {"t": "x"})), "version": 150}],
        )
        pull_now(c)
        with c.cloud_sync_host.locked() as machine:
            assert machine.record_keys() == [("notes", "main")]
        notes = c.cloud_sync.collection("notes")
        assert notes.get("main") == {"value": {"t": "x"}, "from": "cloud"}
        w.pull = lambda url: w.body(cursor=w.version + 9, tombstones=[{"record": wire, "version": 200}])
        pull_now(c)
        with c.cloud_sync_host.locked() as machine:
            assert machine.record_keys() == []
        assert notes.get("main") is None
    finally:
        c.close()
