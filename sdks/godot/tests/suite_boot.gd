extends RefCounted
# @pkey-feature ui.stages
# PKeyBoot and PolarisKey.boot() (P1-10). Two halves:
#
#   rows    every stage-matrix.json row through PolarisKey.boot({view, host}) with a scripted host
#           (PKeyFakeBootHost): each step's event is the pending stage work's answer when it is one
#           (shell.done, guard.done, sync.done, gate.status, decide.done, fetch.done, mount.done,
#           fail), a gate re-check after the host's `changed` when the gate waits, and otherwise
#           sent to PKeyBoot directly (a Retry, a late timeout, background work, an ignored
#           event). Checked per row: the signals of each step equal the step's emits, the
#           stage_changed sequence equals expect.stages, the final stage and outcome, PKeyBoot did
#           a stage's work exactly once per entry, and boot() resolves with the first stop while
#           the last boot_finished carries the row's outcome (no result for running or waiting).
#   dropin  PolarisKey.boot() without a view (its own CanvasLayer): a mandatory or blocked update
#           answer outlives the boot view at READY as a top-wide prompt with no dismiss that is
#           not full-screen, keep_update_prompt false drops it, a dismissable one goes on
#           dismiss, and a PKeyUpdatePrompt the game adds later replays update.last_available.
#   server  PKeyBootHost against PKeyFakeServer with the real SDK: each sync class (answered 200,
#           304, 401, 403, 429 -> ok; no answer -> offline; 5xx and a document that does not
#           verify -> error), the keyless registration (minted, no answer, refused), an offline
#           first launch under allow_offline false that stops at offline, a full boot to READY,
#           and the wall-clock sync deadline.

const MATRIX := "res://tests/corpus/v2/stage-matrix.json"
const ANSWERS := {
	"shell": ["shell.done", "fail"],
	"guard": ["guard.done", "fail"],
	"sync": ["sync.done", "fail"],
	"gate": ["gate.status", "fail"],
	"decide": ["decide.done", "fail"],
	"fetch": ["fetch.done", "fail"],
	"mount": ["mount.done", "fail"],
}
const WORK_STAGES := ["shell", "guard", "sync", "gate", "decide", "fetch", "mount"]
const S := preload("res://tests/license/support.gd")

var _emits: Array = []


func run(t: PKeyTestContext, args: PackedStringArray) -> bool:
	var only := args[0] if args.size() > 0 and not args[0].begins_with("-") else ""
	var groups := 0
	if only == "" or only == "rows":
		await _rows(t)
		groups += 1
	if only == "" or only == "dropin":
		await _dropin(t)
		groups += 1
	if only == "" or only == "server":
		await _server(t)
		groups += 1
	t.check("coverage: groups", groups >= 1)
	return true


# ── Rows ─────────────────────────────────────────────────────────────────────────────────

func _rows(t: PKeyTestContext) -> void:
	var m = PKeyTestFixtures.read_json(MATRIX)
	if not t.check("rows: stage-matrix.json loads", m is Dictionary):
		return
	var ok := 0
	for row in m["rows"]:
		if await _row(t, row):
			ok += 1
	t.check("rows: coverage", ok == m["rows"].size() and ok >= 56, "%d/%d rows" % [ok, m["rows"].size()])


func _record(boot: PKeyBoot) -> void:
	boot.stage_changed.connect(func(s, p): _emits.append({"type": "stage_changed", "stage": s, "previous": p}))
	boot.waiting.connect(func(s): _emits.append({"type": "waiting", "status": s}))
	boot.update_available.connect(func(): _emits.append({"type": "update_available"}))
	boot.blocked.connect(func(r): _emits.append({"type": "blocked", "reason": r}))
	boot.offline.connect(func(c): _emits.append({"type": "offline", "canPlayOffline": c}))
	boot.error.connect(func(c): _emits.append({"type": "error", "code": c}))
	boot.boot_rolled_back.connect(func(): _emits.append({"type": "boot_rolled_back"}))
	boot.boot_ready.connect(func(): _emits.append({"type": "boot_ready"}))


func _row(t: PKeyTestContext, row: Dictionary) -> bool:
	var name: String = row["name"]
	var init: Dictionary = row["init"]
	var sdk := PKeyTestFixtures.new_sdk()
	var boot := PKeyBoot.new()
	boot.auto_sdk = false
	(Engine.get_main_loop() as SceneTree).root.add_child(boot)
	var host := PKeyFakeBootHost.new()
	_emits = []
	_record(boot)
	var finished: Array = []
	sdk.boot_finished.connect(func(r): finished.append(r))
	var first: Array = []
	var opts := {"view": boot, "host": host, "sync_timeout_seconds": 1000}
	if init.has("allowOffline"):
		opts["allow_offline"] = init["allowOffline"]
	if init.has("allowGrace"):
		opts["allow_grace"] = init["allowGrace"]
	if init.has("requiredPacks"):
		opts["required_packs"] = init["requiredPacks"]
	var good := true
	var steps: Array = row["steps"]
	if steps[0]["event"]["type"] != "start":
		good = t.check("%s: the row starts with start" % name, false)
	_capture(sdk, opts, first)
	if _emits != steps[0]["emits"]:
		good = t.check("%s: step 1 (start) signals" % name, false, "%s vs %s" % [JSON.stringify(_emits), JSON.stringify(steps[0]["emits"])])
	var first_stop := ""
	if steps[0]["emits"].any(func(e): return e["type"] == "stage_changed" and e["stage"] in ["ready", "blocked", "offline", "error"]):
		first_stop = steps[0]["emits"].back()["stage"]
	for i in range(1, steps.size()):
		var e: Dictionary = steps[i]["event"]
		_emits = []
		var stage: String = boot.state["stage"]
		var waiting: bool = stage == "gate" and boot.state["outcome"] == "waiting"
		if host.waiting_stage == stage and ANSWERS.has(stage) and ANSWERS[stage].has(e["type"]):
			host.answer(e)
		elif waiting and e["type"] == "gate.status":
			host.poke()
			host.answer(e)
		else:
			boot.send(e)
		if _emits != steps[i]["emits"]:
			good = t.check("%s: step %d (%s) signals" % [name, i + 1, e["type"]], false, "%s vs %s" % [JSON.stringify(_emits), JSON.stringify(steps[i]["emits"])])
		if first_stop == "":
			for x in steps[i]["emits"]:
				if x["type"] == "stage_changed" and x["stage"] in ["ready", "blocked", "offline", "error"] and x["previous"] != "background":
					first_stop = x["stage"]
	var expect: Dictionary = row["expect"]
	if boot.stages != expect["stages"]:
		good = t.check("%s: stage sequence in the signals" % name, false, "%s vs %s" % [boot.stages, expect["stages"]])
	if boot.state["stage"] != expect["stages"].back() or boot.state["outcome"] != expect["outcome"]:
		good = t.check("%s: final stage and outcome" % name, false, "%s/%s" % [boot.state["stage"], boot.state["outcome"]])
	var work: Array = host.calls.filter(func(c): return not String(c).ends_with("*"))
	var entered: Array = expect["stages"].filter(func(s): return s in WORK_STAGES)
	if work != entered:
		good = t.check("%s: a stage's work runs on every entry" % name, false, "%s vs %s" % [work, entered])
	var stops := ["ready", "blocked", "offline", "error"]
	if expect["outcome"] in stops:
		if first.is_empty() or first[0].outcome != first_stop:
			good = t.check("%s: boot() resolves with the first stop" % name, false, "%s vs %s" % [first, first_stop])
		if finished.is_empty() or finished.back().outcome != expect["outcome"]:
			good = t.check("%s: the last boot_finished is the row's outcome" % name, false, str(finished))
		elif expect["outcome"] == "blocked" and finished.back().reason == "":
			good = t.check("%s: a blocked result carries its reason" % name, false)
	elif first_stop == "" and not first.is_empty():
		good = t.check("%s: boot() has not resolved while %s" % [name, expect["outcome"]], false, str(first))
	t.check("row: %s" % name, good)
	boot.queue_free()
	sdk.queue_free()
	return good


func _capture(sdk: Node, opts: Dictionary, out: Array) -> void:
	var r: PKeyBootResult = await sdk.boot(opts)
	out.append(r)


# ── Drop-in ──────────────────────────────────────────────────────────────────────────────

const SC := preload("res://tests/ui/scenarios.gd")


## PolarisKey.boot({host}) without a view, every stage answered, decide carrying `answer`.
func _boot_to_ready(sdk: Node, answer: PKeyResult, extra := {}) -> PKeyBootResult:
	var host := PKeyFakeBootHost.new()
	host.update_result = answer
	var opts := {"host": host, "sync_timeout_seconds": 1000}
	opts.merge(extra)
	var first: Array = []
	_capture(sdk, opts, first)
	for e in [
		{"type": "shell.done"}, {"type": "guard.done", "result": "ok"}, {"type": "sync.done", "result": "ok"},
		{"type": "gate.status", "status": "ok"}, {"type": "decide.done", "decision": "optional"},
		{"type": "fetch.done", "result": "ok", "installed": []}, {"type": "mount.done"},
	]:
		host.answer(e)
	var tree := Engine.get_main_loop() as SceneTree
	await tree.process_frame
	await tree.process_frame
	await tree.process_frame
	return first[0] if not first.is_empty() else null


func _dropin(t: PKeyTestContext) -> void:
	var sc = SC.new()
	var tree := Engine.get_main_loop() as SceneTree
	var rel := {"version": "1.5.0", "seq": 15, "sha256": "ab"}
	var answers := {
		"mandatory": sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": true, "critical": false, "prestage": [], "discardStaged": false}),
		"blocked": sc.update_check({"action": "blocked", "reason": "app-floor", "discardStaged": false}),
	}
	# The headless runner's window is tiny; measure on a game-sized screen.
	var saved_size := tree.root.size
	tree.root.size = Vector2i(1152, 900)
	var screen := Vector2(tree.root.get_visible_rect().size)
	for kind in answers:
		var sdk := PKeyTestFixtures.new_sdk()
		var r := await _boot_to_ready(sdk, answers[kind])
		t.check("dropin: a %s answer boots to READY (never stops play)" % kind, r != null and r.outcome == PKeyBoot.READY and r.update == answers[kind], str(r))
		var p = sdk.boot_prompt
		var kept: bool = p is PKeyUpdatePrompt and is_instance_valid(p) and p.is_inside_tree()
		t.check("dropin: the boot view is gone after READY", sdk.boot_view == null or not is_instance_valid(sdk.boot_view))
		t.check("dropin: a %s answer's prompt outlives the boot view" % kind, kept and p.is_visible_in_tree() and p.result == answers[kind])
		if kept:
			var rect: Rect2 = p.get_global_rect()
			t.check("dropin: the kept %s prompt is a strip at the top, not full-screen" % kind, rect.size.y > 0.0 and rect.size.y < screen.y * 0.25 and is_equal_approx(rect.position.y, 0.0) and p.presentation() == "banner", "%s on %s" % [rect, screen])
			t.check("dropin: the kept %s prompt has no dismiss" % kind, not (p.get_node("Body/Actions/Dismiss") as Button).visible)
			p._on_dismiss()
			await tree.process_frame
			t.check("dropin: the kept %s prompt cannot be dismissed" % kind, is_instance_valid(p) and p.is_visible_in_tree())
		# A prompt the game adds later (its own title scene) replays the announced answer.
		sdk.update.last_available = answers[kind]
		var own := PKeyUpdatePrompt.new()
		own.sdk = sdk
		tree.root.add_child(own)
		t.check("dropin: a prompt added after the boot replays update.last_available", own.visible and own.result == answers[kind] and own.model.get("locked", false))
		own.queue_free()
		sdk.queue_free()
		await tree.process_frame

	# keep_update_prompt false: the game shows its own prompt, nothing stays on the layer.
	var sdk2 := PKeyTestFixtures.new_sdk()
	var r2 := await _boot_to_ready(sdk2, answers["blocked"], {"keep_update_prompt": false})
	t.check("dropin: keep_update_prompt false keeps nothing", r2 != null and r2.outcome == PKeyBoot.READY and sdk2.boot_prompt == null)
	sdk2.queue_free()

	# A dismissable answer stays until the player dismisses it, then goes.
	var sdk3 := PKeyTestFixtures.new_sdk()
	var optional = sc.update_check({"action": "binary", "method": "download", "release": rel, "build": "b", "mandatory": false, "critical": false, "prestage": [], "discardStaged": false})
	await _boot_to_ready(sdk3, optional)
	var p3 = sdk3.boot_prompt
	var ok3: bool = p3 is PKeyUpdatePrompt and p3.is_visible_in_tree() and (p3.get_node("Body/Actions/Dismiss") as Button).visible
	t.check("dropin: a dismissable answer stays with its dismiss", ok3)
	if ok3:
		p3._on_dismiss()
		await tree.process_frame
		await tree.process_frame
		t.check("dropin: a dismissed kept prompt is freed", not is_instance_valid(p3) and sdk3.boot_prompt == null)
	sdk3.queue_free()

	# No answer to show: the whole layer goes at READY, as before.
	var sdk4 := PKeyTestFixtures.new_sdk()
	var r4 := await _boot_to_ready(sdk4, null)
	t.check("dropin: with no answer nothing stays after READY", r4 != null and r4.outcome == PKeyBoot.READY and sdk4.boot_prompt == null and sdk4.get_node_or_null("PKeyBootLayer") == null)
	sdk4.queue_free()
	tree.root.size = saved_size


# ── Server ───────────────────────────────────────────────────────────────────────────────

var h: PKeyLicenseTestSupport


func _server(t: PKeyTestContext) -> void:
	h = PKeyLicenseTestSupport.new()
	if not t.check("server: fixtures present", h.ready()):
		return
	await _sync_classes(t)
	await _keyless(t)
	await _full_boots(t)
	await _deadline(t)
	h.free_server()


## A started SDK over the fixtures, with a host whose discovery step is off (the plan answers
## discovery with 404, which never counts; turning it off keeps the request logs readable).
func _host(sdk: Node) -> PKeyBootHost:
	var host := PKeyBootHost.new(sdk)
	host.discover = false
	return host


func _sync_classes(t: PKeyTestContext) -> void:
	var F := h.F
	var token: String = F["token"]
	var trust := S.ok_doc(F["trust_jws"])
	var cases := [
		["200 that verifies", {"/license/document": [S.ok_doc(F["license"])], "/config/document": [S.ok_doc(F["config"])]}, "ok"],
		["304", {"/license/document": [{"status": 304}], "/config/document": [{"status": 304}]}, "ok"],
		["401", {"/license/document": [S.json(401, {"error": {"code": "unauthorized"}})], "/config/document": [S.json(401, {"error": {"code": "unauthorized"}})], "/license/token": [S.json(401, {"error": {"code": "unauthorized"}})]}, "ok"],
		["403 build block", {"/license/document": [S.json(403, {"error": {"code": "version_blocked", "reason": "version-too-old"}, "allowedRange": {"min": "9.0.0"}})], "/config/document": [S.ok_doc(F["config"])]}, "ok"],
		["429", {"/license/document": [S.json(429, {"error": {"code": "rate_limited"}})], "/config/document": [S.ok_doc(F["config"])]}, "ok"],
		["no answer", {"/license/document": [{"hang": true}], "/config/document": [S.ok_doc(F["config"])]}, "offline"],
		["500", {"/license/document": [S.json(500, {"error": "internal_error"})], "/config/document": [S.ok_doc(F["config"])]}, "error"],
		["200 that does not verify", {"/license/document": [S.ok_doc(F["config"])], "/config/document": [S.ok_doc(F["config"])]}, "error"],
	]
	for c in cases:
		h.plan = c[1].duplicate()
		h.plan["polaris-trust.jws"] = [trust]
		h.plan["/devices/report"] = [S.json(200, {"ok": true})]
		var store := PKeyMemoryStore.new(F["device_id"], token)
		var sdk = await h.sdk(store, PackedStringArray(), func(o): o.request_timeout_seconds = 1.0)
		var e: Dictionary = await _host(sdk).sync(false)
		t.check("server: sync answered %s -> sync.done %s" % [c[0], c[2]], e == {"type": "sync.done", "result": c[2]}, str(e))
		sdk.queue_free()
	# A local-only build never asks: offline.
	var lo = await h.sdk(PKeyMemoryStore.new(F["device_id"], token), PackedStringArray(), func(o): o.local_only = true)
	var e2: Dictionary = await _host(lo).sync(false)
	t.check("server: a local-only build reports sync.done offline", e2 == {"type": "sync.done", "result": "offline"}, str(e2))
	lo.queue_free()


func _keyless(t: PKeyTestContext) -> void:
	var F := h.F
	var minted := "pkeyt_KEYLESSKEYLESSKEYLESSKEYLESSKEYLESS0000"
	var config_only := PackedStringArray(["config"])
	var cases := [
		["minted, then synced", [S.json(200, {"token": minted, "deviceId": F["device_id"]})], "ok", true],
		["no answer", [{"hang": true}], "offline", false],
		["refused (403 registration_closed)", [S.json(403, {"error": {"code": "registration_closed"}})], "error", false],
		["a 200 without a token", [S.json(200, {"ok": true})], "error", false],
	]
	for c in cases:
		h.server.requests.clear()
		h.plan = {
			"polaris-trust.jws": [S.ok_doc(F["trust_jws"])],
			"/devices/register": c[1],
			"/config/document": [S.doc_for([minted], F["config"])],
			"/devices/report": [S.json(200, {"ok": true})],
		}
		var sdk = await h.sdk(PKeyMemoryStore.new(F["device_id"]), config_only, func(o): o.request_timeout_seconds = 1.0)
		var e: Dictionary = await _host(sdk).sync(false)
		var synced: bool = not h.requests("GET", "/config/document").is_empty()
		t.check("server: keyless registration %s -> sync.done %s" % [c[0], c[2]], e == {"type": "sync.done", "result": c[2]} and synced == c[3], "%s synced=%s" % [e, synced])
		sdk.queue_free()
	# A licensed product never registers first.
	h.server.requests.clear()
	h.plan = {"/devices/register": [S.json(200, {"token": minted})]}
	var lic = await h.sdk(PKeyMemoryStore.new(F["device_id"]))
	var e3: Dictionary = await _host(lic).sync(false)
	t.check("server: a product with License does not register; nothing counted is ok", e3 == {"type": "sync.done", "result": "ok"} and h.requests("POST", "/devices/register").is_empty(), str(e3))
	lic.queue_free()
	# Discovery's policy wins over the default.
	var core: PKeyCore = (await h.sdk(PKeyMemoryStore.new(F["device_id"]), config_only)).core
	t.check("server: the §6 default for a config-only product is open", PKeyBootHost.registration_open(core))
	core.discovery_manifest = {"core": {"registration": "requires-identity"}}
	t.check("server: discovery's core.registration overrides the default", not PKeyBootHost.registration_open(core))


func _full_boots(t: PKeyTestContext) -> void:
	var F := h.F
	# An offline first launch of a config-only product under allow_offline: false stops at offline.
	h.plan = {"/devices/register": [{"hang": true}]}
	var sdk = await h.sdk(PKeyMemoryStore.new(F["device_id"]), PackedStringArray(["config"]), func(o): o.request_timeout_seconds = 1.0)
	var view := PKeyBoot.new()
	view.auto_sdk = false
	(Engine.get_main_loop() as SceneTree).root.add_child(view)
	var host := _host(sdk)
	var r: PKeyBootResult = await sdk.boot({"view": view, "host": host, "allow_offline": false})
	t.check("server: offline first launch under allow_offline false stops at OFFLINE", r.outcome == PKeyBoot.OFFLINE and r.stages == ["shell", "guard", "sync", "offline"], "%s %s" % [r, r.stages])
	# The same launch with the default allow_offline continues on its defaults to READY.
	var r2: PKeyBootResult = await sdk.boot({"view": view, "host": host})
	t.check("server: offline first launch continues to READY by default", r2.outcome == PKeyBoot.READY and r2.ok, "%s %s" % [r2, r2.stages])
	view.queue_free()
	sdk.queue_free()

	# A licensed device with fresh documents boots to READY through the real host.
	h.serve_docs([F["token"]])
	var sdk2 = await h.sdk(PKeyMemoryStore.new(F["device_id"], F["token"]))
	var view2 := PKeyBoot.new()
	view2.auto_sdk = false
	(Engine.get_main_loop() as SceneTree).root.add_child(view2)
	var signals: Array = []
	view2.stage_changed.connect(func(s, _p): signals.append(s))
	var r3: PKeyBootResult = await sdk2.boot({"view": view2, "host": _host(sdk2)})
	t.check("server: a licensed device boots to READY", r3.outcome == PKeyBoot.READY and signals == ["shell", "guard", "sync", "gate", "decide", "fetch", "mount", "ready"], "%s %s" % [r3, signals])
	view2.queue_free()
	sdk2.queue_free()

	# A 403 build block is answered, so it reaches BLOCKED (update-required), never sync-failed,
	# even under allow_offline false.
	h.plan["/license/document"] = [S.json(403, {"error": {"code": "version_blocked", "reason": "version-too-old"}, "allowedRange": {"min": "9.0.0"}})]
	var sdk3 = await h.sdk(PKeyMemoryStore.new(F["device_id"], F["token"]))
	var view3 := PKeyBoot.new()
	view3.auto_sdk = false
	(Engine.get_main_loop() as SceneTree).root.add_child(view3)
	var r4: PKeyBootResult = await sdk3.boot({"view": view3, "host": _host(sdk3), "allow_offline": false})
	t.check("server: a 403 build block reaches BLOCKED update-required", r4.outcome == PKeyBoot.BLOCKED and r4.reason == "update-required", str(r4))
	view3.queue_free()
	sdk3.queue_free()


func _deadline(t: PKeyTestContext) -> void:
	# The host never answers the sync: PKeyBoot's own wall-clock deadline sends sync.timeout.
	var sdk := PKeyTestFixtures.new_sdk()
	var view := PKeyBoot.new()
	view.auto_sdk = false
	(Engine.get_main_loop() as SceneTree).root.add_child(view)
	var host := PKeyFakeBootHost.new()
	var first: Array = []
	_capture(sdk, {"view": view, "host": host, "sync_timeout_seconds": 0.3, "allow_offline": false}, first)
	host.answer({"type": "shell.done"})
	host.answer({"type": "guard.done", "result": "ok"})
	var started := Time.get_ticks_msec()
	while first.is_empty() and Time.get_ticks_msec() - started < 3000:
		await (Engine.get_main_loop() as SceneTree).process_frame
	var took := Time.get_ticks_msec() - started
	t.check("server: the sync deadline sends sync.timeout (OFFLINE under allow_offline false)", not first.is_empty() and first[0].outcome == PKeyBoot.OFFLINE and took >= 250, "%s after %d ms" % [first, took])
	# The late answer is dropped.
	host.answer({"type": "sync.done", "result": "ok"})
	t.check("server: a late sync answer after the timeout is dropped", view.state["stage"] == "offline")
	view.queue_free()
	sdk.queue_free()
