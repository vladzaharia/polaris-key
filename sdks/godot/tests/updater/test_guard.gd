extends RefCounted
# @pkey-feature update.bootguard
# The boot guard over launches of one portable install (a fresh SDK per launch, configured with
# the version of the pack that runs):
#
#   - two failed boots roll back to previous, record the skipped version, restart, and the next
#     launch reports `rolled-back`; the next decision never offers the skipped version as code;
#   - a confirmed boot resets the counter: BOOT_OK_SECONDS at `ready`, confirm_boot(), a
#     `waiting` outcome; `error` and `running` never confirm;
#   - staged code is dropped on a channel switch (the decision's discardStaged, the dev menu), an
#     engine change, and a binary at least as new; a replaced install forgets its slots;
#   - stage-matrix.json: every guardCase's (staged, failedBoots) reaches the host's guard and
#     takes the expected action, and every confirmCase's outcome confirms (or not) as expected.

const S := preload("res://tests/updater/support.gd")
const MATRIX := "res://tests/corpus/v2/stage-matrix.json"


func run(t: PKeyTestContext) -> void:
	await _rollback(t)
	await _confirm(t)
	await _drops(t)
	await _matrix(t)


## Stage and apply 1.5.0 over a shipped 1.4.0 pack: {inst, old, fresh}.
func _updated(sup: PKeyUpdaterTestSupport, tag: String) -> Dictionary:
	var old := S.bytes(4000, 11)
	var fresh := S.bytes(6000, 12)
	var inst := S.install(tag, old)
	var sdk: Node = await sup.launch(inst, "1.4.0")
	sup.discovered(sdk)
	sup.plan = {"/djdl/distribution/builds/": [S.ranged(fresh)]}
	await sdk.update.updater.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	await sdk.update.restart_to_update()
	sdk.queue_free()
	return {"inst": inst, "old": old, "fresh": fresh}


func _rollback(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var u0 := await _updated(sup, "guard-rollback")
	var inst: Dictionary = u0["inst"]
	var e: PKeyFakeUpdaterEnv = inst["env"]
	var restarts: int = e.restarts
	# Launch 1 on the new pack: reports applied and counts.
	var l1: Node = await sup.launch(inst, "1.5.0")
	var g: Dictionary = await l1.update.run_guard()
	t.check("guard: the first launch on the new pack reports applied and counts it (failedBoots 1)", g["result"] == "applied" and not g["restart"] and float(l1.update.updater.slots.load_state()["failedBoots"]) == 1.0, str(g))
	t.check("guard: while the code pack runs, the decision's binaryVersion is the binary's", l1.update.updater.binary_version() == "1.4.0")
	l1.queue_free()   # crashed: never confirmed
	var l2: Node = await sup.launch(inst, "1.5.0")
	g = await l2.update.run_guard()
	t.check("guard: a second unconfirmed launch counts again (failedBoots 2), no rollback yet", g["result"] == "ok" and g["action"] == "none" and float(l2.update.updater.slots.load_state()["failedBoots"]) == 2.0, str(g))
	l2.queue_free()   # crashed again
	var l3: Node = await sup.launch(inst, "1.5.0")
	g = await l3.update.run_guard()
	var st: Dictionary = l3.update.updater.slots.load_state()
	t.check("guard: two failed boots roll back on the third launch and restart before guard.done", g["action"] == "roll-back" and g["restart"] == true and e.restarts == restarts + 1 and S.read(inst["pck"]) == u0["old"], str(g))
	t.check("guard: the rolled-back version is recorded as skipVersion, the counter reset", st["skipVersion"] == "1.5.0" and float(st["failedBoots"]) == 0.0 and l3.update.updater.slots.meta("current") == null and l3.update.updater.slots.meta("previous") == null, str(st))
	t.check("guard: boot_rolled_back is recorded locally (P6-03 allowlists it later)", st["events"].map(func(x): return x["event"]).has("boot_rolled_back"))
	l3.queue_free()
	var l4: Node = await sup.launch(inst, "1.4.0")
	g = await l4.update.run_guard()
	t.check("guard: the launch after a rollback reports rolled-back once, counting nothing (the shipped pack runs)", g["result"] == "rolled-back" and not g["restart"] and float(l4.update.updater.slots.load_state()["failedBoots"]) == 0.0, str(g))
	t.check("guard: the skipped version is a decision input", l4.update.updater.skip_version() == "1.5.0")
	t.check("guard: with the shipped pack back, binaryVersion is the running version again", l4.update.updater.binary_version() == "")
	# The next decision does not offer it: the corpus's 1.5.0 win-pck code pack (sidecar-pck
	# without a skip) is never staged again; the decision falls to the binary download.
	await _skip_decides(t, sup, l4)
	l4.queue_free()
	var l5: Node = await sup.launch(inst, "1.4.0")
	g = await l5.update.run_guard()
	t.check("guard: rolled-back is reported only once", g["result"] == "ok", str(g))
	l5.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


## decide() with the corpus's signed feed and record on a Windows direct 1.4.0 build (engine
## godot-4.7): the code pack is offered as sidecar-pck, except once 1.5.0 is the skipped version.
func _skip_decides(t: PKeyTestContext, sup: PKeyUpdaterTestSupport, sdk: Node) -> void:
	var corpus = PKeyTestFixtures.read_json(PKeyTestFixtures.CASES)
	var feed := ""
	var record := ""
	var trust := {}
	var keys := {}
	for c in corpus["feedCases"]:
		if c["id"] == "feed-valid":
			feed = c["jws"]
			trust = c["trust"]
	for c in corpus["releaseRecordCases"]:
		if c["id"] == "record-valid-app":
			record = c["jws"]
			keys = c["releaseKeys"]
	var base := sup.server.base_url() + "/djdl"
	sup.plan = {
		"/djdl/.well-known/polaris.json": [{"status": 200, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify({"product": "djdl", "services": {
			"update": {"enabled": true, "endpoints": {"feed": base + "/update/{channel}/feed.jws"}},
			"release": {"enabled": true, "endpoints": {"record": base + "/release/records/{sha256}"}},
			"distribution": {"enabled": true, "endpoints": {"builds": base + "/distribution/builds/{selector}/{buildId}"}},
		}})}],
		"/djdl/update/": [{"status": 200, "headers": {"Content-Type": "application/jose"}, "body": feed}],
		"/djdl/release/records/": [{"status": 200, "headers": {"Content-Type": "application/jose"}, "body": record}],
		"/djdl/distribution/builds/": [{"hang": true}],
	}
	var inst := S.install("guard-skip", S.bytes(100, 1), "windows", "Game.exe")
	var tweak := func(o: PKeyOptions) -> void:
		o.pinned_trust_keys = trust
		o.pinned_release_keys = keys
		o.build_stamp_path = "res://tests/fixtures/build_stamp_windows.json"
		o.expected_services = PackedStringArray(["update", "release", "distribution"])
	var a: Node = await sup.launch(inst, "1.4.0", tweak)
	a.update.auto_stage = false
	var r: PKeyUpdateCheck = await a.update.decide()
	t.check("guard: without a skip, the Windows 1.4.0 build is offered the 1.5.0 code pack (sidecar-pck)", r.ok and r.decision.get("action") == "binary" and r.decision.get("method") == "sidecar-pck" and r.decision.get("build") == "win-pck", str(r))
	var st: Dictionary = a.update.updater.slots.load_state()
	st["skipVersion"] = "1.5.0"
	a.update.updater.slots.save_state(st)
	r = await a.update.decide()
	t.check("guard: with 1.5.0 skipped, decide() passes skip_version and the code pack is not offered (a binary download instead)", r.ok and r.decision.get("action") == "binary" and r.decision.get("method") == "download", str(r))
	a.queue_free()
	PKeyTestFixtures.remove_tree(inst["dir"])


func _confirm(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var u0 := await _updated(sup, "guard-confirm")
	var inst: Dictionary = u0["inst"]
	var l1: Node = await sup.launch(inst, "1.5.0")
	await l1.update.run_guard()
	var u: PKeyUpdater = l1.update.updater
	l1.update.note_boot_outcome("running")
	t.check("guard: running never confirms", float(u.slots.load_state()["failedBoots"]) == 1.0 and not u.is_confirmed())
	# A reference timer for the full BOOT_OK_SECONDS, created in the same frame as the guard's
	# (same flags, so both count the same frame deltas) and before it: it always fires first (an
	# earlier frame, or earlier in the same frame's timer list), even under load. Wall-clock bounds are not asserted (a loaded
	# machine credits a timer with its creation frame's time); the order is.
	var tree := Engine.get_main_loop() as SceneTree
	var full := tree.create_timer(u.boot_ok_seconds, true, false, true)
	var started := Time.get_ticks_msec()
	l1.update.note_boot_outcome("ready")
	t.check("guard: ready does not confirm at once", float(u.slots.load_state()["failedBoots"]) == 1.0 and not u.is_confirmed())
	await full.timeout
	t.check("guard: ready has not confirmed before BOOT_OK_SECONDS", float(u.slots.load_state()["failedBoots"]) == 1.0 and not u.is_confirmed())
	await u.boot_confirmed
	var st := u.slots.load_state()
	t.check("guard: ready confirms after BOOT_OK_SECONDS (shortened to %.1f s here) and resets the counter" % u.boot_ok_seconds, float(st["failedBoots"]) == 0.0 and u.is_confirmed() and Time.get_ticks_msec() - started < 60000, str(st))
	t.check("guard: update_confirmed is recorded once for the version", st["events"].filter(func(x): return x["event"] == "update_confirmed").size() == 1 and st["confirmedVersion"] == "1.5.0")
	l1.queue_free()
	var l2: Node = await sup.launch(inst, "1.5.0")
	await l2.update.run_guard()
	u = l2.update.updater
	u.note_outcome("error")
	var refused := not u.confirm_boot()
	t.check("guard: confirm_boot() is refused while the boot outcome is error", refused and float(u.slots.load_state()["failedBoots"]) == 1.0)
	u.note_outcome("ready")
	t.check("guard: confirm_boot() at ready confirms at once", l2.update.confirm_boot() and float(u.slots.load_state()["failedBoots"]) == 0.0)
	l2.queue_free()
	var l3: Node = await sup.launch(inst, "1.5.0")
	await l3.update.run_guard()
	l3.update.note_boot_outcome("waiting")
	t.check("guard: a waiting outcome (the gate waits for the player) confirms at once", float(l3.update.updater.slots.load_state()["failedBoots"]) == 0.0)
	l3.queue_free()
	var l4: Node = await sup.launch(inst, "1.5.0")
	await l4.update.run_guard()
	l4.update.note_boot_outcome("ready")
	l4.update.note_boot_outcome("error")
	await PKeyTestFixtures.frames(2)
	await (Engine.get_main_loop() as SceneTree).create_timer(l4.update.updater.boot_ok_seconds + 0.1).timeout
	t.check("guard: leaving ready before BOOT_OK_SECONDS (an error) does not confirm", float(l4.update.updater.slots.load_state()["failedBoots"]) == 1.0)
	l4.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


func _drops(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var fresh := S.bytes(3000, 5)
	var inst := S.install("guard-drops", S.bytes(2000, 4))
	var sdk: Node = await sup.launch(inst, "1.4.0")
	sup.discovered(sdk)
	sup.plan = {"/djdl/distribution/builds/": [S.ranged(fresh)]}
	var u: PKeyUpdater = sdk.update.updater
	# A channel switch from the dev menu drops staged code.
	await u.stage_sidecar(S.sidecar_check("1.5.0", fresh, "beta"))
	var menu := PKeyDevMenuSection.new()
	menu.auto_sdk = false
	menu.sdk = sdk
	menu.facts_override = {"device": "d", "outlet": "direct", "outlet_kind": "direct", "channel": "beta", "version": "1.4.0", "build": "0", "sdk": "0.1.0", "engine": "4.7.2", "platform": "linux", "gate": "ok", "last_sync": null}
	menu.entitled_override = ["beta"]
	(Engine.get_main_loop() as SceneTree).root.add_child(menu)
	var picked: Array = []
	menu.channel_selected.connect(func(c): picked.append(c))
	menu.select_channel("stable")
	t.check("guard: picking another channel in the dev menu drops the staged pack", picked == ["stable"] and u.slots.meta("staged") == null and u.staged_input() == null)
	menu.queue_free()
	# The same: a decision that discards it (staged on beta, the feed is stable).
	await u.stage_sidecar(S.sidecar_check("1.5.0", fresh, "beta"))
	t.check("guard: a staged pack is a decision input with its channel", u.staged_input() == {"version": "1.5.0", "channel": "beta"})
	t.check("guard: drop_staged() drops it", sdk.update.drop_staged() and u.slots.meta("staged") == null)
	# An engine change.
	await u.stage_sidecar(S.sidecar_check("1.5.0", fresh, "stable", "godot-3.9"))
	t.check("guard: a pack staged for another engine is staged (the record says so)", u.slots.meta("staged") is Dictionary)
	var g: Dictionary = await sdk.update.run_guard()
	t.check("guard: the guard drops staged code for another engine (no swap)", g["action"] == "none" and u.slots.meta("staged") == null and not g["restart"], str(g))
	# A binary at least as new: the staged 1.5.0 under a 1.5.0 (or newer) binary.
	await u.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	sdk.queue_free()
	var newer: Node = await sup.launch(inst, "1.5.0")
	g = await newer.update.run_guard()
	t.check("guard: staged code not newer than the binary is dropped (A4 P10)", g["action"] == "none" and newer.update.updater.slots.meta("staged") == null and not g["restart"], str(g))
	newer.queue_free()
	# A replaced install (the pack beside the executable is not the applied one) forgets its slots.
	var u0 := await _updated(sup, "guard-replaced")
	var rinst: Dictionary = u0["inst"]
	S.write(rinst["pck"], S.bytes(7777, 9))
	var l: Node = await sup.launch(rinst, "1.6.0")
	g = await l.update.run_guard()
	var st: Dictionary = l.update.updater.slots.load_state()
	t.check("guard: an install replaced from outside forgets current and previous and counts nothing", g["result"] == "ok" and l.update.updater.slots.meta("current") == null and l.update.updater.slots.meta("previous") == null and float(st["failedBoots"]) == 0.0 and st["binaryVersion"] == "1.6.0", str(st))
	l.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])
	PKeyTestFixtures.remove_tree(rinst["dir"])


## stage-matrix.json's guardCases through the host's own slots: (staged, failedBoots) as the slot
## state, then PKeyBootGuard's action; confirmCases through note_outcome.
func _matrix(t: PKeyTestContext) -> void:
	var m = PKeyTestFixtures.read_json(MATRIX)
	if not t.check("guard: stage-matrix.json is present (version 2)", m is Dictionary and m.get("guardCases") is Array and m.get("confirmCases") is Array):
		return
	t.check("guard: MAX_FAILED_BOOTS and BOOT_OK_SECONDS are the matrix's", float(m["maxFailedBoots"]) == PKeyStages.MAX_FAILED_BOOTS and float(m["bootOkSeconds"]) == PKeyStages.BOOT_OK_SECONDS)
	var sup := S.new()
	sup.serve()
	var done := 0
	for c in m["guardCases"]:
		var u0 := await _updated(sup, "guard-case")
		var inst: Dictionary = u0["inst"]
		var l: Node = await sup.launch(inst, "1.5.0")
		var u: PKeyUpdater = l.update.updater
		var st := u.slots.load_state()
		st["notice"] = ""
		st["failedBoots"] = c["input"]["failedBoots"]
		u.slots.save_state(st)
		if c["input"]["staged"] == true:
			var next := S.bytes(5000, 21)
			sup.plan = {"/djdl/distribution/builds/": [S.ranged(next)]}
			sup.discovered(l)
			await u.stage_sidecar(S.sidecar_check("1.6.0", next))
		var g: Dictionary = await l.update.run_guard()
		var want: String = c["expect"]["action"]
		var effect := true
		match want:
			"roll-back":
				effect = g["restart"] and S.read(inst["pck"]) == u0["old"]
			"apply-staged":
				effect = g["restart"] and u.slots.meta("current")["version"] == "1.6.0"
			"none":
				effect = not g["restart"] and float(u.slots.load_state()["failedBoots"]) == float(c["input"]["failedBoots"]) + 1
		if t.check("guard: guardCase %s" % c["name"], g["action"] == want and effect, str(g)):
			done += 1
		l.queue_free()
		PKeyTestFixtures.remove_tree(inst["dir"])
	t.check("guard: every guardCase ran", done == m["guardCases"].size(), "%d/%d" % [done, m["guardCases"].size()])
	# confirmCases: `now` confirms at once, `after-ok-seconds` only after the wait, `never` not.
	var u1 := await _updated(sup, "confirm-case")
	var cinst: Dictionary = u1["inst"]
	var confirmed := 0
	for c in m["confirmCases"]:
		var l: Node = await sup.launch(cinst, "1.5.0")
		var u: PKeyUpdater = l.update.updater
		var st := u.slots.load_state()
		st["failedBoots"] = 1
		st["notice"] = ""
		u.slots.save_state(st)
		u.note_outcome(c["outcome"])
		var at_once := float(u.slots.load_state()["failedBoots"]) == 0.0
		await (Engine.get_main_loop() as SceneTree).create_timer(u.boot_ok_seconds + 0.1).timeout
		var later := float(u.slots.load_state()["failedBoots"]) == 0.0
		var got := "now" if at_once else ("after-ok-seconds" if later else "never")
		if t.check("guard: confirmCase %s -> %s" % [c["outcome"], c["expect"]], got == c["expect"] and PKeyStages.boot_confirmation(c["outcome"]) == c["expect"], got):
			confirmed += 1
		l.queue_free()
	t.check("guard: every confirmCase ran", confirmed == m["confirmCases"].size())
	sup.free_server()
	PKeyTestFixtures.remove_tree(cinst["dir"])
