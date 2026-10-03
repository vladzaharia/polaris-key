# @pkey-feature packs.type.l10n.table packs.type.data.json packs.type.ml.model packs.handlers
"""The v3 pack-type handlers (P4-16; CONTENT §4.1, §4.2): every shared case of
``packages/client-core/test/fixtures/pack-type-cases.json`` through Python's handlers (the same
verdict, detail and path as every other SDK), and each handler through the engine: stage, verify,
activate, rollback, uninstall and one rejection each; a game-registered ``custom.dialogue``
handler end to end, under the same path rules as ``files.tree``.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from pack_fixtures import ByteServer, TreePack, stamp_for, tree_pack
from polaris_key.core.pack_claims import variant_key
from polaris_key.update.packs import (
    DataJsonHandler,
    InstalledFile,
    InstalledPayload,
    L10nTableHandler,
    MlModelCandidate,
    MlModelHandler,
    PackError,
    PackHandler,
    PackPayload,
    StagedPack,
    bcp47_canonical,
    memory_pack_state_store,
    memory_pack_storage,
    memory_source,
    parse_l10n_table,
)
from polaris_key.update.packs.handlers import check_l10n_files
from test_packs_engine import engine

CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "packages/client-core/test/fixtures/pack-type-cases.json").read_text(
        encoding="utf-8"
    )
)


def _bytes(f: Dict[str, Any]) -> bytes:
    return base64.b64decode(f["base64"]) if "base64" in f else f["text"].encode("utf-8")


def _files(case: Dict[str, Any]) -> List[InstalledFile]:
    out = []
    for f in case["files"]:
        b = _bytes(f)
        out.append(InstalledFile(f["path"], "0" * 64, len(b), memory_source(b)))
    return out


def _staged(case: Dict[str, Any], variant: Optional[Dict[str, str]] = None) -> StagedPack:
    return StagedPack(
        pack_id="p",
        record={},
        variant={"variant": variant if variant is not None else case.get("variant", {})},
        location="loc",
        files=_files(case),
        payload=None,
    )


def _verdict(refusal: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    return {"ok": True} if refusal is None else {"ok": False, "detail": refusal["detail"], "path": refusal.get("path")}


def _expect_refusal(case: Dict[str, Any]) -> Dict[str, Any]:
    e = case["expect"]
    return {"ok": False, "detail": e["detail"], "path": e["path"]}


def _payload(case: Dict[str, Any]) -> PackPayload:
    files = _files(case)
    return PackPayload(lambda: InstalledPayload(payload=None, files=files))


# ── The shared cases ────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", CASES["bcp47"], ids=lambda c: repr(c["tag"]))
def test_bcp47(case: Dict[str, Any]) -> None:
    got = bcp47_canonical(case["tag"])
    if case["ok"]:
        assert got == case.get("canonical", case["tag"])
    else:
        assert got is None


@pytest.mark.parametrize("case", CASES["dataJson"], ids=lambda c: c["name"])
def test_data_json_cases(case: Dict[str, Any]) -> None:
    opts = case.get("options", {})
    h = DataJsonHandler(**({"max_file_bytes": opts["maxFileBytes"]} if "maxFileBytes" in opts else {}))
    v = _verdict(h.check(_staged(case)))
    if not case["expect"]["ok"]:
        assert v == _expect_refusal(case)
        return
    assert v == {"ok": True}
    seen: List[Any] = []
    h2 = DataJsonHandler(on_activate=lambda pid, docs: seen.append((pid, docs)))
    h2.activate({"packId": "p", "location": "loc", "variant": ""}, _payload(case))
    assert h2.documents("p") == case["expect"]["documents"]
    assert list(h2.documents("p") or {}) == sorted(case["expect"]["documents"], key=lambda p: p.encode())
    assert seen == [("p", case["expect"]["documents"])]


@pytest.mark.parametrize("case", CASES["l10nTable"], ids=lambda c: c["name"])
def test_l10n_cases(case: Dict[str, Any]) -> None:
    opts = case.get("options", {})
    kw = {"max_file_bytes": opts["maxFileBytes"]} if "maxFileBytes" in opts else {}
    h = L10nTableHandler(**kw)
    v = _verdict(h.check(_staged(case)))
    if not case["expect"]["ok"]:
        assert v == _expect_refusal(case)
        return
    assert v == {"ok": True}
    got = check_l10n_files(_files(case), {"variant": case["variant"]}, h.max_file_bytes)
    assert [t.to_dict() for t in got] == case["expect"]["tables"]
    # Activation re-reads the payload under the install's variant key.
    h.activate({"packId": "p", "location": "loc", "variant": variant_key(case["variant"])}, _payload(case))
    assert [t.to_dict() for t in h.tables("p")] == case["expect"]["tables"]
    h.deactivate({"packId": "p", "location": "loc"})
    assert h.tables("p") is None


def _ml_handler(case: Dict[str, Any], calls: Optional[List[MlModelCandidate]] = None) -> MlModelHandler:
    o = case["options"]
    lt = case.get("loadTest")

    def load_test(c: MlModelCandidate) -> bool:
        if calls is not None:
            calls.append(c)
        return bool(lt)

    return MlModelHandler(
        runtimes=o["runtimes"],
        ram_bytes=o["ramBytes"],
        vram_bytes=o.get("vramBytes", 0),
        quantizations=o.get("quantizations"),
        load_test=load_test if lt is not None else None,
    )


@pytest.mark.parametrize("case", CASES["mlModel"], ids=lambda c: c["name"])
def test_ml_model_cases(case: Dict[str, Any]) -> None:
    calls: List[MlModelCandidate] = []
    h = _ml_handler(case, calls)
    v = _verdict(h.check(_staged(case, {})))
    if not case["expect"]["ok"]:
        assert v == _expect_refusal(case)
        return
    assert v == {"ok": True}
    if case.get("loadTest") is not None:
        assert [c.file.path for c in calls] == [case["expect"]["file"]]
        assert calls[0].descriptor["file"] == case["expect"]["file"]
    h.activate({"packId": "p", "location": "loc", "variant": ""}, _payload(case))
    m = h.model("p")
    assert m is not None and m.path == case["expect"]["file"] and m.location == "loc"


def test_load_test_that_raises_refuses() -> None:
    case = next(c for c in CASES["mlModel"] if c["name"] == "fits")

    def boom(_: MlModelCandidate) -> bool:
        raise RuntimeError("cannot load")

    h = MlModelHandler(runtimes=["onnx"], ram_bytes=1000, load_test=boom)
    assert _verdict(h.check(_staged(case, {}))) == {"ok": False, "detail": "load-test", "path": "net.onnx"}


def test_parsers_never_evaluate() -> None:
    # A table that looks like code is text: a CSV cell is a string, never run.
    r = parse_l10n_table("t.csv", b'keys,fr\nk,"__import__(\'os\').system(\'x\')"\n')
    assert r.ok and r.tables[0].messages[0].strings == ["__import__('os').system('x')"]


# ── Through the engine ──────────────────────────────────────────────────────────────────────


def _pack(pack_id: str, version: str, seq: int, files: Dict[str, str], type: str, **kw: Any) -> TreePack:
    return tree_pack(pack_id, version, seq, files, type=type, **kw)


def _err(fn: Any) -> PackError:
    with pytest.raises(PackError) as ex:
        fn()
    return ex.value


class _Run:
    """One storage and state across several releases (each boot a new engine)."""

    def __init__(self, handlers: List[Any], prefs: Optional[Dict[str, Any]] = None) -> None:
        self.storage = memory_pack_storage()
        self.state = memory_pack_state_store()
        self.handlers = handlers
        self.prefs = prefs or {"engine": None, "axes": {}}

    def boot(self, *packs: TreePack, server: Optional[ByteServer] = None) -> Any:
        e = engine(
            server or ByteServer.of(*packs),
            storage=self.storage,
            state=self.state,
            stamp=stamp_for(*packs),
            handlers=self.handlers,
            prefs=self.prefs,
        )
        e.load()
        return e


def test_data_json_stage_verify_activate_rollback_uninstall() -> None:
    events: List[str] = []
    h = DataJsonHandler(
        on_activate=lambda pid, docs: events.append(f"on {docs['tune.json']['hp']}"),
        on_deactivate=lambda pid: events.append("off"),
    )
    v1 = _pack("djdl.tune", "1.0.0", 1, {"tune.json": '{"hp": 1}'}, "data.json")
    v2 = _pack("djdl.tune", "1.1.0", 2, {"tune.json": '{"hp": 2}'}, "data.json")
    v3 = _pack("djdl.tune", "1.2.0", 3, {"tune.json": '{"hp": 3}'}, "data.json")
    run = _Run([h])
    (i1,) = run.boot(v1).ensure(["djdl.tune"])
    assert h.documents("djdl.tune") == {"tune.json": {"hp": 1}}
    e2 = run.boot(v2)
    (i2,) = e2.ensure(["djdl.tune"])
    assert h.documents("djdl.tune") == {"tune.json": {"hp": 2}}
    assert e2.rollback("djdl.tune") is True
    assert h.documents("djdl.tune") == {"tune.json": {"hp": 1}}
    assert events == ["on 1", "on 1", "off", "on 2", "off", "on 1"]
    # Uninstall: once v2 and v3 have both been installed, v1's location is no GC root.
    run.boot(v2).ensure(["djdl.tune"])
    run.boot(v3).ensure(["djdl.tune"])
    assert i1["location"] not in run.storage.store
    assert i2["location"] in run.storage.store  # previous survives
    assert h.documents("djdl.tune") == {"tune.json": {"hp": 3}}


def test_data_json_rejections() -> None:
    too_new = _pack("djdl.tune", "1.0.0", 1, {"a.json": "{}"}, "data.json", record_extra={"formatVersion": 2})
    run = _Run([])
    assert _err(lambda: run.boot(too_new).ensure(["djdl.tune"])).code == "pack-type-unsupported"
    # A host that lists formatVersion 2 takes it.
    run2 = _Run([DataJsonHandler(format_versions=[1, 2])])
    assert len(run2.boot(too_new).ensure(["djdl.tune"])) == 1
    bad = _pack("djdl.tune", "1.0.0", 1, {"a.json": "{}", "b.json": "{,}"}, "data.json")
    run3 = _Run([])
    e = run3.boot(bad)
    err = _err(lambda: e.ensure(["djdl.tune"]))
    assert (err.code, err.detail, err.path) == ("pack-type-check-failed", "json", "b.json")
    # Nothing activated, nothing kept: the install was abandoned, staging and store collected.
    assert e.state().active == {} and e.state().inflight == {} and e.state().running == {}
    assert run3.storage.store == {} and run3.storage.staging == {}


LOCALE_PREFS = {"engine": None, "axes": {"locale": ["fr", "de"]}}


def _l10n(version: str, seq: int, files: Dict[str, str], locale: str = "fr", **kw: Any) -> TreePack:
    return _pack("djdl.fr", version, seq, files, "l10n.table", variant_extra={"variant": {"locale": locale}}, **kw)


def test_l10n_stage_verify_activate_rollback_uninstall() -> None:
    events: List[str] = []
    h = L10nTableHandler(
        on_activate=lambda pid, t: events.append("on " + t[0].messages[0].strings[0]),
        on_deactivate=lambda pid, t: events.append("off " + t[0].messages[0].strings[0]),
    )
    po = 'msgid ""\nmsgstr "Language: fr\\n"\n\nmsgid "hello"\nmsgstr "%s"\n'
    v1 = _l10n("1.0.0", 1, {"fr.po": po % "Bonjour"})
    v2 = _l10n("1.1.0", 2, {"fr.po": po % "Salut"})
    v3 = _l10n("1.2.0", 3, {"fr.csv": "keys,fr\nhello,Coucou\n"})
    run = _Run([h], LOCALE_PREFS)
    (i1,) = run.boot(v1).ensure(["djdl.fr"])
    assert [t.locale for t in h.tables("djdl.fr")] == ["fr"]
    e2 = run.boot(v2)
    (i2,) = e2.ensure(["djdl.fr"])
    assert h.tables("djdl.fr")[0].messages[0].strings == ["Salut"]
    assert e2.rollback("djdl.fr") is True
    assert h.tables("djdl.fr")[0].messages[0].strings == ["Bonjour"]
    assert events == ["on Bonjour", "on Bonjour", "off Bonjour", "on Salut", "off Salut", "on Bonjour"]
    run.boot(v2).ensure(["djdl.fr"])
    run.boot(v3).ensure(["djdl.fr"])
    assert i1["location"] not in run.storage.store and i2["location"] in run.storage.store
    assert h.tables("djdl.fr")[0].messages[0].strings == ["Coucou"]


def test_l10n_wrong_locale_refused() -> None:
    wrong = _l10n("1.0.0", 1, {"de.json": '{"locale": "de", "messages": {"a": "b"}}'})
    run = _Run([], LOCALE_PREFS)
    e = run.boot(wrong)
    err = _err(lambda: e.ensure(["djdl.fr"]))
    assert (err.code, err.detail, err.path) == ("pack-type-check-failed", "locale", "de.json")
    assert e.state().active == {} and run.storage.store == {}


def test_l10n_format_version_too_new() -> None:
    v = _l10n("1.0.0", 1, {"fr.csv": "keys,fr\na,b\n"}, record_extra={"formatVersion": 2})
    run = _Run([], LOCALE_PREFS)
    assert _err(lambda: run.boot(v).ensure(["djdl.fr"])).code == "pack-type-unsupported"


MODEL = {"model.json": '{"runtime": "onnx", "file": "net.onnx", "memBytes": %d}', "net.onnx": "ONNX"}


def _model(version: str, seq: int, mem: int, **kw: Any) -> TreePack:
    files = {"model.json": MODEL["model.json"] % mem, "net.onnx": "ONNX" + version}
    return _pack("djdl.model", version, seq, files, "ml.model", **kw)


def test_ml_model_needs_a_registered_handler() -> None:
    run = _Run([])
    err = _err(lambda: run.boot(_model("1.0.0", 1, 10)).ensure(["djdl.model"]))
    assert err.code == "pack-type-unsupported" and "MlModelHandler" in str(err)


def test_ml_model_stage_verify_activate_rollback_uninstall() -> None:
    tested: List[str] = []
    events: List[str] = []

    def load_test(c: MlModelCandidate) -> bool:
        tested.append(c.location)
        return c.file.source.read(0, 4) == b"ONNX"

    h = MlModelHandler(
        runtimes=["onnx"],
        ram_bytes=100,
        load_test=load_test,
        on_activate=lambda m: events.append("on " + m.location),
        on_deactivate=lambda pid: events.append("off"),
    )
    v1, v2, v3 = _model("1.0.0", 1, 10), _model("1.1.0", 2, 20), _model("1.2.0", 3, 30)
    run = _Run([h])
    (i1,) = run.boot(v1).ensure(["djdl.model"])
    m = h.model("djdl.model")
    assert m is not None and m.path == "net.onnx" and m.location == i1["location"]
    assert tested == [i1["location"]]
    e2 = run.boot(v2)
    (i2,) = e2.ensure(["djdl.model"])
    assert h.model("djdl.model").location == i2["location"]  # type: ignore[union-attr]
    assert e2.rollback("djdl.model") is True
    assert h.model("djdl.model").location == i1["location"]  # type: ignore[union-attr]
    assert events == [
        "on " + i1["location"],
        "on " + i1["location"],
        "off",
        "on " + i2["location"],
        "off",
        "on " + i1["location"],
    ]
    run.boot(v2).ensure(["djdl.model"])
    run.boot(v3).ensure(["djdl.model"])
    assert i1["location"] not in run.storage.store and i2["location"] in run.storage.store


def test_ml_model_memory_above_budget_refused() -> None:
    h = MlModelHandler(runtimes=["onnx"], ram_bytes=100)
    run = _Run([h])
    e = run.boot(_model("1.0.0", 1, 101))
    err = _err(lambda: e.ensure(["djdl.model"]))
    assert (err.code, err.detail, err.path) == ("pack-type-check-failed", "memory", "model.json")
    assert h.model("djdl.model") is None and run.storage.store == {}
    with pytest.raises(TypeError):
        MlModelHandler(runtimes=[], ram_bytes=1)
    with pytest.raises(TypeError):
        MlModelHandler(runtimes=["onnx"], ram_bytes=-1)


def test_ml_model_load_test_refused() -> None:
    h = MlModelHandler(runtimes=["onnx"], ram_bytes=100, load_test=lambda c: False)
    run = _Run([h])
    err = _err(lambda: run.boot(_model("1.0.0", 1, 1)).ensure(["djdl.model"]))
    assert (err.code, err.detail, err.path) == ("pack-type-check-failed", "load-test", "net.onnx")


# ── custom.<name> ───────────────────────────────────────────────────────────────────────────


def _dialogue_handler(events: List[str]) -> PackHandler:
    def check(staged: StagedPack) -> Optional[Dict[str, Any]]:
        for f in staged.files or []:
            if f.source.read(0, f.size).startswith(b"BAD"):
                return {"detail": "dialogue-syntax", "path": f.path}
        return None

    def activate(install: Dict[str, Any], payload: PackPayload) -> None:
        p = payload.read()
        assert p is not None and p.files is not None
        events.append("on " + ",".join(sorted(f.path for f in p.files)))

    return PackHandler(
        type="custom.dialogue",
        layout="tree",
        activation="hot",
        supports=lambda fv: fv == 1,
        activate=activate,
        deactivate=lambda i: events.append("off " + i["version"]),
        check=check,
        reads_payload=True,
    )


def test_custom_dialogue_installs_end_to_end() -> None:
    events: List[str] = []
    v1 = _pack("djdl.dialogue", "1.0.0", 1, {"act1/intro.dlg": "hello", "act1/end.dlg": "bye"}, "custom.dialogue")
    v2 = _pack("djdl.dialogue", "1.1.0", 2, {"act1/intro.dlg": "hi"}, "custom.dialogue")
    run = _Run([])
    # Unregistered, a custom type is unsupported.
    assert _err(lambda: run.boot(v1).ensure(["djdl.dialogue"])).code == "pack-type-unsupported"
    run = _Run([_dialogue_handler(events)])
    (i1,) = run.boot(v1).ensure(["djdl.dialogue"])
    assert i1["type"] == "custom.dialogue" and i1["activation"] == "hot"
    e2 = run.boot(v2)
    e2.ensure(["djdl.dialogue"])
    assert e2.rollback("djdl.dialogue") is True
    assert events == [
        "on act1/end.dlg,act1/intro.dlg",
        "on act1/end.dlg,act1/intro.dlg",
        "off 1.0.0",
        "on act1/intro.dlg",
        "off 1.1.0",
        "on act1/end.dlg,act1/intro.dlg",
    ]
    bad = _pack("djdl.dialogue", "1.2.0", 3, {"x.dlg": "BAD"}, "custom.dialogue")
    err = _err(lambda: run.boot(bad).ensure(["djdl.dialogue"]))
    assert (err.code, err.detail, err.path) == ("pack-type-check-failed", "dialogue-syntax", "x.dlg")


@pytest.mark.parametrize("path", ["a/../b.dlg", "/abs.dlg", ".pkey/x.dlg", "a//b.dlg", "./a.dlg"])
def test_custom_payload_passes_the_files_tree_path_rules(path: str) -> None:
    events: List[str] = []
    custom = _pack("djdl.dialogue", "1.0.0", 1, {path: "x"}, "custom.dialogue")
    tree = _pack("djdl.dialogue", "1.0.0", 1, {path: "x"}, "files.tree")
    run = _Run([_dialogue_handler(events)])
    a = _err(lambda: run.boot(custom).ensure(["djdl.dialogue"]))
    b = _err(lambda: _Run([]).boot(tree).ensure(["djdl.dialogue"]))
    assert (a.code, a.path) == (b.code, b.path)
    assert a.code == "files-unsafe-path"
    assert events == []


def test_check_that_raises_or_names_a_bad_detail_refuses_as_check() -> None:
    def raising(_: StagedPack) -> Optional[Dict[str, Any]]:
        raise RuntimeError("parser crashed")

    for check, msg in ((raising, "parser crashed"), (lambda s: {"detail": "Not A Token", "path": 7}, None)):
        h = PackHandler(type="custom.dialogue", layout="tree", activation="hot", supports=lambda fv: fv == 1, check=check)
        v = _pack("djdl.dialogue", "1.0.0", 1, {"a.dlg": "x"}, "custom.dialogue")
        run = _Run([h])
        e = run.boot(v)
        err = _err(lambda: e.ensure(["djdl.dialogue"]))
        assert (err.code, err.detail, err.path) == ("pack-type-check-failed", "check", None)
        if msg is not None:
            assert msg in str(err)
        assert e.state().active == {} and run.storage.store == {}


def test_staged_files_reach_check_in_index_order() -> None:
    seen: List[List[str]] = []

    def check(s: StagedPack) -> None:
        seen.append([f.path for f in s.files or []])
        return None

    h = PackHandler(type="custom.dialogue", layout="tree", activation="hot", supports=lambda fv: fv == 1, check=check)
    v = _pack("djdl.dialogue", "1.0.0", 1, {"c": "1", "a/z": "2", "B": "3", "a.x": "4"}, "custom.dialogue")
    _Run([h]).boot(v).ensure(["djdl.dialogue"])
    assert seen == [["B", "a.x", "a/z", "c"]]
