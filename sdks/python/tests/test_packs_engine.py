# @pkey-feature packs.state packs.handlers
"""Unit proofs for the pack install-state machine and the pipeline (plans/P4-01.md §2.13; CONTENT
§9–§10), a port of client-core's ``test/packsEngine.test.ts``. The appliers, planner and
selection are pinned by the content corpus and ``plan-matrix.json``; these pin what no corpus row
can: commit and the pointer swap, resume, rollback, garbage-collection roots, embedded baselines,
the boot stage machine's host side (whose machine ``stage-matrix.json`` pins) and the state
reload that trusts nothing it reads back.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional

import pytest

from pack_fixtures import (
    PRODUCT,
    PRODUCT_TRUST,
    PROBE_BASE,
    PROBE_TARGET,
    RELEASE_KEYS,
    ByteServer,
    TreePack,
    marker_for,
    sha,
    stamp_for,
    tree_pack,
)
from polaris_key.core.stages import boot_transition, initial_boot_state
from polaris_key.update.packs import (
    ApplyPorts,
    EmbeddedBaseline,
    PackEngine,
    PackError,
    PackHandler,
    apply_delta,
    boot_pack_options,
    commit_install,
    empty_pack_state,
    gc_roots,
    memory_pack_state_store,
    memory_pack_storage,
    memory_source,
    pack_set_id,
    parse_pack_state,
    reload_pack_state,
    rollback_install,
    run_boot_fetch,
    serialize_pack_state,
)
from polaris_key.update.packs.zstd import select_python_zstd


_ZSTD, _ = select_python_zstd()


class Counting:
    """A streaming SHA-256 port that counts the bytes it is fed."""

    def __init__(self) -> None:
        self.fed = 0

    def __call__(self) -> Any:
        outer = self
        h = hashlib.sha256()

        class _H:
            def update(self, b: bytes) -> None:
                outer.fed += len(b)
                h.update(b)

            def hexdigest(self) -> str:
                return h.hexdigest()

        return _H()


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
        sha256=Counting(),
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


V1_FILES: Dict[str, Any] = {
    "fr/strings.json": '{"hello":"bonjour"}',
    "fr/menu.json": '{"play":"jouer"}',
    "probe.txt": PROBE_BASE,
    "big.bin": "x" * 50000,
}


def releases() -> Dict[str, TreePack]:
    v1 = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES)
    v2 = tree_pack("djdl.l10n", "1.1.0", 2, {**V1_FILES, "fr/strings.json": '{"hello":"salut"}'})
    v3 = tree_pack(
        "djdl.l10n",
        "1.2.0",
        3,
        {**V1_FILES, "fr/strings.json": '{"hello":"salut"}', "probe.txt": PROBE_TARGET, "fr/new.json": "{}"},
        from_pack=v2,
    )
    return {"v1": v1, "v2": v2, "v3": v3}


def tree_of(storage: Any, location: str) -> Dict[str, str]:
    t = (storage.store.get(location) or {}).get("tree") or {}
    return {p: sha(b) for p, b in t.items()}


def hashes(files: Dict[str, bytes]) -> Dict[str, str]:
    return {p: sha(b) for p, b in files.items()}


def test_probe_vector_fixture() -> None:
    assert sha(PROBE_TARGET) == "cb0e436ee45ab5d453e18dd20612ce36c56e371dbf940bc5cabd20fd0ef27c27"


# ── the install-state machine (pure) ────────────────────────────────────────────────────────


def _install(pack_id: str, n: int) -> Dict[str, Any]:
    return {
        "packId": pack_id,
        "record": f"r{n}",
        "recordSha256": sha(f"r{n}"),
        "version": f"1.{n}.0",
        "seq": n,
        "type": "files.tree",
        "variant": "",
        "layout": "tree",
        "payloadSha256": sha(f"p{n}"),
        "payloadSize": n,
        "activation": "hot",
        "location": f"{pack_id}/{n}",
        "installedAt": n,
    }


def test_commit_swaps_and_rollback_restores() -> None:
    s = commit_install(empty_pack_state(), _install("a", 1))
    s = commit_install(s, _install("a", 2))
    assert s["active"]["a"]["seq"] == 2
    assert s["previous"]["a"]["seq"] == 1
    r, rolled = rollback_install(s, "a")
    assert rolled
    assert r["active"]["a"]["seq"] == 1
    assert "a" not in r["previous"]
    assert rollback_install(r, "a")[1] is False


def test_gc_roots() -> None:
    s = commit_install(empty_pack_state(), _install("a", 1))
    s = commit_install(s, _install("a", 2))
    s = dict(
        s,
        inflight={
            "b": {
                "planId": "p9",
                "packId": "b",
                "record": "x",
                "recordSha256": sha("x"),
                "variant": "",
                "strategy": "full",
                "objects": [],
                "startedAt": 0,
            }
        },
    )
    locations, plans = gc_roots(s, [{"location": "emb/c"}])
    assert sorted(locations) == ["a/1", "a/2", "emb/c"]
    assert sorted(plans) == ["p9"]


def test_parse_and_reload_trust_nothing() -> None:
    assert parse_pack_state("not json") == empty_pack_state()
    assert parse_pack_state(json.dumps({"v": 2})) == empty_pack_state()
    s = commit_install(commit_install(empty_pack_state(), _install("a", 1)), _install("b", 2))
    text = serialize_pack_state(s).replace('"payloadSize":2', '"payloadSize":-2')
    assert list(parse_pack_state(text)["active"].keys()) == ["a"]
    reloaded = reload_pack_state(s, lambda i: i["packId"] == "b", lambda j: True)
    assert list(reloaded["active"].keys()) == ["b"]
    assert reloaded["bootSeq"] == s["bootSeq"] + 1


# ── PackEngine: a files.tree pack through the pipeline ──────────────────────────────────────


def test_installs_by_full_reports_pack_set_id_and_keeps_index() -> None:
    v1 = releases()["v1"]
    server = ByteServer.of(v1)
    storage = memory_pack_storage()
    e = engine(server, storage=storage, stamp=stamp_for(v1))
    e.load()
    progress: List[int] = []
    e.on(lambda p: progress.append(p.done))
    (i,) = e.ensure(["djdl.l10n"])
    assert i["recordSha256"] == v1.record_sha256
    assert i["payloadSha256"] == v1.tree_digest
    assert tree_of(storage, i["location"]) == hashes(v1.files)
    assert len(storage.store[i["location"]]["index"]["files"]) == 4
    assert e.state().running["djdl.l10n"]["recordSha256"] == v1.record_sha256
    assert e.pack_set_id() == pack_set_id([{"packId": "djdl.l10n", "releaseSha256": v1.record_sha256}])
    assert [c["sha256"] for c in server.calls] == [v1.index_sha256, v1.full_sha256]
    assert progress[-1] > 0
    e.ensure(["djdl.l10n"])
    assert len(server.calls) == 2


def test_updates_by_file_and_by_files_delta_set() -> None:
    r = releases()
    v1, v2, v3 = r["v1"], r["v2"], r["v3"]
    server = ByteServer.of(v1, v2, v3)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    e.ensure(["djdl.l10n"])

    server.calls.clear()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v2))
    e.load()
    (i2,) = e.ensure(["djdl.l10n"])
    assert tree_of(storage, i2["location"]) == hashes(v2.files)
    assert [c["sha256"] for c in server.calls] == [v2.index_sha256, sha('{"hello":"salut"}')]

    server.calls.clear()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v3), strategies=["delta", "full"])
    e.load()
    (i3,) = e.ensure(["djdl.l10n"])
    assert tree_of(storage, i3["location"]) == hashes(v3.files)
    want = sorted(
        h
        for h in v3.objects
        if h not in v2.objects
        and h not in (v3.index_sha256, v3.full_sha256, sha(PROBE_TARGET), sha("{}"))
    )
    assert sorted(c["sha256"] for c in server.calls[1:]) == want
    assert e.state().previous["djdl.l10n"]["recordSha256"] == v2.record_sha256
    assert sorted(storage.store.keys()) == sorted([i2["location"], i3["location"]])
    assert len(storage.staging) == 0


def test_crash_before_pointer_swap_leaves_active_untouched() -> None:
    r = releases()
    v1, v2 = r["v1"], r["v2"]
    server = ByteServer.of(v1, v2)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    (i1,) = e.ensure(["djdl.l10n"])
    before = state.text

    class Dying:
        def read(self) -> Optional[str]:
            return state.read()

        def replace(self, text: str) -> None:
            doc = json.loads(text)
            if (doc["active"].get("djdl.l10n") or {}).get("seq") == 2:
                raise RuntimeError("killed")
            state.replace(text)

        def quarantine(self, t: str) -> None:
            state.quarantine(t)

        def quarantined(self) -> bool:
            return state.quarantined()

        def clear_quarantine(self) -> None:
            state.clear_quarantine()

    e = engine(server, storage=storage, state=Dying(), stamp=stamp_for(v2))
    e.load()
    with pytest.raises(RuntimeError, match="killed"):
        e.ensure(["djdl.l10n"])
    assert json.loads(state.text)["active"]["djdl.l10n"]["seq"] == 1
    assert state.text != before

    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    assert e.state().active["djdl.l10n"]["recordSha256"] == v1.record_sha256
    assert list(storage.store.keys()) == [i1["location"]]


def test_resumes_with_range_and_if_range_rehashing_staged() -> None:
    v1 = releases()["v1"]
    server = ByteServer.of(v1)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1), checkpoint_bytes=1)
    e.load()
    orig = server.fetch_object
    n = [0]

    def cutting(s: str, o: int, r: Optional[str]) -> Any:
        n[0] += 1
        if n[0] == 2:
            server.cut = 1000
        return orig(s, o, r)

    e._fetch_object = cutting  # type: ignore[attr-defined]
    with pytest.raises(PackError) as ex:
        e.ensure(["djdl.l10n"])
    assert ex.value.code == "network-error"
    journal = json.loads(state.text)["inflight"]["djdl.l10n"]
    assert next(o for o in journal["objects"] if o["sha256"] == v1.full_sha256)["done"] == 1000

    server.calls.clear()
    relaunch = Counting()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1), sha256=relaunch)
    e.load()
    assert "djdl.l10n" in e.state().inflight
    (i,) = e.ensure(["djdl.l10n"])
    assert tree_of(storage, i["location"]) == hashes(v1.files)
    resumed = next(c for c in server.calls if c["sha256"] == v1.full_sha256)
    assert resumed == {"sha256": v1.full_sha256, "offset": 1000, "ifRange": f'"{v1.full_sha256}"'}
    assert relaunch.fed >= 1000 + v1.size


def test_refetches_when_staged_prefix_no_longer_hashes() -> None:
    v1 = releases()["v1"]
    server = ByteServer.of(v1)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    orig = server.fetch_object
    n = [0]

    def cutting(s: str, o: int, r: Optional[str]) -> Any:
        n[0] += 1
        if n[0] == 2:
            server.cut = 1000
        return orig(s, o, r)

    e._fetch_object = cutting  # type: ignore[attr-defined]
    with pytest.raises(PackError):
        e.ensure(["djdl.l10n"])
    for objs in storage.staging.values():
        b = objs.get(v1.full_sha256)
        if b is not None:
            b[0] ^= 1
    server.calls.clear()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    (i,) = e.ensure(["djdl.l10n"])
    assert tree_of(storage, i["location"]) == hashes(v1.files)
    assert [c["offset"] for c in server.calls if c["sha256"] == v1.full_sha256] == [1000, 0]


def test_rollback_with_hot_handler_hooks() -> None:
    r = releases()
    v1, v2 = r["v1"], r["v2"]
    server = ByteServer.of(v1, v2)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    events: List[str] = []
    handler = PackHandler(
        type="files.tree",
        layout="tree",
        activation="hot",
        supports=lambda fv: fv == 1,
        activate=lambda i: events.append(f"on {i['version']}"),
        deactivate=lambda i: events.append(f"off {i['version']}"),
    )
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1), handlers=[handler])
    e.load()
    e.ensure(["djdl.l10n"])
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v2), handlers=[handler])
    e.load()
    e.ensure(["djdl.l10n"])
    assert e.rollback("djdl.l10n") is True
    assert e.state().active["djdl.l10n"]["version"] == "1.0.0"
    assert e.state().running["djdl.l10n"]["version"] == "1.0.0"
    assert events == ["on 1.0.0", "on 1.0.0", "off 1.0.0", "on 1.1.0", "off 1.1.0", "on 1.0.0"]
    assert e.rollback("djdl.l10n") is False
    e.confirm()
    assert json.loads(state.text)["confirmedBootSeq"] == e.state().boot_seq


def test_embedded_baseline_is_installed_state_and_a_gc_root() -> None:
    v1 = releases()["v1"]
    other = tree_pack("djdl.extra", "1.0.0", 1, {"a.txt": "a"})
    server = ByteServer.of(v1, other)
    storage = memory_pack_storage()
    storage.store["embedded/djdl.l10n"] = {"layout": "tree", "tree": dict(v1.files), "index": None}
    baseline = EmbeddedBaseline(
        marker=marker_for(v1),
        payload={"kind": "tree", "treeDigest": v1.tree_digest},
        location="embedded/djdl.l10n",
    )
    e = engine(server, storage=storage, stamp=stamp_for(v1, other))
    assert e.load([baseline])["refused"] == []
    (i,) = e.ensure(["djdl.l10n"])
    assert i["embedded"] is True
    assert server.calls == []
    e.ensure(["djdl.extra"])
    assert "embedded/djdl.l10n" in storage.store
    assert e.pack_set_id() == pack_set_id(
        [
            {"packId": "djdl.l10n", "releaseSha256": v1.record_sha256},
            {"packId": "djdl.extra", "releaseSha256": other.record_sha256},
        ]
    )

    v2 = tree_pack("djdl.l10n", "1.1.0", 2, {"a": "b"})
    bad = engine(server, storage=storage, stamp=stamp_for(v1)).load(
        [EmbeddedBaseline(baseline.marker, {"kind": "tree", "treeDigest": v2.tree_digest}, baseline.location)]
    )
    assert bad["refused"] == [{"location": "embedded/djdl.l10n", "step": "payload"}]
    unpinned = engine(server, storage=storage, stamp=stamp_for(v2)).load([baseline])
    assert unpinned["refused"] == [{"location": "embedded/djdl.l10n", "step": "pin"}]
    forged = engine(server, storage=storage, stamp=stamp_for(v1)).load(
        [EmbeddedBaseline(marker_for(v1).replace('"1.0.0"', '"1.0.1"'), baseline.payload, baseline.location)]
    )
    assert forged["refused"] == [{"location": "embedded/djdl.l10n", "step": "cross-check"}]


def test_reverifies_stored_state_on_load() -> None:
    v1 = releases()["v1"]
    server = ByteServer.of(v1)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    (i,) = e.ensure(["djdl.l10n"])
    state.text = state.text.replace(v1.jws, v1.jws[:-4] + "AAAA")
    e2 = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e2.load()
    assert "djdl.l10n" not in e2.state().active
    assert i["location"] not in storage.store
    state3 = memory_pack_state_store()
    e3 = engine(server, storage=storage, state=state3, stamp=stamp_for(v1))
    e3.load()
    (j,) = e3.ensure(["djdl.l10n"])
    storage.store[j["location"]]["tree"]["fr/menu.json"] = b"{}"
    e4 = engine(server, storage=storage, state=state3, stamp=stamp_for(v1))
    e4.load()
    assert "djdl.l10n" not in e4.state().active


def _code(fn: Any) -> Any:
    with pytest.raises(PackError) as ex:
        fn()
    return ex.value


def test_refuses_with_typed_codes() -> None:
    v1 = releases()["v1"]
    server = ByteServer.of(v1)
    no_stamp = engine(server)
    no_stamp.load()
    assert _code(lambda: no_stamp.ensure(["djdl.l10n"])).code == "not-configured"
    e = engine(server, stamp=stamp_for(v1))
    e.load()
    assert _code(lambda: e.ensure(["djdl.other"])).code == "pack-not-pinned"

    table = tree_pack("djdl.table", "1.0.0", 1, {"a": "1"}, type="l10n.table")
    t = engine(ByteServer.of(table), stamp=stamp_for(table))
    t.load()
    assert _code(lambda: t.ensure(["djdl.table"])).code == "pack-type-unsupported"

    paid = tree_pack("djdl.hd", "1.0.0", 1, {"a": "1"}, entitlement="hd")
    p = engine(ByteServer.of(paid), stamp=stamp_for(paid), entitlements=lambda: {"other"})
    p.load()
    assert _code(lambda: p.ensure(["djdl.hd"])).code == "pack-not-entitled"
    p2 = engine(ByteServer.of(paid), stamp=stamp_for(paid), entitlements=lambda: {"hd"})
    p2.load()
    assert len(p2.ensure(["djdl.hd"])) == 1

    forged = ByteServer.of(v1)
    forged.fetch_record = lambda h: {"ok": True, "body": v1.jws + "x"}  # type: ignore[method-assign]
    f = engine(forged, stamp=stamp_for(v1))
    f.load()
    err = _code(lambda: f.ensure(["djdl.l10n"]))
    assert (err.code, err.detail) == ("record-rejected", "hash")


def test_register_handler_validates() -> None:
    e = engine(ByteServer())

    class Half:
        type = "x"

    with pytest.raises(PackError):
        e.register_handler(Half())


def test_rule_5_base_with_dictionary_magic_is_refused_before_any_decoder() -> None:
    called = [False]

    class Spy:
        pointer_bits = 31
        decode_stream = None

        def decode(self, frame: bytes, size: int) -> bytes:
            return b""

        def decode_with_prefix(self, frame: bytes, prefix: bytes, size: int, wlm: int) -> bytes:
            called[0] = True
            return b""

    base = bytes([0x37, 0xA4, 0x30, 0xEC, 1, 2, 3])
    frame = bytes([0x28, 0xB5, 0x2F, 0xFD, 0x20, 0x05, 0, 0])
    variant = {
        "variant": {},
        "payload": {"size": 5, "sha256": sha("hello")},
        "full": {"sha256": sha("f"), "bytes": 1, "size": 5, "codec": "zstd"},
        "files": {"format": "pkey-files/1", "layout": "container", "sha256": sha("i"), "bytes": 1, "size": 1, "codec": "zstd"},
        "deltas": [
            {
                "method": "zstd-patch-from",
                "scope": "payload",
                "from": sha(base),
                "memBytes": 64,
                "artifact": {"sha256": sha(frame), "bytes": len(frame)},
            }
        ],
    }
    r = apply_delta(variant, 0, memory_source(base), ApplyPorts(objects=lambda h: memory_source(frame), zstd=Spy()))  # type: ignore[arg-type]
    assert r.verdict == {"ok": False, "error": "delta-apply-failed"}
    assert called[0] is False


# ── the stage machine's host side (plans/P4-01.md §2.10) ────────────────────────────────────


class Boot:
    def __init__(self, stamp: Dict[str, Any]) -> None:
        opts = boot_pack_options(stamp)
        self.state = initial_boot_state(required_packs=opts["requiredPacks"], essential_packs=opts["essentialPacks"])
        self.emits: List[str] = []
        for ev in (
            {"type": "start"},
            {"type": "shell.done"},
            {"type": "guard.done", "result": "ok"},
            {"type": "sync.done", "result": "ok"},
            {"type": "gate.status", "status": "ok"},
            {"type": "decide.done", "decision": "none"},
        ):
            self.send(ev)

    def send(self, event: Dict[str, Any]) -> None:
        t = boot_transition(self.state, event)  # type: ignore[arg-type]
        self.state = t.state
        for e in t.emits:
            self.emits.append(f"blocked:{e['reason']}" if e["type"] == "blocked" else e["type"])


def test_boot_asks_on_metered_downloads_with_progress_reaches_ready() -> None:
    v1 = releases()["v1"]
    stamp = stamp_for(v1)
    e = engine(ByteServer.of(v1), stamp=stamp)
    e.load()
    boot = Boot(stamp)
    assert boot.state.stage == "fetch"
    asked = [0]

    def answer(n: int, metered: bool) -> bool:
        asked[0] = n
        return True

    r = run_boot_fetch(e, stamp=stamp, send=boot.send, metered=True, answer=answer)
    assert r == {"result": "ok", "installed": ["djdl.l10n"]}
    assert asked[0] > 0
    assert boot.state.stage == "mount"
    boot.send({"type": "mount.done"})
    assert boot.state.outcome == "ready"
    assert "consent_needed" in boot.emits
    assert len([x for x in boot.emits if x == "fetch_progress"]) >= 2


def test_boot_declined_required_download_blocks() -> None:
    v1 = releases()["v1"]
    stamp = stamp_for(v1)
    e = engine(ByteServer.of(v1), stamp=stamp)
    e.load()
    boot = Boot(stamp)
    r = run_boot_fetch(e, stamp=stamp, send=boot.send, consent="always", answer=lambda n, m: False)
    assert r["result"] == "declined"
    assert boot.state.stage == "blocked"
    assert "blocked:content-declined" in boot.emits


def test_boot_unreachable_server_is_offline_essential_can_play() -> None:
    v1 = releases()["v1"]
    stamp = dict(stamp_for(v1), expects=[{"pack": "djdl.l10n", "required": False, "delivery": "essential"}])
    server = ByteServer.of(v1)

    def offline(s: str, o: int, r: Optional[str]) -> Any:
        raise ConnectionError("offline")

    e = engine(server, stamp=stamp, fetch_object=offline)
    e.load()
    boot = Boot(stamp)
    r = run_boot_fetch(e, stamp=stamp, send=boot.send, consent="never")
    assert r == {"result": "offline", "installed": []}
    assert boot.state.stage == "offline"
    assert boot.state.canPlayOffline is True


# ── a load never loses what it could not judge ───────────────────────────────────────────────


def test_torn_state_is_held_and_nothing_collected_until_recover() -> None:
    v1 = releases()["v1"]
    server = ByteServer.of(v1)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    (i,) = e.ensure(["djdl.l10n"])
    torn = state.text[:20]
    state.text = torn
    e2 = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e2.load()
    assert e2.state().state_issue == "torn"
    assert state.torn == torn
    assert i["location"] in storage.store
    e3 = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e3.load()
    assert e3.state().state_issue == "torn"
    assert i["location"] in storage.store
    e3.ensure(["djdl.l10n"])
    e3.recover_state()
    assert state.torn is None
    assert e3.state().state_issue is None
    assert e3.state().active["djdl.l10n"]["location"] == i["location"]
    assert i["location"] in storage.store


class _Flaky:
    """A storage whose ``verify`` raises (an I/O error) for chosen locations."""

    def __init__(self, inner: Any, broken: Any) -> None:
        self._inner = inner
        self._broken = broken

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def verify(self, install: Dict[str, Any]) -> bool:
        if self._broken(install):
            raise OSError(5, "EIO")
        return self._inner.verify(install)


def test_install_whose_check_threw_is_kept_out_of_use_and_restored() -> None:
    v1 = releases()["v1"]
    server = ByteServer.of(v1)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    (i,) = e.ensure(["djdl.l10n"])
    e2 = engine(server, storage=_Flaky(storage, lambda x: True), state=state, stamp=stamp_for(v1))
    e2.load()
    assert "djdl.l10n" not in e2.state().active
    assert "djdl.l10n" not in e2.state().running
    assert i["location"] in storage.store
    assert json.loads(state.text)["active"]["djdl.l10n"]["location"] == i["location"]
    e3 = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e3.load()
    assert e3.state().active["djdl.l10n"]["recordSha256"] == v1.record_sha256
    assert "djdl.l10n" in e3.state().running


def test_unreadable_state_writes_and_installs_nothing() -> None:
    v1 = releases()["v1"]
    server = ByteServer.of(v1)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    (i,) = e.ensure(["djdl.l10n"])
    before = state.text

    class Broken:
        def read(self) -> Optional[str]:
            raise PermissionError(13, "EACCES")

        def replace(self, text: str) -> None:
            state.replace(text)

        def quarantine(self, t: str) -> None:
            state.quarantine(t)

        def quarantined(self) -> bool:
            return state.quarantined()

        def clear_quarantine(self) -> None:
            state.clear_quarantine()

    e2 = engine(server, storage=storage, state=Broken(), stamp=stamp_for(v1))
    e2.load()
    assert e2.state().state_issue == "unreadable"
    for call in (
        lambda: e2.ensure(["djdl.l10n"]),
        lambda: e2.estimate(["djdl.l10n"]),
        e2.confirm,
        lambda: e2.rollback("djdl.l10n"),
        e2.recover_state,
    ):
        assert _code(call).code == "pack-state-unreadable"
    assert state.text == before
    assert i["location"] in storage.store
    e3 = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e3.load()
    assert e3.state().active["djdl.l10n"]["location"] == i["location"]


def test_noop_commit_over_embedded_copy_stays_embedded() -> None:
    v1 = releases()["v1"]
    server = ByteServer.of(v1)
    storage = memory_pack_storage()
    other = tree_pack("djdl.l10n", "0.9.0", 1, {"a.txt": "a"})
    state = memory_pack_state_store()
    first = engine(ByteServer.of(other), storage=storage, state=state, stamp=stamp_for(other))
    first.load()
    first.ensure(["djdl.l10n"])
    storage.store["embedded/djdl.l10n"] = {"layout": "tree", "tree": dict(v1.files), "index": None}
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load(
        [
            EmbeddedBaseline(
                marker=marker_for(v1),
                payload={"kind": "tree", "treeDigest": v1.tree_digest},
                location="embedded/djdl.l10n",
            )
        ]
    )
    (i,) = e.ensure(["djdl.l10n"])
    assert i["location"] == "embedded/djdl.l10n"
    assert i["embedded"] is True
    assert json.loads(state.text)["active"]["djdl.l10n"]["embedded"] is True


def test_index_over_limit_refused_before_staging() -> None:
    big = tree_pack("djdl.l10n", "1.0.0", 1, V1_FILES, index_bytes=33554433)
    server = ByteServer.of(big)
    e = engine(server, stamp=stamp_for(big))
    e.load()
    assert _code(lambda: e.ensure(["djdl.l10n"])).code == "pack-no-variant"
    assert server.calls == []


# ── round-2 state safety ─────────────────────────────────────────────────────────────────────


def test_previous_whose_check_threw_is_kept_across_two_loads() -> None:
    r = releases()
    v1, v2 = r["v1"], r["v2"]
    server = ByteServer.of(v1, v2)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    (i1,) = e.ensure(["djdl.l10n"])
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v2))
    e.load()
    e.ensure(["djdl.l10n"])
    flaky = _Flaky(storage, lambda i: i["location"] == i1["location"])
    for _ in range(2):
        f = engine(server, storage=flaky, state=state, stamp=stamp_for(v2))
        f.load()
        assert "djdl.l10n" not in f.state().previous
        assert json.loads(state.text)["previous"]["djdl.l10n"]["location"] == i1["location"]
        assert i1["location"] in storage.store
    ok = engine(server, storage=storage, state=state, stamp=stamp_for(v2))
    ok.load()
    assert ok.state().previous["djdl.l10n"]["version"] == "1.0.0"
    assert ok.rollback("djdl.l10n") is True


def test_fresh_commit_carries_deferred_active_to_previous_reverified_at_rollback() -> None:
    r = releases()
    v1, v2 = r["v1"], r["v2"]
    server = ByteServer.of(v1, v2)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    (i1,) = e.ensure(["djdl.l10n"])
    broken = [True]
    flaky = _Flaky(storage, lambda i: broken[0] and i["location"] == i1["location"])
    f = engine(server, storage=flaky, state=state, stamp=stamp_for(v2))
    f.load()
    f.ensure(["djdl.l10n"])
    assert f.state().previous["djdl.l10n"]["location"] == i1["location"]
    assert f.rollback("djdl.l10n") is False
    broken[0] = False
    assert f.rollback("djdl.l10n") is True
    assert f.state().active["djdl.l10n"]["version"] == "1.0.0"


def test_store_without_quarantine_members_treats_torn_as_unreadable() -> None:
    v1 = releases()["v1"]
    server = ByteServer.of(v1)
    storage = memory_pack_storage()
    good = memory_pack_state_store()
    e = engine(server, storage=storage, state=good, stamp=stamp_for(v1))
    e.load()
    (i,) = e.ensure(["djdl.l10n"])
    box = {"text": good.text[:15]}

    class Minimal:
        def read(self) -> Optional[str]:
            return box["text"]

        def replace(self, t: str) -> None:
            box["text"] = t

    events: List[str] = []
    f = engine(server, storage=storage, state=Minimal(), stamp=stamp_for(v1))
    f.on(lambda p: events.append(f"{p.phase}:{p.issue or ''}"))
    f.load()
    assert f.state().state_issue == "unreadable"
    assert events == ["state-issue:unreadable"]
    assert box["text"] == good.text[:15]
    assert i["location"] in storage.store
    assert _code(lambda: f.estimate(["djdl.l10n"])).code == "pack-state-unreadable"
    assert _code(f.confirm).code == "pack-state-unreadable"


def test_store_with_quarantine_members_holds_torn() -> None:
    v1 = releases()["v1"]
    server = ByteServer.of(v1)
    storage = memory_pack_storage()
    good = memory_pack_state_store()
    e = engine(server, storage=storage, state=good, stamp=stamp_for(v1))
    e.load()
    (i,) = e.ensure(["djdl.l10n"])
    box: Dict[str, Optional[str]] = {"text": good.text[:15], "aside": None}

    class Custom:
        def read(self) -> Optional[str]:
            return box["text"]

        def replace(self, t: str) -> None:
            box["text"] = t

        def quarantine(self, t: str) -> None:
            if box["aside"] is None:
                box["aside"] = t

        def quarantined(self) -> bool:
            return box["aside"] is not None

        def clear_quarantine(self) -> None:
            box["aside"] = None

    f = engine(server, storage=storage, state=Custom(), stamp=stamp_for(v1))
    f.load()
    assert f.state().state_issue == "torn"
    assert box["aside"] == good.text[:15]
    assert i["location"] in storage.store


def test_torn_hold_is_bounded() -> None:
    r = releases()
    v1, v2 = r["v1"], r["v2"]
    server = ByteServer.of(v1, v2)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    (i1,) = e.ensure(["djdl.l10n"])
    state.text = state.text[:15]
    storage.staging["old-orphan"] = {}
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v2))
    e.load()
    assert e.state().state_issue == "torn"
    storage.staging["new-orphan"] = {}
    storage.store["djdl.l10n/new-orphan"] = {"layout": "tree", "tree": {}, "index": None}
    e.ensure(["djdl.l10n"])
    assert i1["location"] in storage.store
    assert "old-orphan" in storage.staging
    assert "new-orphan" not in storage.staging
    assert "djdl.l10n/new-orphan" not in storage.store


# ── the torn hold's snapshot (round 3) ───────────────────────────────────────────────────────


def _torn_setup() -> Dict[str, Any]:
    r = releases()
    v1, v2 = r["v1"], r["v2"]
    server = ByteServer.of(v1, v2)
    storage = memory_pack_storage()
    state = memory_pack_state_store()
    e = engine(server, storage=storage, state=state, stamp=stamp_for(v1))
    e.load()
    (i1,) = e.ensure(["djdl.l10n"])
    state.text = state.text[:15]
    return {"v1": v1, "v2": v2, "server": server, "storage": storage, "state": state, "i1": i1}


def _later() -> Dict[str, Any]:
    return {"layout": "tree", "tree": {}, "index": None}


def test_listing_that_errors_holds_gc_entirely() -> None:
    s = _torn_setup()
    storage = s["storage"]

    class Failing(_Flaky):
        def list(self) -> Any:
            raise PermissionError(13, "EACCES")

    e = engine(s["server"], storage=Failing(storage, lambda i: False), state=s["state"], stamp=stamp_for(s["v2"]))
    e.load()
    storage.store["djdl.l10n/new-orphan"] = _later()
    e.ensure(["djdl.l10n"])
    assert s["i1"]["location"] in storage.store
    assert "djdl.l10n/new-orphan" in storage.store


def test_first_snapshot_is_saved_and_reused() -> None:
    s = _torn_setup()
    storage, state = s["storage"], s["state"]
    engine(s["server"], storage=storage, state=state, stamp=stamp_for(s["v1"])).load()
    assert json.loads(state.hold_list)["locations"] == [s["i1"]["location"]]
    storage.store["djdl.l10n/later"] = _later()
    e = engine(s["server"], storage=storage, state=state, stamp=stamp_for(s["v1"]))
    e.load()
    assert e.state().state_issue == "torn"
    assert s["i1"]["location"] in storage.store
    assert "djdl.l10n/later" not in storage.store
    e.recover_state()
    assert state.hold_list is None


def test_unreadable_saved_snapshot_holds_gc_entirely() -> None:
    s = _torn_setup()
    storage, state = s["storage"], s["state"]
    engine(s["server"], storage=storage, state=state, stamp=stamp_for(s["v1"])).load()
    storage.store["djdl.l10n/later"] = _later()

    class Broken:
        def __getattr__(self, name: str) -> Any:
            return getattr(state, name)

        def read_hold_list(self) -> Optional[str]:
            raise OSError(5, "EIO")

    engine(s["server"], storage=storage, state=Broken(), stamp=stamp_for(s["v1"])).load()
    assert s["i1"]["location"] in storage.store
    assert "djdl.l10n/later" in storage.store
