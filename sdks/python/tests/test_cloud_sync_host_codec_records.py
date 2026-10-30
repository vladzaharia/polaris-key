# @pkey-feature sync.records
"""The record half of the Python host codec (U-22.0; WIRE-CONTRACT-V5 §13.10.4, "Record names"): a record
value is sealed under its collection with ``k = id`` and its id travels blinded; a pulled record opens only
when the ``k`` re-blinds to the id on the wire. Scalar values only (D-2): the other record operations are
refused and sealed ``fields`` / ``elements`` read as invalid. Mirrors ``hostCodecRecords.test.ts`` and the
Swift, Kotlin and Godot ports.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from polaris_key.cloud_sync.host_codec import open_pull, seal_push
from polaris_key.core import sync_crypto as sc
from polaris_key.core.b64url import b64url_decode, b64url_encode
from polaris_key.core.errors import PolarisError

ROOT = bytes((3 * i + 7) % 256 for i in range(32))
OTHER = bytes((250 - 5 * i) % 256 for i in range(32))
ID = "slot-1"


class Codec:
    locked = False

    def __init__(self, root: bytes = ROOT) -> None:
        self.root = root

    def seal(self, collection: str, name: str, value: Any) -> bytes:
        return sc.seal_value(self.root, collection, name, value)

    def open(self, collection: str, name: str, envelope: bytes, aliases: Any = None) -> Any:
        return sc.open_value(self.root, collection, name, envelope, aliases)

    def open_any(self, collection: str, envelope: bytes) -> Any:
        return sc.open_value_any_name(self.root, collection, envelope)

    def blind(self, kind: str, ctx: str, name: str) -> str:
        return sc.blind(self.root, kind, ctx, name)


C = Codec()


def seal_ct(collection: str, name: str, value: Any, root: bytes = ROOT) -> str:
    return b64url_encode(sc.seal_value(root, collection, name, value))


def rec(mid: int, rid: str, op: str, **rest: Any) -> Dict[str, Any]:
    return {"mutationId": mid, "target": {"record": ["saves", rid]}, "op": op, **rest}


def push(m: Dict[str, Any]) -> Dict[str, Any]:
    return seal_push({"mutations": [m]}, C, [])["mutations"][0]


def refused(m: Dict[str, Any]) -> None:
    with pytest.raises(PolarisError) as e:
        seal_push({"mutations": [m]}, C, [])
    assert e.value.code == "invalid-options"


def wire_id(rid: str = ID) -> str:
    return C.blind("record", "saves", rid)


def row(value: Any, **over: Any) -> Dict[str, Any]:
    return {"record": ["saves", wire_id()], "ct": seal_ct("saves", ID, value), "version": 7, **over}


def test_set_seals_under_the_id_and_blinds_it() -> None:
    m = push(rec(1, ID, "set", value={"hp": 10}, baseVersion="*"))
    assert m["target"] == {"record": ["saves", wire_id()]}
    assert "value" not in m and m["baseVersion"] == "*"
    got = C.open("saves", ID, b64url_decode(m["ct"]))
    assert got.ok and got.name == ID and got.value == {"hp": 10}
    assert ID not in json.dumps(m)


def test_delete_carries_the_blinded_id_and_no_ct() -> None:
    m = push(rec(2, ID, "delete", baseVersion=3))
    assert m["target"]["record"][1] == wire_id() and "ct" not in m and m["baseVersion"] == 3


def test_the_body_is_not_changed() -> None:
    body = {"mutations": [rec(1, ID, "set", value=1)]}
    before = json.dumps(body)
    seal_push(body, C, [])
    assert json.dumps(body) == before


@pytest.mark.parametrize(
    "ref",
    [[], ["saves"], ["saves", ""], ["", "a"], ["saves", "a\0b"], ["sa\0ves", "a"], ["$settings", "a"], ["$x", "a"], ["saves", 7], "saves/a"],
)
def test_a_malformed_reference_is_refused(ref: Any) -> None:
    refused({"mutationId": 1, "target": {"record": ref}, "op": "set", "value": 1})


def test_what_an_operation_does_not_take_is_refused() -> None:
    refused(rec(1, "a", "set"))
    refused(rec(1, "a", "set", value=1, ct="AQ"))
    refused(rec(1, "a", "set", value=1, field="f"))
    refused(rec(1, "a", "set", value=1, element=1))
    refused(rec(1, "a", "set", value=1, member="m"))
    refused(rec(1, "a", "delete", value=1))
    for op in ("setField", "removeField", "add", "remove", "clear", "setMember", "removeMember", "nope"):
        refused(rec(1, "a", op, value=1, field="f", element=1))
        refused(rec(1, "a", op))


def test_a_locked_codec_refuses_before_sealing() -> None:
    class Locked(Codec):
        locked = True

    with pytest.raises(PolarisError) as e:
        seal_push({"mutations": [rec(1, "a", "set", value=1)]}, Locked(), [])
    assert e.value.code == "sync-locked"


def test_one_bad_mutation_returns_nothing() -> None:
    with pytest.raises(PolarisError):
        seal_push({"mutations": [rec(1, "a", "set", value=1), rec(2, "", "set", value=1)]}, C, [])


def test_a_value_opens_to_the_plaintext_id() -> None:
    out, opened = open_pull({"changes": [row({"hp": 10}, editedHlc="h")]}, C)
    assert out["changes"][0] == {"record": ["saves", ID], "value": {"hp": 10}, "version": 7, "editedHlc": "h"}
    assert opened["changes"] == [{"sealed": True}]


def test_a_plaintext_id_never_opens() -> None:
    out, opened = open_pull({"changes": [row(1, record=["saves", ID])]}, C)
    assert opened["changes"] == [{"invalid": True}]
    e = out["changes"][0]
    assert "value" not in e and "ct" not in e and e["record"] == ["saves", ID]


def test_an_envelope_under_another_record_collection_root_or_text_is_invalid() -> None:
    other = wire_id("slot-2")
    flipped = row(1)
    flipped["ct"] = flipped["ct"][:-2] + ("BB" if flipped["ct"].endswith("A") else "AA")
    rows = [
        row(1, record=["saves", other]),
        row(1, record=["other", C.blind("record", "other", ID)]),
        row(1, ct=seal_ct("saves", ID, 1, OTHER)),
        row(1, ct="not*base64"),
        flipped,
    ]
    out, opened = open_pull({"changes": rows}, C)
    assert opened["changes"] == [{"invalid": True}] * 5
    assert out["changes"][0]["record"] == ["saves", other]
    assert all("value" not in e and "ct" not in e for e in out["changes"])


def test_the_settings_namespace_an_empty_id_and_a_missing_id_never_open() -> None:
    env = seal_ct("$settings", ID, 1)
    rows = [
        {"record": ["$settings", C.blind("record", "$settings", ID)], "ct": env, "version": 1},
        {"record": ["saves", ""], "ct": env, "version": 1},
        {"record": ["saves"], "ct": env, "version": 1},
    ]
    _out, opened = open_pull({"changes": rows}, C)
    assert opened["changes"] == [{"invalid": True}] * 3


def test_a_plaintext_record_row_is_legacy_and_claims_are_stripped() -> None:
    out, opened = open_pull(
        {"changes": [{"record": ["saves", "old"], "value": {"hp": 1}, "version": 3, "sealed": True, "seq": 99, "invalid": True}]},
        C,
    )
    assert out["changes"][0] == {"record": ["saves", "old"], "value": {"hp": 1}, "version": 3}
    assert opened["changes"] == [{"seq": 3}]


def test_sealed_fields_and_elements_are_outside_the_scalar_codec() -> None:
    cell = {"field": C.blind("field", "saves", "hp"), "ct": seal_ct("saves", f"{ID}\0hp", 10), "editedHlc": "h"}
    rows = [
        {"record": ["saves", wire_id()], "fields": [cell], "version": 8},
        {"record": ["saves", wire_id()], "elements": [], "version": 8},
        {**row(1), "fields": [cell]},
    ]
    _out, opened = open_pull({"changes": rows}, C)
    assert opened["changes"] == [{"invalid": True}] * 3


def test_a_record_tombstone_maps_back_only_for_a_held_record() -> None:
    w = wire_id()
    t = {"record": ["saves", w], "editedHlc": "h"}
    out, _ = open_pull(
        {"tombstones": [t, {"record": ["saves", wire_id("slot-2")]}, {"record": ["other", w]}, {"setting": "x:abc"}, "junk"]},
        C,
        record_keys=[("saves", ID), ("$bad", "x"), ("saves", "")],
    )
    ts = out["tombstones"]
    assert ts[0] == {"record": ["saves", ID], "editedHlc": "h"}
    assert ts[1]["record"][1] == wire_id("slot-2") and ts[2]["record"] == ["other", w]
    assert ts[3] == {"setting": "x:abc"} and ts[4] == "junk"
    plain, _ = open_pull({"tombstones": [t]}, C)
    assert plain["tombstones"][0]["record"][1] == w


def test_a_conflict_copy_opens_under_the_mutations_own_record() -> None:
    mutations = [rec(1, ID, "set", baseVersion=3)]
    body = {"results": [{"mutationId": 1, "status": "conflict", "server": {"ct": seal_ct("saves", ID, {"hp": 5}), "version": 9}}]}
    out, opened = open_pull(body, C, mutations=mutations)
    assert out["results"][0]["server"] == {"value": {"hp": 5}, "version": 9}
    assert opened["conflicts"] == {1: {"sealed": True}}


def test_a_conflict_copy_for_another_record_or_no_mutation_is_invalid() -> None:
    bad = {"ct": seal_ct("saves", "slot-2", 1), "version": 9}
    good = {"ct": seal_ct("saves", ID, 1), "version": 9}
    results = [
        {"mutationId": 1, "status": "conflict", "server": bad},
        {"mutationId": 2, "status": "conflict", "server": good},
        {"mutationId": 3, "status": "conflict", "server": good},
    ]
    mutations: List[Dict[str, Any]] = [
        rec(1, ID, "set", baseVersion=3),
        {"mutationId": 3, "target": {"record": ["saves", ""]}, "op": "set", "value": 1},
    ]
    out, opened = open_pull({"results": results}, C, mutations=mutations)
    assert opened["conflicts"] == {1: {"invalid": True}, 2: {"invalid": True}, 3: {"invalid": True}}
    assert all("value" not in r["server"] and "ct" not in r["server"] for r in out["results"])


def test_a_plaintext_conflict_copy_is_legacy_and_a_setting_copy_still_opens_as_a_setting() -> None:
    _o, opened = open_pull(
        {"results": [{"mutationId": 1, "status": "conflict", "server": {"value": {"hp": 1}, "version": 2}}]},
        C,
        mutations=[rec(1, ID, "set", baseVersion=1)],
    )
    assert opened["conflicts"] == {1: {"seq": 2}}
    out, opened = open_pull(
        {"results": [{"mutationId": 1, "status": "conflict", "server": {"ct": seal_ct("$settings", "audio.volume", 0.3), "version": 2}}]},
        C,
        mutations=[{"mutationId": 1, "target": {"setting": "audio.volume", "scope": "user"}, "op": "set", "value": 1}],
    )
    assert out["results"][0]["server"]["value"] == 0.3 and opened["conflicts"] == {1: {"sealed": True}}


def test_what_push_sends_for_a_value_pull_reads_back() -> None:
    m = push(rec(1, ID, "set", value=[1, 2]))
    out, _ = open_pull({"changes": [{"record": m["target"]["record"], "ct": m["ct"], "version": 1}]}, C)
    assert out["changes"][0]["record"] == ["saves", ID] and out["changes"][0]["value"] == [1, 2]


# ── the corpus rows ──────────────────────────────────────────────────────────────────────────────

_PATH = Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "sync-vectors.json"
ROWS = [c for c in json.loads(_PATH.read_text(encoding="utf-8"))["envelopeCases"] if "record" in c]


def test_the_corpus_holds_the_record_rows() -> None:
    assert len(ROWS) >= 15


@pytest.mark.parametrize("c", ROWS, ids=[c["id"] for c in ROWS])
def test_corpus_record_rows(c: Dict[str, Any]) -> None:
    codec = Codec(bytes.fromhex(c["rootHex"]))
    w = c["record"]
    ct = b64url_encode(bytes.fromhex(c["envelopeHex"]))
    ref = [c["collection"], w["id"]]
    if w["kind"] == "value":
        change: Dict[str, Any] = {"record": ref, "ct": ct, "version": 5}
    elif w["kind"] == "field":
        change = {"record": ref, "fields": [{"field": w["name"], "ct": ct, "editedHlc": "h"}], "version": 5}
    else:
        change = {"record": ref, "elements": [{"element": w["name"], "ct": ct}], "version": 5}
    out, opened = open_pull({"changes": [change]}, codec)
    # Only a value of the corpus opens here; a field or element row is outside the scalar codec.
    if c["expect"]["result"] == "ok" and w["kind"] == "value":
        assert opened["changes"] == [{"sealed": True}]
        assert out["changes"][0]["record"] == [c["collection"], c["name"]]
    else:
        assert opened["changes"] == [{"invalid": True}]
        e = out["changes"][0]
        assert "value" not in e and "ct" not in e and e["record"] == ref
