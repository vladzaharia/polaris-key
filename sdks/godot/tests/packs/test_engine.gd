extends RefCounted
# @pkey-feature packs.state packs.handlers packs.apply.delta packs.apply.file packs.apply.full
# PKeyPackEngine end to end over the fake transport (client-core packsEngine.test.ts, ported for
# the parts Godot shares) and the `godot.pck` handler over the kaykit packs CI would publish:
#
#   tree     a `files.tree` first install (full), an update by its files delta, rollback, the
#            running set and packSetId
#   resume   an interrupted download resumes with Range and If-Range; a moved validator restarts
#   refuse   not pinned, no stamp, a record that is not the pinned release, an entitlement
#   pck      v1→v2 by the payload delta, the files delta, file and full: each commits CI's v2 at
#            store/<sha256>.pck, which the next boot mounts (its new entry then reads through
#            res://); the directory check and the header check refuse before anything commits
#   embedded a baseline in the build counts as installed and is a delta base; a bad marker is
#            refused by step

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")


func run(t: PKeyTestContext) -> void:
	await _tree(t)
	await _resume(t)
	await _refuse(t)
	await _pck(t)
	await _embedded(t)


func _tree(t: PKeyTestContext) -> void:
	# A large unchanged file makes `full` the dearest candidate, so the update shows the delta.
	var keep := PackedByteArray()
	keep.resize(200000)
	for k in keep.size():
		keep[k] = (k * 73 + 11) % 253
	var v1 := F.tree_pack("djdl.l10n", "1.0.0", 1, {"strings/en.json": "{\"hi\":\"Hello\"}", "probe.txt": F.probe_base(), "keep.bin": keep})
	var v2 := F.tree_pack("djdl.l10n", "1.1.0", 2, {"strings/en.json": "{\"hi\":\"Hello!\"}", "probe.txt": F.probe_target(), "keep.bin": keep, "new.txt": "added"}, v1)
	var root := S.scratch("engine-tree")
	var tr := F.FakeTransport.new().add(v1).add(v2)
	var e := F.engine(root, tr, F.stamp_for([v1]))
	await e.load_state([])
	var r := await e.ensure(["djdl.l10n"])
	var i: Dictionary = r.detail[0] if r.ok else {}
	t.check("tree: a first install commits", r.ok and i.get("recordSha256") == v1["recordSha256"] and i.get("location") == e.storage.tree_path(v1["treeDigest"]), str(r))
	t.check("tree: the hot pack runs at once and its files are on disk", e.running.has("djdl.l10n") and FileAccess.get_file_as_string(String(i.get("location", "")).path_join("strings/en.json")) == "{\"hi\":\"Hello\"}")
	t.check("tree: the files index is kept beside the files (never inside the payload's paths)", FileAccess.file_exists(String(i.get("location", "")).path_join(".pkey/files.json")))
	t.check("tree: the first install fetched the full object (index + full)", tr.calls.map(func(c): return c["sha256"]) == [v1["indexSha256"], v1["fullSha256"]], S.canon(tr.calls))
	S.check_same(t, "tree: packSetId is the running set's", e.pack_set_id(), PKeyPackClaims.pack_set_id([{"packId": "djdl.l10n", "releaseSha256": v1["recordSha256"]}]))

	# A new process pins v2: the delta set (or the file strategy without patch-from) updates it.
	tr.calls.clear()
	var e2 := F.engine(root, tr, F.stamp_for([v2]))
	await e2.load_state([])
	t.check("tree: the next load re-verifies v1 and runs it", e2.running.has("djdl.l10n") and e2.running["djdl.l10n"]["recordSha256"] == v1["recordSha256"])
	r = await e2.ensure(["djdl.l10n"])
	var fetched: Array = tr.calls.map(func(c): return c["sha256"])
	var patch_sha: String = v2["record"]["variants"][0]["deltas"][0]["patch"]["sha256"] if v2["record"]["variants"][0].has("deltas") else ""
	var by_delta := fetched.has(patch_sha)
	t.check("tree: v2 installs over v1", r.ok and e2.running["djdl.l10n"]["recordSha256"] == v2["recordSha256"] and FileAccess.get_file_as_string(e2.storage.tree_path(v2["treeDigest"]).path_join("new.txt")) == "added", str(r))
	var advertised := not e2.patch_methods.is_empty()
	t.check("tree: by the files delta when patch-from is advertised, else by file", by_delta == advertised and not fetched.has(v2["fullSha256"]), S.canon(fetched))
	t.check("tree: the probe file was decoded by the engine (its bytes are the target)", FileAccess.get_file_as_bytes(e2.storage.tree_path(v2["treeDigest"]).path_join("probe.txt")) == F.probe_target())
	t.check("tree: v1 is previous and still stored (a rollback target)", e2.doc["previous"].has("djdl.l10n") and DirAccess.dir_exists_absolute(e2.storage.tree_path(v1["treeDigest"])))
	var rb := await e2.rollback("djdl.l10n")
	t.check("tree: rollback re-points the hot pack at v1 at once", rb.ok and rb.detail == true and e2.running["djdl.l10n"]["recordSha256"] == v1["recordSha256"] and e2.doc["active"]["djdl.l10n"]["recordSha256"] == v1["recordSha256"], str(rb))
	var rb2 := await e2.rollback("djdl.l10n")
	t.check("tree: a second rollback has nothing to roll back to", rb2.ok and rb2.detail == false)
	var c := await e2.confirm()
	t.check("tree: confirm records the running set as confirmed", c.ok and e2.doc["confirmed"].get("djdl.l10n") == v1["recordSha256"] and e2.pending().is_empty())
	S.remove_tree(root)


func _resume(t: PKeyTestContext) -> void:
	var big := PackedByteArray()
	big.resize(150000)
	for k in big.size():
		big[k] = (k * 131 + 7) % 251
	var p := F.tree_pack("djdl.music", "1.0.0", 1, {"track.ogg": big})
	var root := S.scratch("engine-resume")
	var tr := F.FakeTransport.new().add(p)
	var e := F.engine(root, tr, F.stamp_for([p]))
	await e.load_state([])
	tr.cut = 40000
	tr.cut_for = p["fullSha256"]
	var r := await e.ensure(["djdl.music"])
	t.check("resume: an interrupted download fails with network-error", not r.ok and r.code == PKeyErrors.NETWORK, str(r))
	var inflight: Dictionary = e.state()["inflight"].get("djdl.music", {})
	t.check("resume: the journal keeps the plan and what is staged", int(inflight.get("done", 0)) > 0 and int(inflight.get("done", 0)) < int(inflight.get("total", 0)), S.canon(inflight))
	# A new process resumes from what is staged, re-hashed, with Range and the strong If-Range.
	tr.calls.clear()
	var e2 := F.engine(root, tr, F.stamp_for([p]))
	await e2.load_state([])
	r = await e2.ensure(["djdl.music"])
	var resumed = tr.calls.filter(func(c): return c["offset"] > 0)
	t.check("resume: the next ensure resumes with Range from the staged size and If-Range \"<sha256>\"", r.ok and not resumed.is_empty() and resumed[0]["if_range"] == "\"%s\"" % resumed[0]["sha256"], S.canon(tr.calls))
	t.check("resume: the resumed install is whole", r.ok and FileAccess.get_file_as_bytes(e2.storage.tree_path(p["treeDigest"]).path_join("track.ogg")) == big)
	# The validator moved: the server answers a resume with 200 and the object starts over.
	var root2 := S.scratch("engine-moved")
	var e3 := F.engine(root2, tr, F.stamp_for([p]))
	await e3.load_state([])
	tr.cut = 30000
	tr.cut_for = p["fullSha256"]
	await e3.ensure(["djdl.music"])
	tr.moved = true
	tr.calls.clear()
	r = await e3.ensure(["djdl.music"])
	tr.moved = false
	t.check("resume: a 200 to a resume starts the object over and still installs it whole", r.ok and FileAccess.get_file_as_bytes(e3.storage.tree_path(p["treeDigest"]).path_join("track.ogg")) == big, str(r))
	S.remove_tree(root)
	S.remove_tree(root2)


func _refuse(t: PKeyTestContext) -> void:
	var p := F.tree_pack("djdl.hd", "1.0.0", 1, {"a.txt": "x"}, null, {"entitlement": "hd"})
	var root := S.scratch("engine-refuse")
	var tr := F.FakeTransport.new().add(p)
	var e := F.engine(root, tr, F.stamp_for([p]))
	e.entitlements = func() -> Variant: return {}
	await e.load_state([])
	var r := await e.ensure(["djdl.hd"])
	t.check("refuse: a pack whose entitlement the licence lacks", not r.ok and String(r.code) == "pack-not-entitled", str(r))
	e.entitlements = func() -> Variant: return {"hd": true}
	r = await e.ensure(["djdl.hd"])
	t.check("refuse: …installs once the licence grants it", r.ok, str(r))
	r = await e.ensure(["djdl.other"])
	t.check("refuse: a pack the stamp does not pin", not r.ok and String(r.code) == "pack-not-pinned", str(r))
	var e2 := F.engine(S.scratch("engine-nostamp"), tr, null)
	await e2.load_state([])
	r = await e2.ensure(["djdl.hd"])
	t.check("refuse: a build without a content stamp has no packs", not r.ok and r.code == PKeyErrors.NOT_CONFIGURED, str(r))
	var wrong := F.stamp_for([p])
	wrong["pins"][0]["release"]["version"] = "9.9.9"
	var e3 := F.engine(S.scratch("engine-mismatch"), tr, wrong)
	await e3.load_state([])
	r = await e3.ensure(["djdl.hd"])
	t.check("refuse: a record that is not the pinned release (its version) is record-mismatch", not r.ok and r.code == PKeyErrors.RECORD_MISMATCH, str(r))
	var est := await e3.estimate(["djdl.hd"])
	t.check("refuse: estimate reports it refused, with the code", est["refused"].size() == 1 and est["refused"][0]["code"] == "record-mismatch", S.canon(est))
	S.remove_tree(root)


## The kaykit release `which`, its `requires.engine` dropped on an engine outside 4.7 (so the
## header check, not the variant selection, is what such an engine meets).
func _kaykit(which: String, seq: int, extra := Callable()) -> Dictionary:
	var minor := int(Engine.get_version_info()["minor"])
	return F.kaykit_pack(which, seq, func(rec: Dictionary) -> void:
		if minor != 7:
			rec["variants"][0].erase("requires")
		if extra.is_valid():
			extra.call(rec))


func _pck(t: PKeyTestContext) -> void:
	var m := F.manifest()
	var v2sha: String = m["v2"]["variant"]["payload"]["sha256"]
	var v1_bytes := FileAccess.get_file_as_bytes(F.UPDATE.path_join("kaykit-v1.pck"))
	var header_ok := PKeyPck.engine_check(PKeyPck.read_directory(PKeyByteSource.memory(v1_bytes))["header"]) == ""
	var v1 := _kaykit("v1", 1)
	var root0 := S.scratch("engine-pck-v1")
	var tr := F.FakeTransport.new().add(v1)
	var e := F.engine(root0, tr, F.stamp_for([v1]))
	await e.load_state([])
	var r := await e.ensure(["diceroll.core3d"])
	if not header_ok:
		t.check("pck: a pack built by a newer engine is refused before it commits (pck-engine-mismatch)", not r.ok and String(r.code) == PKeyPck.ENGINE_MISMATCH and e.storage.list()["locations"].is_empty(), str(r))
		t.info("pck: %s cannot load the kaykit packs (PCK v4, engine 4.7.2); the update strategies run on 4.7" % Engine.get_version_info().string)
		S.remove_tree(root0)
		return
	var store_v1 := e.storage.container_path(v1["payloadSha256"])
	t.check("pck: v1's first install commits CI's pack at store/<sha256>.pck", r.ok and r.detail[0]["location"] == store_v1 and F.sha(FileAccess.get_file_as_bytes(store_v1)) == v1["payloadSha256"], str(r))
	var h: PKeyGodotPckHandler = e.handlers["godot.pck"]
	t.check("pck: committed during this boot's FETCH, it joins this boot's mounts (restart activation)", h.to_mount.has("diceroll.core3d") and e.running["diceroll.core3d"]["recordSha256"] == v1["recordSha256"])

	var variant: Dictionary = m["v2"]["variant"]
	var payload_delta: Dictionary = variant["deltas"].filter(func(d): return d["scope"] == "payload")[0]
	var files_delta: Dictionary = variant["deltas"].filter(func(d): return d["scope"] == "files")[0]
	var cases := [
		["the payload delta", ["delta"], func(rec: Dictionary) -> void: rec["variants"][0]["deltas"] = rec["variants"][0]["deltas"].filter(func(d): return d["scope"] == "payload"), String(payload_delta["artifact"]["sha256"])],
		["the files delta", ["delta"], func(rec: Dictionary) -> void: rec["variants"][0]["deltas"] = rec["variants"][0]["deltas"].filter(func(d): return d["scope"] == "files"), String(files_delta["patch"]["sha256"])],
		["file", ["file"], Callable(), String(variant["files"]["gaps"]["sha256"])],
		["full", [], Callable(), String(variant["full"]["sha256"])],
	]
	var patch_from := not e.patch_methods.is_empty()
	for c in cases:
		if c[1] == ["delta"] and not patch_from:
			t.info("pck: v1→v2 by %s skipped: zstd-patch-from is not advertised here" % c[0])
			continue
		var root := S.scratch("engine-pck")
		DirAccess.make_dir_recursive_absolute(root.path_join("store"))
		# Start from an installed v1 (copied from the first install's store and state).
		S.write_file(root.path_join("store").path_join(v1["payloadSha256"] + ".pck"), FileAccess.get_file_as_bytes(store_v1))
		S.write_file(root.path_join("store").path_join(v1["payloadSha256"] + ".files.json"), FileAccess.get_file_as_bytes(e.storage.store_dir().path_join(v1["payloadSha256"] + ".files.json")))
		var state_text := FileAccess.get_file_as_string(e.storage.state_path).replace(e.storage.root, root)
		S.write_file(root.path_join("content/state.json"), state_text.to_utf8_buffer())
		var v2 := _kaykit("v2", 2, c[2])
		var tr2 := F.FakeTransport.new().add(v1).add(v2)
		var e2 := F.engine(root, tr2, F.stamp_for([v2]))
		e2.strategies = c[1]
		if c[0] != "full":
			# A small pack's `full` (one request) is always the cheapest candidate; drop it so the
			# strategy under test is what runs (the one-shot bound is the engine's own lever).
			e2.one_shot_budget = 1
		await e2.load_state([])
		var started := Time.get_ticks_usec()
		var r2 := await e2.ensure(["diceroll.core3d"])
		var ms := (Time.get_ticks_usec() - started) / 1000.0
		var dest := e2.storage.container_path(v2sha)
		var fetched: Array = tr2.calls.map(func(x): return x["sha256"])
		t.check("pck: v1→v2 by %s commits CI's v2 at store/<sha256>.pck" % c[0], r2.ok and r2.detail[0]["location"] == dest and F.sha(FileAccess.get_file_as_bytes(dest)) == v2sha, str(r2))
		t.check("pck: …having fetched %s" % c[0], fetched.has(c[3]), S.canon(fetched))
		t.check("pck: …v1 stays stored as previous, never overwritten", F.sha(FileAccess.get_file_as_bytes(root.path_join("store").path_join(v1["payloadSha256"] + ".pck"))) == v1["payloadSha256"] and e2.doc["previous"].has("diceroll.core3d"))
		t.info("pck: v1→v2 by %s in %.1f ms" % [c[0], ms])
		# The next boot: a fresh engine loads the state and mounts v2 from its store path.
		if c[0] == "full":
			var e3 := F.engine(root, tr2, F.stamp_for([v2]))
			await e3.load_state([])
			var facade := PKeyPacks.new()
			facade.engine = e3
			facade.content = F.stamp_for([v2])
			var ready_ids: Array = []
			facade.pack_ready.connect(func(id): ready_ids.append(id))
			var mounted: Dictionary = await facade.mount()
			var level10 := "res://assets/kaykit/data/level_010.json"
			t.check("pck: the next boot mounts v2 from store/<sha256>.pck", mounted["mounted"] == ["diceroll.core3d"] and ready_ids == ["diceroll.core3d"] and facade.mounted["diceroll.core3d"]["location"] == dest, S.canon(mounted))
			t.check("pck: …and v2's new entry reads through res://", FileAccess.file_exists(level10) and FileAccess.get_file_as_string(level10).contains("\"level\":10"))
			var again: Dictionary = await facade.mount()
			t.check("pck: a pack is never mounted twice in a process", again["mounted"].is_empty())
		S.remove_tree(root)

	# The directory check and the header check refuse before anything commits.
	for bad in [["kaykit-forbidden", PKeyPck.DIRECTORY_REFUSED, "assets/kaykit/roll.gd"], ["reader-v2-res", PKeyPck.ENGINE_MISMATCH, ""]]:
		var bytes := FileAccess.get_file_as_bytes("res://tests/fixtures/packs/check/%s.pck" % bad[0])
		var full := {"sha256": F.sha(bytes), "bytes": bytes.size(), "size": bytes.size(), "codec": "none"}
		var rec_pack := F.kaykit_pack("v1", 3, func(rec: Dictionary) -> void:
			rec["variants"][0] = {"variant": {}, "payload": {"size": bytes.size(), "sha256": F.sha(bytes)}, "full": full,
				"files": {"format": "pkey-files/1", "layout": "container", "sha256": "ab".repeat(32), "bytes": 10, "size": 10, "codec": "zstd", "gaps": {"sha256": "cd".repeat(32), "bytes": 1, "size": 1, "codec": "none"}},
				"requires": {"engine": "godot-4.7"} if int(Engine.get_version_info()["minor"]) == 7 else {}})
		rec_pack["objects"] = {F.sha(bytes): bytes}
		var root := S.scratch("engine-pck-bad")
		var e4 := F.engine(root, F.FakeTransport.new().add(rec_pack), F.stamp_for([rec_pack]))
		await e4.load_state([])
		var r4 := await e4.ensure(["diceroll.core3d"])
		var listed = e4.storage.list()
		t.check("pck: %s is refused before it commits (%s%s)" % [bad[0], bad[1], (" at " + bad[2]) if bad[2] != "" else ""], not r4.ok and String(r4.code) == bad[1] and String(r4.detail.get("path", "")) == bad[2] and listed["locations"].is_empty() and listed["plans"].is_empty() and e4.doc["inflight"].is_empty() and e4.doc["active"].is_empty(), "%s %s" % [r4, S.canon(listed)])
		S.remove_tree(root)
	S.remove_tree(root0)


func _embedded(t: PKeyTestContext) -> void:
	var p1 := F.tree_pack("djdl.base", "1.0.0", 1, {"probe.txt": F.probe_base(), "a.txt": "a"})
	var p2 := F.tree_pack("djdl.base", "1.1.0", 2, {"probe.txt": F.probe_target(), "a.txt": "a"}, p1)
	var root := S.scratch("engine-embedded")
	var emb := root.path_join("res-pkey_packs")
	for path in p1["files"]:
		S.write_file(emb.path_join("base").path_join(path), p1["files"][path])
	S.write_file(emb.path_join("base/.pkey/pack.json"), F.marker_for(p1).to_utf8_buffer())
	var baselines := PKeyPackEmbeddedTransport.new(emb).embedded()
	t.check("embedded: the transport finds the tree baseline and measures it", baselines.size() == 1 and baselines[0].get("payload", {}).get("treeDigest") == p1["treeDigest"], S.canon(baselines))
	var tr := F.FakeTransport.new().add(p1).add(p2)
	var e := F.engine(root.path_join("store-root"), tr, F.stamp_for([p1]))
	var loaded := await e.load_state(baselines)
	t.check("embedded: a verified baseline runs and counts as installed", loaded["refused"].is_empty() and e.running.has("djdl.base") and e.running["djdl.base"].get("embedded") == true, S.canon(loaded))
	var r := await e.ensure(["djdl.base"])
	t.check("embedded: the pinned release embedded is current: nothing is fetched", r.ok and tr.calls.is_empty() and tr.record_calls.is_empty(), "%s %s" % [r, S.canon(tr.calls)])
	var e2 := F.engine(root.path_join("store-root"), tr, F.stamp_for([p2]))
	await e2.load_state(baselines)
	r = await e2.ensure(["djdl.base"])
	t.check("embedded: the baseline is the base of the next release's delta", r.ok and e2.running["djdl.base"]["recordSha256"] == p2["recordSha256"], str(r))
	t.check("embedded: the baseline is never collected", DirAccess.dir_exists_absolute(emb.path_join("base")) and FileAccess.file_exists(emb.path_join("base/a.txt")))
	# A tampered marker is refused by its step.
	var bad := F.marker_for(p1).replace("\"version\":\"1.0.0\"", "\"version\":\"1.0.1\"")
	S.write_file(emb.path_join("base/.pkey/pack.json"), bad.to_utf8_buffer())
	var e3 := F.engine(root.path_join("store-root-2"), tr, F.stamp_for([p1]))
	var l3 := await e3.load_state(PKeyPackEmbeddedTransport.new(emb).embedded())
	t.check("embedded: a marker whose version is not its record's is refused at cross-check", l3["refused"].size() == 1 and l3["refused"][0]["step"] == "cross-check" and not e3.running.has("djdl.base"), S.canon(l3))
	S.remove_tree(root)
