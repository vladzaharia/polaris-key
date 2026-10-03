extends RefCounted
# @pkey-feature packs.revoke update.content
# P4-13's client side in Godot (plans/P4-13.md §2.5; P4-24), a port of client-core's
# test/content.test.ts and the Python and Swift ports' revocation tests: the sibling
# revocations.json (written only with a first entry, `revocationsStored` first, re-verified on
# load, `relearn`, the 256-target cap, torn and unreadable files, two loads over the same
# directory), the pack engine's `pack-revoked` refusals, and PKeyUpdateFlow's content steps 10–14.
# The corpus pins every verdict and decision row; these pin the persistence and the I/O around
# them, which no corpus row can carry. Failures are injected through a PKeyPackStorage subclass.
# The facet (PolarisKey.update.packs): content_input, record_revocations, and a `packs` answer
# applied by boot_fetch (required and essential entries at their exact release, before mount)
# and background() (the rest). A failed flag write never lets the sibling file exist without the
# flag on disk. Then the engine over real files: EACCES (chmod 000) and a directory at the path
# both read as unreadable; with no flag nothing is written and baselines mount; with the flag they
# are refused (offline pack-revoked/relearn) and the bytes stay untouched; a crash between the
# flag and the file mounts; torn files, the cap through record_revocations, a rotated key, and a
# lost flag restored. Permissions are restored in teardown.

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")

const NOW := 1759400100


## A storage that records the order of its state and revocations writes, and whose revocations
## read can be made to fail (the document is unknown, not absent).
class Recorder extends PKeyPackStorage:
	var order: Array = []
	var revs_unreadable := false
	var revs_writes: Array = []
	## The state write fails (the store refuses it), as a full disk would.
	var state_fails := false

	func state_replace(text: String) -> bool:
		order.append("state")
		if state_fails:
			return false
		return super.state_replace(text)

	func revocations_read() -> Dictionary:
		return {"ok": false} if revs_unreadable else super.revocations_read()

	func revocations_replace(text: String) -> bool:
		order.append("revocations")
		revs_writes.append(text)
		return super.revocations_replace(text)

	func revocations_quarantine(text: String) -> bool:
		order.append("quarantine")
		return super.revocations_quarantine(text)


func run(t: PKeyTestContext) -> void:
	var v1 := F.tree_pack("djdl.l10n", "1.0.0", 1, {"fr.json": "{\"a\":\"b\"}"})
	var v2 := F.tree_pack("djdl.l10n", "1.1.0", 2, {"fr.json": "{\"a\":\"c\"}"})
	await _pure(t, v1, v2)
	await _no_revocations(t, v1)
	await _store_and_refuse(t, v1)
	await _torn(t, v1)
	await _unreadable(t, v1)
	await _relearn_fetch(t, v1)
	await _state_lost_flag(t, v1)
	await _exact_releases(t, v1, v2)
	await _flow(t, v1, v2)
	await _facet(t, v1, v2)
	await _flag_write_fails(t, v1, v2)
	await _disk(t, v1, v2)


# ── Helpers ─────────────────────────────────────────────────────────────────────────────────

func _verified(r: Dictionary) -> Variant:
	var v: Dictionary = await PKeyReleaseRecord.verify_revocation(r["jws"], {
		"release_keys": F.release_keys(), "product_trust": F.product_trust(), "expected_aud": F.PRODUCT, "entry": r["entry"],
	})
	return v["revocation"] if v["ok"] else null


func _learned(r: Dictionary) -> Dictionary:
	return {"revocation": await _verified(r), "jws": r["jws"]}


func _engine(root: String, tr: PKeyPackTransport, stamp: Variant, storage: PKeyPackStorage = null) -> PKeyPackEngine:
	var e := F.engine(root, tr, stamp)
	if storage != null:
		e.storage = storage
	return e


## The tree baseline of `v` under `root`/emb, as the embedded transport reports it.
func _baseline(root: String, v: Dictionary) -> Array:
	var emb := root.path_join("emb")
	if not DirAccess.dir_exists_absolute(emb.path_join("l10n")):
		for path in v["files"]:
			S.write_file(emb.path_join("l10n").path_join(path), v["files"][path])
		S.write_file(emb.path_join("l10n/.pkey/pack.json"), F.marker_for(v).to_utf8_buffer())
	return PKeyPackEmbeddedTransport.new(emb).embedded()


func _json_file(path: String) -> Variant:
	if not FileAccess.file_exists(path):
		return null
	var j := JSON.new()
	if j.parse(FileAccess.get_file_as_string(path)) != OK:
		return null
	return j.data


func _revs_path(root: String) -> String:
	return root.path_join("store/content/revocations.json")


func _state_path(root: String) -> String:
	return root.path_join("store/content/state.json")


# ── revocations.json (pure) ─────────────────────────────────────────────────────────────────

func _pure(t: PKeyTestContext, v1: Dictionary, v2: Dictionary) -> void:
	t.check("pure: text that does not parse is torn", PKeyPackRevocations.parse("not json") == null and PKeyPackRevocations.parse("") == null)
	t.check("pure: another version is torn", PKeyPackRevocations.parse(JSON.stringify({"v": 2})) == null)
	var t_hash := F.sha("t".to_utf8_buffer())
	var doc = PKeyPackRevocations.parse(JSON.stringify({"v": 1, "revoked": {t_hash: {"pack": "djdl.l10n", "jws": 5}}, "relearn": ["djdl.other", "Not A Pack"]}))
	S.check_same(t, "pure: a malformed entry is dropped into relearn, sorted", doc, {"v": 1, "revoked": {}, "relearn": ["djdl.l10n", "djdl.other"]})

	var a := F.revocation_for(v1, {"issuedAt": 1000})
	var b := F.revocation_for(v1, {"issuedAt": 2000, "replacement": v2})
	var old := F.revocation_for(v1, {"issuedAt": 500, "reason": "older"})
	var va = await _verified(a)
	var vb = await _verified(b)
	var vo = await _verified(old)
	if not t.check("pure: the test revocations verify", va is Dictionary and vb is Dictionary and vo is Dictionary):
		return
	var r := PKeyPackRevocations.store(PKeyPackRevocations.empty(), va, a["jws"])
	t.check("pure: a new target is stored", r["changed"] and r["doc"]["revoked"].has(v1["recordSha256"]))
	t.check("pure: the same record again changes nothing", not PKeyPackRevocations.store(r["doc"], va, a["jws"])["changed"])
	r = PKeyPackRevocations.store(r["doc"], vb, b["jws"], va)
	t.check("pure: a newer revocation of the target supersedes", r["changed"] and r["doc"]["revoked"][v1["recordSha256"]]["record"] == b["record"])
	t.check("pure: an older one is ignored", not PKeyPackRevocations.store(r["doc"], vo, old["jws"], vb)["changed"])
	t.check("pure: without the verified copy the stored issuedAt ranks it", not PKeyPackRevocations.store(r["doc"], vo, old["jws"])["changed"])
	t.check("pure: newer_revocation picks the later issuedAt", is_same(PKeyReleaseRecord.newer_revocation(va, vb), vb))

	# The 256-target cap drops the oldest, without relearn.
	var big := PKeyPackRevocations.empty()
	for i in PKeyPackRevocations.MAX_STORED_REVOCATIONS + 3:
		big["revoked"][F.sha(("t%d" % i).to_utf8_buffer())] = {"jws": "x", "pack": "djdl.l10n", "version": "1.0.0", "seq": 1, "record": F.sha(("r%d" % i).to_utf8_buffer()), "issuedAt": 1000 + i}
	var capped := PKeyPackRevocations.cap(big)
	var oldest_gone := true
	for i in 3:
		oldest_gone = oldest_gone and not capped["revoked"].has(F.sha(("t%d" % i).to_utf8_buffer()))
	t.check("pure: at most 256 targets, the oldest dropped first, no relearn", capped["revoked"].size() == PKeyPackRevocations.MAX_STORED_REVOCATIONS and oldest_gone and capped["relearn"].is_empty())

	# Re-verification on load: a rotated key forgets; any other failure relearns.
	var good := F.revocation_for(v1)
	var rotated := F.revocation_for(v2, {"kid": "djdl-release-test-2027"})
	var stored := PKeyPackRevocations.empty()
	stored["revoked"][v1["recordSha256"]] = {"jws": good["jws"], "pack": "djdl.l10n", "version": "1.0.0", "seq": 1, "record": good["record"], "issuedAt": 1759350000}
	stored["revoked"][v2["recordSha256"]] = {"jws": rotated["jws"], "pack": "djdl.l10n", "version": "1.1.0", "seq": 2, "record": rotated["record"], "issuedAt": 1759350000}
	var keys := {"release_keys": F.release_keys(), "product_trust": F.product_trust(), "expected_aud": F.PRODUCT}
	var re: Dictionary = await PKeyPackRevocations.reload(stored, keys)
	t.check("pure: reload keeps the verified entry and forgets the rotated key's", re["doc"]["revoked"].keys() == [v1["recordSha256"]] and re["doc"]["relearn"].is_empty() and re["changed"] and re["verified"].has(v1["recordSha256"]), S.canon(re["doc"]))
	stored["revoked"][v1["recordSha256"]]["seq"] = 9
	var re2: Dictionary = await PKeyPackRevocations.reload(stored, keys)
	t.check("pure: a pin mismatch drops the entry and relearns its pack", re2["doc"]["revoked"].is_empty() and re2["doc"]["relearn"] == ["djdl.l10n"])
	t.check("pure: clear_relearn clears the named pack", PKeyPackRevocations.clear_relearn(re2["doc"], ["djdl.l10n"])["doc"]["relearn"].is_empty())

	# A stamp's holds beside parse_content_stamp, with the token rule.
	var pin := {"sha256": F.sha("h".to_utf8_buffer()), "seq": 3, "version": "1.0.0"}
	var text := JSON.stringify({"format": "pkey-content/1", "contentApi": 1, "pins": [], "expects": [], "holds": [{"pack": "djdl.l10n", "release": pin}]})
	S.check_same(t, "pure: stamp_holds reads the holds", PKeyPackClaims.stamp_holds(text), [{"pack": "djdl.l10n", "release": pin}])
	t.check("pure: a hold seq token 3.0 makes the holds unusable", PKeyPackClaims.stamp_holds(text.replace("\"seq\":3", "\"seq\":3.0")) == null)
	S.check_same(t, "pure: a stamp without holds reads []", PKeyPackClaims.stamp_holds(JSON.stringify({"format": "pkey-content/1", "contentApi": 1, "pins": [], "expects": []})), [])


# ── PKeyPackEngine and revocations (plans/P4-13.md §2.5) ────────────────────────────────────

func _no_revocations(t: PKeyTestContext, v1: Dictionary) -> void:
	var root := S.scratch("revs-none")
	var tr := F.FakeTransport.new().add(v1)
	var e := _engine(root.path_join("store"), tr, F.stamp_for([v1]))
	await e.load_state([])
	await e.ensure(["djdl.l10n"])
	await e.record_revocations([])
	var st = _json_file(_state_path(root))
	t.check("none: no revocations.json and no flag", not FileAccess.file_exists(_revs_path(root)) and st is Dictionary and not st.has("revocationsStored"))
	var again := _engine(root.path_join("store"), tr, F.stamp_for([v1]))
	await again.load_state([])
	t.check("none: a second load mounts exactly as before", again.running.has("djdl.l10n") and again.running["djdl.l10n"]["recordSha256"] == v1["recordSha256"])
	st = _json_file(_state_path(root))
	t.check("none: still no file, no flag, no issue", not FileAccess.file_exists(_revs_path(root)) and not st.has("revocationsStored") and again.revocations()["issue"] == "")

	# An unreadable (absent) file with no flag refuses nothing.
	var root2 := S.scratch("revs-none-unreadable")
	var baselines := _baseline(root2, v1)
	var rec := Recorder.new(root2.path_join("store"))
	rec.revs_unreadable = true
	var e2 := _engine(root2.path_join("store"), F.FakeTransport.new(), F.stamp_for([v1]), rec)
	await e2.load_state(baselines)
	t.check("none: an unreadable file reads as unreadable", e2.revocations()["issue"] == "unreadable")
	t.check("none: without the flag the baseline still mounts", e2.running.has("djdl.l10n") and e2.running["djdl.l10n"].get("embedded") == true)
	var r := await e2.ensure(["djdl.l10n"])
	t.check("none: and ensure answers the embedded copy", r.ok and r.detail[0]["recordSha256"] == v1["recordSha256"], str(r))
	S.remove_tree(root)
	S.remove_tree(root2)


func _store_and_refuse(t: PKeyTestContext, v1: Dictionary) -> void:
	var root := S.scratch("revs-store")
	var tr := F.FakeTransport.new().add(v1)
	var rec := Recorder.new(root.path_join("store"))
	var e := _engine(root.path_join("store"), tr, F.stamp_for([v1]), rec)
	await e.load_state([])
	await e.ensure(["djdl.l10n"])
	t.check("store: the pack runs", e.running.has("djdl.l10n"))
	t.check("store: no file before the first entry", not FileAccess.file_exists(_revs_path(root)))
	var rv := F.revocation_for(v1)
	rec.order.clear()
	await e.record_revocations([await _learned(rv)])
	t.check("store: state.json is written before revocations.json", rec.order == ["state", "revocations"], str(rec.order))
	var st = _json_file(_state_path(root))
	var rd = _json_file(_revs_path(root))
	t.check("store: the flag is set", st is Dictionary and st.get("revocationsStored") == true)
	t.check("store: the file holds the target", rd is Dictionary and rd["revoked"].keys() == [v1["recordSha256"]])
	t.check("store: the revoked install stops running", not e.running.has("djdl.l10n"))
	var r := await e.ensure(["djdl.l10n"])
	t.check("store: ensure refuses it with pack-revoked", not r.ok and String(r.code) == PKeyConstants.ErrorCode.PACK_REVOKED, str(r.code))
	var rb := await e.rollback("djdl.l10n")
	t.check("store: nothing to roll back to", rb.ok and rb.detail == false)
	# A fresh process (two loads over the same directory) re-verifies the file.
	var again := _engine(root.path_join("store"), tr, F.stamp_for([v1]))
	await again.load_state([])
	t.check("store: a fresh load never mounts the revoked install", not again.running.has("djdl.l10n") and again.is_revoked(v1["recordSha256"]))
	var verified: Dictionary = again.revocations()["verified"]
	t.check("store: the reloaded entry is verified", verified.has(v1["recordSha256"]) and verified[v1["recordSha256"]]["record"] == rv["record"])
	var third := _engine(root.path_join("store"), tr, F.stamp_for([v1]))
	await third.load_state([])
	t.check("store: a third load still refuses it", not third.running.has("djdl.l10n") and third.is_revoked(v1["recordSha256"]))
	S.remove_tree(root)


func _torn(t: PKeyTestContext, v1: Dictionary) -> void:
	var root := S.scratch("revs-torn")
	var baselines := _baseline(root, v1)
	S.write_file(_revs_path(root), "{torn".to_utf8_buffer())
	var tr := F.FakeTransport.new().add(v1)
	var e := _engine(root.path_join("store"), tr, F.stamp_for([v1]))
	await e.load_state(baselines)
	t.check("torn: the torn text is quarantined", FileAccess.get_file_as_string(_revs_path(root) + ".torn") == "{torn")
	var rd = _json_file(_revs_path(root))
	t.check("torn: a fresh file relearns the stamp's packs", rd is Dictionary and rd["relearn"] == ["djdl.l10n"] and rd["revoked"].is_empty())
	var st = _json_file(_state_path(root))
	t.check("torn: the flag is set", st is Dictionary and st.get("revocationsStored") == true)
	t.check("torn: issue torn, and the baseline is refused", e.revocations()["issue"] == "torn" and not e.running.has("djdl.l10n"))
	# A fresh feed that re-teaches the pack clears relearn; the baseline mounts at the next boot.
	await e.record_revocations([], ["djdl.l10n"])
	rd = _json_file(_revs_path(root))
	t.check("torn: relearn cleared on disk", rd is Dictionary and rd["relearn"].is_empty())
	var nxt := _engine(root.path_join("store"), tr, F.stamp_for([v1]))
	await nxt.load_state(baselines)
	t.check("torn: the next boot mounts the baseline", nxt.running.has("djdl.l10n") and nxt.running["djdl.l10n"].get("embedded") == true)

	# recover_state() clears relearn wholesale and releases the quarantine.
	var root2 := S.scratch("revs-torn-recover")
	var b2 := _baseline(root2, v1)
	S.write_file(_revs_path(root2), "{torn".to_utf8_buffer())
	var e2 := _engine(root2.path_join("store"), tr, F.stamp_for([v1]))
	await e2.load_state(b2)
	var rr := await e2.recover_state()
	rd = _json_file(_revs_path(root2))
	t.check("torn: recover_state releases the quarantine and clears relearn", rr.ok and not FileAccess.file_exists(_revs_path(root2) + ".torn") and e2.revocations()["relearn"].is_empty() and rd is Dictionary and rd["relearn"].is_empty() and e2.revocations()["issue"] == "")
	S.remove_tree(root)
	S.remove_tree(root2)


func _unreadable(t: PKeyTestContext, v1: Dictionary) -> void:
	var root := S.scratch("revs-unreadable")
	var baselines := _baseline(root, v1)
	var flagged := PKeyPackState.empty()
	flagged["revocationsStored"] = true
	S.write_file(_state_path(root), JSON.stringify(flagged).to_utf8_buffer())
	var rec := Recorder.new(root.path_join("store"))
	rec.revs_unreadable = true
	var e := _engine(root.path_join("store"), F.FakeTransport.new().add(v1), F.stamp_for([v1]), rec)
	await e.load_state(baselines)
	t.check("unreadable: issue unreadable", e.revocations()["issue"] == "unreadable")
	t.check("unreadable: with the flag the stamp's baseline is refused", not e.running.has("djdl.l10n"))
	await e.record_revocations([await _learned(F.revocation_for(v1))])
	t.check("unreadable: nothing is written to it, even for a learned revocation", rec.revs_writes.is_empty() and not FileAccess.file_exists(_revs_path(root)))
	t.check("unreadable: the learned revocation applies for the process", e.is_revoked(v1["recordSha256"]))
	# Without the flag the same unreadable file refuses nothing.
	var root2 := S.scratch("revs-unreadable-noflag")
	var b2 := _baseline(root2, v1)
	var rec2 := Recorder.new(root2.path_join("store"))
	rec2.revs_unreadable = true
	var e2 := _engine(root2.path_join("store"), F.FakeTransport.new(), F.stamp_for([v1]), rec2)
	await e2.load_state(b2)
	t.check("unreadable: without the flag the baseline mounts", e2.running.has("djdl.l10n") and e2.running["djdl.l10n"].get("embedded") == true)
	S.remove_tree(root)
	S.remove_tree(root2)


func _relearn_fetch(t: PKeyTestContext, v1: Dictionary) -> void:
	# Offline: the baseline refused for relearn cannot be fetched: pack-revoked, detail relearn.
	var root := S.scratch("revs-relearn-offline")
	var baselines := _baseline(root, v1)
	S.write_file(_revs_path(root), "{torn".to_utf8_buffer())
	var e := _engine(root.path_join("store"), F.FakeTransport.new(), F.stamp_for([v1]))
	await e.load_state(baselines)
	var r := await e.ensure(["djdl.l10n"])
	t.check("relearn: offline, the refused baseline raises pack-revoked (relearn)", not r.ok and String(r.code) == PKeyConstants.ErrorCode.PACK_REVOKED and r.detail is Dictionary and r.detail.get("detail") == "relearn" and r.detail.get("packId") == "djdl.l10n", "%s %s" % [r.code, r.detail])
	# Online: it is fetched and verified again, then runs.
	var root2 := S.scratch("revs-relearn-online")
	var b2 := _baseline(root2, v1)
	S.write_file(_revs_path(root2), "{torn".to_utf8_buffer())
	var tr := F.FakeTransport.new().add(v1)
	var e2 := _engine(root2.path_join("store"), tr, F.stamp_for([v1]))
	await e2.load_state(b2)
	t.check("relearn: online, the baseline does not mount before the fetch", not e2.running.has("djdl.l10n"))
	var r2 := await e2.ensure(["djdl.l10n"])
	t.check("relearn: online, the record is fetched and verified again", r2.ok and tr.record_calls.has(v1["recordSha256"]) and e2.doc["active"].get("djdl.l10n", {}).get("recordSha256") == v1["recordSha256"], str(r2))
	S.remove_tree(root)
	S.remove_tree(root2)


func _state_lost_flag(t: PKeyTestContext, v1: Dictionary) -> void:
	var root := S.scratch("revs-flag-restore")
	var rv := F.revocation_for(v1)
	var vr: Dictionary = await _verified(rv)
	var doc: Dictionary = PKeyPackRevocations.store(PKeyPackRevocations.empty(), vr, rv["jws"])["doc"]
	S.write_file(_revs_path(root), PKeyPackRevocations.serialize(doc).to_utf8_buffer())
	S.write_file(_state_path(root), "{torn state".to_utf8_buffer())
	var e := _engine(root.path_join("store"), F.FakeTransport.new().add(v1), F.stamp_for([v1]))
	await e.load_state([])
	var st = _json_file(_state_path(root))
	t.check("flag: a torn state.json gets revocationsStored back", e.state_issue == "torn" and st is Dictionary and st.get("revocationsStored") == true and e.is_revoked(v1["recordSha256"]))
	S.remove_tree(root)


func _exact_releases(t: PKeyTestContext, v1: Dictionary, v2: Dictionary) -> void:
	var root := S.scratch("revs-exact")
	var e := _engine(root.path_join("store"), F.FakeTransport.new().add(v1).add(v2), F.stamp_for([v1]))
	await e.load_state([])
	var pin2 := {"sha256": v2["recordSha256"], "seq": 2, "version": "1.1.0"}
	var est := await e.estimate_releases([{"pack": "djdl.l10n", "release": pin2}])
	t.check("exact: estimate_releases plans the named release", est["packs"] == ["djdl.l10n"], S.canon(est))
	var r := await e.ensure_releases([{"pack": "djdl.l10n", "release": pin2}])
	t.check("exact: ensure_releases installs exactly that release", r.ok and r.detail[0]["recordSha256"] == v2["recordSha256"], str(r))
	await e.record_revocations([await _learned(F.revocation_for(v2))])
	t.check("exact: a revoked exact release stops running", not e.running.has("djdl.l10n"))
	r = await e.ensure_releases([{"pack": "djdl.l10n", "release": pin2}])
	t.check("exact: and is refused with pack-revoked", not r.ok and String(r.code) == PKeyConstants.ErrorCode.PACK_REVOKED)
	var rb := await e.rollback("djdl.l10n")
	t.check("exact: a rollback to an unrevoked previous is still allowed", rb.ok)
	S.remove_tree(root)


# ── PKeyUpdateFlow content steps 10–14 (plans/P4-13.md §2.5) ────────────────────────────────

func _setup(v1: Dictionary, v2: Dictionary, replacement := false, no_pack_sets := false) -> Dictionary:
	var app_record := {
		"schemaVersion": 1, "aud": F.PRODUCT, "deliverable": "app", "kind": "app", "version": "1.5.0", "seq": 15,
		"issuedAt": 1759000000,
		"builds": [{"id": "macos-dmg", "platform": "macos", "arch": "universal", "format": "dmg", "artifacts": [{"name": "a.dmg", "role": "payload", "sha256": F.sha("a".to_utf8_buffer()), "size": 1}]}],
	}
	var app_jws := F.sign_with(app_record, F.RELEASE_KID, "pkey-release+jws")
	var app_sha := F.sha(app_jws.to_utf8_buffer())
	var rv := F.revocation_for(v1, {"replacement": v2} if replacement else {})
	var set_id := F.sha(("djdl.l10n %s\n" % v1["recordSha256"]).to_utf8_buffer())
	var feed := {
		"schemaVersion": 1, "iss": "key.plrs.im", "aud": F.PRODUCT, "channel": "stable", "selector": {}, "seq": 7,
		"issuedAt": NOW - 100, "expiresAt": NOW + 800,
		"app": {"deliverable": "app", "versionScheme": "semver", "targets": [{
			"platform": "macos", "release": {"sha256": app_sha, "seq": 15, "version": "1.5.0"}, "floor": null, "critical": false,
			"outlets": {"direct": {"kind": "direct", "live": {"version": "1.5.0", "seq": 15}, "halted": false}},
		}]},
	}
	if not no_pack_sets:
		feed["packSets"] = {
			"releases": {v1["recordSha256"]: {"pack": "djdl.l10n", "version": "1.0.0", "seq": 1}},
			"sets": {set_id: [v1["recordSha256"]]},
			"rows": [{"contentApi": 1, "platform": "macos", "engine": "", "variant": {}, "set": set_id}],
		}
	feed["revocations"] = [rv["entry"]]
	var feed_jws := F.sign_with(feed, F.PRODUCT_KID, "pkey-feed+jws")
	var records := {app_sha: app_jws, rv["record"]: rv["jws"], v1["recordSha256"]: v1["jws"], v2["recordSha256"]: v2["jws"]}
	var fetched: Array = []
	var refuse := {}
	var fetch_record := func(h: String) -> Dictionary:
		fetched.append(h)
		if records.has(h) and not refuse.has(h):
			return {"ok": true, "body": records[h]}
		return {"ok": false, "code": "network-error"}
	var content := {
		"stamp": {"contentApi": 1, "pins": [], "expects": [{"pack": "djdl.l10n", "required": true, "delivery": "essential"}]},
		"holds": [],
		"active": {"djdl.l10n": {"sha256": v1["recordSha256"], "seq": 1, "version": "1.0.0"}},
		"engine": null, "axes": {}, "revoked": {}, "relearn": ["djdl.l10n"],
	}
	var opts := {
		"channel": "stable", "expected_aud": F.PRODUCT, "trust": F.product_trust(), "release_keys": F.release_keys(),
		"now": NOW, "install_id": "dev_1",
		"installed": {"version": "1.5.0", "binaryVersion": "1.5.0", "buildNumber": null, "platform": "macos", "arch": "arm64", "format": null, "engine": null},
		"outlet": {"id": "direct", "kind": "direct"}, "subkind": null, "staged": null, "skip_version": null, "methods": ["download"],
		"cache": {"feeds": {}, "releaseRecords": {}},
		"fetch_feed": func(_c: String) -> Dictionary: return {"ok": true, "body": feed_jws},
		"fetch_record": fetch_record, "content": content, "offload": false,
	}
	return {"rev": rv, "opts": opts, "fetched": fetched, "refuse": refuse, "content": content}


func _flow(t: PKeyTestContext, v1: Dictionary, v2: Dictionary) -> void:
	# Learns a relevant revocation and blocks revoked REQUIRED content.
	var s := _setup(v1, v2)
	var r: Dictionary = await PKeyUpdateFlow.run(s["opts"])
	var learned: Array = r.get("revocations", {}).get("learned", [])
	t.check("flow: the relevant revocation is learned", r["ok"] and learned.size() == 1 and learned[0]["revocation"]["record"] == s["rev"]["record"] and learned[0]["jws"] == s["rev"]["jws"], S.canon(r.get("revocations")).left(300))
	t.check("flow: relearn clears once every considered revocation is known", r["ok"] and r["revocations"]["relearnCleared"] == ["djdl.l10n"])
	t.check("flow: revoked required content blocks, boot required", r["ok"] and r["check"]["decision"].get("action") == "blocked" and r["check"]["decision"].get("reason") == "revoked-content" and r["boot"] == PKeyDecision.BOOT_REQUIRED, S.canon(r.get("check")).left(300))

	# An older release outside H: not fetched, and it keeps nothing in relearn.
	s = _setup(v1, v2, false, true)
	var pin2 := {"sha256": v2["recordSha256"], "seq": 2, "version": "1.1.0"}
	s["content"]["stamp"]["pins"] = [{"pack": "djdl.l10n", "release": pin2}]
	s["content"]["active"] = {"djdl.l10n": pin2}
	r = await PKeyUpdateFlow.run(s["opts"])
	t.check("flow: a revocation outside H is not fetched and clears relearn", r["ok"] and not s["fetched"].has(s["rev"]["record"]) and r["revocations"]["learned"].is_empty() and r["revocations"]["relearnCleared"] == ["djdl.l10n"])

	# A considered revocation that cannot be fetched keeps relearn.
	s = _setup(v1, v2)
	s["refuse"][s["rev"]["record"]] = true
	r = await PKeyUpdateFlow.run(s["opts"])
	t.check("flow: an unfetchable considered revocation keeps relearn", r["ok"] and r["revocations"]["relearnCleared"].is_empty() and r["check"]["errors"].size() >= 1)

	# A fetched, verified, usable replacement is installed instead.
	s = _setup(v1, v2, true)
	r = await PKeyUpdateFlow.run(s["opts"])
	var d: Dictionary = r["check"]["decision"] if r["ok"] else {}
	S.check_same(t, "flow: a usable replacement is the packs answer's install", d.get("install"), [{"pack": "djdl.l10n", "release": {"sha256": v2["recordSha256"], "seq": 2, "version": "1.1.0"}}])
	t.check("flow: the replacement was fetched; boot none", r["ok"] and s["fetched"].has(v2["recordSha256"]) and d.get("action") == "packs" and r["boot"] == PKeyDecision.BOOT_NONE)

	# An unfetchable replacement is not yet usable: the required pack stays blocked.
	s = _setup(v1, v2, true)
	s["refuse"][v2["recordSha256"]] = true
	r = await PKeyUpdateFlow.run(s["opts"])
	t.check("flow: an unfetchable replacement keeps the required pack blocked", r["ok"] and r["check"]["decision"].get("action") == "blocked" and r["check"]["decision"].get("reason") == "revoked-content")

	# A stored revocation is not fetched again, and a committed feed clears nothing.
	s = _setup(v1, v2)
	var first: Dictionary = await PKeyUpdateFlow.run(s["opts"])
	var v = await _verified(s["rev"])
	s["fetched"].clear()
	s["content"]["revoked"] = {s["rev"]["entry"]["target"]: v}
	s["opts"]["cache"] = first["cache"]
	s["opts"]["fetch_feed"] = func(_c: String) -> Dictionary: return {"ok": false, "code": "network-error"}
	r = await PKeyUpdateFlow.run(s["opts"])
	t.check("flow: a stored revocation is not fetched; a committed feed clears nothing", r["ok"] and not s["fetched"].has(s["rev"]["record"]) and r["check"]["feed"] == "committed" and r["revocations"]["relearnCleared"].is_empty())

	# Without content the check is P3-01's.
	s = _setup(v1, v2)
	s["opts"].erase("content")
	r = await PKeyUpdateFlow.run(s["opts"])
	t.check("flow: without content the check is P3-01's", r["ok"] and not r.has("revocations") and not s["fetched"].has(s["rev"]["record"]) and r["check"]["decision"].get("action") == "none")


# ── The facet: content_input, record_revocations, a `packs` answer through FETCH ────────────

func _facet(t: PKeyTestContext, v1: Dictionary, v2: Dictionary) -> void:
	var extra := F.tree_pack("djdl.extra", "1.0.0", 1, {"x.txt": "x"})
	var root := S.scratch("revs-facet")
	var stamp_file := root.path_join("pkey-content.json")
	var stamp := F.stamp_for([v1])
	stamp["expects"].append({"pack": "djdl.extra", "required": false, "delivery": "on-demand"})
	S.write_file(stamp_file, F.stamp_text(stamp).to_utf8_buffer())
	var sdk := PKeyTestFixtures.new_sdk()
	var opts := PKeyTestFixtures.options("http://127.0.0.1:9", PKeyMemoryStore.new("dev_7c1e2d"), [1759500000.0], "djdl", F.product_trust())
	opts.pinned_release_keys = F.release_keys()
	opts.expected_services = PackedStringArray(["release", "distribution"])
	sdk.configure(opts)
	await sdk.start()
	var packs: PKeyPacks = sdk.update.packs
	packs.root = root.path_join("pkey")
	packs.stamp_path = stamp_file
	packs.embedded_dir = root.path_join("none")
	packs.transport = F.FakeTransport.new().add(v1).add(v2).add(extra)
	var c = await packs.content_input()
	t.check("facet: content_input carries the stamp, holds [] and the running set", c is Dictionary and c["holds"] == [] and c["stamp"]["pins"].size() == 1 and c["active"].is_empty() and c["revoked"].is_empty() and c["relearn"].is_empty() and String(c["engine"]).begins_with("godot-"), S.canon(c).left(300))
	var pin2 := {"sha256": v2["recordSha256"], "seq": 2, "version": "1.1.0"}
	var pin_x := {"sha256": extra["recordSha256"], "seq": 1, "version": "1.0.0"}
	var sent: Array = []
	var done: Dictionary = await packs.boot_fetch(func(e: Dictionary) -> void: sent.append(e), {"install": [{"pack": "djdl.l10n", "release": pin2}, {"pack": "djdl.extra", "release": pin_x}]})
	t.check("facet: FETCH installs a required pack at the packs answer's exact release", done.get("result") == "ok" and done.get("installed") == ["djdl.l10n"] and packs.engine.running.get("djdl.l10n", {}).get("recordSha256") == v2["recordSha256"], S.canon(done))
	t.check("facet: the other entries wait for BACKGROUND", packs.background_targets.size() == 1 and packs.background_targets[0]["pack"] == "djdl.extra" and not packs.engine.running.has("djdl.extra"))
	var bg: Dictionary = await packs.background([])
	t.check("facet: background() installs them at their exact release", bg["installed"] == ["djdl.extra"] and packs.engine.running.get("djdl.extra", {}).get("recordSha256") == extra["recordSha256"] and packs.background_targets.is_empty(), S.canon(bg))
	c = await packs.content_input()
	t.check("facet: content_input's active is the running set", c["active"].get("djdl.l10n", {}).get("sha256") == v2["recordSha256"] and c["active"].has("djdl.extra"))
	var rv := F.revocation_for(v2)
	var lr := await _learned(rv)
	var changed: Array = []
	packs.set_changed.connect(func(a): changed.append(a))
	var kept := await packs.record_revocations({"learned": [lr], "relearnCleared": []})
	t.check("facet: record_revocations stops the revoked release and says so", kept.ok and not packs.engine.running.has("djdl.l10n") and changed.size() == 1)
	c = await packs.content_input()
	t.check("facet: the stored revocation reaches the next content input", c["revoked"].has(v2["recordSha256"]) and not c["active"].has("djdl.l10n"))
	var r := await packs.ensure_releases([{"pack": "djdl.l10n", "release": pin2}])
	t.check("facet: ensure_releases refuses the revoked release", not r.ok and String(r.code) == PKeyConstants.ErrorCode.PACK_REVOKED)
	sdk.queue_free()
	S.remove_tree(root)


# ── A failed flag write (review round 1) ────────────────────────────────────────────────────

func _flag_write_fails(t: PKeyTestContext, v1: Dictionary, v2: Dictionary) -> void:
	var extra := F.tree_pack("djdl.extra", "1.0.0", 1, {"x.txt": "x"})
	var root := S.scratch("revs-flag-fails")
	var rec := Recorder.new(root.path_join("store"))
	var e := _engine(root.path_join("store"), F.FakeTransport.new().add(v1), F.stamp_for([v1]), rec)
	await e.load_state([])
	rec.state_fails = true
	await e.record_revocations([await _learned(F.revocation_for(v1))])
	await e.record_revocations([await _learned(F.revocation_for(v2))])
	var st = _json_file(_state_path(root))
	t.check("flag fails: after two records no sibling file exists without the flag on disk", not FileAccess.file_exists(_revs_path(root)) and st is Dictionary and not st.has("revocationsStored"), S.canon(st))
	t.check("flag fails: the flag is not believed in memory", not PKeyClaims.is_true(e.doc.get("revocationsStored")))
	t.check("flag fails: the revocations still apply for the process", e.is_revoked(v1["recordSha256"]) and e.is_revoked(v2["recordSha256"]))
	rec.state_fails = false
	await e.record_revocations([await _learned(F.revocation_for(extra))])
	st = _json_file(_state_path(root))
	var rd = _json_file(_revs_path(root))
	t.check("flag fails: once the state is writable, the flag then the file", st is Dictionary and st.get("revocationsStored") == true and rd is Dictionary and rd["revoked"].size() == 3)
	S.remove_tree(root)


# ── Over real files (review round 1) ────────────────────────────────────────────────────────

func _chmod(path: String, mode: String) -> void:
	OS.execute("chmod", [mode, ProjectSettings.globalize_path(path)])


func _bytes(path: String) -> PackedByteArray:
	return FileAccess.get_file_as_bytes(path) if FileAccess.file_exists(path) else PackedByteArray()


## Write an entry signed by `rv` for `target` into a fresh revocations.json under `root`.
func _write_doc(root: String, entries: Array) -> void:
	var doc := PKeyPackRevocations.empty()
	for x in entries:
		var v: Dictionary = await _verified(x)
		doc = PKeyPackRevocations.store(doc, v, x["jws"])["doc"]
	S.write_file(_revs_path(root), PKeyPackRevocations.serialize(doc).to_utf8_buffer())


func _flagged_state(root: String) -> void:
	var st := PKeyPackState.empty()
	st["revocationsStored"] = true
	S.write_file(_state_path(root), JSON.stringify(st).to_utf8_buffer())


func _load(root: String, v1: Dictionary, tr: PKeyPackTransport, rec: PKeyPackStorage = null) -> PKeyPackEngine:
	var e := _engine(root.path_join("store"), tr, F.stamp_for([v1]), rec)
	await e.load_state(_baseline(root, v1))
	return e


func _disk(t: PKeyTestContext, v1: Dictionary, v2: Dictionary) -> void:
	var offline := F.FakeTransport.new()
	var locked: Array = []

	# EACCES and a directory at the path both read as unreadable.
	var r1 := S.scratch("revs-disk-eacces")
	await _write_doc(r1, [F.revocation_for(v2)])
	_chmod(_revs_path(r1), "000")
	locked.append(_revs_path(r1))
	var denied := FileAccess.open(_revs_path(r1), FileAccess.READ) == null
	if denied:
		var st := PKeyPackStorage.new(r1.path_join("store")).revocations_read()
		t.check("disk: a chmod 000 revocations.json reads as unreadable, not missing", not st["ok"])
	else:
		t.info("disk: chmod 000 does not deny this user (running as root); the EACCES case is covered by the directory case only")
	var r2 := S.scratch("revs-disk-dir")
	DirAccess.make_dir_recursive_absolute(_revs_path(r2))
	t.check("disk: a directory at revocations.json reads as unreadable, not missing", not PKeyPackStorage.new(r2.path_join("store")).revocations_read()["ok"])

	# No flag: zero writes, the baseline mounts over two loads.
	var unreadable_root := r1 if denied else r2
	for n in 2:
		var rec := Recorder.new(unreadable_root.path_join("store"))
		var e := await _load(unreadable_root, v1, offline, rec)
		t.check("disk: unreadable without the flag, load %d: the baseline mounts, nothing is written" % (n + 1), e.revocations()["issue"] == "unreadable" and e.running.has("djdl.l10n") and not rec.order.has("revocations") and not rec.order.has("quarantine"), S.canon(rec.order))

	# With the flag: refused, offline pack-revoked/relearn, the bytes untouched over two loads.
	var r3 := S.scratch("revs-disk-flag")
	await _write_doc(r3, [F.revocation_for(v2)])
	var before := _bytes(_revs_path(r3))
	_flagged_state(r3)
	if denied:
		_chmod(_revs_path(r3), "000")
		locked.append(_revs_path(r3))
	else:
		S.remove_tree(_revs_path(r3))
		DirAccess.make_dir_recursive_absolute(_revs_path(r3))
	for n in 2:
		var e := await _load(r3, v1, offline)
		var r := await e.ensure(["djdl.l10n"])
		t.check("disk: unreadable with the flag, load %d: the baseline is refused" % (n + 1), e.revocations()["issue"] == "unreadable" and not e.running.has("djdl.l10n"))
		t.check("disk: unreadable with the flag, load %d: offline ensure is pack-revoked (relearn)" % (n + 1), not r.ok and String(r.code) == PKeyConstants.ErrorCode.PACK_REVOKED and r.detail is Dictionary and r.detail.get("detail") == "relearn", "%s %s" % [r.code, r.detail])
	if denied:
		_chmod(_revs_path(r3), "644")
		t.check("disk: the unreadable file's bytes are untouched over two loads", _bytes(_revs_path(r3)) == before)
	else:
		t.check("disk: the directory at the path is untouched over two loads", DirAccess.dir_exists_absolute(_revs_path(r3)))

	# A crash between the flag and the file (flag set, no file): the baseline mounts.
	var r4 := S.scratch("revs-disk-crash")
	_flagged_state(r4)
	var e4 := await _load(r4, v1, offline)
	t.check("disk: flag set but no file (a crash in between): absent is empty, the baseline mounts", e4.revocations()["issue"] == "" and e4.running.has("djdl.l10n") and not FileAccess.file_exists(_revs_path(r4)))

	# Torn: quarantine; relearn persists to load 2; a second torn file keeps the first .torn;
	# recover_state, then the baseline mounts.
	var r5 := S.scratch("revs-disk-torn")
	S.write_file(_revs_path(r5), "{torn".to_utf8_buffer())
	var e5 := await _load(r5, v1, offline)
	t.check("disk: torn, load 1: quarantined, baseline refused", FileAccess.get_file_as_string(_revs_path(r5) + ".torn") == "{torn" and not e5.running.has("djdl.l10n"))
	e5 = await _load(r5, v1, offline)
	var rd5 = _json_file(_revs_path(r5))
	t.check("disk: torn, load 2: relearn persisted, baseline still refused", e5.revocations()["issue"] == "" and e5.revocations()["relearn"] == ["djdl.l10n"] and rd5 is Dictionary and rd5["relearn"] == ["djdl.l10n"] and not e5.running.has("djdl.l10n"))
	S.write_file(_revs_path(r5), "{torn again".to_utf8_buffer())
	e5 = await _load(r5, v1, offline)
	t.check("disk: a second torn file never overwrites the first .torn", FileAccess.get_file_as_string(_revs_path(r5) + ".torn") == "{torn" and e5.revocations()["issue"] == "torn")
	var rr := await e5.recover_state()
	e5 = await _load(r5, v1, offline)
	t.check("disk: recover_state, then the next load mounts the baseline", rr.ok and not FileAccess.file_exists(_revs_path(r5) + ".torn") and e5.running.has("djdl.l10n") and e5.revocations()["relearn"].is_empty())

	# The cap through record_revocations: 258 across two calls -> 256 on disk.
	var r6 := S.scratch("revs-disk-cap")
	var e6 := _engine(r6.path_join("store"), offline, F.stamp_for([v1]))
	await e6.load_state([])
	var batch: Array = []
	var oldest: Array = []
	for i in PKeyPackRevocations.MAX_STORED_REVOCATIONS + 2:
		var target := {"packId": "djdl.other", "version": "1.0.0", "seq": 1, "recordSha256": F.sha(("cap-target-%d" % i).to_utf8_buffer())}
		var rv := F.revocation_for(target, {"issuedAt": 1000 + i})
		if i < 2:
			oldest.append(target["recordSha256"])
		batch.append(await _learned(rv))
		if batch.size() == 200:
			await e6.record_revocations(batch)
			batch = []
	await e6.record_revocations(batch)
	var rd6 = _json_file(_revs_path(r6))
	t.check("disk: 258 revocations across two calls keep 256 on disk, the oldest dropped, no relearn", rd6 is Dictionary and rd6["revoked"].size() == PKeyPackRevocations.MAX_STORED_REVOCATIONS and not rd6["revoked"].has(oldest[0]) and not rd6["revoked"].has(oldest[1]) and rd6["relearn"].is_empty())
	t.check("disk: the dropped targets are forgotten in the process too", not e6.is_revoked(oldest[0]) and not e6.is_revoked(oldest[1]))
	var again6 := _engine(r6.path_join("store"), offline, F.stamp_for([v1]))
	await again6.load_state([])
	t.check("disk: all 256 re-verify on reload", again6.revocations()["verified"].size() == PKeyPackRevocations.MAX_STORED_REVOCATIONS and again6.revocations()["relearn"].is_empty())

	# A rotated key: forgotten with no relearn, the file rewritten, the baseline mounting on loads
	# 2 and 3.
	var r7 := S.scratch("revs-disk-rotated")
	var rotated := F.revocation_for(v1, {"kid": "djdl-release-test-2027"})
	var doc7 := PKeyPackRevocations.empty()
	doc7["revoked"][v1["recordSha256"]] = {"jws": rotated["jws"], "pack": "djdl.l10n", "version": "1.0.0", "seq": 1, "record": rotated["record"], "issuedAt": 1759350000}
	S.write_file(_revs_path(r7), PKeyPackRevocations.serialize(doc7).to_utf8_buffer())
	_flagged_state(r7)
	await _load(r7, v1, offline)
	var rd7 = _json_file(_revs_path(r7))
	t.check("disk: a rotated key's entry is forgotten, no relearn, the file rewritten", rd7 is Dictionary and rd7["revoked"].is_empty() and rd7["relearn"].is_empty())
	for n in [2, 3]:
		var e7 := await _load(r7, v1, offline)
		t.check("disk: rotated key, load %d: the baseline mounts" % n, e7.running.has("djdl.l10n") and not e7.is_revoked(v1["recordSha256"]))

	# The flag lost with state.json: restored, then an unreadable file refuses.
	var r8 := S.scratch("revs-disk-lost-flag")
	await _write_doc(r8, [F.revocation_for(v2)])
	_flagged_state(r8)
	DirAccess.remove_absolute(_state_path(r8))
	await _load(r8, v1, offline)
	var st8 = _json_file(_state_path(r8))
	t.check("disk: a deleted state.json gets revocationsStored back from the sibling file", st8 is Dictionary and st8.get("revocationsStored") == true)
	S.remove_tree(_revs_path(r8))
	DirAccess.make_dir_recursive_absolute(_revs_path(r8))
	var e8 := await _load(r8, v1, offline)
	t.check("disk: then an unreadable file refuses the baseline", e8.revocations()["issue"] == "unreadable" and not e8.running.has("djdl.l10n"))

	# Teardown: permissions back, scratch removed.
	for path in locked:
		_chmod(path, "644")
	t.check("disk: teardown restored every permission", locked.all(func(p): return FileAccess.open(p, FileAccess.READ) != null))
	for root in [r1, r2, r3, r4, r5, r6, r7, r8]:
		S.remove_tree(root)
