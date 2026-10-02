extends RefCounted
# @pkey-feature packs.state update.bootguard
# The shared boot guard and packs (P4-08 with P3-10's slots and PKeyBootGuard), over launches of
# one portable install with the updater enabled (a fresh SDK per launch):
#
#   - a new pack set that two launches never confirm is rolled back to `previous` on the third:
#     the guard reports `rolled-back` without a restart (nothing is mounted before MOUNT), the
#     counter resets, and the device report carries `boot_rolled_back` with the pack id and the
#     restored set's packSetId;
#   - a confirmed launch confirms the running pack set, so it is no longer counted;
#   - a binary (a sidecar code pack) and its pack set roll back together.

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")
const U := preload("res://tests/updater/support.gd")


## One launch: the updater enabled on the install's env, and packs over the install's own store
## with `content` as the build's stamp.
func _launch(sup: PKeyUpdaterTestSupport, inst: Dictionary, version: String, content: Dictionary, tr: PKeyPackTransport) -> Node:
	var tweak := func(o: PKeyOptions) -> void:
		o.pinned_trust_keys = F.product_trust()
		o.pinned_release_keys = F.release_keys()
		o.expected_services = PackedStringArray(["release", "distribution"])
	var sdk: Node = await sup.launch(inst, version, tweak)
	var packs: PKeyPacks = sdk.update.packs
	var stamp := String(inst["dir"]).path_join("pkey-content.json")
	S.write_file(stamp, F.stamp_text(content).to_utf8_buffer())
	packs.root = String(inst["dir"]).path_join("pkey")
	packs.stamp_path = stamp
	packs.embedded_dir = String(inst["dir"]).path_join("none")
	packs.transport = tr
	return sdk


func run(t: PKeyTestContext) -> void:
	var v1 := F.tree_pack("djdl.l10n", "1.0.0", 1, {"a.txt": "one", "b.txt": "b"})
	var v2 := F.tree_pack("djdl.l10n", "1.1.0", 2, {"a.txt": "two", "b.txt": "b"})
	var tr := F.FakeTransport.new().add(v1).add(v2)
	await _packs_only(t, v1, v2, tr)
	await _together(t, v1, v2, tr)


func _packs_only(t: PKeyTestContext, v1: Dictionary, v2: Dictionary, tr: PKeyPackTransport) -> void:
	var sup := U.new()
	sup.serve()
	var inst := U.install("guard-packs", U.bytes(2000, 5))
	# A healthy launch on v1, confirmed.
	var l0: Node = await _launch(sup, inst, "1.4.0", F.stamp_for([v1]), tr)
	var g: Dictionary = await l0.update.run_guard()
	await l0.update.packs.ensure(["djdl.l10n"])
	var c: PKeyResult = await l0.update.packs.confirm()
	t.check("guard: a confirmed launch confirms the running pack set (nothing pending)", c.ok and l0.update.packs.engine.pending().is_empty(), str(g))
	l0.queue_free()
	# The next build pins v2: it installs, and nothing confirms it.
	var l1: Node = await _launch(sup, inst, "1.4.0", F.stamp_for([v2]), tr)
	await l1.update.run_guard()
	await l1.update.packs.ensure(["djdl.l10n"])
	t.check("guard: a new pack set is pending until a launch confirms it", Array(l1.update.packs.engine.pending()) == ["djdl.l10n"])
	l1.queue_free()   # crashed (it ran the hot v2 after installing it)
	for n in 2:
		var ln: Node = await _launch(sup, inst, "1.4.0", F.stamp_for([v2]), tr)
		g = await ln.update.run_guard()
		t.check("guard: launch %d on the pending pack set counts (failedBoots %d)" % [n + 1, n + 1], g["action"] == "none" and float(ln.update.updater.slots.load_state()["failedBoots"]) == float(n + 1), "%s %s" % [g, S.canon(ln.update.updater.slots.load_state())])
		ln.queue_free()   # crashed
	var l3: Node = await _launch(sup, inst, "1.4.0", F.stamp_for([v2]), tr)
	g = await l3.update.run_guard()
	var packs: PKeyPacks = l3.update.packs
	var st: Dictionary = l3.update.updater.slots.load_state()
	t.check("guard: after two failed boots with a new set, previous is active again", g["action"] == "roll-back" and g["result"] == "rolled-back" and not g["restart"] and packs.engine.doc["active"]["djdl.l10n"]["recordSha256"] == v1["recordSha256"], str(g))
	t.check("guard: …running this launch (the restored set is what this boot runs)", packs.engine.running["djdl.l10n"]["recordSha256"] == v1["recordSha256"] and FileAccess.get_file_as_string(packs.path("djdl.l10n").path_join("a.txt")) == "one")
	t.check("guard: the counter is reset", float(st["failedBoots"]) == 0.0, S.canon(st))
	var report: Dictionary = l3.devices.snapshot()
	var ev: Array = report.get("updates", []).filter(func(e): return e["event"] == "boot_rolled_back" and e["deliverable"] == "djdl.l10n")
	var set_id = PKeyPackClaims.pack_set_id([{"packId": "djdl.l10n", "releaseSha256": v1["recordSha256"]}])
	t.check("guard: …and the device report says so (boot_rolled_back, the pack, the restored packSetId)", ev.size() == 1 and ev[0]["release"] == "1.0.0" and ev[0].get("fromRelease") == "1.1.0" and ev[0].get("packSetId") == set_id and ev[0].get("code") == "failed-boots", S.canon(report.get("updates")))
	# B3: the same boot's FETCH (and any later ensure) must not reinstall the rolled-back release
	# while the stamp still pins it: v1 stays active, nothing is downloaded, it counts as present.
	(tr as F.FakeTransport).calls.clear()
	var done: Dictionary = await l3.update.packs.boot_fetch(func(_e): pass)
	t.check("guard: this boot's FETCH keeps the restored v1 (present, ok, nothing fetched)", done["result"] == "ok" and done["installed"] == ["djdl.l10n"] and (tr as F.FakeTransport).calls.is_empty() and packs.engine.doc["active"]["djdl.l10n"]["recordSha256"] == v1["recordSha256"], "%s %s" % [S.canon(done), S.canon((tr as F.FakeTransport).calls)])
	var again: PKeyResult = await l3.update.packs.ensure(["djdl.l10n"])
	t.check("guard: ensure of the rolled-back release is refused with pack-rolled-back, v1 still active", not again.ok and String(again.code) == "pack-rolled-back" and packs.engine.doc["active"]["djdl.l10n"]["recordSha256"] == v1["recordSha256"] and (tr as F.FakeTransport).calls.is_empty(), str(again))
	t.check("guard: the hold names the rolled-back record and counts it once", packs.engine.doc["held"].get("djdl.l10n", {}).get("recordSha256") == v2["recordSha256"] and int(packs.engine.doc["held"]["djdl.l10n"]["count"]) == 1)
	# The next launches (same build, same stamp): no reinstall, no rollback, no repeated report.
	var events_now := (l3.update.updater.slots.load_state()["events"] as Array).filter(func(e): return e["event"] == "boot_rolled_back").size()
	l3.queue_free()
	for n in 3:
		var ln: Node = await _launch(sup, inst, "1.4.0", F.stamp_for([v2]), tr)
		var gn: Dictionary = await ln.update.run_guard()
		var dn: Dictionary = await ln.update.packs.boot_fetch(func(_e): pass)
		var st_n: Dictionary = ln.update.updater.slots.load_state()
		var rb: int = (st_n["events"] as Array).filter(func(e): return e["event"] == "boot_rolled_back").size()
		t.check("guard: launch %d after the rollback keeps v1 with no reinstall and no new boot_rolled_back" % (n + 1), gn["action"] == "none" and gn["result"] == "ok" and dn["result"] == "ok" and ln.update.packs.engine.doc["active"]["djdl.l10n"]["recordSha256"] == v1["recordSha256"] and rb == events_now and float(st_n["failedBoots"]) == 0.0 and (tr as F.FakeTransport).calls.is_empty(), "%s %s %s" % [gn, S.canon(dn), S.canon(st_n)])
		if n < 2:
			ln.queue_free()
		else:
			l3 = ln
	# A pack the build cannot install (its record is not the pinned release) queues pack_failed.
	var extra := F.tree_pack("djdl.extra", "1.0.0", 1, {"x.txt": "x"})
	(tr as F.FakeTransport).add(extra)
	var wrong := F.stamp_for([v1, extra])
	wrong["pins"][1]["release"]["version"] = "9.9.9"
	l3.update.packs.content = wrong
	l3.update.packs.engine.stamp = wrong
	var r: PKeyResult = await l3.update.packs.ensure(["djdl.extra"])
	var failed: Array = l3.devices.snapshot().get("updates", []).filter(func(e): return e["event"] == "pack_failed")
	t.check("guard: a refused pack goes on the device report as pack_failed (its code, the pinned version)", not r.ok and failed.size() == 1 and failed[0]["deliverable"] == "djdl.extra" and failed[0]["code"] == "record-mismatch" and failed[0]["release"] == "9.9.9" and not failed[0].has("fromRelease"), "%s %s" % [r, S.canon(failed)])
	l3.queue_free()
	sup.free_server()
	S.remove_tree(inst["dir"])


func _together(t: PKeyTestContext, v1: Dictionary, v2: Dictionary, tr: PKeyPackTransport) -> void:
	var sup := U.new()
	sup.serve()
	var old := U.bytes(4000, 21)
	var fresh := U.bytes(6000, 22)
	var inst := U.install("guard-together", old)
	# 1.4.0 runs v1, confirmed; then 1.5.0 is staged and applied, and its build pins v2.
	var l0: Node = await _launch(sup, inst, "1.4.0", F.stamp_for([v1]), tr)
	await l0.update.run_guard()
	await l0.update.packs.ensure(["djdl.l10n"])
	await l0.update.packs.confirm()
	sup.discovered(l0)
	sup.plan = {"/djdl/distribution/builds/": [U.ranged(fresh)]}
	await l0.update.updater.stage_sidecar(U.sidecar_check("1.5.0", fresh))
	await l0.update.restart_to_update()
	# update_staged decides again in the background; let its requests finish before this launch ends.
	for k in 60:
		if l0.update.get("_busy") != true:
			break
		await (Engine.get_main_loop() as SceneTree).process_frame
	await PKeyTestFixtures.frames(10)
	l0.queue_free()
	var l1: Node = await _launch(sup, inst, "1.5.0", F.stamp_for([v2]), tr)
	var g: Dictionary = await l1.update.run_guard()
	await l1.update.packs.ensure(["djdl.l10n"])
	t.check("guard: the new binary runs its new pack set (unconfirmed)", g["result"] == "applied" and Array(l1.update.packs.engine.pending()) == ["djdl.l10n"], str(g))
	l1.queue_free()   # crashed
	var l2: Node = await _launch(sup, inst, "1.5.0", F.stamp_for([v2]), tr)
	await l2.update.run_guard()
	l2.queue_free()   # crashed
	var l3: Node = await _launch(sup, inst, "1.5.0", F.stamp_for([v2]), tr)
	var e: PKeyFakeUpdaterEnv = inst["env"]
	var restarts: int = e.restarts
	g = await l3.update.run_guard()
	var st: Dictionary = l3.update.updater.slots.load_state()
	var events: Array = st["events"].filter(func(x): return x["event"] == "boot_rolled_back").map(func(x): return x["deliverable"])
	t.check("guard: the binary rolls back (the old pack is back, restart) …", g["action"] == "roll-back" and g["restart"] == true and e.restarts == restarts + 1 and U.read(inst["pck"]) == old, str(g))
	t.check("guard: …together with its pack set (previous active in the state the next launch loads)", l3.update.packs.engine.doc["active"]["djdl.l10n"]["recordSha256"] == v1["recordSha256"])
	t.check("guard: …and both are reported (app and the pack)", events.has("app") and events.has("djdl.l10n"), S.canon(events))
	l3.queue_free()
	sup.free_server()
	S.remove_tree(inst["dir"])
