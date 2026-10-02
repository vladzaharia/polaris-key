extends RefCounted
# @pkey-feature packs.state ui.stages
# PKeyBoot's pack stages (P4-08; plans/P4-01.md §2.10, stage matrix v3) with the real PKeyBootHost
# fetch and mount over PolarisKey.update.packs (a fake transport underneath; the stages before
# FETCH answer at once):
#
#   a missing required pack: FETCH (the consent card discloses the size) → MOUNT → READY, the pack
#   signals in order (pack_progress, set_changed, pack_ready); a `godot.pck` one is mounted in
#   MOUNT (4.7: its pack_ready comes after `mount`); offline with the required set present →
#   READY; required missing and unreachable → OFFLINE; declined → BLOCKED {content-declined};
#   an essential pack missing offline → OFFLINE with "Play offline" → MOUNT → READY; BACKGROUND
#   installs the prefetch packs after READY behind the corner pill.

const S := preload("res://tests/packs/support.gd")
const F := preload("res://tests/packs/fixtures.gd")


## PKeyBootHost with the pre-FETCH stages answered at once (`sync_result` for SYNC).
class Host extends PKeyBootHost:
	var sync_result := "ok"

	func shell(_opts: Dictionary) -> Dictionary:
		return {"type": "shell.done"}

	func guard() -> Variant:
		return {"type": "guard.done", "result": "ok"}

	func sync(_force := false) -> Dictionary:
		return {"type": "sync.done", "result": sync_result}

	func gate_status() -> Dictionary:
		return {"type": "gate.status", "status": "ok"}

	func decide() -> Dictionary:
		return {"type": "decide.done", "decision": "none"}


var _keep: Array = []


## A configured SDK whose packs read `content` and fetch through `tr`, under a fresh root.
func _sdk(tag: String, content: Dictionary, tr: PKeyPackTransport) -> Node:
	var root := S.scratch("boot-" + tag)
	var stamp_file := root.path_join("pkey-content.json")
	S.write_file(stamp_file, F.stamp_text(content).to_utf8_buffer())
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
	packs.transport = tr
	_keep.append(root)
	return sdk


func _boot(sdk: Node, _host: Host, _opts: Dictionary, log: Array) -> PKeyBoot:
	var b := PKeyBoot.new()
	b.sdk = sdk
	(Engine.get_main_loop() as SceneTree).root.add_child(b)
	b.stage_changed.connect(func(s, _p): log.append("stage:" + s))
	b.consent_needed.connect(func(bytes, metered): log.append("consent:%d:%s" % [bytes, metered]))
	var packs: PKeyPacks = sdk.update.packs
	packs.pack_progress.connect(func(id, _d, _n): if log.is_empty() or log[-1] != "pack_progress:" + id: log.append("pack_progress:" + id))
	packs.set_changed.connect(func(a): log.append("set_changed:" + a))
	packs.pack_ready.connect(func(id): log.append("pack_ready:" + id))
	packs.pack_failed.connect(func(id, err): log.append("pack_failed:%s:%s" % [id, err]))
	return b


func _stages(log: Array) -> Array:
	return log.filter(func(x): return String(x).begins_with("stage:")).map(func(x): return String(x).substr(6))


func _without_progress(log: Array) -> Array:
	return log.filter(func(x): return not String(x).begins_with("stage:"))


func run(t: PKeyTestContext) -> void:
	var big := PackedByteArray()
	big.resize(60000)
	for k in big.size():
		big[k] = (k * 29 + 3) % 239
	var req := F.tree_pack("djdl.core", "1.0.0", 1, {"core.bin": big})
	var ess := F.tree_pack("djdl.music", "1.0.0", 1, {"m.bin": big.slice(0, 20000)})
	var pre := F.tree_pack("djdl.hd", "1.0.0", 1, {"hd.bin": big.slice(0, 30000)})

	# 1. A missing required pack, consent always: FETCH (size disclosed) → MOUNT → READY.
	var tr := F.FakeTransport.new().add(req)
	var sdk := await _sdk("required", F.stamp_for([req]), tr)
	var log: Array = []
	var host := Host.new(sdk)
	var b := _boot(sdk, host, {}, log)
	var est: Dictionary = await sdk.update.packs.estimate(["djdl.core"])
	b.consent_needed.connect(func(_bytes, _m): b.answer_consent.call_deferred(true))
	var r: PKeyBootResult = await b.run({"host": host, "consent": "always", "sync_timeout_seconds": 60})
	t.check("boot: a missing required pack ends READY", r.outcome == PKeyBoot.READY, str(r))
	S.check_same(t, "boot: …through FETCH and MOUNT", _stages(log), ["shell", "guard", "sync", "gate", "decide", "fetch", "mount", "ready"])
	t.check("boot: the consent card disclosed the download size first", log.has("consent:%d:false" % int(est["bytes"])) and int(est["bytes"]) > 0 and log.find("consent:%d:false" % int(est["bytes"])) < log.find("pack_progress:djdl.core"), S.canon(log))
	S.check_same(t, "boot: the pack signals fire in order", _without_progress(log).filter(func(x): return not String(x).begins_with("consent")), ["pack_progress:djdl.core", "set_changed:hot", "pack_ready:djdl.core"])
	b.queue_free()
	sdk.queue_free()

	# 2. Offline with the required set present: READY.
	var tr2 := F.FakeTransport.new().add(req)
	var sdk2 := await _sdk("offline-present", F.stamp_for([req]), tr2)
	await sdk2.update.packs.ensure(["djdl.core"])
	tr2.records.clear()
	tr2.objects.clear()
	var host2 := Host.new(sdk2)
	host2.sync_result = "offline"
	var log2: Array = []
	var b2 := _boot(sdk2, host2, {}, log2)
	r = await b2.run({"host": host2, "sync_timeout_seconds": 60})
	t.check("boot: offline with the required set present ends READY", r.outcome == PKeyBoot.READY and _stages(log2).has("fetch") and _stages(log2).has("mount"), "%s %s" % [r, S.canon(log2)])
	b2.queue_free()
	sdk2.queue_free()

	# 3. Required missing and the bytes unreachable: OFFLINE, nothing to play.
	var tr3 := F.FakeTransport.new()
	var sdk3 := await _sdk("offline-missing", F.stamp_for([req]), tr3)
	var host3 := Host.new(sdk3)
	host3.sync_result = "offline"
	var b3 := _boot(sdk3, host3, {}, [])
	r = await b3.run({"host": host3, "sync_timeout_seconds": 60})
	t.check("boot: a required pack missing and unreachable stops OFFLINE without Play offline", r.outcome == PKeyBoot.OFFLINE and not r.can_play_offline, str(r))
	b3.queue_free()
	sdk3.queue_free()

	# 4. The player declines: BLOCKED {content-declined}, never ERROR.
	var tr4 := F.FakeTransport.new().add(req)
	var sdk4 := await _sdk("declined", F.stamp_for([req]), tr4)
	var host4 := Host.new(sdk4)
	var b4 := _boot(sdk4, host4, {}, [])
	b4.consent_needed.connect(func(_bytes, _m): b4.answer_consent.call_deferred(false))
	r = await b4.run({"host": host4, "consent": "always", "sync_timeout_seconds": 60})
	# (A tree's index is preflighted before the question, as client-core does; its payload is not.)
	t.check("boot: a declined required download stops BLOCKED {content-declined}, fetching no payload", r.outcome == PKeyBoot.BLOCKED and r.reason == "content-declined" and tr4.calls.all(func(c): return c["sha256"] == req["indexSha256"]), "%s %s" % [r, S.canon(tr4.calls)])
	b4.queue_free()
	sdk4.queue_free()

	# 5. Required present, essential missing, offline: Play offline → MOUNT → READY.
	var tr5 := F.FakeTransport.new().add(req)
	var content5 := F.stamp_for([req, ess], [{"pack": "djdl.core", "required": true, "delivery": "essential"}, {"pack": "djdl.music", "required": false, "delivery": "essential"}])
	var sdk5 := await _sdk("essential", content5, tr5)
	await sdk5.update.packs.ensure(["djdl.core"])
	var host5 := Host.new(sdk5)
	host5.sync_result = "offline"
	var log5: Array = []
	var b5 := _boot(sdk5, host5, {}, log5)
	r = await b5.run({"host": host5, "sync_timeout_seconds": 60})
	t.check("boot: an essential pack missing offline stops OFFLINE with Play offline", r.outcome == PKeyBoot.OFFLINE and r.can_play_offline, str(r))
	var finished: Array = []
	b5.boot_finished.connect(func(x): finished.append(x))
	b5.play_offline()
	for k in 30:
		if not finished.is_empty():
			break
		await (Engine.get_main_loop() as SceneTree).process_frame
	t.check("boot: Play offline mounts what is present and ends READY", not finished.is_empty() and finished[0].outcome == PKeyBoot.READY and _stages(log5).slice(-2) == ["mount", "ready"], "%s %s" % [S.canon(finished.map(func(x): return str(x))), S.canon(_stages(log5))])
	b5.queue_free()
	sdk5.queue_free()

	# 6. BACKGROUND: the prefetch pack installs after READY behind the corner pill.
	var tr6 := F.FakeTransport.new().add(req).add(pre)
	var content6 := F.stamp_for([req, pre], [{"pack": "djdl.core", "required": true, "delivery": "essential"}, {"pack": "djdl.hd", "required": false, "delivery": "prefetch"}])
	var sdk6 := await _sdk("background", content6, tr6)
	var host6 := Host.new(sdk6)
	var log6: Array = []
	var b6 := _boot(sdk6, host6, {}, log6)
	var pill_seen := [false]
	b6.stage_changed.connect(func(s, _p):
		if s == "background":
			pill_seen[0] = true)
	r = await b6.run({"host": host6, "consent": "never", "sync_timeout_seconds": 60})
	for k in 60:
		if sdk6.update.packs.state().get("running", {}).has("djdl.hd") and b6.state["stage"] == "ready" and not b6._background_running:
			break
		await (Engine.get_main_loop() as SceneTree).process_frame
	t.check("boot: READY first, then BACKGROUND installs the prefetch pack and returns to ready", r.outcome == PKeyBoot.READY and pill_seen[0] and sdk6.update.packs.state()["running"].has("djdl.hd") and b6.state["stage"] == "ready" and _stages(log6).slice(-3) == ["ready", "background", "ready"], S.canon(_stages(log6)))
	b6.queue_free()
	sdk6.queue_free()

	await _godot_pck(t)
	for root in _keep:
		S.remove_tree(root)


## 4.7: a missing required `godot.pck` is fetched in FETCH and mounted in MOUNT, from its store
## path, after the first frame; its pack_ready comes with the mount.
func _godot_pck(t: PKeyTestContext) -> void:
	if int(Engine.get_version_info()["minor"]) != 7:
		t.info("boot: the godot.pck boot runs on 4.7 (the kaykit packs are PCK v4 from 4.7.2)")
		return
	var v1 := F.kaykit_pack("v1", 1)
	var tr := F.FakeTransport.new().add(v1)
	var sdk := await _sdk("pck", F.stamp_for([v1]), tr)
	var host := Host.new(sdk)
	var log: Array = []
	var b := _boot(sdk, host, {}, log)
	var r: PKeyBootResult = await b.run({"host": host, "consent": "never", "sync_timeout_seconds": 60})
	var packs: PKeyPacks = sdk.update.packs
	t.check("boot: a missing required godot.pck ends READY, mounted from store/<sha256>.pck", r.outcome == PKeyBoot.READY and packs.mounted.has("diceroll.core3d") and String(packs.mounted["diceroll.core3d"]["location"]).ends_with("/store/%s.pck" % v1["payloadSha256"]), "%s %s" % [r, S.canon(log)])
	var at_mount := log.find("stage:mount")
	t.check("boot: …set_changed(restart) in FETCH, pack_ready in MOUNT", log.find("set_changed:restart") > log.find("stage:fetch") and log.find("set_changed:restart") < at_mount and log.find("pack_ready:diceroll.core3d") > at_mount, S.canon(log))
	t.check("boot: the mounted pack's files read through res://", FileAccess.file_exists("res://assets/kaykit/data/level_000.json"))
	b.queue_free()
	sdk.queue_free()
