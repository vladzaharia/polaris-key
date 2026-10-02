extends RefCounted
# @pkey-feature packs.state
# The install state, hardened as P4-06's (client-core packsEngine.test.ts "a load never loses what
# it could not judge", "round-2 state safety", "the torn hold's snapshot"), over PKeyPackStorage
# on disk: a state read is "missing" only when there is no file; a torn document is held aside as
# state.json.torn with GC held and its snapshot saved as state.json.torn.list and reused; an
# unreadable state blocks every write path with pack-state-unreadable; an install whose check
# raised stays in the document, out of use and out of GC, for active and previous; a fresh commit
# carries a deferred active over as previous, re-verified at rollback; a listing that fails never
# drives GC. Failures are injected through a PKeyPackStorage subclass, and one real one (the state
# path is a directory) through the disk.

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")


## A storage whose verify, list, state read and hold-list read can be made to fail.
class Flaky extends PKeyPackStorage:
	var verify_raises := {}  # location -> true
	var list_fails := false
	var read_fails := false
	var hold_read_fails := false

	func verify(install: Dictionary) -> int:
		if verify_raises.has(install["location"]):
			return -1
		return super.verify(install)

	func list() -> Variant:
		return null if list_fails else super.list()

	func state_read() -> Dictionary:
		return {"ok": false} if read_fails else super.state_read()

	func state_read_hold_list() -> Dictionary:
		return {"ok": false} if hold_read_fails else super.state_read_hold_list()


func _engine(root: String, tr: PKeyPackTransport, stamp: Variant, storage: PKeyPackStorage = null) -> PKeyPackEngine:
	var e := F.engine(root, tr, stamp)
	if storage != null:
		e.storage = storage
	return e


func _flaky(root: String) -> Flaky:
	return Flaky.new(root)


func _state_json(root: String) -> Dictionary:
	var j := JSON.new()
	j.parse(FileAccess.get_file_as_string(root.path_join("content/state.json")))
	return j.data if j.data is Dictionary else {}


func run(t: PKeyTestContext) -> void:
	_pure(t)
	var v1 := F.tree_pack("djdl.l10n", "1.0.0", 1, {"a.txt": "a", "b.txt": "b"})
	var v2 := F.tree_pack("djdl.l10n", "1.1.0", 2, {"a.txt": "a2", "b.txt": "b"})
	var tr := F.FakeTransport.new().add(v1).add(v2)
	await _torn(t, tr, v1, v2)
	await _deferred(t, tr, v1, v2)
	await _unreadable(t, tr, v1)
	await _snapshot(t, tr, v1, v2)
	await _index_limit(t)


func _install(id: String, sha: String, loc: String) -> Dictionary:
	return {"packId": id, "record": "x", "recordSha256": sha, "version": "1", "seq": 1, "type": "files.tree", "variant": "", "layout": "tree", "payloadSha256": "ab".repeat(32), "payloadSize": 1, "activation": "hot", "location": loc, "installedAt": 1}


func _pure(t: PKeyTestContext) -> void:
	var st := PKeyPackState.empty()
	var a := _install("djdl.a", "11".repeat(32), "L1")
	var b := _install("djdl.a", "22".repeat(32), "L2")
	st = PKeyPackState.commit_install(st, a)
	st = PKeyPackState.commit_install(st, b)
	t.check("state: commit swaps the pointer and keeps the replaced install as previous", st["active"]["djdl.a"]["location"] == "L2" and st["previous"]["djdl.a"]["location"] == "L1")
	var r := PKeyPackState.rollback_install(st, "djdl.a")
	t.check("state: rollback restores it", r["rolled_back"] and r["state"]["active"]["djdl.a"]["location"] == "L1" and not r["state"]["previous"].has("djdl.a"))
	var j := {"planId": "p1", "packId": "djdl.b", "record": "x", "recordSha256": "33".repeat(32), "variant": "", "strategy": "full", "objects": [], "startedAt": 1}
	st = PKeyPackState.begin_install(st, j)
	var roots := PKeyPackState.gc_roots(st, [{"location": "E"}])
	t.check("state: GC keeps active, previous, in-flight and embedded roots", roots["locations"].has("L1") and roots["locations"].has("L2") and roots["locations"].has("E") and roots["plans"].has("p1"))
	var parsed := PKeyPackState.parse("{\"v\":1,\"active\":{\"djdl.a\":{\"packId\":\"djdl.b\"},\"djdl.c\":%s},\"bootSeq\":3,\"confirmedBootSeq\":9}" % JSON.stringify(_install("djdl.c", "44".repeat(32), "L4")))
	t.check("state: parse drops a malformed entry and clamps confirmedBootSeq to bootSeq", not parsed["active"].has("djdl.a") and parsed["active"].has("djdl.c") and parsed["bootSeq"] == 3 and parsed["confirmedBootSeq"] == 3)
	t.check("state: a document that does not parse is the empty state", PKeyPackState.parse("{not json")["active"].is_empty() and not PKeyPackState.looks_like_state("{not json") and PKeyPackState.looks_like_state("{\"v\":1}"))
	st = PKeyPackState.confirm_boot(st, {"djdl.a": "22".repeat(32)})
	S.check_same(t, "state: pending lists an active install the confirmed set does not run", Array(PKeyPackState.pending(st)), [])
	st = PKeyPackState.commit_install(st, _install("djdl.a", "55".repeat(32), "L5"))
	S.check_same(t, "state: …and a new commit is pending until confirmed", Array(PKeyPackState.pending(st)), ["djdl.a"])


func _torn(t: PKeyTestContext, tr: PKeyPackTransport, v1: Dictionary, v2: Dictionary) -> void:
	var root := S.scratch("state-torn")
	var e := _engine(root, tr, F.stamp_for([v1]))
	await e.load_state([])
	var r := await e.ensure(["djdl.l10n"])
	var loc: String = r.detail[0]["location"] if r.ok else ""
	var full := FileAccess.get_file_as_string(root.path_join("content/state.json"))
	var torn := full.substr(0, 20)
	S.write_file(root.path_join("content/state.json"), torn.to_utf8_buffer())
	S.write_file(root.path_join("staging/old-orphan/objects/x"), "x".to_utf8_buffer())
	var events: Array = []
	var e2 := _engine(root, tr, F.stamp_for([v2]))
	e2.progress.connect(func(ev): events.append(ev))
	await e2.load_state([])
	t.check("torn: a document that exists but does not parse is held aside (state.json.torn)", e2.state_issue == "torn" and FileAccess.get_file_as_string(root.path_join("content/state.json.torn")) == torn)
	t.check("torn: one state-issue event says why", events.size() == 1 and events[0]["phase"] == "state-issue" and events[0]["issue"] == "torn", S.canon(events))
	t.check("torn: the hold's snapshot is saved (state.json.torn.list)", FileAccess.file_exists(root.path_join("content/state.json.torn.list")) and FileAccess.get_file_as_string(root.path_join("content/state.json.torn.list")).contains(loc))
	t.check("torn: nothing it named is collected", DirAccess.dir_exists_absolute(loc) and DirAccess.dir_exists_absolute(root.path_join("staging/old-orphan")))
	# Garbage the held process creates is not protected by the hold.
	S.write_file(root.path_join("staging/new-orphan/objects/x"), "x".to_utf8_buffer())
	S.write_file(root.path_join("trees/" + "ee".repeat(32) + "/f.txt"), "f".to_utf8_buffer())
	r = await e2.ensure(["djdl.l10n"])
	t.check("torn: installing is allowed while held", r.ok, str(r))
	t.check("torn: what existed is kept, what the held process leaves is collected", DirAccess.dir_exists_absolute(loc) and DirAccess.dir_exists_absolute(root.path_join("staging/old-orphan")) and not DirAccess.dir_exists_absolute(root.path_join("staging/new-orphan")) and not DirAccess.dir_exists_absolute(root.path_join("trees/" + "ee".repeat(32))))
	# The next load: the document parses now, the torn copy is still held, still no GC of it.
	var e3 := _engine(root, tr, F.stamp_for([v2]))
	await e3.load_state([])
	t.check("torn: the next load still holds it", e3.state_issue == "torn" and DirAccess.dir_exists_absolute(loc))
	var rec := await e3.recover_state()
	t.check("torn: recover_state drops the copy and its snapshot and resumes GC", rec.ok and e3.state_issue == "" and not FileAccess.file_exists(root.path_join("content/state.json.torn")) and not FileAccess.file_exists(root.path_join("content/state.json.torn.list")) and not DirAccess.dir_exists_absolute(root.path_join("staging/old-orphan")))
	t.check("torn: …keeping what the state names (v2) and collecting what only the torn copy did (v1)", DirAccess.dir_exists_absolute(e3.storage.tree_path(v2["treeDigest"])) and not DirAccess.dir_exists_absolute(loc))
	S.remove_tree(root)


func _deferred(t: PKeyTestContext, tr: PKeyPackTransport, v1: Dictionary, v2: Dictionary) -> void:
	var root := S.scratch("state-deferred")
	var e := _engine(root, tr, F.stamp_for([v1]))
	await e.load_state([])
	var r := await e.ensure(["djdl.l10n"])
	var loc1: String = r.detail[0]["location"]
	# A load whose payload check raises: kept in the document, out of use, out of GC.
	var flaky := _flaky(root)
	flaky.verify_raises[loc1] = true
	var e2 := _engine(root, tr, F.stamp_for([v1]), flaky)
	await e2.load_state([])
	t.check("deferred: an install whose check raised is out of use", not e2.doc["active"].has("djdl.l10n") and not e2.running.has("djdl.l10n"))
	t.check("deferred: …kept in the written document and on disk", _state_json(root).get("active", {}).get("djdl.l10n", {}).get("location") == loc1 and DirAccess.dir_exists_absolute(loc1))
	var e3 := _engine(root, tr, F.stamp_for([v1]))
	await e3.load_state([])
	t.check("deferred: the next load, readable again, has it back", e3.doc["active"].get("djdl.l10n", {}).get("recordSha256") == v1["recordSha256"] and e3.running.has("djdl.l10n"))
	# A fresh commit over a deferred active carries it over as previous, re-verified at rollback.
	var flaky2 := _flaky(root)
	flaky2.verify_raises[loc1] = true
	var f := _engine(root, tr, F.stamp_for([v2]), flaky2)
	await f.load_state([])
	r = await f.ensure(["djdl.l10n"])
	t.check("deferred: a commit carries the deferred active over as previous", r.ok and f.doc["previous"].get("djdl.l10n", {}).get("location") == loc1, str(r))
	var rb := await f.rollback("djdl.l10n")
	t.check("deferred: still unreadable, the rollback refuses rather than switch to unverified bytes", rb.ok and rb.detail == false and f.doc["active"]["djdl.l10n"]["recordSha256"] == v2["recordSha256"])
	flaky2.verify_raises.clear()
	rb = await f.rollback("djdl.l10n")
	t.check("deferred: readable again, the rollback re-verifies and switches", rb.ok and rb.detail == true and f.doc["active"]["djdl.l10n"]["version"] == "1.0.0")
	# A previous whose check raised survives two loads.
	var e4 := _engine(root, tr, F.stamp_for([v2]))
	await e4.load_state([])
	await e4.ensure(["djdl.l10n"])
	for n in 2:
		var fl := _flaky(root)
		fl.verify_raises[loc1] = true
		var g := _engine(root, tr, F.stamp_for([v2]), fl)
		await g.load_state([])
		t.check("deferred: a previous whose check raised stays in the document (load %d)" % (n + 1), not g.doc["previous"].has("djdl.l10n") and _state_json(root).get("previous", {}).get("djdl.l10n", {}).get("location") == loc1 and DirAccess.dir_exists_absolute(loc1))
	var ok := _engine(root, tr, F.stamp_for([v2]))
	await ok.load_state([])
	var prev_version = ok.doc["previous"].get("djdl.l10n", {}).get("version")
	var back := await ok.rollback("djdl.l10n")
	t.check("deferred: and is a rollback target once readable", prev_version == "1.0.0" and back.detail == true)
	S.remove_tree(root)


func _unreadable(t: PKeyTestContext, tr: PKeyPackTransport, v1: Dictionary) -> void:
	var root := S.scratch("state-unreadable")
	var e := _engine(root, tr, F.stamp_for([v1]))
	await e.load_state([])
	var r := await e.ensure(["djdl.l10n"])
	var loc: String = r.detail[0]["location"]
	var before := FileAccess.get_file_as_string(root.path_join("content/state.json"))
	var flaky := _flaky(root)
	flaky.read_fails = true
	var e2 := _engine(root, tr, F.stamp_for([v1]), flaky)
	var events: Array = []
	e2.progress.connect(func(ev): events.append(ev))
	await e2.load_state([])
	t.check("unreadable: a state that cannot be read is never the empty state", e2.state_issue == "unreadable" and events.size() == 1 and events[0]["issue"] == "unreadable")
	var code := PKeyConstants.ErrorCode.PACK_STATE_UNREADABLE
	var ens := await e2.ensure(["djdl.l10n"])
	t.check("unreadable: ensure is refused", String(ens.code) == code, str(ens))
	var con := await e2.confirm()
	t.check("unreadable: confirm is refused", String(con.code) == code)
	var rbk := await e2.rollback("djdl.l10n")
	t.check("unreadable: rollback is refused", String(rbk.code) == code)
	var est := await e2.estimate(["djdl.l10n"])
	t.check("unreadable: estimate refuses each pack with the code", est["refused"].size() == 1 and est["refused"][0]["code"] == code)
	var rcv := await e2.recover_state()
	t.check("unreadable: recover_state is refused", String(rcv.code) == code)
	t.check("unreadable: nothing was written or collected", FileAccess.get_file_as_string(root.path_join("content/state.json")) == before and DirAccess.dir_exists_absolute(loc))
	var e3 := _engine(root, tr, F.stamp_for([v1]))
	await e3.load_state([])
	t.check("unreadable: the next load, readable again, lost nothing", e3.doc["active"].get("djdl.l10n", {}).get("location") == loc)
	# On the disk itself: the state path is a directory (it exists, and cannot be read as a file).
	var root2 := S.scratch("state-dir")
	DirAccess.make_dir_recursive_absolute(root2.path_join("content/state.json"))
	var st := PKeyPackStorage.new(root2).state_read()
	t.check("unreadable: a state path that is a directory reads as unreadable, not missing", not st["ok"])
	t.check("unreadable: a state file that is not there reads as missing", PKeyPackStorage.new(S.scratch("state-none")).state_read() == {"ok": true, "text": null})
	S.remove_tree(root)
	S.remove_tree(root2)


func _snapshot(t: PKeyTestContext, tr: PKeyPackTransport, v1: Dictionary, v2: Dictionary) -> void:
	var root := S.scratch("state-snapshot")
	var e := _engine(root, tr, F.stamp_for([v1]))
	await e.load_state([])
	var r := await e.ensure(["djdl.l10n"])
	var loc: String = r.detail[0]["location"]
	S.write_file(root.path_join("content/state.json"), FileAccess.get_file_as_string(root.path_join("content/state.json")).substr(0, 15).to_utf8_buffer())
	# A listing that errors holds GC entirely.
	var failing := _flaky(root)
	failing.list_fails = true
	var f := _engine(root, tr, F.stamp_for([v2]), failing)
	await f.load_state([])
	var later := root.path_join("trees/" + "dd".repeat(32))
	S.write_file(later.path_join("x.txt"), "x".to_utf8_buffer())
	await f.ensure(["djdl.l10n"])
	t.check("snapshot: a listing that errors holds GC entirely", DirAccess.dir_exists_absolute(loc) and DirAccess.dir_exists_absolute(later) and not FileAccess.file_exists(root.path_join("content/state.json.torn.list")))
	S.remove_tree(later)
	# The first readable listing is saved and reused on later loads.
	var g := _engine(root, tr, F.stamp_for([v1]))
	await g.load_state([])
	var listed = S.read_json(root.path_join("content/state.json.torn.list"))
	t.check("snapshot: the first hold saves the store's listing", listed is Dictionary and listed["locations"].has(loc), S.canon(listed))
	S.write_file(later.path_join("x.txt"), "x".to_utf8_buffer())
	var h := _engine(root, tr, F.stamp_for([v1]))
	await h.load_state([])
	t.check("snapshot: a later load reuses it, so what appeared since is collected", h.state_issue == "torn" and DirAccess.dir_exists_absolute(loc) and not DirAccess.dir_exists_absolute(later))
	# An unreadable saved snapshot holds GC entirely.
	S.write_file(later.path_join("x.txt"), "x".to_utf8_buffer())
	var broken := _flaky(root)
	broken.hold_read_fails = true
	var k := _engine(root, tr, F.stamp_for([v1]), broken)
	await k.load_state([])
	t.check("snapshot: an unreadable saved snapshot holds GC entirely", DirAccess.dir_exists_absolute(loc) and DirAccess.dir_exists_absolute(later))
	var rec := await h.recover_state()
	t.check("snapshot: recover_state drops the saved snapshot", rec.ok and not FileAccess.file_exists(root.path_join("content/state.json.torn.list")))
	S.remove_tree(root)


func _index_limit(t: PKeyTestContext) -> void:
	var big := F.tree_pack("djdl.big", "1.0.0", 1, {"a.txt": "a"}, null, {"indexBytes": 33554433})
	var tr := F.FakeTransport.new().add(big)
	var e := _engine(S.scratch("state-index"), tr, F.stamp_for([big]))
	await e.load_state([])
	var r := await e.ensure(["djdl.big"])
	t.check("index: a tree whose index is over the limit is refused before a byte is fetched", not r.ok and String(r.code) == "pack-no-variant" and tr.calls.is_empty(), "%s %s" % [r, S.canon(tr.calls)])
	S.remove_tree(e.storage.root)
