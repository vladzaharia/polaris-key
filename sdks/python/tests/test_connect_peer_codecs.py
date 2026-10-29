# @pkey-feature connect.protocol connect.lan
"""The ``adverts``, ``sas``, ``handshakePayloads``, ``lanAddresses`` and ``mdnsAnswers`` rows of
``peer-matrix.json`` (WIRE-CONTRACT-V5 §15.4, §15.4.1, §15.5) through the Python codecs. Mirrors the Node
runner ``peerMatrix.test.ts``.

The ``lanAddresses.candidates`` rows (the CANDIDATES record, §15.6) are not run: this SDK neither sends nor
reads that record (CC-08R), so it has no ``candidate_target``. Their count is still pinned, so a row added
to the corpus is a deliberate change here too."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from polaris_key.core.peer_advert import (
    account_instance,
    advert_epoch,
    base32_lower,
    browse_account_instance,
    browse_table,
    device_id_bytes,
    is_instance_name,
    parse_txt,
    product_tag,
)
from polaris_key.core.peer_lan_address import lan_group_key, lan_verdict
from polaris_key.core.peer_mdns import AddressBook
from polaris_key.core.peer_mdns_packet import parse_packet
from polaris_key.core.peer_payload import (
    MAX_HANDSHAKE_PAYLOAD,
    caps_intersection,
    parse_handshake_payload,
    payload1,
    payload23,
)
from polaris_key.core.peer_sas import (
    decode_sas_value,
    encode_sas_value,
    parse_sas_body,
    sas_body,
    sas_commit,
    sas_display,
    sas_reveal_ok,
    sas_value,
)

M: Dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "peer-matrix.json").read_text()
)


def test_row_counts() -> None:
    a = M["adverts"]
    assert len(a["epochs"]) + len(a["names"]) + len(a["tags"]) + len(a["txt"]) + len(a["instances"]) + len(
        a["browse"]
    ) == 70
    s = M["sas"]
    assert len(s["commits"]) + len(s["codes"]) + len(s["reveals"]) + len(s["nonces"]) == 31
    assert len(M["handshakePayloads"]["payloads"]) + len(M["handshakePayloads"]["intersection"]) == 65


# -- adverts ----------------------------------------------------------------------------------------


def test_epochs() -> None:
    assert M["adverts"]["epochSeconds"] == 900
    for r in M["adverts"]["epochs"]:
        assert advert_epoch(r["now"]) == r["epoch"], r["now"]


def test_names() -> None:
    for r in M["adverts"]["names"]:
        assert account_instance(bytes.fromhex(r["kDisc"]), r["epoch"], r["deviceId"]) == r["instance"], r["id"]


def test_tags() -> None:
    for r in M["adverts"]["tags"]:
        assert product_tag(r["slug"], r["epoch"]) == r["h"]


@pytest.mark.parametrize("r", M["adverts"]["txt"], ids=[r["id"] for r in M["adverts"]["txt"]])
def test_txt(r: Dict[str, Any]) -> None:
    assert parse_txt(r["entries"]) == r["want"]


def test_instance_shapes() -> None:
    for r in M["adverts"]["instances"]:
        assert is_instance_name(r["name"]) is r["want"], r["name"]


@pytest.mark.parametrize("r", M["adverts"]["browse"], ids=[r["id"] for r in M["adverts"]["browse"]])
def test_browse(r: Dict[str, Any]) -> None:
    hit = browse_account_instance(r["instance"], [bytes.fromhex(k) for k in r["kDiscs"]], r["now"], r["roster"])
    want = r["want"]
    if want is None:
        assert hit is None
    else:
        assert hit is not None
        assert {"deviceId": hit.device_id, "epochBack": hit.epoch_back, "keyIndex": hit.key_index} == want


def test_base32_and_device_ids() -> None:
    assert base32_lower(b"") == ""
    assert base32_lower(b"f") == "my"
    assert base32_lower(b"foobar") == "mzxw6ytboi"
    assert len(device_id_bytes("leAZmawulGPwc1GRLRg7UxoOyzqRd3Zp")) == 24
    for bad in ("short", "x" * 33, "x" * 31 + "+", ""):
        with pytest.raises(ValueError):
            device_id_bytes(bad)


def test_browse_is_bounded_to_two_keys_and_128_devices() -> None:
    k = bytes([7]) * 32
    roster = ["%032d" % i for i in range(130)]
    inst = account_instance(k, 5, roster[129])
    assert browse_account_instance(inst, [k], 5 * 900, roster) is None  # the 130th is never tried
    third = account_instance(bytes([9]) * 32, 5, roster[0])
    assert browse_account_instance(third, [k, k, bytes([9]) * 32], 5 * 900, roster) is None


def test_the_browse_table_agrees_with_the_browse_and_holds_at_most_512_names() -> None:
    k1, k2 = bytes([7]) * 32, bytes([8]) * 32
    roster = ["%032d" % i for i in range(130)]
    table = browse_table([k1, k2, bytes([9]) * 32], 5 * 900 + 3, roster)
    assert len(table) == 128 * 2 * 2
    for inst, hit in list(table.items())[::37]:
        assert browse_account_instance(inst, [k1, k2], 5 * 900 + 3, roster) == hit
    assert account_instance(k1, 5, roster[129]) not in table
    assert browse_table([k1], 0, roster[:2]).keys() == {account_instance(k1, 0, r) for r in roster[:2]}


# -- SAS --------------------------------------------------------------------------------------------


def test_commits_and_bodies() -> None:
    for r in M["sas"]["commits"]:
        nd = bytes.fromhex(r["nD"])
        assert sas_commit(nd).hex() == r["c"]
        assert sas_body("c", bytes.fromhex(r["c"])).decode() == r["commitBody"]
        assert sas_body("nD", nd).decode() == r["revealBody"]
        assert parse_sas_body("c", r["commitBody"].encode()) == bytes.fromhex(r["c"])
        assert parse_sas_body("nD", r["revealBody"].encode()) == nd


def test_codes() -> None:
    for r in M["sas"]["codes"]:
        code = sas_value(bytes.fromhex(r["h"]), bytes.fromhex(r["nD"]), bytes.fromhex(r["nM"]), r["mode"])
        assert code == r["code"], r["id"]
        assert sas_display(code) == r["display"], r["id"]


def test_reveals() -> None:
    for r in M["sas"]["reveals"]:
        assert sas_reveal_ok(r["c"], r["nD"]) is r["want"], r["id"]


def test_nonces() -> None:
    for r in M["sas"]["nonces"]:
        got = decode_sas_value(r["text"])
        assert (got.hex() if got is not None else None) == r["want"], r["id"]


def test_sas_bodies_refuse_anything_but_the_canonical_object() -> None:
    v = encode_sas_value(bytes(range(32)))
    assert parse_sas_body("nM", ('{"nM":"%s"}' % v).encode()) == bytes(range(32))
    for bad in (
        ('{"nD":"%s"}' % v).encode(),  # another member
        (' {"nM":"%s"}' % v).encode(),
        ('{"nM":"%s","x":1}' % v).encode(),
        b"\xff\xfe",
        b"",
    ):
        assert parse_sas_body("nM", bad) is None
    with pytest.raises(ValueError):
        encode_sas_value(b"short")
    with pytest.raises(ValueError):
        sas_body("x", bytes(32))


# -- handshake payloads -----------------------------------------------------------------------------


def _payload(r: Dict[str, Any]) -> bytes:
    if "payloadHex" in r:
        return bytes.fromhex(r["payloadHex"])
    if "payloadPad" in r:
        p = r["payloadPad"]
        return (p["prefix"] + p["fill"] * p["count"] + p["suffix"]).encode("utf-8")
    return r["payload"].encode("utf-8")


@pytest.mark.parametrize(
    "r", M["handshakePayloads"]["payloads"], ids=[r["id"] for r in M["handshakePayloads"]["payloads"]]
)
def test_payloads(r: Dict[str, Any]) -> None:
    b = _payload(r)
    assert len(b) == r["length"]
    v = parse_handshake_payload(r["mode"], r["message"], b)
    assert v.ok is r["want"]["ok"]
    if r["want"]["ok"] and "caps" in r["want"]:
        assert v.caps == r["want"]["caps"]
    if "cert" in r["want"] and v.ok:
        assert v.cert == r["want"]["cert"] and v.ring == r["want"]["ring"]


@pytest.mark.parametrize(
    "r", M["handshakePayloads"]["intersection"], ids=[r["id"] for r in M["handshakePayloads"]["intersection"]]
)
def test_intersection(r: Dict[str, Any]) -> None:
    assert caps_intersection(r["local"], r["remote"]) == r["want"]


def test_the_builders_round_trip() -> None:
    assert payload1() == b'{"v":1}'
    assert parse_handshake_payload("a", 1, payload1()).ok
    caps = ["app/1", "ring/1"]
    b = payload23("a", caps, {"cert": "e30.e30.c2ln", "ring": 3})
    assert b == b'{"v":1,"cert":"e30.e30.c2ln","ring":3,"caps":["app/1","ring/1"]}'
    v = parse_handshake_payload("a", 2, b)
    assert (v.ok, v.caps, v.ring, v.cert) == (True, caps, 3, "e30.e30.c2ln")
    assert payload23("v", caps) == b'{"v":1,"caps":["app/1","ring/1"]}'
    with pytest.raises(ValueError):
        payload23("a", caps)
    with pytest.raises(ValueError):
        payload23("v", ["a/1"] * 2000)
    assert MAX_HANDSHAKE_PAYLOAD == 8192


# -- lanAddresses and mdnsAnswers (WIRE-CONTRACT-V5 §15.4, §15.4.1) -------------------------------------

LAN_ROWS = M["lanAddresses"]["rows"]
MDNS_ROWS = M["mdnsAnswers"]["rows"]


def test_lan_and_mdns_row_counts() -> None:
    # Exact: a row added or dropped is a deliberate corpus change.
    assert len(LAN_ROWS) == 133
    assert len(M["lanAddresses"]["candidates"]["rows"]) == 73
    assert len(MDNS_ROWS) == 36
    for rows in (LAN_ROWS, M["lanAddresses"]["candidates"]["rows"], MDNS_ROWS):
        assert len({r["id"] for r in rows}) == len(rows)


@pytest.mark.parametrize("r", LAN_ROWS, ids=[r["id"] for r in LAN_ROWS])
def test_lan_addresses_row(r: Dict[str, Any]) -> None:
    v = lan_verdict(r["remote"], r.get("local"), r["allowLoopback"])
    assert (v.dial, v.key) == (r["dial"], r["key"])
    assert lan_group_key(r["key"]) == r["group"]


def _grouped(pairs: Any) -> Dict[str, Any]:
    """The table by name: the order across names carries no meaning, the order within one does."""
    out: Dict[str, Any] = {}
    for name, address in pairs:
        out.setdefault(name, []).append(address)
    return out


@pytest.mark.parametrize("r", MDNS_ROWS, ids=[r["id"] for r in MDNS_ROWS])
def test_mdns_answers_row(r: Dict[str, Any]) -> None:
    book = AddressBook()
    for p in r.get("prior", []):
        book.hold(p["name"], p["address"])
    for rec in parse_packet(bytes.fromhex(r["packet"])).answers:
        if rec.type in ("A", "AAAA") and isinstance(rec.data, str):
            book.learn(rec, r["source"], r["zone"], 0.0)
    assert _grouped(book.table()) == _grouped((e["name"], e["address"]) for e in r["learned"])
