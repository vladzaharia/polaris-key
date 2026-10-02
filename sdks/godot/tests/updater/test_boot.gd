extends RefCounted
# @pkey-feature update.driver update.bootguard ui.stages
# PKeyBoot with the real PKeyBootHost and an active updater:
#
#   - GUARD applies a staged pack: the pack is swapped, the game restarts, and no guard.done is
#     sent (the machine stays in guard; the next launch starts a new machine, P1-09 §2.3);
#   - GUARD rolls back after two failed boots the same way;
#   - the launch after a rollback sends guard.done rolled-back: boot_rolled_back fires and the boot
#     goes on; the waiting gate confirms the launch (the counter is back to 0);
#   - DECIDE on a macOS direct build with `native` declared but no Sparkle plugin: the decision
#     gets `download` (native narrowed away), the boot reaches READY, and the prompt's action opens
#     the build's download link from discovery;
#   - the dev menu's channel lock follows the decision's outlet and the feed's narrowing.

const S := preload("res://tests/updater/support.gd")


func _view(sdk: Node) -> PKeyBoot:
	var view := PKeyBoot.new()
	view.auto_sdk = false
	view.sdk = sdk
	(Engine.get_main_loop() as SceneTree).root.add_child(view)
	return view


func _until(cond: Callable, frames := 600) -> bool:
	for i in frames:
		if cond.call():
			return true
		await PKeyTestFixtures.frames(1)
	return cond.call()


func run(t: PKeyTestContext) -> void:
	await _guard_restarts(t)
	await _rolled_back(t)
	await _decide(t)
	_dev_lock(t)


func _guard_restarts(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var old := S.bytes(3000, 31)
	var fresh := S.bytes(4000, 32)
	var inst := S.install("boot-apply", old)
	var sdk: Node = await sup.launch(inst, "1.4.0")
	sup.discovered(sdk)
	sup.plan = {"/djdl/distribution/builds/": [S.ranged(fresh)]}
	await sdk.update.updater.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	var e: PKeyFakeUpdaterEnv = inst["env"]
	var view := _view(sdk)
	view.run({"sync_timeout_seconds": 1000})
	var restarted := await _until(func(): return e.restarts == 1)
	await PKeyTestFixtures.frames(5)
	t.check("boot: GUARD applies the staged pack and restarts", restarted and S.read(inst["pck"]) == fresh, "restarts=%d" % e.restarts)
	t.check("boot: no guard.done is sent before the restart (the machine stays in guard)", view.state["stage"] == "guard" and view.stages == ["shell", "guard"], str(view.stages))
	view.queue_free()
	sdk.queue_free()
	# Two failed boots on 1.5.0, then a launch through PKeyBoot rolls back the same way.
	for i in 2:
		var l: Node = await sup.launch(inst, "1.5.0")
		await l.update.run_guard()
		l.queue_free()
	var l3: Node = await sup.launch(inst, "1.5.0")
	var v3 := _view(l3)
	v3.run({"sync_timeout_seconds": 1000})
	var rolled := await _until(func(): return e.restarts == 2)
	await PKeyTestFixtures.frames(5)
	t.check("boot: GUARD rolls back after two failed boots, restarts, and sends nothing", rolled and S.read(inst["pck"]) == old and v3.stages == ["shell", "guard"], "%s restarts=%d" % [v3.stages, e.restarts])
	v3.queue_free()
	l3.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


func _rolled_back(t: PKeyTestContext) -> void:
	var sup := S.new()
	sup.serve()
	var old := S.bytes(3000, 41)
	var fresh := S.bytes(4000, 42)
	var inst := S.install("boot-rolled", old)
	var sdk: Node = await sup.launch(inst, "1.4.0")
	sup.discovered(sdk)
	sup.plan = {"/djdl/distribution/builds/": [S.ranged(fresh)]}
	await sdk.update.updater.stage_sidecar(S.sidecar_check("1.5.0", fresh))
	await sdk.update.restart_to_update()
	sdk.queue_free()
	# The launch on 1.5.0 is told a rollback happened (as the launch after a rollback to an
	# earlier update would be).
	var l: Node = await sup.launch(inst, "1.5.0", func(o): o.local_only = true)
	var st: Dictionary = l.update.updater.slots.load_state()
	st["notice"] = "rolled-back"
	l.update.updater.slots.save_state(st)
	var view := _view(l)
	var fired := [0]
	view.boot_rolled_back.connect(func(): fired[0] += 1)
	view.run({"sync_timeout_seconds": 1000})
	var waited := await _until(func(): return view.state["outcome"] == PKeyBoot.WAITING)
	var counted: float = float(l.update.updater.slots.load_state()["failedBoots"])
	t.check("boot: guard.done rolled-back emits boot_rolled_back and the boot goes on to the gate", waited and fired[0] == 1 and view.rolled_back and view.stages.slice(0, 4) == ["shell", "guard", "sync", "gate"], "%s fired=%d" % [view.stages, fired[0]])
	t.check("boot: the waiting gate confirms the launch (failedBoots back to 0)", counted == 0.0 and l.update.updater.is_confirmed(), str(counted))
	view.queue_free()
	l.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


func _decide(t: PKeyTestContext) -> void:
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
	var sup := S.new()
	sup.serve()
	var base := sup.server.base_url() + "/djdl"
	sup.plan = {
		"/djdl/.well-known/polaris.json": [{"status": 200, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify({"product": "djdl", "services": {
			"update": {"enabled": true, "endpoints": {"feed": base + "/update/{channel}/feed.jws"}},
			"release": {"enabled": true, "endpoints": {"record": base + "/release/records/{sha256}"}},
			"distribution": {"enabled": true, "endpoints": {"builds": S.DL + "/djdl/distribution/builds/{selector}/{buildId}"}},
		}})}],
		"/djdl/update/": [{"status": 200, "headers": {"Content-Type": "application/jose"}, "body": feed}],
		"/djdl/release/records/": [{"status": 200, "headers": {"Content-Type": "application/jose"}, "body": record}],
	}
	var inst := S.install("boot-decide", S.bytes(100, 1), "macos", "Game")
	var sdk: Node = await sup.launch(inst, "1.4.0", func(o: PKeyOptions) -> void:
		o.pinned_trust_keys = trust
		o.pinned_release_keys = keys
		o.build_stamp_path = "res://tests/fixtures/build_stamp_update.json"
		o.expected_services = PackedStringArray(["update", "release", "distribution"])
		o.update_methods = PackedStringArray(["native", "download"]))
	var e: PKeyFakeUpdaterEnv = inst["env"]
	t.check("boot: native is declared, but with no Sparkle plugin only download reaches the decision", sdk.update.updater.methods() == ["download"], str(sdk.update.updater.methods()))
	var view := _view(sdk)
	var r: PKeyBootResult = await view.run({"sync_timeout_seconds": 1000})
	var d: Dictionary = r.update.decision if r.update is PKeyUpdateCheck else {}
	t.check("boot: the boot reaches READY with the binary offer (download), never blocked by it", r.outcome == PKeyBoot.READY and d.get("action") == "binary" and d.get("method") == "download", "%s %s" % [r, d])
	var want := S.DL + "/djdl/distribution/builds/1.5.0/macos-dmg"
	t.check("boot: the prompt offers the build's download link from discovery", view.prompt.model.get("behaviour") == "link" and view.prompt.model.get("action_url") == want and view.prompt.model.get("action") == "update_action", str(view.prompt.model))
	view.prompt._on_action()
	await PKeyTestFixtures.frames(3)
	t.check("boot: the prompt's action opens it through the adapter", e.opened == [want], str(e.opened))
	view.queue_free()
	sdk.queue_free()
	sup.free_server()
	PKeyTestFixtures.remove_tree(inst["dir"])


func _dev_lock(t: PKeyTestContext) -> void:
	t.check("boot: the dev menu locks a Steam build's channel (locked by steam)", PKeyDevMenuController.channel_lock("steam", "windows") == "steam")
	t.check("boot: a direct build may switch", PKeyDevMenuController.channel_lock("direct", "linux") == "")
	t.check("boot: a feed entry that narrows channelSwitch locks a direct build", PKeyDevMenuController.channel_lock("direct", "linux", null, {"channelSwitch": false}) == "direct")
	t.check("boot: iOS narrows direct's updates, not its channel switch", PKeyDevMenuController.channel_lock("direct", "ios") == "")
	var menu := PKeyDevMenuSection.new()
	menu.auto_sdk = false
	menu.facts_override = {"device": "d", "outlet": "itch-beta", "outlet_kind": "itch", "channel": "beta", "version": "1.0.0", "build": "1", "sdk": "0.1.0", "engine": "4.7.2", "platform": "linux", "gate": "ok", "last_sync": null}
	menu.entitled_override = []
	(Engine.get_main_loop() as SceneTree).root.add_child(menu)
	var picked: Array = []
	menu.channel_selected.connect(func(c): picked.append(c))
	menu.select_channel("stable")
	var row: Dictionary = menu.rows()[0]
	t.check("boot: a custom itch outlet is locked by its id, and a locked picker switches nothing", row["locked"].contains("itch-beta") and picked.is_empty(), row["locked"])
	menu.queue_free()
