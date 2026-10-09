extends Node
## P5-07's end-to-end probe. res://e2e.json (written by the run script before the export) names a
## config file outside the pack, so one build serves every case:
##
##   {"case": "...", "feed": "...", "log": "/abs/log.jsonl", "headers": {}, "public_key": "...",
##    "target_version": "1.0.1", "quit_after_s": 90}
##
## Every case first logs `boot`. A build whose application/config/version is `target_version`
## logs `target_reached` and quits: that line is what the run script waits for after an update.
## Cases go through the SDK's own objects (the P3-10 bridges and P5-07's facades), never around
## them:
##
##   idle                  boot and quit (installers, hooks)
##   facades               every facade's availability() and the Windows extension's classes
##   sparkle_missing_key   PKeySparkle.start() on a bundle without SUPublicEDKey
##   sparkle_update        PKeySparkleBridge.install_and_relaunch() (headless user driver)
##   velopack_update       PKeyVelopackBridge.install_and_relaunch()
##   winsparkle_update     PKeyWinSparkleBridge.install_and_relaunch()
##   store_unpackaged      PKeyStoreContext: identity, then the native query on its MTA thread

var cfg := {}
var t0 := Time.get_ticks_msec()
var version: String = str(ProjectSettings.get_setting("application/config/version", ""))
var bridge: PKeyNativeBridge = null


func plog(event: String, detail: Variant = {}) -> void:
	var line := JSON.stringify({"t_ms": Time.get_ticks_msec() - t0, "pid": OS.get_process_id(), "v": version, "event": event, "detail": detail})
	print(line)
	var p := String(cfg.get("log", ""))
	if p == "":
		return
	var f := FileAccess.open(p, FileAccess.READ_WRITE if FileAccess.file_exists(p) else FileAccess.WRITE)
	if f:
		f.seek_end()
		f.store_line(line)
		f.close()


func result(r: Variant) -> Dictionary:
	if r is PKeyResult:
		return {"ok": r.ok, "code": String(r.code), "message": r.message, "detail": r.detail}
	return {"value": r}


func _ready() -> void:
	var pointer := FileAccess.open("res://e2e.json", FileAccess.READ)
	if pointer:
		var p = JSON.parse_string(pointer.get_as_text())
		var f := FileAccess.open(String(p.get("config", "")) if p is Dictionary else "", FileAccess.READ)
		if f:
			var c = JSON.parse_string(f.get_as_text())
			cfg = c if c is Dictionary else {}
	plog("boot", {"exe": OS.get_executable_path(), "args": OS.get_cmdline_args(), "case": cfg.get("case", ""), "godot": Engine.get_version_info().string})
	get_tree().create_timer(float(cfg.get("quit_after_s", 90))).timeout.connect(func():
		plog("timeout_quit")
		get_tree().quit(3))
	if version == String(cfg.get("target_version", "")):
		plog("target_reached")
		_quit_soon(0)
		return
	match String(cfg.get("case", "idle")):
		"facades":
			_facades()
		"sparkle_missing_key":
			var s := PKeySparkle.new(PKeyUpdaterEnv.new())
			plog("bundle_info", s.bundle_info())
			plog("sparkle_start", result(s.start(String(cfg.get("feed", "")))))
			_quit_soon(0)
		"sparkle_update":
			bridge = PKeySparkleBridge.new(PKeyUpdaterEnv.new(), String(cfg.get("feed", "")))
			bridge.options = {"mode": "headless"}
			await _hand_off()
		"velopack_update":
			bridge = PKeyVelopackBridge.new(PKeyUpdaterEnv.new(), String(cfg.get("feed", "")))
			await _hand_off()
		"winsparkle_update":
			bridge = PKeyWinSparkleBridge.new(PKeyUpdaterEnv.new(), String(cfg.get("feed", "")))
			bridge.options = {"public_key": String(cfg.get("public_key", "")), "company": "PolarisKeyE2E", "app": "PKeyE2E", "version": version}
			await _hand_off()
		"store_unpackaged":
			await _store()
		_:
			_quit_soon(0)


## Hand the update to the native updater through P3-10's bridge, logging every native event.
func _hand_off() -> void:
	var headers: Dictionary = cfg.get("headers", {})
	bridge.headers_source = func() -> Dictionary: return headers
	var f := bridge.facade()
	f.event.connect(func(e: String, d: Dictionary): plog("native:" + e, d))
	plog("availability", result(f.availability()))
	if bridge.id() == "velopack":
		plog("direct_apply", f._native().call("apply_on_exit", true))
	var r: PKeyApplyResult = await bridge.install_and_relaunch()
	plog("install_and_relaunch", {"ok": r.ok, "code": String(r.code), "message": r.message, "behaviour": r.behaviour, "bridge": r.bridge, "detail": r.detail})
	if not r.ok:
		_quit_soon(1)


func _facades() -> void:
	var env := PKeyUpdaterEnv.new()
	var out := {}
	for f in [PKeySparkle.new(env), PKeyVelopack.new(env), PKeyWinSparkle.new(env), PKeyStoreContext.new(env)]:
		out[f.id()] = result(f.availability())
	var classes := {}
	for c in ["PKeySparkleNative", "PKeyVelopackNative", "PKeyWinSparkleNative", "PKeyStoreContextNative"]:
		classes[c] = ClassDB.class_exists(c)
	plog("facades", {"availability": out, "classes": classes})
	_quit_soon(0)


func _store() -> void:
	var f := PKeyStoreContext.new(PKeyUpdaterEnv.new(), {"timeout_s": 60.0})
	plog("store_availability", result(f.availability()))
	plog("package_identity", f.package_identity())
	var n := f._native()
	if n != null:
		# The facade stops at "no package identity"; the native query still runs here, so the MTA
		# thread, IInitializeWithWindow and the HRESULT mapping are exercised on a real Windows.
		var request := int(n.call("request_async", "updates", f.window_handle(), false))
		var got: Dictionary = await f.wait_event(["store_result"], request, 60.0)
		plog("store_result", {"event": got["event"], "detail": got["detail"], "interpreted": result(PKeyStoreContext.interpret(got["detail"]))})
	_quit_soon(0)


func _quit_soon(code: int) -> void:
	get_tree().create_timer(0.5).timeout.connect(func(): get_tree().quit(code))


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		plog("wm_close_request")


func _exit_tree() -> void:
	plog("exit_tree")
