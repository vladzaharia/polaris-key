# @pkey-feature packs.revoke update.content
"""Unit proofs for P4-13's client side in Python (plans/P4-13.md §2.5), a port of client-core's
``test/content.test.ts``: the sibling ``revocations.json`` (written only with a first entry,
re-verified on load, ``relearn``, the 256-target cap, torn and unreadable files, two loads), the
pack engine's ``pack-revoked`` refusals, and ``run_update_check``'s content steps 10–14. The
corpus pins every verdict and decision row across SDKs; these pin the persistence and the I/O
around them, which no corpus row can carry.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import pytest

from pack_fixtures import (
    PRODUCT,
    PRODUCT_TRUST,
    RELEASE_KEYS,
    ByteServer,
    TreePack,
    marker_for,
    revocation_for,
    sha,
    sign_feed_doc,
    sign_release_doc,
    stamp_for,
    tree_pack,
)
from polaris_key.constants_generated import ErrorCode
from polaris_key.core.check import FetchOutcome, UpdateCheckContent, run_update_check
from polaris_key.core.models import InstalledBuild, ReleasePin, UpdateOutlet
from polaris_key.core.release_record import (
    VerifiedRevocation,
    newer_revocation,
    verify_revocation,
)
from polaris_key.update.packs import (
    EmbeddedBaseline,
    PackEngine,
    PackError,
    memory_pack_state_store,
    memory_pack_storage,
    stamp_holds,
)
from polaris_key.update.packs.revocations import (
    MAX_STORED_REVOCATIONS,
    cap_revocations,
    clear_relearn,
    empty_revocations,
    parse_revocations,
    reload_revocations,
    serialize_revocations,
    store_revocation,
)
from polaris_key.update.packs.storage import DirPackStorage
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


@pytest.fixture(scope="module")
def l10n() -> Dict[str, TreePack]:
    return {
        "v1": tree_pack("djdl.l10n", "1.0.0", 1, {"fr.json": '{"a":"b"}'}),
        "v2": tree_pack("djdl.l10n", "1.1.0", 2, {"fr.json": '{"a":"c"}'}),
    }


def verified(r: Dict[str, Any]) -> VerifiedRevocation:
    v = verify_revocation(
        r["jws"],
        release_keys=RELEASE_KEYS,
        product_trust=PRODUCT_TRUST,
        expected_aud=PRODUCT,
        entry=r["entry"],
    )
    assert v.ok and v.revocation is not None, f"revocation refused at {v.step}"
    return v.revocation


def learned(r: Dict[str, Any]) -> Dict[str, Any]:
    return {"revocation": verified(r), "jws": r["jws"]}


class Watched:
    """A state store that records the order of its writes into ``order``."""

    def __init__(self, inner: Any, name: str, order: List[str]) -> None:
        self._inner, self._name, self._order = inner, name, order

    def __getattr__(self, attr: str) -> Any:
        return getattr(self._inner, attr)

    def replace(self, text: str) -> None:
        self._order.append(self._name)
        self._inner.replace(text)


class Unreadable:
    """A store whose ``read`` fails (EIO): the document is unknown, not absent."""

    def __init__(self) -> None:
        self.text: Optional[str] = None
        self.torn: Optional[str] = None

    def read(self) -> Optional[str]:
        raise OSError("EIO")

    def replace(self, text: str) -> None:
        self.text = text

    def quarantine(self, text: str) -> None:
        self.torn = text


def _baseline(storage: Any, v1: TreePack) -> EmbeddedBaseline:
    storage.store["embedded/djdl.l10n"] = {"layout": "tree", "tree": dict(v1.files), "index": None}
    return EmbeddedBaseline(
        marker_for(v1), {"kind": "tree", "treeDigest": v1.tree_digest}, "embedded/djdl.l10n"
    )


# ── revocations.json (pure) ─────────────────────────────────────────────────────────────────


def test_parses_nothing_torn_and_drops_a_malformed_entry_into_relearn() -> None:
    assert parse_revocations("not json") is None
    assert parse_revocations(json.dumps({"v": 2})) is None
    doc = parse_revocations(
        json.dumps(
            {
                "v": 1,
                "revoked": {sha("t"): {"pack": "djdl.l10n", "jws": 5}},
                "relearn": ["djdl.other", "Not A Pack"],
            }
        )
    )
    assert doc == {"v": 1, "revoked": {}, "relearn": ["djdl.l10n", "djdl.other"]}


def test_stores_a_new_target_supersedes_with_a_newer_one_ignores_an_older_one(
    l10n: Dict[str, TreePack],
) -> None:
    v1, v2 = l10n["v1"], l10n["v2"]
    a = revocation_for(v1, issued_at=1000)
    b = revocation_for(v1, issued_at=2000, replacement=v2)
    old = revocation_for(v1, issued_at=500, reason="older")
    va, vb, vo = verified(a), verified(b), verified(old)
    doc, changed = store_revocation(empty_revocations(), va, a["jws"])
    assert changed
    assert store_revocation(doc, va, a["jws"])[1] is False
    doc, _ = store_revocation(doc, vb, b["jws"], lambda _t: va)
    assert doc["revoked"][v1.record_sha256]["record"] == b["record"]
    assert store_revocation(doc, vo, old["jws"], lambda _t: vb)[1] is False
    # Without the verified copy the stored entry's own issuedAt ranks it.
    assert store_revocation(doc, vo, old["jws"])[1] is False
    assert newer_revocation(va, vb) is vb


def test_keeps_at_most_256_targets_dropping_the_oldest_without_relearn() -> None:
    doc = empty_revocations()
    for i in range(MAX_STORED_REVOCATIONS + 3):
        doc["revoked"][sha(f"t{i}")] = {
            "jws": "x",
            "pack": "djdl.l10n",
            "version": "1.0.0",
            "seq": 1,
            "record": sha(f"r{i}"),
            "issuedAt": 1000 + i,
        }
    capped = cap_revocations(doc)
    assert len(capped["revoked"]) == MAX_STORED_REVOCATIONS
    for i in (0, 1, 2):
        assert sha(f"t{i}") not in capped["revoked"]
    assert capped["relearn"] == []


def test_reverifies_on_load_a_rotated_key_forgets_any_other_failure_relearns(
    l10n: Dict[str, TreePack],
) -> None:
    v1, v2 = l10n["v1"], l10n["v2"]
    good = revocation_for(v1)
    rotated = revocation_for(v2, kid="djdl-release-test-2027")
    doc = empty_revocations()
    doc["revoked"][v1.record_sha256] = {
        "jws": good["jws"],
        "pack": "djdl.l10n",
        "version": "1.0.0",
        "seq": 1,
        "record": good["record"],
        "issuedAt": 1759350000,
    }
    doc["revoked"][v2.record_sha256] = {
        "jws": rotated["jws"],
        "pack": "djdl.l10n",
        "version": "1.1.0",
        "seq": 2,
        "record": rotated["record"],
        "issuedAt": 1759350000,
    }
    keys = dict(release_keys=RELEASE_KEYS, product_trust=PRODUCT_TRUST, expected_aud=PRODUCT)
    r = reload_revocations(doc, **keys)
    assert list(r.doc["revoked"]) == [v1.record_sha256]
    assert r.doc["relearn"] == []
    assert r.changed
    # A pin mismatch (the stored seq is wrong) relearns the pack.
    doc["revoked"][v1.record_sha256] = {**doc["revoked"][v1.record_sha256], "seq": 9}
    r2 = reload_revocations(doc, **keys)
    assert r2.doc["revoked"] == {}
    assert r2.doc["relearn"] == ["djdl.l10n"]
    assert clear_relearn(r2.doc, ["djdl.l10n"])[0]["relearn"] == []


def test_reads_a_stamps_holds_beside_parse_content_stamp_with_the_token_rule() -> None:
    pin = {"sha256": sha("h"), "seq": 3, "version": "1.0.0"}
    stamp = {
        "format": "pkey-content/1",
        "contentApi": 1,
        "pins": [],
        "expects": [],
        "holds": [{"pack": "djdl.l10n", "release": pin}],
    }
    text = json.dumps(stamp, separators=(",", ":"))
    assert stamp_holds(text) == [{"pack": "djdl.l10n", "release": pin}]
    assert stamp_holds(text.replace('"seq":3', '"seq":3.0')) is None
    assert stamp_holds(json.dumps({k: v for k, v in stamp.items() if k != "holds"})) == []


# ── PackEngine and revocations (plans/P4-13.md §2.5) ────────────────────────────────────────


def test_a_product_with_no_revocations_writes_no_file_and_no_flag(l10n: Dict[str, TreePack]) -> None:
    v1 = l10n["v1"]
    state, revs = memory_pack_state_store(), memory_pack_state_store()
    storage = memory_pack_storage()
    e = engine(ByteServer.of(v1), storage=storage, state=state, revocations=revs, stamp=stamp_for(v1))
    e.load()
    e.ensure(["djdl.l10n"])
    e.record_revocations([])
    assert revs.text is None
    assert "revocationsStored" not in json.loads(state.text or "{}")
    # A second load of the same product: still nothing, and the install mounts exactly as before.
    again = engine(ByteServer.of(v1), storage=storage, state=state, revocations=revs, stamp=stamp_for(v1))
    again.load()
    assert again.state().running["djdl.l10n"]["recordSha256"] == v1.record_sha256
    assert revs.text is None
    assert "revocationsStored" not in json.loads(state.text or "{}")
    assert again.revocations().issue is None


def test_no_revocations_with_an_unreadable_absent_file_refuses_nothing(
    l10n: Dict[str, TreePack],
) -> None:
    v1 = l10n["v1"]
    storage = memory_pack_storage()
    baseline = _baseline(storage, v1)
    e = engine(ByteServer(), storage=storage, revocations=Unreadable(), stamp=stamp_for(v1))
    e.load([baseline])
    assert e.revocations().issue == "unreadable"
    assert e.state().running["djdl.l10n"].get("embedded") is True
    assert e.ensure(["djdl.l10n"])[0]["recordSha256"] == v1.record_sha256


def test_stores_a_revocation_flag_first_unmounts_and_refuses_it(l10n: Dict[str, TreePack]) -> None:
    v1 = l10n["v1"]
    state, revs = memory_pack_state_store(), memory_pack_state_store()
    order: List[str] = []
    e = engine(
        ByteServer.of(v1),
        state=Watched(state, "state", order),
        revocations=Watched(revs, "revocations", order),
        stamp=stamp_for(v1),
    )
    e.load()
    e.ensure(["djdl.l10n"])
    assert "djdl.l10n" in e.state().running
    r = revocation_for(v1)
    order.clear()
    e.record_revocations([learned(r)])
    assert order == ["state", "revocations"]
    assert json.loads(state.text or "{}")["revocationsStored"] is True
    assert list(json.loads(revs.text or "{}")["revoked"]) == [v1.record_sha256]
    assert "djdl.l10n" not in e.state().running
    with pytest.raises(PackError) as err:
        e.ensure(["djdl.l10n"])
    assert err.value.code == ErrorCode.PACK_REVOKED
    assert e.rollback("djdl.l10n") is False

    # A fresh process re-verifies the file and never mounts the revoked install.
    again = engine(ByteServer.of(v1), state=state, revocations=revs, stamp=stamp_for(v1))
    again.load()
    assert "djdl.l10n" not in again.state().running
    assert again.is_revoked(v1.record_sha256)
    assert again.revocations().verified[v1.record_sha256].record == r["record"]


def test_two_loads_over_a_directory_keep_the_revocation(tmp_path: Any, l10n: Dict[str, TreePack]) -> None:
    v1 = l10n["v1"]
    root = str(tmp_path / "packs")
    storage = DirPackStorage(root)
    storage.free_disk()
    e = engine(
        ByteServer.of(v1),
        storage=storage,
        state=storage.state_store(),
        revocations=storage.revocation_store(),
        stamp=stamp_for(v1),
    )
    e.load()
    e.ensure(["djdl.l10n"])
    assert not (tmp_path / "packs" / "revocations.json").exists()
    e.record_revocations([learned(revocation_for(v1))])
    assert (tmp_path / "packs" / "revocations.json").exists()
    storage2 = DirPackStorage(root)
    again = engine(
        ByteServer.of(v1),
        storage=storage2,
        state=storage2.state_store(),
        revocations=storage2.revocation_store(),
        stamp=stamp_for(v1),
    )
    again.load()
    assert again.is_revoked(v1.record_sha256)
    assert "djdl.l10n" not in again.state().running


def test_refuses_a_revoked_baseline_and_a_pack_in_relearn_after_a_torn_file(
    l10n: Dict[str, TreePack],
) -> None:
    v1 = l10n["v1"]
    storage = memory_pack_storage()
    baseline = _baseline(storage, v1)
    # Torn: quarantined, replaced by a fresh file whose relearn holds the stamp's pins.
    revs = memory_pack_state_store("{torn")
    state = memory_pack_state_store()
    e = engine(ByteServer.of(v1), storage=storage, state=state, revocations=revs, stamp=stamp_for(v1))
    e.load([baseline])
    assert revs.torn == "{torn"
    assert json.loads(revs.text or "{}")["relearn"] == ["djdl.l10n"]
    assert json.loads(state.text or "{}")["revocationsStored"] is True
    assert e.revocations().issue == "torn"
    assert "djdl.l10n" not in e.state().running
    # A fresh feed that re-teaches the pack clears relearn; the baseline mounts next boot.
    e.record_revocations([], relearn_cleared=["djdl.l10n"])
    assert json.loads(revs.text or "{}")["relearn"] == []
    nxt = engine(ByteServer.of(v1), storage=storage, state=state, revocations=revs, stamp=stamp_for(v1))
    nxt.load([baseline])
    assert nxt.state().running["djdl.l10n"].get("embedded") is True

    # recover_state() clears relearn wholesale and releases the quarantine.
    torn2 = memory_pack_state_store("{torn")
    e2 = engine(ByteServer.of(v1), storage=storage, revocations=torn2, stamp=stamp_for(v1))
    e2.load([baseline])
    e2.recover_state()
    assert torn2.torn is None
    assert e2.revocations().relearn == []
    assert json.loads(torn2.text or "{}")["relearn"] == []


def test_an_unreadable_file_refuses_the_stamps_baselines_only_when_the_flag_is_set(
    l10n: Dict[str, TreePack],
) -> None:
    v1 = l10n["v1"]
    storage = memory_pack_storage()
    baseline = _baseline(storage, v1)
    flagged = memory_pack_state_store(
        json.dumps(
            {
                "v": 1,
                "active": {},
                "previous": {},
                "inflight": {},
                "observed": {},
                "confirmedBootSeq": 0,
                "bootSeq": 0,
                "revocationsStored": True,
            }
        )
    )
    unreadable = Unreadable()
    a = engine(ByteServer.of(v1), storage=storage, state=flagged, revocations=unreadable, stamp=stamp_for(v1))
    a.load([baseline])
    assert a.revocations().issue == "unreadable"
    assert "djdl.l10n" not in a.state().running
    # Nothing is written to an unreadable file, even when a revocation is learned.
    a.record_revocations([learned(revocation_for(v1))])
    assert unreadable.text is None
    assert a.is_revoked(v1.record_sha256)
    b = engine(ByteServer.of(v1), storage=storage, revocations=Unreadable(), stamp=stamp_for(v1))
    b.load([baseline])
    assert b.state().running["djdl.l10n"].get("embedded") is True


def test_offline_a_baseline_refused_for_relearn_raises_pack_revoked_relearn(
    l10n: Dict[str, TreePack],
) -> None:
    v1 = l10n["v1"]
    storage = memory_pack_storage()
    baseline = _baseline(storage, v1)
    e = engine(
        ByteServer(),  # offline: no record can be fetched
        storage=storage,
        revocations=memory_pack_state_store("{torn"),
        stamp=stamp_for(v1),
    )
    e.load([baseline])
    with pytest.raises(PackError) as err:
        e.ensure(["djdl.l10n"])
    assert err.value.code == ErrorCode.PACK_REVOKED
    assert err.value.detail == "relearn"
    assert err.value.pack_id == "djdl.l10n"


def test_online_a_baseline_refused_for_relearn_is_fetched_instead(l10n: Dict[str, TreePack]) -> None:
    v1 = l10n["v1"]
    storage = memory_pack_storage()
    baseline = _baseline(storage, v1)
    e = engine(
        ByteServer.of(v1), storage=storage, revocations=memory_pack_state_store("{torn"), stamp=stamp_for(v1)
    )
    e.load([baseline])
    assert "djdl.l10n" not in e.state().running
    # The record is fetched and verified again over the network, then the release runs.
    got = e.ensure(["djdl.l10n"])[0]
    assert got["recordSha256"] == v1.record_sha256
    assert e.state().active["djdl.l10n"]["recordSha256"] == v1.record_sha256


def test_restores_revocations_stored_when_state_lost_it(l10n: Dict[str, TreePack]) -> None:
    v1 = l10n["v1"]
    r = revocation_for(v1)
    doc, _ = store_revocation(empty_revocations(), verified(r), r["jws"])
    state = memory_pack_state_store("{torn state")
    e = engine(
        ByteServer.of(v1),
        state=state,
        revocations=memory_pack_state_store(serialize_revocations(doc)),
        stamp=stamp_for(v1),
    )
    e.load()
    assert e.state().state_issue == "torn"
    assert json.loads(state.text or "{}")["revocationsStored"] is True
    assert e.is_revoked(v1.record_sha256)


def test_raises_a_typed_pack_error_for_a_revoked_pin(l10n: Dict[str, TreePack]) -> None:
    v1 = l10n["v1"]
    e = engine(ByteServer.of(v1), stamp=stamp_for(v1))
    e.load()
    e.record_revocations([learned(revocation_for(v1))])
    with pytest.raises(PackError) as err:
        e.ensure(["djdl.l10n"])
    assert err.value.code == ErrorCode.PACK_REVOKED


def test_ensure_releases_installs_the_exact_release_and_refuses_a_revoked_one(
    l10n: Dict[str, TreePack],
) -> None:
    v1, v2 = l10n["v1"], l10n["v2"]
    e = engine(ByteServer.of(v1, v2), stamp=stamp_for(v1))
    e.load()
    pin2 = {"sha256": v2.record_sha256, "seq": 2, "version": "1.1.0"}
    assert e.estimate_releases([{"pack": "djdl.l10n", "release": pin2}]).packs == ["djdl.l10n"]
    got = e.ensure_releases([{"pack": "djdl.l10n", "release": pin2}])[0]
    assert got["recordSha256"] == v2.record_sha256
    e.record_revocations([learned(revocation_for(v2))])
    assert "djdl.l10n" not in e.state().running
    with pytest.raises(PackError) as err:
        e.ensure_releases([{"pack": "djdl.l10n", "release": pin2}])
    assert err.value.code == ErrorCode.PACK_REVOKED


def test_the_cap_drops_the_oldest_stored_target(l10n: Dict[str, TreePack]) -> None:
    v1 = l10n["v1"]
    revs = memory_pack_state_store()
    e = engine(ByteServer.of(v1), revocations=revs, stamp=stamp_for(v1))
    e.load()
    e.record_revocations([learned(revocation_for(v1, issued_at=1))])
    assert e.is_revoked(v1.record_sha256)
    # Fill the stored document past the cap with newer entries, then reload: the oldest goes.
    doc = json.loads(revs.text or "{}")
    for i in range(MAX_STORED_REVOCATIONS):
        doc["revoked"][sha(f"t{i}")] = {
            "jws": "x",
            "pack": "djdl.other",
            "version": "1.0.0",
            "seq": 1,
            "record": sha(f"r{i}"),
            "issuedAt": 1000 + i,
        }
    assert len(cap_revocations(doc)["revoked"]) == MAX_STORED_REVOCATIONS
    assert v1.record_sha256 not in cap_revocations(doc)["revoked"]


# ── run_update_check content steps 10–14 (plans/P4-13.md §2.5) ──────────────────────────────

NOW = 1_759_400_100


def _setup(l10n: Dict[str, TreePack], *, replacement: bool = False, no_pack_sets: bool = False) -> Dict[str, Any]:
    v1, v2 = l10n["v1"], l10n["v2"]
    app_record = {
        "schemaVersion": 1,
        "aud": PRODUCT,
        "deliverable": "app",
        "kind": "app",
        "version": "1.5.0",
        "seq": 15,
        "issuedAt": 1_759_000_000,
        "builds": [
            {
                "id": "macos-dmg",
                "platform": "macos",
                "arch": "universal",
                "format": "dmg",
                "artifacts": [{"name": "a.dmg", "role": "payload", "sha256": sha("a"), "size": 1}],
            }
        ],
    }
    app_jws = sign_release_doc(app_record)
    rev = revocation_for(v1, replacement=v2 if replacement else None)
    set_id = sha(f"djdl.l10n {v1.record_sha256}\n")
    feed: Dict[str, Any] = {
        "schemaVersion": 1,
        "iss": "key.plrs.im",
        "aud": PRODUCT,
        "channel": "stable",
        "selector": {},
        "seq": 7,
        "issuedAt": NOW - 100,
        "expiresAt": NOW + 800,
        "app": {
            "deliverable": "app",
            "versionScheme": "semver",
            "targets": [
                {
                    "platform": "macos",
                    "release": {"sha256": sha(app_jws), "seq": 15, "version": "1.5.0"},
                    "floor": None,
                    "critical": False,
                    "outlets": {
                        "direct": {"kind": "direct", "live": {"version": "1.5.0", "seq": 15}, "halted": False}
                    },
                }
            ],
        },
    }
    if not no_pack_sets:
        feed["packSets"] = {
            "releases": {v1.record_sha256: {"pack": "djdl.l10n", "version": "1.0.0", "seq": 1}},
            "sets": {set_id: [v1.record_sha256]},
            "rows": [{"contentApi": 1, "platform": "macos", "engine": "", "variant": {}, "set": set_id}],
        }
    feed["revocations"] = [rev["entry"]]
    feed_jws = sign_feed_doc(feed)
    records = {
        sha(app_jws): app_jws,
        rev["record"]: rev["jws"],
        v1.record_sha256: v1.jws,
        v2.record_sha256: v2.jws,
    }
    fetched: List[str] = []

    def fetch_record(h: str) -> FetchOutcome:
        fetched.append(h)
        b = records.get(h)
        return FetchOutcome(ok=True, body=b) if b else FetchOutcome(ok=False, code="network-error")

    content = UpdateCheckContent(
        stamp={
            "contentApi": 1,
            "pins": [],
            "expects": [{"pack": "djdl.l10n", "required": True, "delivery": "essential"}],
        },
        holds=[],
        active={"djdl.l10n": ReleasePin(sha256=v1.record_sha256, seq=1, version="1.0.0")},
        engine=None,
        axes={},
        revoked={},
        relearn=["djdl.l10n"],
    )
    opts: Dict[str, Any] = dict(
        channel="stable",
        expected_aud=PRODUCT,
        trust=PRODUCT_TRUST,
        release_keys=RELEASE_KEYS,
        now=NOW,
        install_id="dev_1",
        installed=InstalledBuild(version="1.5.0", platform="macos", arch="arm64"),
        outlet=UpdateOutlet(id="direct", kind="direct"),
        subkind=None,
        methods=["download"],
        cache_feeds={},
        cache_release_records={},
        fetch_feed=lambda _c: FetchOutcome(ok=True, body=feed_jws),
        fetch_record=fetch_record,
        content=content,
    )
    return {"v1": v1, "v2": v2, "rev": rev, "opts": opts, "fetched": fetched, "content": content}


def _with_content(s: Dict[str, Any], **kw: Any) -> Dict[str, Any]:
    c = s["content"]
    fields = dict(
        stamp=c.stamp,
        holds=c.holds,
        active=c.active,
        engine=c.engine,
        axes=c.axes,
        revoked=c.revoked,
        relearn=c.relearn,
    )
    fields.update(kw)
    return {**s["opts"], "content": UpdateCheckContent(**fields)}


def test_learns_a_relevant_revocation_and_blocks_revoked_required_content(
    l10n: Dict[str, TreePack],
) -> None:
    s = _setup(l10n)
    r = run_update_check(**s["opts"])
    assert r.ok and r.check is not None and r.revocations is not None
    assert [x.revocation.record for x in r.revocations.learned] == [s["rev"]["record"]]
    assert r.revocations.relearn_cleared == ["djdl.l10n"]
    assert r.check.decision.action == "blocked"
    assert r.check.decision.reason == "revoked-content"
    assert r.boot == "required"


def test_clears_relearn_when_the_feed_lists_only_an_older_release_the_device_does_not_hold(
    l10n: Dict[str, TreePack],
) -> None:
    s = _setup(l10n, no_pack_sets=True)
    v2 = s["v2"]
    pin2 = ReleasePin(sha256=v2.record_sha256, seq=2, version="1.1.0")
    opts = _with_content(
        s,
        stamp={**s["content"].stamp, "pins": [{"pack": "djdl.l10n", "release": pin2.to_dict()}]},
        active={"djdl.l10n": pin2},
    )
    r = run_update_check(**opts)
    assert r.ok and r.revocations is not None
    # v1 is outside H: its revocation is not fetched, and it keeps nothing in relearn.
    assert s["rev"]["record"] not in s["fetched"]
    assert r.revocations.learned == []
    assert r.revocations.relearn_cleared == ["djdl.l10n"]


def test_keeps_relearn_while_a_considered_revocation_cannot_be_fetched(l10n: Dict[str, TreePack]) -> None:
    s = _setup(l10n)
    inner = s["opts"]["fetch_record"]
    rev_record = s["rev"]["record"]
    opts = {
        **s["opts"],
        "fetch_record": lambda h: FetchOutcome(ok=False, code="network-error") if h == rev_record else inner(h),
    }
    r = run_update_check(**opts)
    assert r.ok and r.revocations is not None
    assert r.revocations.relearn_cleared == []


def test_installs_a_fetched_verified_usable_replacement_instead(l10n: Dict[str, TreePack]) -> None:
    s = _setup(l10n, replacement=True)
    v2 = s["v2"]
    r = run_update_check(**s["opts"])
    assert r.ok and r.check is not None
    assert v2.record_sha256 in s["fetched"]
    d = r.check.decision.to_dict()
    assert d["action"] == "packs"
    assert d["install"] == [
        {"pack": "djdl.l10n", "release": {"sha256": v2.record_sha256, "seq": 2, "version": "1.1.0"}}
    ]
    assert r.boot == "none"


def test_an_unfetchable_replacement_is_not_yet_usable_the_required_pack_stays_blocked(
    l10n: Dict[str, TreePack],
) -> None:
    s = _setup(l10n, replacement=True)
    inner = s["opts"]["fetch_record"]
    v2_hash = s["v2"].record_sha256
    opts = {
        **s["opts"],
        "fetch_record": lambda h: FetchOutcome(ok=False, code="network-error") if h == v2_hash else inner(h),
    }
    r = run_update_check(**opts)
    assert r.ok and r.check is not None
    assert r.check.decision.action == "blocked"


def test_skips_a_stored_revocation_and_clears_nothing_from_a_committed_feed(
    l10n: Dict[str, TreePack],
) -> None:
    s = _setup(l10n)
    v = verified(s["rev"])
    first = run_update_check(**s["opts"])
    assert first.ok
    s["fetched"].clear()
    opts = _with_content(s, revoked={s["rev"]["entry"]["target"]: v})
    opts.update(
        cache_feeds=first.feeds,
        cache_release_records=first.release_records,
        fetch_feed=lambda _c: FetchOutcome(ok=False, code="network-error"),
    )
    r = run_update_check(**opts)
    assert r.ok and r.check is not None and r.revocations is not None
    assert s["rev"]["record"] not in s["fetched"]
    assert r.check.feed == "committed"
    assert r.revocations.relearn_cleared == []


def test_without_content_the_check_is_p3_01(l10n: Dict[str, TreePack]) -> None:
    s = _setup(l10n)
    opts = {**s["opts"]}
    del opts["content"]
    r = run_update_check(**opts)
    assert r.ok and r.check is not None
    assert r.revocations is None
    assert s["rev"]["record"] not in s["fetched"]
    assert r.check.decision.action == "none"
