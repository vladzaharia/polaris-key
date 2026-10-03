# @pkey-feature packs.delegation packs.provides
"""Unit proofs for P4-19's client side in Python (plans/P4-19.md §2.3–§2.7), a port of
client-core's ``test/delegation.test.ts``: the pack engine's delegated surface (a feed target
installs through its delegation; a stamp pin, a hold or a replacement never does), the data-only
rule before any payload byte is fetched and while files are written, the install's
``delegation`` member and its reload, delegation revocations (``pack-revoked``, detail
``delegation``), and ``run_update_check``'s step 11 relevance and decision-input expansion. The
corpus pins every verdict across SDKs (``delegationCases``, ``dataOnlyCases``); these pin the I/O
around them.
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
    content_key_pair,
    delegation_for,
    delegation_revocation_for,
    revocation_for,
    sha,
    sign_feed_doc,
    sign_release_doc,
    tree_pack,
)
from polaris_key.constants_generated import MAX_DELEGATIONS_PER_CHECK, ErrorCode
from polaris_key.core.check import FetchOutcome, UpdateCheckContent, run_update_check
from polaris_key.core.models import InstalledBuild, ReleasePin, UpdateOutlet
from polaris_key.core.release_record import (
    VerifiedRevocation,
    delegated_kid,
    delegation_hash_of,
    verify_revocation,
)
from polaris_key.update.client import UpdateClientOptions, _configure
from polaris_key.update.packs import (
    PackEngine,
    PackError,
    memory_pack_state_store,
    memory_pack_storage,
)
from polaris_key.update.packs.dataonly import data_only_file_refusal
from polaris_key.update.packs.zstd import select_python_zstd

_ZSTD, _ = select_python_zstd()
_plans = [0]


def _plan_id() -> str:
    _plans[0] += 1
    return f"plan-{_plans[0]}"


def engine(server: ByteServer, delegations: Dict[str, str], **kw: Any) -> PackEngine:
    def fetch_record(h: str) -> Dict[str, Any]:
        d = delegations.get(h)
        return {"ok": True, "body": d} if d is not None else server.fetch_record(h)

    opts: Dict[str, Any] = dict(
        product=PRODUCT,
        release_keys=RELEASE_KEYS,
        product_trust=lambda: PRODUCT_TRUST,
        stamp={"contentApi": 1, "pins": [], "expects": []},
        prefs={"engine": None, "axes": {}},
        zstd=_ZSTD,
        mem_budget=1 << 30,
        storage=memory_pack_storage(),
        state=memory_pack_state_store(),
        fetch_record=fetch_record,
        fetch_object=lambda s, o, r: server.fetch_object(s, o, r),
        now=lambda: 1759400000,
        new_plan_id=_plan_id,
    )
    opts.update(kw)
    return PackEngine(**opts)


def target(p: TreePack) -> Dict[str, Any]:
    return {"pack": p.pack_id, "release": {"sha256": p.record_sha256, "seq": p.seq, "version": p.version}}


def fixture(files: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    ck = content_key_pair()
    d = delegation_for("djdl.events", ck["pub"])
    pack = tree_pack(
        "djdl.events.halloween",
        "1.0.0",
        1,
        files if files is not None else {"a.json": "{}"},
        issued_at=1759250000,
        signer={"pem": ck["pem"], "kid": d["kid"]},
    )
    return {
        "ck": ck,
        "d": d,
        "pack": pack,
        "delegations": {d["sha256"]: d["jws"]},
        "server": ByteServer.of(pack),
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


def raises(code: str, fn: Any, **want: Any) -> PackError:
    with pytest.raises(PackError) as ei:
        fn()
    e = ei.value
    assert e.code == code, (e.code, str(e))
    for k, v in want.items():
        assert getattr(e, k) == v, (k, getattr(e, k))
    return e


def test_kid_helpers() -> None:
    f = fixture()
    assert delegation_hash_of(f["pack"].jws) == f["d"]["sha256"]
    assert delegated_kid(f["d"]["sha256"]) == f["d"]["kid"]
    assert delegation_hash_of(f["d"]["jws"]) is None
    assert delegation_hash_of(42) is None


# ── The pack engine (plans/P4-19.md §2.4, §2.5) ─────────────────────────────────────────────


def test_installs_a_delegated_feed_target_stores_its_delegation_and_reloads_it() -> None:
    f = fixture({"lore/a.json": '{"spooky": true}', "img/banner.png": b"\x89PNG\r\n\x1a\nbanner"})
    pack, d = f["pack"], f["d"]
    state, storage = memory_pack_state_store(), memory_pack_storage()
    e = engine(f["server"], f["delegations"], state=state, storage=storage)
    e.load()
    [install] = e.ensure_releases([target(pack)])
    assert install["delegation"] == d["jws"]
    assert e.delegated_releases() == {
        pack.record_sha256: {"pack": pack.pack_id, "delegation": d["sha256"]}
    }
    # A fresh engine over the same state re-verifies the install through its delegation, with no
    # network (an installed release stays valid after its window).
    again = engine(ByteServer(), {}, state=state, storage=storage)
    again.load()
    assert again.state().active[pack.pack_id]["recordSha256"] == pack.record_sha256
    assert pack.pack_id in again.state().running


def test_never_takes_the_delegated_path_for_the_stamps_pin() -> None:
    f = fixture()
    pack = f["pack"]
    e = engine(
        f["server"],
        f["delegations"],
        stamp={
            "contentApi": 1,
            "pins": [target(pack)],
            "expects": [{"pack": pack.pack_id, "required": True, "delivery": "essential"}],
        },
    )
    e.load()
    raises(ErrorCode.RECORD_REJECTED, lambda: e.ensure([pack.pack_id]), detail="jws")


def test_refuses_a_file_off_the_extension_allow_list_before_any_payload_object_is_fetched() -> None:
    f = fixture({"a.json": "{}", "scene.tres": "[gd_resource]"})
    pack, server = f["pack"], f["server"]
    e = engine(server, f["delegations"])
    e.load()
    raises(
        ErrorCode.PACK_NOT_DATA_ONLY,
        lambda: e.ensure_releases([target(pack)]),
        detail="extension",
        path="scene.tres",
    )
    # Only the files index was fetched.
    assert [c["sha256"] for c in server.calls] == [pack.index_sha256]
    # `estimate` reports the same refusal.
    est = e.estimate_releases([target(pack)])
    assert est.refused == [{"packId": pack.pack_id, "code": ErrorCode.PACK_NOT_DATA_ONLY}]


def test_refuses_an_allowed_extension_carrying_a_godot_head_while_writing_and_discards_the_plan() -> None:
    f = fixture({"a.json": "{}", "b.json": "RSRC\x00\x00\x00\x00"})
    pack = f["pack"]
    e = engine(f["server"], f["delegations"])
    e.load()
    raises(
        ErrorCode.PACK_NOT_DATA_ONLY,
        lambda: e.ensure_releases([target(pack)]),
        detail="content",
        path="b.json",
    )
    assert pack.pack_id not in e.state().active
    assert pack.pack_id not in e.state().inflight
    assert data_only_file_refusal("b.json", pack.files["b.json"]) == "content"


def test_refuses_a_release_under_a_revoked_delegation_and_unmounts_it() -> None:
    f = fixture()
    pack, d = f["pack"], f["d"]
    e = engine(f["server"], f["delegations"])
    e.load()
    e.ensure_releases([target(pack)])
    assert pack.pack_id in e.state().running
    rev = delegation_revocation_for(d, "djdl.events")
    e.record_revocations([{"revocation": verified(rev), "jws": rev["jws"]}])
    assert pack.pack_id not in e.state().running
    assert e.revoked_by(pack.record_sha256, d["sha256"]) == "delegation"
    raises(
        ErrorCode.PACK_REVOKED, lambda: e.ensure_releases([target(pack)]), detail="delegation"
    )


def test_re_sniffs_a_reused_install_on_a_noop_plan() -> None:
    files = {"cfg.txt": 'x = Object(GDScript,"script/source":"extends Node")\n'}
    released = tree_pack("djdl.events.halloween", "0.9.0", 1, files)
    ck = content_key_pair()
    d = delegation_for("djdl.events", ck["pub"])
    delegated = tree_pack(
        "djdl.events.halloween",
        "1.0.0",
        2,
        files,
        issued_at=1759250000,
        signer={"pem": ck["pem"], "kid": d["kid"]},
    )
    assert delegated.tree_digest == released.tree_digest
    server = ByteServer.of(released, delegated)
    e = engine(server, {d["sha256"]: d["jws"]})
    e.load()
    e.ensure_releases([target(released)])
    before = len(server.calls)
    raises(
        ErrorCode.PACK_NOT_DATA_ONLY,
        lambda: e.ensure_releases([target(delegated)]),
        detail="content",
        path="cfg.txt",
    )
    assert e.state().active[released.pack_id]["recordSha256"] == released.record_sha256
    # A noop plan: no payload object was fetched for the delegated release.
    assert not any(c["sha256"] == delegated.full_sha256 for c in server.calls[before:])


def test_never_takes_the_delegated_path_for_the_stamps_hold() -> None:
    f = fixture()
    pack = f["pack"]
    e = engine(
        f["server"],
        f["delegations"],
        stamp={"contentApi": 1, "pins": [], "expects": [], "holds": [{**target(pack), "reason": "held"}]},
    )
    e.load()
    raises(ErrorCode.RECORD_REJECTED, lambda: e.ensure_releases([target(pack)]), detail="jws")


def test_never_takes_the_delegated_path_for_a_stored_revocations_replacement() -> None:
    f = fixture()
    pack = f["pack"]
    old = tree_pack(pack.pack_id, "0.9.0", 1, {"a.json": "[]"})
    rev = revocation_for(old, replacement=pack)
    e = engine(ByteServer.of(old, pack), f["delegations"])
    e.load()
    e.record_revocations([{"revocation": verified(rev), "jws": rev["jws"]}])
    raises(ErrorCode.RECORD_REJECTED, lambda: e.ensure_releases([target(pack)]), detail="jws")


def test_fetches_at_most_max_delegations_per_check_distinct_delegations_per_call() -> None:
    ck = content_key_pair()
    delegations: Dict[str, str] = {}
    packs: List[TreePack] = []
    for k in range(MAX_DELEGATIONS_PER_CHECK + 1):
        d = delegation_for("djdl.events", ck["pub"], seq=k + 1)
        delegations[d["sha256"]] = d["jws"]
        packs.append(
            tree_pack(
                f"djdl.events.p{k}",
                "1.0.0",
                1,
                {"a.json": f"[{k}]"},
                issued_at=1759250000,
                signer={"pem": ck["pem"], "kid": d["kid"]},
            )
        )
    e = engine(ByteServer.of(*packs), delegations)
    e.load()
    est = e.estimate_releases([target(p) for p in packs])
    assert len(est.packs) == MAX_DELEGATIONS_PER_CHECK
    assert est.refused == [
        {"packId": f"djdl.events.p{MAX_DELEGATIONS_PER_CHECK}", "code": ErrorCode.NETWORK_ERROR}
    ]
    # The next call has a fresh bound, and the fetched delegations are kept in the process.
    again = e.estimate_releases([target(packs[-1])])
    assert again.refused == []


def test_at_boot_a_stored_delegation_revocation_keeps_the_delegated_install_from_running() -> None:
    f = fixture()
    pack, d = f["pack"], f["d"]
    state, storage, revocations = memory_pack_state_store(), memory_pack_storage(), memory_pack_state_store()
    e = engine(f["server"], f["delegations"], state=state, storage=storage, revocations=revocations)
    e.load()
    e.ensure_releases([target(pack)])
    rev = delegation_revocation_for(d, "djdl.events")
    e.record_revocations([{"revocation": verified(rev), "jws": rev["jws"]}])
    boot = engine(ByteServer(), {}, state=state, storage=storage, revocations=revocations)
    boot.load()
    assert boot.state().active[pack.pack_id]["recordSha256"] == pack.record_sha256
    assert pack.pack_id not in boot.state().running
    raises(
        ErrorCode.PACK_REVOKED, lambda: boot.ensure_releases([target(pack)]), detail="delegation"
    )


def test_a_delegated_variant_carrying_a_chunk_index_still_passes_the_data_only_sink() -> None:
    ck = content_key_pair()
    d = delegation_for("djdl.events", ck["pub"])
    pack = tree_pack(
        "djdl.events.halloween",
        "1.0.0",
        1,
        {"a.json": "{}", "b.json": "[gd_resource]"},
        issued_at=1759250000,
        signer={"pem": ck["pem"], "kid": d["kid"]},
        variant_extra={
            "chunks": {
                "format": "pkey-chunks/1",
                "sha256": sha("chunk index"),
                "bytes": 64,
                "size": 64,
                "codec": "none",
            }
        },
    )
    e = engine(ByteServer.of(pack), {d["sha256"]: d["jws"]})
    e.load()
    raises(
        ErrorCode.PACK_NOT_DATA_ONLY,
        lambda: e.ensure_releases([target(pack)]),
        detail="content",
        path="b.json",
    )


def test_refuses_a_delegated_record_whose_delegation_cannot_be_fetched() -> None:
    f = fixture()
    e = engine(f["server"], {})
    e.load()
    raises("not_found", lambda: e.ensure_releases([target(f["pack"])]), detail="delegation")


def test_drops_a_stored_delegated_install_whose_delegation_was_tampered_with() -> None:
    f = fixture()
    pack = f["pack"]
    state, storage = memory_pack_state_store(), memory_pack_storage()
    e = engine(f["server"], f["delegations"], state=state, storage=storage)
    e.load()
    e.ensure_releases([target(pack)])
    doc = json.loads(state.read() or "{}")
    other = delegation_for("djdl.events", content_key_pair()["pub"])
    doc["active"][pack.pack_id]["delegation"] = other["jws"]
    tampered = memory_pack_state_store()
    tampered.replace(json.dumps(doc))
    again = engine(ByteServer(), {}, state=tampered, storage=storage)
    again.load()
    assert pack.pack_id not in again.state().active


def test_refuses_a_pinned_release_kid_that_is_a_delegated_kid() -> None:
    from polaris_key.core.errors import PolarisError

    kid = "pkd1-" + "a" * 64
    with pytest.raises(PolarisError) as ei:
        _configure(UpdateClientOptions(pinned_release_keys={kid: RELEASE_KEYS[next(iter(RELEASE_KEYS))]}), {})
    assert ei.value.code == ErrorCode.INVALID_OPTIONS


# ── run_update_check and delegation revocations (plans/P4-19.md §2.7) ────────────────────────

NOW = 1_759_400_100


def _setup(kind: bool = True) -> Dict[str, Any]:
    f = fixture()
    d, pack = f["d"], f["pack"]
    app_jws = sign_release_doc(
        {
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
    )
    rev = delegation_revocation_for(d, "djdl.events")
    plain = {k: v for k, v in rev["entry"].items() if k != "kind"}
    feed = {
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
        "revocations": [rev["entry"] if kind else plain],
    }
    feed_jws = sign_feed_doc(feed)
    records = {sha(app_jws): app_jws, rev["record"]: rev["jws"]}
    fetched: List[str] = []

    def fetch_record(h: str) -> FetchOutcome:
        fetched.append(h)
        b = records.get(h)
        return FetchOutcome(ok=True, body=b) if b else FetchOutcome(ok=False, code="network-error")

    def content(delegated: Any) -> UpdateCheckContent:
        return UpdateCheckContent(
            stamp={
                "contentApi": 1,
                "pins": [],
                "expects": [{"pack": pack.pack_id, "required": True, "delivery": "essential"}],
            },
            holds=[],
            active={pack.pack_id: ReleasePin(sha256=pack.record_sha256, seq=pack.seq, version=pack.version)},
            engine=None,
            axes={},
            revoked={},
            relearn=[],
            delegated=delegated,
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
        content=content({pack.record_sha256: {"pack": pack.pack_id, "delegation": d["sha256"]}}),
    )
    return {"d": d, "pack": pack, "rev": rev, "opts": opts, "fetched": fetched, "content": content}


def test_learns_a_delegation_revocation_for_an_active_delegated_install_and_revokes_it() -> None:
    s = _setup()
    r = run_update_check(**s["opts"])
    assert r.ok and r.check is not None and r.revocations is not None
    assert [x.revocation.record for x in r.revocations.learned] == [s["rev"]["record"]]
    assert r.check.decision.action == "blocked"
    assert r.check.decision.reason == "revoked-content"


def test_treats_a_delegation_entry_as_relevant_by_scope_with_no_known_delegated_release() -> None:
    s = _setup()
    r = run_update_check(**{**s["opts"], "content": s["content"]({})})
    assert r.ok and r.check is not None and r.revocations is not None
    # djdl.events covers djdl.events.halloween (an expected, active pack): fetched and stored,
    # but with no known delegated release nothing is revoked for the decision.
    assert [x.revocation.record for x in r.revocations.learned] == [s["rev"]["record"]]
    assert r.check.decision.reason != "revoked-content"


def test_does_not_consider_an_entry_without_kind_whose_target_is_a_delegation() -> None:
    s = _setup(kind=False)
    r = run_update_check(**s["opts"])
    assert r.ok
    assert s["rev"]["record"] not in s["fetched"]


def test_pack_for_resolves_a_delegated_feed_targets_provides() -> None:
    # P4-20 x P4-19: pack_for verifies a delegated feed target through its delegation, as ensure
    # does (one `_fetch_verified`), instead of refusing it at `jws`.
    ck = content_key_pair()
    d = delegation_for("djdl.events", ck["pub"])
    pack = tree_pack(
        "djdl.events.halloween",
        "1.0.0",
        1,
        {"a.json": "{}"},
        issued_at=1759250000,
        signer={"pem": ck["pem"], "kid": d["kid"]},
        record_extra={"provides": ["event.halloween"]},
    )
    server = ByteServer.of(pack)
    e = engine(server, {d["sha256"]: d["jws"]})
    e.load()
    got = e.pack_for("event.halloween", [target(pack)])
    assert got is not None and got.to_dict() == {"packId": pack.pack_id, **{"release": target(pack)["release"]}}
    assert e.delegated_releases() == {
        pack.record_sha256: {"pack": pack.pack_id, "delegation": d["sha256"]}
    }
    # Without the delegation the target cannot verify, so it never answers.
    bare = engine(server, {})
    bare.load()
    assert bare.pack_for("event.halloween", [target(pack)]) is None
