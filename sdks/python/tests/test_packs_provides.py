# @pkey-feature packs.provides
"""Unit proofs for save compatibility on the device (P4-20, CONTENT §6.7 item 8), a port of
client-core's ``test/packsProvides.test.ts``: ``provides_of``, the reader of a pack record's
reserved record-level ``provides``, and the engine's ``is_available`` (the active set) and
``pack_for`` (the target set). Node, Swift and Godot pin the same cases.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, List, Set

import pytest

from pack_fixtures import (
    PRODUCT,
    PRODUCT_TRUST,
    RELEASE_KEYS,
    ByteServer,
    TreePack,
    marker_for,
    stamp_for,
    tree_pack,
)
from polaris_key.core.models import PackTarget, ReleasePin
from polaris_key.update.packs import (
    CONTENT_ID_PATTERN,
    MAX_PROVIDES,
    EmbeddedBaseline,
    PackEngine,
    PackError,
    PackProvider,
    memory_pack_state_store,
    memory_pack_storage,
    provides_of,
)
from polaris_key.update.packs.provides import verified_payload_of
from polaris_key.update.packs.zstd import select_python_zstd

_ZSTD, _ = select_python_zstd()
_plans = [0]


def _plan_id() -> str:
    _plans[0] += 1
    return f"plan-{_plans[0]}"


def engine(server: ByteServer, **kw: Any) -> PackEngine:
    opts: Dict[str, Any] = dict(
        product=PRODUCT,
        release_keys=RELEASE_KEYS,
        product_trust=lambda: PRODUCT_TRUST,
        stamp=None,
        prefs={"engine": None, "axes": {}},
        zstd=_ZSTD,
        sha256=hashlib.sha256,
        patch_methods=["zstd-patch-from"],
        mem_budget=1 << 30,
        storage=memory_pack_storage(),
        state=memory_pack_state_store(),
        fetch_record=lambda h: server.fetch_record(h),
        fetch_object=lambda s, o, r: server.fetch_object(s, o, r),
        now=lambda: 1759400000,
        new_plan_id=_plan_id,
    )
    opts.update(kw)
    return PackEngine(**opts)


_ABSENT = object()


def pack(pack_id: str, provides: Any = _ABSENT, **kw: Any) -> TreePack:
    return tree_pack(
        pack_id,
        "1.0.0",
        1,
        {f"{pack_id}.txt": pack_id},
        record_extra=None if provides is _ABSENT else {"provides": provides},
        **kw,
    )


def target(p: TreePack) -> Dict[str, Any]:
    return {"pack": p.pack_id, "release": {"sha256": p.record_sha256, "seq": p.seq, "version": p.version}}


def provider(p: TreePack) -> PackProvider:
    return PackProvider(pack_id=p.pack_id, release=ReleasePin(sha256=p.record_sha256, seq=p.seq, version=p.version))


# ── provides_of ──────────────────────────────────────────────────────────────────────────────


def test_reads_a_well_formed_list() -> None:
    assert provides_of({"provides": ["foe.goblin", "item.sword"]}) == {"foe.goblin", "item.sword"}
    assert provides_of({"provides": []}) == frozenset()


def test_reads_absent_as_nothing_provided() -> None:
    assert provides_of({}) == frozenset()
    assert provides_of(None) == frozenset()
    assert provides_of([]) == frozenset()


def test_reads_an_unusable_list_as_nothing_provided() -> None:
    unusable: List[Any] = [
        "foe.goblin",
        {"foe.goblin": True},
        ["foe.goblin", "foe.goblin"],
        ["foe goblin"],
        [""],
        ["x" * 129],
        ["é"],
        [7],
        [True],
        ["foe.goblin\n"],
        [f"id.{i}" for i in range(MAX_PROVIDES + 1)],
    ]
    for provides in unusable:
        assert provides_of({"provides": provides}) == frozenset(), provides
    assert len(provides_of({"provides": [f"id.{i}" for i in range(MAX_PROVIDES)]})) == MAX_PROVIDES
    assert CONTENT_ID_PATTERN.fullmatch("x" * 128) is not None
    assert CONTENT_ID_PATTERN.fullmatch("~!res://a/b#c") is not None


def test_verified_payload_of_decodes_or_answers_none() -> None:
    p = pack("djdl.foes", ["foe.goblin"])
    assert provides_of(verified_payload_of(p.jws)) == {"foe.goblin"}
    assert verified_payload_of("a.b") is None
    assert verified_payload_of("a.!!.c") is None
    assert verified_payload_of("a.bm90IGpzb24.c") is None


# ── is_available and pack_for ────────────────────────────────────────────────────────────────


def test_answers_from_an_installed_and_active_pack() -> None:
    foes = pack("djdl.foes", ["foe.goblin", "foe.orc"])
    e = engine(ByteServer.of(foes), stamp=stamp_for(foes))
    e.load()
    assert e.is_available("foe.goblin") is False
    e.ensure(["djdl.foes"])
    assert e.is_available("foe.goblin") is True
    assert e.is_available("foe.dragon") is False
    assert e.pack_for("foe.orc") == provider(foes)
    assert provider(foes).to_dict() == {"packId": foes.pack_id, "release": target(foes)["release"]}


def test_names_a_pack_only_the_target_set_provides_without_installing_it() -> None:
    l10n = pack("djdl.l10n", ["l10n.en"])
    foes = pack("djdl.foes", ["foe.goblin"])
    server = ByteServer.of(l10n, foes)
    e = engine(server, stamp=stamp_for(l10n, foes))
    e.load()
    e.ensure(["djdl.l10n"])
    before = len(server.calls)
    assert e.is_available("foe.goblin") is False
    assert e.pack_for("foe.goblin") == provider(foes)
    # Only the record was read: no object was fetched and nothing was installed.
    assert len(server.calls) == before
    assert "djdl.foes" not in e.state().active
    assert e.is_available("foe.goblin") is False


def test_takes_a_packs_decisions_targets_instead_of_the_stamps_pins() -> None:
    v1 = pack("djdl.events", ["event.halloween"])
    v2 = tree_pack(
        "djdl.events",
        "1.1.0",
        2,
        {"e.txt": "e2"},
        record_extra={"provides": ["event.halloween", "event.winter"]},
    )
    e = engine(ByteServer.of(v1, v2), stamp=stamp_for(v1))
    e.load()
    assert e.pack_for("event.winter") is None
    assert e.pack_for("event.winter", [target(v2)]) == provider(v2)
    # A typed PackTarget is accepted as well as a mapping.
    typed = PackTarget(pack=v2.pack_id, release=ReleasePin(sha256=v2.record_sha256, seq=v2.seq, version=v2.version))
    assert e.pack_for("event.winter", [typed]) == provider(v2)
    assert e.pack_for("event.winter", []) is None


def test_counts_an_embedded_baselines_record() -> None:
    core = pack("djdl.core", ["dice.d6"])
    storage = memory_pack_storage()
    storage.store["embedded/djdl.core"] = {"layout": "tree", "tree": dict(core.files), "index": None}
    # The server holds nothing: the embedded marker's record answers both questions.
    e = engine(ByteServer(), storage=storage, stamp=stamp_for(core))
    loaded = e.load(
        [
            EmbeddedBaseline(
                marker=marker_for(core),
                payload={"kind": "tree", "treeDigest": core.tree_digest},
                location="embedded/djdl.core",
            )
        ]
    )
    assert loaded["refused"] == []
    assert e.is_available("dice.d6") is True
    assert e.pack_for("dice.d6") == provider(core)


def test_answers_nothing_for_an_id_no_pack_provides() -> None:
    plain = pack("djdl.plain")
    broken = pack("djdl.broken", ["ok.id", "ok.id"])
    e = engine(ByteServer.of(plain, broken), stamp=stamp_for(plain, broken))
    e.load()
    e.ensure(["djdl.plain", "djdl.broken"])
    assert e.is_available("ok.id") is False
    assert e.pack_for("ok.id") is None
    assert e.pack_for("anything") is None


def test_skips_a_target_that_names_another_packs_record() -> None:
    foes = pack("djdl.foes", ["foe.goblin"])
    e = engine(ByteServer.of(foes), stamp=stamp_for(foes))
    e.load()
    assert e.pack_for("foe.goblin") == provider(foes)
    forged = {**target(foes), "pack": "djdl.other"}
    assert e.pack_for("foe.goblin", [forged]) is None


def test_skips_a_target_whose_record_cannot_be_fetched() -> None:
    gone = pack("djdl.gone", ["foe.ghost"])
    e = engine(ByteServer(), stamp=stamp_for(gone))
    e.load()
    assert e.pack_for("foe.ghost") is None


def test_hides_a_pack_the_licence_is_not_entitled_to() -> None:
    skins = pack("djdl.skins", ["skin.gold"], entitlement="extras.skins")
    granted: List[Set[str]] = [set()]
    e = engine(ByteServer.of(skins), stamp=stamp_for(skins), entitlements=lambda: granted[0])
    e.load()
    assert e.pack_for("skin.gold") is None
    granted[0] = {"extras.skins"}
    assert e.pack_for("skin.gold") == provider(skins)


def test_requires_load() -> None:
    e = engine(ByteServer(), stamp=None)
    with pytest.raises(PackError) as ex:
        e.is_available("x")
    assert ex.value.code == "not-configured"
    with pytest.raises(PackError) as ex:
        e.pack_for("x")
    assert ex.value.code == "not-configured"
