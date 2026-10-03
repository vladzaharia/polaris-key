extends Node
## S-11 probe. Reads /tmp/s11/run/config.json:
##   {"mode":"headless|standard|none", "feed":"http://...", "log":"...", "channels":[], "headers":{},
##    "quit_after_s": 60, "target_version": "2"}
const CONFIG := "/tmp/s11/run/config.json"
var cfg := {}
var sparkle = null
var t0 := Time.get_ticks_msec()

func plog(event: String, detail = {}) -> void:
	var line := JSON.stringify({"src": "gd", "t_ms": Time.get_ticks_msec() - t0, "pid": OS.get_process_id(),
		"event": event, "detail": detail})
	var p: String = cfg.get("log", "/tmp/s11.log") + ".gd"
	var f := FileAccess.open(p, FileAccess.READ_WRITE if FileAccess.file_exists(p) else FileAccess.WRITE)
	if f:
		f.seek_end()
		f.store_line(line)
		f.close()
	print(line)

func _ready() -> void:
	var f := FileAccess.open(CONFIG, FileAccess.READ)
	if f:
		cfg = JSON.parse_string(f.get_as_text())
	var opened := PKeySparkle.open()
	plog("boot", {"godot": Engine.get_version_info().string, "project_version": ProjectSettings.get_setting("application/config/version"),
		"exe": OS.get_executable_path(), "open": {"ok": opened.ok, "unsupported": opened.get("unsupported", ""), "info": opened.get("info", {})}})
	get_tree().create_timer(float(cfg.get("quit_after_s", 60))).timeout.connect(func(): plog("timeout_quit"); get_tree().quit(3))
	if not opened.ok:
		return
	var info: Dictionary = opened.info
	if str(info.get("version", "")) == str(cfg.get("target_version", "")) or cfg.get("mode", "none") == "none":
		plog("target_reached_or_idle", {"version": info.get("version")})
		get_tree().create_timer(1.0).timeout.connect(func(): get_tree().quit(0))
		return
	sparkle = opened.native
	if cfg.get("thread_test", false):
		var th := Thread.new()
		th.start(func(): return sparkle.start("headless", cfg.get("feed", ""), {}, PackedStringArray(), cfg.get("log", "")))
		plog("thread_start_result", th.wait_to_finish())
	sparkle.sparkle_event.connect(func(e, d): plog("signal:" + e, d))
	var r: Dictionary = sparkle.start(cfg.get("mode", "headless"), cfg.get("feed", ""), cfg.get("headers", {}),
		PackedStringArray(cfg.get("channels", [])), cfg.get("log", "/tmp/s11.log"))
	plog("start_result", r)
	if r.get("ok", false):
		if cfg.get("auto_download", false):
			sparkle.set_automatically_checks(true)
			sparkle.set_automatically_downloads(true)
		if cfg.get("background", false):
			sparkle.check_in_background()
		else:
			sparkle.check_for_updates()
		plog("check_called", sparkle.get_state())

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		plog("wm_close_request")
	elif what == NOTIFICATION_APPLICATION_FOCUS_OUT:
		pass

func _exit_tree() -> void:
	plog("exit_tree")
