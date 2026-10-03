extends RefCounted
# @pkey-feature packs.delegation
# P4-19's device side in Godot (plans/P4-19.md §2.3–§2.7, Amendment A1; P4-26), a port of
# client-core's delegation engine tests and the Python and Swift ports' test_delegation: the parts
# no corpus row can carry.
#
#   utf8      is_strict_utf8 equals TextDecoder("utf-8", {fatal: true}) on direct vectors
#             (overlongs, encoded surrogates, above U+10FFFF, truncated and stray bytes refused;
#             the range edges admitted), alone and through the text rule on `a.txt`
#   pure      the generated lists, record_revoked, covers_pack, the simplify_path() identity, the
#             data-only rule on a worker thread, a pinned `pkd1-` kid (invalid-options), a timing
#   surface   a delegated feed target installs and keeps its delegation; the stamp's pin, a hold and
#             a revocation's replacement are release-key surfaces (`jws`, nothing fetched)
#   dataonly  pack-not-data-only before any payload object (the path rule over the index), while
#             writing (text marker, refused head), and on a `noop` reuse (the re-sniff)
#   revoked   a delegation revocation stops the running release, refuses it again (current and
#             fetched: pack-revoked, detail delegation) and holds across a reload
#   reload    a stored delegated install reloads through its delegation; a swapped one is dropped
#   bound     at most MAX_DELEGATIONS_PER_CHECK distinct delegations per call
#   gddl      a delegated update never takes the GDDL route (no delegated byte is mounted); the
#             godot.pck handler and the mount refuse a delegated install
#   pack_for  P4-20's pack_for answers through a delegation and skips a revoked one
#   facet     PolarisKey.update.packs hands the stamp's holds to the engine (a held release is
#             refused at jws even under a valid delegation) and content_input carries `delegated`
#   flow      PKeyUpdateFlow step 11: delegation entries are relevant (by known delegation or by
#             scope), clear `relearn`, and add the decision-input revocation of a delegated release

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")

const NOW := 1759400100
const ROOT_ID := "djdl.events"
const PACK := "djdl.events.halloween"

var _key: Dictionary
var _g: Dictionary


func run(t: PKeyTestContext) -> void:
	var started := Time.get_ticks_msec()
	_key = F.content_key("djdl-events-2026")
	_g = F.delegation_for(_key, ROOT_ID, ["files.tree", "data.json"])
	t.info("delegation fixtures: content key and delegation in %d ms" % (Time.get_ticks_msec() - started))
	_utf8(t)
	await _pure(t)
	await _surface(t)
	await _dataonly(t)
	await _revoked(t)
	await _reload(t)
	await _bound(t)
	await _gddl(t)
	await _pack_for(t)
	await _flow(t)
	await _facet(t)


func _delegated(pack_id: String, version: String, seq: int, files: Dictionary, from: Variant = null, extra: Dictionary = {}) -> Dictionary:
	var opts := {"signer": _g["signer"]}
	if not extra.is_empty():
		opts["extra"] = extra
	return F.tree_pack(pack_id, version, seq, files, from, opts)


static func _target(p: Dictionary) -> Dictionary:
	return {"pack": p["packId"], "release": {"sha256": p["recordSha256"], "seq": p["seq"], "version": p["version"]}}


func _transport() -> F.FakeTransport:
	var tr := F.FakeTransport.new()
	tr.records[_g["sha256"]] = _g["jws"]
	return tr


static func _code(r: PKeyResult) -> String:
	return String(r.code) if not r.ok else "ok"


static func _detail(r: PKeyResult, key: String) -> Variant:
	return r.detail.get(key) if r.detail is Dictionary else null


func _verified(rv: Dictionary) -> Variant:
	var v: Dictionary = await PKeyReleaseRecord.verify_revocation(rv["jws"], {
		"release_keys": F.release_keys(), "product_trust": F.product_trust(), "expected_aud": F.PRODUCT, "entry": rv["entry"],
	})
	return v["revocation"] if v["ok"] else null


## The revocation of the delegation itself (plans/P4-19.md §2.6) and its feed entry (`kind`).
func _revoke_g() -> Dictionary:
	var rv := F.revocation_for({"packId": ROOT_ID, "recordSha256": _g["sha256"], "version": "1", "seq": 1})
	rv["entry"]["kind"] = "delegation"
	return rv


# ── utf8 ────────────────────────────────────────────────────────────────────────────────────

func _utf8(t: PKeyTestContext) -> void:
	var refused := {
		"overlong 2 (C0 80)": "c080", "overlong 2 (C1 BF)": "c1bf", "overlong 3 (E0 80 80)": "e08080",
		"overlong 3 (E0 9F BF)": "e09fbf", "overlong 4 (F0 80 80 80)": "f0808080", "overlong 4 (F0 8F BF BF)": "f08fbfbf",
		"surrogate (ED A0 80)": "eda080", "surrogate (ED BF BF)": "edbfbf", "above U+10FFFF (F4 90 80 80)": "f4908080",
		"F5": "f5808080", "FE": "fe", "FF": "ff", "stray continuation": "61806162", "truncated 2": "61c3",
		"truncated 3": "e282", "truncated 4": "f09f98", "bad continuation": "c341", "bad continuation 4": "f09f2880",
	}
	var admitted := {
		"ascii": "6869", "U+00E9": "c3a9", "U+D7FF (ED 9F BF)": "ed9fbf", "U+E000 (EE 80 80)": "ee8080",
		"U+FFFD": "efbfbd", "U+1F600": "f09f9880", "U+10FFFF (F4 8F BF BF)": "f48fbfbf", "empty": "",
	}
	for name in refused:
		var b: PackedByteArray = String(refused[name]).hex_decode()
		t.check("utf8: %s refused" % name, not PKeyDataOnly.is_strict_utf8(b))
		t.check("utf8: %s refused through the text rule (a.txt)" % name, PKeyDataOnly.data_only_file_refusal("a.txt", b) == "content")
	for name in admitted:
		var b: PackedByteArray = String(admitted[name]).hex_decode()
		t.check("utf8: %s admitted" % name, PKeyDataOnly.is_strict_utf8(b))
		t.check("utf8: %s admitted through the text rule (a.txt)" % name, PKeyDataOnly.data_only_file_refusal("a.txt", b) == "")
	t.check("utf8: a NUL is refused by the text rule", PKeyDataOnly.data_only_file_refusal("a.json", "610062".hex_decode()) == "content")
	t.check("utf8: a BOM then text is admitted", PKeyDataOnly.data_only_file_refusal("a.json", "efbbbf7b7d".hex_decode()) == "")


# ── pure ────────────────────────────────────────────────────────────────────────────────────

func _pure(t: PKeyTestContext) -> void:
	t.check("pure: extensions() equals DATA_ONLY_EXTENSION_VALUES", Array(PKeyDataOnly.extensions()) == PKeyConstants.DATA_ONLY_EXTENSION_VALUES)
	t.check("pure: delegable_types() equals DELEGABLE_PACK_TYPE_VALUES", Array(PKeyReleaseRecord.delegable_types()) == PKeyConstants.DELEGABLE_PACK_TYPE_VALUES)
	t.check("pure: script_markers() equals P4-08's list", PKeyDataOnly.script_markers() == PKeyPck.script_markers())
	t.check("pure: record_revoked record", PKeyReleaseRecord.record_revoked("a", "b", {"a": true, "b": true}) == "record")
	t.check("pure: record_revoked delegation", PKeyReleaseRecord.record_revoked("a", "b", ["b"]) == "delegation")
	t.check("pure: record_revoked null", PKeyReleaseRecord.record_revoked("a", null, {"b": true}) == null)
	t.check("pure: covers_pack by whole segments", PKeyReleaseRecord.covers_pack("a.b", "a.b") and PKeyReleaseRecord.covers_pack("a.b", "a.b.c") and not PKeyReleaseRecord.covers_pack("a.b", "a.bc"))
	t.check("pure: delegation_hash_of reads the kid", PKeyReleaseRecord.delegation_hash_of(F.sign_record({"x": 1}, _g["signer"])["jws"]) == _g["sha256"])
	t.check("pure: delegation_hash_of is null for a release kid", PKeyReleaseRecord.delegation_hash_of(_g["jws"]) == null)
	for p in ["a.json", "dir/b.png", "x.gd.json"]:
		t.check("pure: %s is its own simplify_path()" % p, PKeyFilesTreeHandler.simplified(p) and PKeyDataOnly.data_only_path_refusal(p) == "")
	for p in ["a/../b.json", "./a.json", "a//b.json", "a/./b.json", "a/b/", "/a.json", "a\\b.json"]:
		t.check("pure: %s is refused by the path rule" % p, PKeyDataOnly.data_only_path_refusal(p) == "extension")
	t.check("pure: simplified refuses a path simplify_path() changes", not PKeyFilesTreeHandler.simplified("a/../b") and not PKeyFilesTreeHandler.simplified("a//b"))
	# On a worker thread, as the appliers run it.
	var big := ("{\"k\": \"" + "x".repeat(200) + "\"}").to_utf8_buffer()
	var on_worker: Array = await PKeyPackJob.run(func() -> Array:
		return [
			PKeyDataOnly.data_only_file_refusal("a.json", big), PKeyDataOnly.data_only_file_refusal("b.json", "{\"GD\\\\Script\": 1}".to_utf8_buffer()),
			PKeyDataOnly.data_only_file_refusal("c.png", "RSRC0000".to_ascii_buffer()), PKeyDataOnly.data_only_file_refusal("d.tres", PackedByteArray()),
		], "PolarisKey test data-only")
	S.check_same(t, "pure: the rule on a worker thread", on_worker, ["", "content", "content", "extension"])
	# A host may never pin a delegated kid.
	var o := PKeyOptions.new()
	o.pinned_release_keys = {"pkd1-" + "0".repeat(64): F.release_keys()[F.RELEASE_KID]}
	t.check("pure: a pinned pkd1- kid is invalid-options", PKeyCore.check_update_options(o).contains("pkd1-"), PKeyCore.check_update_options(o))
	# Timing: the text rule over about 1 MB of JSON with non-ASCII text (INFO).
	var line := "{\"name\": \"caf\u00e9 \\u00e9t\u00e9\", \"n\": 12345},\n"
	var doc := ("[" + line.repeat(20000) + "{}]").to_utf8_buffer()
	var t0 := Time.get_ticks_usec()
	var verdict := PKeyDataOnly.data_only_file_refusal("big.json", doc)
	t.info("data-only: %d bytes of JSON in %.1f ms (%s)" % [doc.size(), (Time.get_ticks_usec() - t0) / 1000.0, "admitted" if verdict == "" else verdict])
	t.check("pure: the 1 MB JSON is admitted", verdict == "")


# ── surface ─────────────────────────────────────────────────────────────────────────────────

func _surface(t: PKeyTestContext) -> void:
	var d := _delegated(PACK, "1.0.0", 1, {"strings/en.json": "{\"boo\":\"Boo!\"}", "img/pumpkin.png": "\u0089PNG pumpkin"})
	var root := S.scratch("deleg-surface")
	var tr := _transport().add(d)
	var e := F.engine(root, tr, F.stamp_for([]))
	await e.load_state([])
	var r := await e.ensure_releases([_target(d)])
	var i: Dictionary = r.detail[0] if r.ok else {}
	t.check("surface: a delegated feed target installs", r.ok and i.get("recordSha256") == d["recordSha256"] and e.running.has(PACK), str(r))
	t.check("surface: the install keeps its delegation verbatim", i.get("delegation") == _g["jws"])
	t.check("surface: the delegation was fetched by its hash", tr.record_calls.has(_g["sha256"]))
	S.check_same(t, "surface: delegated_releases names it", e.delegated_releases(), {d["recordSha256"]: {"pack": PACK, "delegation": _g["sha256"]}})
	var st = S.read_json(e.storage.state_path)
	t.check("surface: state.json carries the delegation", st is Dictionary and st["active"][PACK].get("delegation") == _g["jws"])
	t.check("surface: the files are on disk", FileAccess.get_file_as_string(String(i.get("location", "")).path_join("strings/en.json")) == "{\"boo\":\"Boo!\"}")
	S.remove_tree(root)

	# The stamp's pin: a release-key surface. The record is refused at jws and no delegation fetched.
	root = S.scratch("deleg-pin")
	tr = _transport().add(d)
	e = F.engine(root, tr, F.stamp_for([d]))
	await e.load_state([])
	r = await e.ensure([PACK])
	t.check("surface: the stamp's pin is never delegated (record-rejected, jws)", _code(r) == String(PKeyErrors.RECORD_REJECTED) and _detail(r, "step") == "jws", str(r))
	t.check("surface: and the delegation is not fetched", not tr.record_calls.has(_g["sha256"]))
	S.remove_tree(root)

	# A hold.
	root = S.scratch("deleg-hold")
	tr = _transport().add(d)
	e = F.engine(root, tr, F.stamp_for([]))
	e.holds = [{"pack": PACK, "release": {"sha256": d["recordSha256"], "seq": 1, "version": "1.0.0"}}]
	await e.load_state([])
	r = await e.ensure_releases([_target(d)])
	t.check("surface: a hold is never delegated (record-rejected, jws)", _code(r) == String(PKeyErrors.RECORD_REJECTED) and _detail(r, "step") == "jws" and not tr.record_calls.has(_g["sha256"]), str(r))
	S.remove_tree(root)

	# A stored revocation's replacement.
	root = S.scratch("deleg-replacement")
	var old := F.tree_pack(PACK, "0.9.0", 1, {"strings/en.json": "{}"})
	tr = _transport().add(d).add(old)
	e = F.engine(root, tr, F.stamp_for([]))
	await e.load_state([])
	var rv := F.revocation_for(old, {"replacement": d})
	await e.record_revocations([{"revocation": await _verified(rv), "jws": rv["jws"]}])
	r = await e.ensure_releases([_target(d)])
	t.check("surface: a revocation's replacement is never delegated (record-rejected, jws)", _code(r) == String(PKeyErrors.RECORD_REJECTED) and _detail(r, "step") == "jws" and not tr.record_calls.has(_g["sha256"]), str(r))
	S.remove_tree(root)

	# A delegation that cannot be fetched.
	root = S.scratch("deleg-missing")
	tr = F.FakeTransport.new().add(d)
	e = F.engine(root, tr, F.stamp_for([]))
	await e.load_state([])
	r = await e.ensure_releases([_target(d)])
	t.check("surface: an unfetchable delegation fails with its code (detail delegation)", _code(r) == "network-error" and _detail(r, "detail") == "delegation", str(r))
	S.remove_tree(root)


# ── dataonly ────────────────────────────────────────────────────────────────────────────────

func _dataonly(t: PKeyTestContext) -> void:
	# The path rule over the index: refused before any payload object is fetched.
	var bad := _delegated(PACK, "1.0.0", 1, {"a.json": "{}", "x.gd": "func f(): pass"})
	var root := S.scratch("deleg-ext")
	var tr := _transport().add(bad)
	var e := F.engine(root, tr, F.stamp_for([]))
	await e.load_state([])
	var r := await e.ensure_releases([_target(bad)])
	t.check("dataonly: a .gd file is refused (pack-not-data-only, extension, its path)", _code(r) == PKeyConstants.ErrorCode.PACK_NOT_DATA_ONLY and _detail(r, "detail") == "extension" and _detail(r, "path") == "x.gd", str(r))
	S.check_same(t, "dataonly: only the files index was fetched", tr.calls.map(func(c): return c["sha256"]), [bad["indexSha256"]])
	t.check("dataonly: nothing installed or in flight", not e.doc["active"].has(PACK) and e.doc["inflight"].is_empty())
	var est := await e.estimate_releases([_target(bad)])
	S.check_same(t, "dataonly: estimate refuses it too", est["refused"], [{"packId": PACK, "code": PKeyConstants.ErrorCode.PACK_NOT_DATA_ONLY}])
	S.remove_tree(root)

	# The text rule while writing: a script marker in a JSON file.
	var writes: Array = [
		["text", {"a.json": "{\"k\": \"GDScript\"}"}, "a.json", "1.0.1"],
		["head", {"img/x.png": "RSRC fake resource", "b.json": "{}"}, "img/x.png", "1.0.2"],
		["tail", {"a.ogg": "OggS........GDPC"}, "a.ogg", "1.0.3"],
	]
	for c in writes:
		var p := _delegated(PACK, c[3], 1, c[1])
		root = S.scratch("deleg-write-%s" % c[0])
		tr = _transport().add(p)
		e = F.engine(root, tr, F.stamp_for([]))
		await e.load_state([])
		r = await e.ensure_releases([_target(p)])
		t.check("dataonly: %s refused while writing (pack-not-data-only, content, %s)" % [c[0], c[2]], _code(r) == PKeyConstants.ErrorCode.PACK_NOT_DATA_ONLY and _detail(r, "detail") == "content" and _detail(r, "path") == c[2], str(r))
		var listed = e.storage.list()
		t.check("dataonly: %s: the plan is abandoned and staging discarded" % c[0], e.doc["inflight"].is_empty() and not e.doc["active"].has(PACK) and listed is Dictionary and (listed["plans"] as Array).is_empty(), S.canon(listed))
		S.remove_tree(root)

	# The noop re-sniff: a release-signed install may hold what a delegated release may not.
	var files := {"a.json": "{\"source_code\": 1}"}
	var signed := F.tree_pack(PACK, "1.0.0", 1, files)
	var reuse := _delegated(PACK, "1.0.1", 2, files)
	root = S.scratch("deleg-noop")
	tr = _transport().add(signed).add(reuse)
	e = F.engine(root, tr, F.stamp_for([signed]))
	await e.load_state([])
	r = await e.ensure([PACK])
	t.check("dataonly: the release-signed install commits", r.ok, str(r))
	tr.calls.clear()
	r = await e.ensure_releases([_target(reuse)])
	t.check("dataonly: a delegated release reusing it is re-sniffed (pack-not-data-only, content, a.json)", _code(r) == PKeyConstants.ErrorCode.PACK_NOT_DATA_ONLY and _detail(r, "detail") == "content" and _detail(r, "path") == "a.json", str(r))
	t.check("dataonly: the reuse fetched no payload object", tr.calls.filter(func(c): return c["sha256"] != reuse["indexSha256"]).is_empty(), S.canon(tr.calls))
	t.check("dataonly: the release-signed install stays active", e.doc["active"][PACK]["recordSha256"] == signed["recordSha256"])
	S.remove_tree(root)


# ── revoked ─────────────────────────────────────────────────────────────────────────────────

func _revoked(t: PKeyTestContext) -> void:
	var d := _delegated(PACK, "1.0.0", 1, {"a.json": "{\"v\":1}"})
	var d3 := _delegated("djdl.events.winter", "1.0.0", 1, {"b.json": "{\"v\":3}"})
	var root := S.scratch("deleg-revoked")
	var tr := _transport().add(d).add(d3)
	var e := F.engine(root, tr, F.stamp_for([]))
	await e.load_state([])
	var r := await e.ensure_releases([_target(d)])
	t.check("revoked: the delegated release installs and runs", r.ok and e.running.has(PACK), str(r))
	var rv := _revoke_g()
	var vr = await _verified(rv)
	t.check("revoked: the delegation's revocation verifies (scope root, its hash)", vr is Dictionary and vr["target"] == _g["sha256"] and vr["pack"] == ROOT_ID)
	await e.record_revocations([{"revocation": vr, "jws": rv["jws"]}])
	t.check("revoked: the running release stops", not e.running.has(PACK))
	t.check("revoked: revoked_by says delegation", e.revoked_by(d["recordSha256"], _g["sha256"]) == "delegation" and e.install_revoked(e.doc["active"][PACK]))
	r = await e.ensure_releases([_target(d)])
	t.check("revoked: the installed release is refused (pack-revoked, delegation)", _code(r) == PKeyConstants.ErrorCode.PACK_REVOKED and _detail(r, "detail") == "delegation", str(r))
	r = await e.ensure_releases([_target(d3)])
	t.check("revoked: a fetched release under it is refused (pack-revoked, delegation)", _code(r) == PKeyConstants.ErrorCode.PACK_REVOKED and _detail(r, "detail") == "delegation" and not e.doc["active"].has("djdl.events.winter"), str(r))
	t.check("revoked: and is known to delegated_releases", e.delegated_releases().has(d3["recordSha256"]))
	# A new process over the same directory: the stored delegation revocation holds.
	var e2 := F.engine(root, _transport().add(d), F.stamp_for([]))
	await e2.load_state([])
	t.check("revoked: after a reload the release under the revoked delegation does not run", not e2.running.has(PACK) and e2.is_revoked(_g["sha256"]))
	S.remove_tree(root)


# ── reload ──────────────────────────────────────────────────────────────────────────────────

func _reload(t: PKeyTestContext) -> void:
	var d := _delegated(PACK, "1.0.0", 1, {"a.json": "{\"v\":1}"})
	var root := S.scratch("deleg-reload")
	var e := F.engine(root, _transport().add(d), F.stamp_for([]))
	await e.load_state([])
	var r := await e.ensure_releases([_target(d)])
	t.check("reload: installed", r.ok, str(r))
	# Offline: no transport can serve anything, the stored delegation is enough.
	var e2 := F.engine(root, F.FakeTransport.new(), F.stamp_for([]))
	await e2.load_state([])
	t.check("reload: the delegated install reloads through its stored delegation and runs", e2.running.has(PACK) and e2.doc["active"][PACK].get("delegation") == _g["jws"])
	# A swapped delegation (another one, validly signed) no longer matches the kid: dropped.
	var other := F.delegation_for(F.content_key("djdl-events-other"), ROOT_ID, ["files.tree"])
	var st: Dictionary = S.read_json(e.storage.state_path)
	st["active"][PACK]["delegation"] = other["jws"]
	S.write_file(e.storage.state_path, JSON.stringify(st).to_utf8_buffer())
	var e3 := F.engine(root, F.FakeTransport.new(), F.stamp_for([]))
	await e3.load_state([])
	t.check("reload: a swapped delegation drops the install", not e3.running.has(PACK) and not e3.doc["active"].has(PACK))
	# Without its delegation the record is refused at jws: dropped too.
	st["active"][PACK].erase("delegation")
	S.write_file(e.storage.state_path, JSON.stringify(st).to_utf8_buffer())
	var e4 := F.engine(root, F.FakeTransport.new(), F.stamp_for([]))
	await e4.load_state([])
	t.check("reload: a delegated install without its delegation is dropped", not e4.doc["active"].has(PACK))
	t.check("reload: a non-string delegation is not an install", PKeyPackState._install({"delegation": 5}, PACK) == null)
	S.remove_tree(root)


# ── bound ───────────────────────────────────────────────────────────────────────────────────

func _bound(t: PKeyTestContext) -> void:
	var root := S.scratch("deleg-bound")
	var tr := F.FakeTransport.new()
	var e := F.engine(root, tr, F.stamp_for([]))
	await e.load_state([])
	e._delegation_budget = PKeyConstants.MAX_DELEGATIONS_PER_CHECK
	var codes: Array = []
	for k in PKeyConstants.MAX_DELEGATIONS_PER_CHECK + 1:
		var h := F.sha(("delegation %d" % k).to_utf8_buffer())
		var d: Dictionary = await e._fetch_delegation(PACK, h)
		codes.append(String(d["error"]["message"]).contains("delegation bound"))
	t.check("bound: %d distinct delegations are fetched, the next waits" % PKeyConstants.MAX_DELEGATIONS_PER_CHECK, tr.record_calls.size() == PKeyConstants.MAX_DELEGATIONS_PER_CHECK and codes.count(true) == 1 and codes[-1] == true, S.canon(codes))
	# A cached delegation costs nothing.
	tr.records[_g["sha256"]] = _g["jws"]
	e._delegation_budget = 1
	var first: Dictionary = await e._fetch_delegation(PACK, _g["sha256"])
	var again: Dictionary = await e._fetch_delegation(PACK, _g["sha256"])
	t.check("bound: a fetched delegation is reused without a fetch", first.get("body") == _g["jws"] and again.get("body") == _g["jws"] and e._delegation_budget == 0)
	# Every call starts with a fresh bound.
	await e.ensure_releases([])
	t.check("bound: ensure_releases resets the bound", e._delegation_budget == PKeyConstants.MAX_DELEGATIONS_PER_CHECK)
	S.remove_tree(root)


# ── gddl ────────────────────────────────────────────────────────────────────────────────────

func _gddl(t: PKeyTestContext) -> void:
	var keep := PackedByteArray()
	keep.resize(200000)
	for k in keep.size():
		keep[k] = (k * 73 + 11) % 253
	var v1 := _delegated(PACK, "1.0.0", 1, {"strings/en.json": "{\"hi\":\"Hello\"}", "probe.txt": F.probe_base(), "keep.png": keep})
	var v2 := _delegated(PACK, "1.1.0", 2, {"strings/en.json": "{\"hi\":\"Hello!\"}", "probe.txt": F.probe_target(), "keep.png": keep}, v1)
	var root := S.scratch("deleg-gddl")
	var tr := _transport().add(v1).add(v2)
	var e := F.engine(root, tr, F.stamp_for([]))
	await e.load_state([])
	var r := await e.ensure_releases([_target(v1)])
	t.check("gddl: v1 installs", r.ok, str(r))
	tr.calls.clear()
	r = await e.ensure_releases([_target(v2)])
	var fetched: Array = tr.calls.map(func(c): return c["sha256"])
	var patch_sha: String = v2["record"]["variants"][0]["deltas"][0]["patch"]["sha256"]
	t.check("gddl: v2 installs over v1", r.ok and e.running[PACK]["recordSha256"] == v2["recordSha256"], str(r))
	t.check("gddl: never by the files delta (no GDDL mount of delegated bytes)", not fetched.has(patch_sha) and e.zstd.stats["batches"] == 0, "%s %s" % [S.canon(fetched), S.canon(e.zstd.stats)])
	t.info("gddl: patch-from %s here; the delegated update fetched %s" % ["advertised" if not e.patch_methods.is_empty() else "not advertised", S.canon(fetched)])
	S.remove_tree(root)
	# The godot.pck handler never queues a delegated install, and the mount refuses one.
	var h := PKeyGodotPckHandler.new()
	h.activate({"packId": "diceroll.core3d", "recordSha256": "0".repeat(64), "delegation": _g["jws"]})
	t.check("gddl: the godot.pck handler never queues a delegated install", h.to_mount.is_empty())


# ── pack_for ────────────────────────────────────────────────────────────────────────────────

func _pack_for(t: PKeyTestContext) -> void:
	var d := _delegated(PACK, "1.0.0", 1, {"a.json": "{}"}, null, {"provides": ["event.halloween"]})
	var root := S.scratch("deleg-packfor")
	var tr := _transport().add(d)
	var e := F.engine(root, tr, F.stamp_for([]))
	await e.load_state([])
	var pr := PKeyPackProvides.new(e)
	S.check_same(t, "pack_for: a delegated target answers through its delegation", await pr.pack_for("event.halloween", [_target(d)]), {"packId": PACK, "release": _target(d)["release"]})
	var rv := _revoke_g()
	await e.record_revocations([{"revocation": await _verified(rv), "jws": rv["jws"]}])
	t.check("pack_for: a target under a revoked delegation never answers (memo hit included)", await pr.pack_for("event.halloween", [_target(d)]) == null)
	S.remove_tree(root)


# ── flow ────────────────────────────────────────────────────────────────────────────────────

func _flow_setup(d: Dictionary, rv: Dictionary, expects_pack: String, delegated: Dictionary) -> Dictionary:
	var app_record := {
		"schemaVersion": 1, "aud": F.PRODUCT, "deliverable": "app", "kind": "app", "version": "1.5.0", "seq": 15,
		"issuedAt": 1759000000,
		"builds": [{"id": "macos-dmg", "platform": "macos", "arch": "universal", "format": "dmg", "artifacts": [{"name": "a.dmg", "role": "payload", "sha256": F.sha("a".to_utf8_buffer()), "size": 1}]}],
	}
	var app_jws := F.sign_with(app_record, F.RELEASE_KID, "pkey-release+jws")
	var app_sha := F.sha(app_jws.to_utf8_buffer())
	var feed := {
		"schemaVersion": 1, "iss": "key.plrs.im", "aud": F.PRODUCT, "channel": "stable", "selector": {}, "seq": 7,
		"issuedAt": NOW - 100, "expiresAt": NOW + 800,
		"app": {"deliverable": "app", "versionScheme": "semver", "targets": [{
			"platform": "macos", "release": {"sha256": app_sha, "seq": 15, "version": "1.5.0"}, "floor": null, "critical": false,
			"outlets": {"direct": {"kind": "direct", "live": {"version": "1.5.0", "seq": 15}, "halted": false}},
		}]},
		"revocations": [rv["entry"]],
	}
	var feed_jws := F.sign_with(feed, F.PRODUCT_KID, "pkey-feed+jws")
	var records := {app_sha: app_jws, rv["record"]: rv["jws"], d["recordSha256"]: d["jws"]}
	var fetched: Array = []
	var content := {
		"stamp": {"contentApi": 1, "pins": [], "expects": [{"pack": expects_pack, "required": true, "delivery": "essential"}]},
		"holds": [],
		"active": {PACK: {"sha256": d["recordSha256"], "seq": 1, "version": "1.0.0"}} if not delegated.is_empty() else {},
		"engine": null, "axes": {}, "revoked": {}, "relearn": [ROOT_ID], "delegated": delegated,
	}
	var opts := {
		"channel": "stable", "expected_aud": F.PRODUCT, "trust": F.product_trust(), "release_keys": F.release_keys(),
		"now": NOW, "install_id": "dev_1",
		"installed": {"version": "1.5.0", "binaryVersion": "1.5.0", "buildNumber": null, "platform": "macos", "arch": "arm64", "format": null, "engine": null},
		"outlet": {"id": "direct", "kind": "direct"}, "subkind": null, "staged": null, "skip_version": null, "methods": ["download"],
		"cache": {"feeds": {}, "releaseRecords": {}},
		"fetch_feed": func(_c: String) -> Dictionary: return {"ok": true, "body": feed_jws},
		"fetch_record": func(h: String) -> Dictionary:
			fetched.append(h)
			return {"ok": true, "body": records[h]} if records.has(h) else {"ok": false, "code": "network-error"},
		"content": content, "offload": false,
	}
	return {"opts": opts, "fetched": fetched}


func _flow(t: PKeyTestContext) -> void:
	var d := _delegated(PACK, "1.0.0", 1, {"a.json": "{\"v\":1}"})
	var rv := _revoke_g()
	var known := {d["recordSha256"]: {"pack": PACK, "delegation": _g["sha256"]}}

	# A delegation entry naming the delegation of an active delegated release: relevant.
	var s := _flow_setup(d, rv, PACK, known)
	var r: Dictionary = await PKeyUpdateFlow.run(s["opts"])
	var learned: Array = r.get("revocations", {}).get("learned", []) if r["ok"] else []
	t.check("flow: the delegation entry is fetched and learned", s["fetched"].has(rv["record"]) and learned.size() == 1 and learned[0]["revocation"]["target"] == _g["sha256"], S.canon(r.get("revocations")).left(300))
	t.check("flow: relearn of the scope root clears once it is known", r["ok"] and r["revocations"]["relearnCleared"] == [ROOT_ID])
	t.check("flow: the active delegated release is revoked for the decision (required: blocked)", r["ok"] and r["check"]["decision"].get("action") == "blocked" and r["check"]["decision"].get("reason") == "revoked-content" and r["boot"] == PKeyDecision.BOOT_REQUIRED, S.canon(r.get("check")).left(400))

	# Relevant by scope alone: the scope root covers an expected pack (no delegated release known).
	s = _flow_setup(d, rv, "djdl.events.spring", {})
	r = await PKeyUpdateFlow.run(s["opts"])
	t.check("flow: a delegation entry whose scope covers a pack in H is fetched", r["ok"] and s["fetched"].has(rv["record"]) and r["revocations"]["learned"].size() == 1)

	# Not relevant: neither a known delegation nor a covered pack. Not fetched; relearn clears.
	s = _flow_setup(d, rv, "djdl.levels", {})
	r = await PKeyUpdateFlow.run(s["opts"])
	t.check("flow: an irrelevant delegation entry is not fetched and keeps nothing in relearn", r["ok"] and not s["fetched"].has(rv["record"]) and r["revocations"]["learned"].is_empty() and r["revocations"]["relearnCleared"] == [ROOT_ID])

	# Already stored: the decision input still revokes the delegated release.
	s = _flow_setup(d, rv, PACK, known)
	s["opts"]["content"]["revoked"] = {_g["sha256"]: await _verified(rv)}
	r = await PKeyUpdateFlow.run(s["opts"])
	t.check("flow: a stored delegation revocation is not fetched again and still blocks", r["ok"] and not s["fetched"].has(rv["record"]) and r["check"]["decision"].get("reason") == "revoked-content")


# ── facet ───────────────────────────────────────────────────────────────────────────────────

func _facet(t: PKeyTestContext) -> void:
	var d := _delegated(PACK, "1.0.0", 1, {"a.json": "{\"v\":1}"})
	for held in [true, false]:
		var root := S.scratch("deleg-facet-%s" % ("held" if held else "free"))
		var stamp_file := root.path_join("pkey-content.json")
		var stamp := F.stamp_for([])
		if held:
			stamp["holds"] = [{"pack": PACK, "release": _target(d)["release"]}]
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
		packs.transport = _transport().add(d)
		var r := await packs.ensure_releases([_target(d)])
		if held:
			t.check("facet: the engine has the stamp's holds", packs.engine.holds is Array and packs.engine.holds.size() == 1)
			t.check("facet: a held release is refused at jws even under a valid delegation", _code(r) == String(PKeyErrors.RECORD_REJECTED) and _detail(r, "step") == "jws", str(r))
		else:
			t.check("facet: without the hold the delegated release installs", r.ok, str(r))
			var c = await packs.content_input()
			S.check_same(t, "facet: content_input carries the delegated releases", c.get("delegated") if c is Dictionary else null, {d["recordSha256"]: {"pack": PACK, "delegation": _g["sha256"]}})
		sdk.queue_free()
		S.remove_tree(root)
