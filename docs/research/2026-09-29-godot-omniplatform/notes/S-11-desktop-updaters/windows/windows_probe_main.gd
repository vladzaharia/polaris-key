extends Node
## S-11 Windows probe. Reads C:/s11/config.json:
##   {"mode":"velopack|winsparkle|store|none", "feed":"...", "log":"C:/s11/logs/x.log", "pub":"<b64>",
##    "target_version":"1.0.1", "quit_after_s":60, "headers":{}}
const CONFIG := "C:/s11/config.json"
var cfg := {}
var t0 := Time.get_ticks_msec()
var native = null
var version: String = ProjectSettings.get_setting("application/config/version")

func plog(event: String, detail = {}) -> void:
	var line := JSON.stringify({"t_ms": Time.get_ticks_msec() - t0, "unix": Time.get_unix_time_from_system(), "pid": OS.get_process_id(),
		"v": version, "event": event, "detail": detail})
	var p: String = cfg.get("log", "C:/s11/logs/default.log")
	var f := FileAccess.open(p, FileAccess.READ_WRITE if FileAccess.file_exists(p) else FileAccess.WRITE)
	if f:
		f.seek_end()
		f.store_line(line)
		f.close()
	print(line)

func _ready() -> void:
	if get_node_or_null("/root/VeloProbe") and get_node("/root/VeloProbe").hooked:
		return
	var f := FileAccess.open(CONFIG, FileAccess.READ)
	if f:
		cfg = JSON.parse_string(f.get_as_text())
	var classes := {}
	for c in ["PKeyVelopackNative", "PKeyWinSparkleNative", "PKeyStoreContextNative"]:
		classes[c] = ClassDB.class_exists(c)
	plog("boot", {"exe": OS.get_executable_path(), "args": OS.get_cmdline_args(), "user_dir": OS.get_user_data_dir(), "classes": classes,
		"godot": Engine.get_version_info().string})
	get_tree().create_timer(float(cfg.get("quit_after_s", 60))).timeout.connect(func(): plog("timeout_quit"); get_tree().quit(3))
	var mode: String = cfg.get("mode", "none")
	if version == str(cfg.get("target_version", "")) or mode == "none":
		plog("target_reached_or_idle")
		get_tree().create_timer(1.0).timeout.connect(func(): get_tree().quit(0))
		return
	match mode:
		"velopack": run_velopack()
		"winsparkle": run_winsparkle()
		"store": run_store()

func run_velopack() -> void:
	if not ClassDB.class_exists("PKeyVelopackNative"):
		plog("unsupported", {"reason": "dependency"}); return
	native = ClassDB.instantiate("PKeyVelopackNative")
	native.velopack_event.connect(_on_velopack)
	var o: Dictionary = native.open(cfg.get("feed", ""))
	plog("velopack_open", o)
	if not o.get("ok", false): return
	var c: Dictionary = native.check()
	plog("velopack_check", c)
	if c.get("status") == "available":
		plog("velopack_download_started", {"started": native.download_async()})

func _on_velopack(ev: String, d: Dictionary) -> void:
	plog("velopack:" + ev, d)
	if ev == "downloaded":
		var a: Dictionary = native.apply_on_exit(true)
		plog("velopack_apply_on_exit", a)
		if a.get("ok", false):
			get_tree().quit(0)

func run_winsparkle() -> void:
	if not ClassDB.class_exists("PKeyWinSparkleNative"):
		plog("unsupported", {"reason": "dependency"}); return
	native = ClassDB.instantiate("PKeyWinSparkleNative")
	native.winsparkle_event.connect(_on_winsparkle)
	var l: Dictionary = native.load(OS.get_executable_path().get_base_dir().path_join("WinSparkle.dll"))
	plog("winsparkle_load", l)
	if not l.get("ok", false): return
	var s: Dictionary = native.start(cfg.get("feed", ""), cfg.get("pub", ""), "PolarisKeyS11", "S11WinSparkle", version, cfg.get("headers", {}))
	plog("winsparkle_start", s)
	if s.get("ok", false):
		native.check(cfg.get("ws_mode", "install"))
		plog("winsparkle_check_called")

func _on_winsparkle(ev: String, d: Dictionary) -> void:
	plog("winsparkle:" + ev, d)
	if ev == "shutdown_request":
		get_tree().quit(0)

func run_store() -> void:
	var pf := FileAccess.open("user://s11_probe.txt", FileAccess.WRITE)
	if pf:
		pf.store_string("s11 %s" % Time.get_unix_time_from_system())
		pf.close()
	plog("user_probe_written", {"user_dir": OS.get_user_data_dir(), "global": ProjectSettings.globalize_path("user://s11_probe.txt"),
		"exe_dir_writable": FileAccess.open(OS.get_executable_path().get_base_dir().path_join("w.txt"), FileAccess.WRITE) != null})
	if not ClassDB.class_exists("PKeyStoreContextNative"):
		plog("unsupported", {"reason": "dependency"}); return
	plog("package_identity", ClassDB.class_call_static("PKeyStoreContextNative", "package_identity"))
	native = ClassDB.instantiate("PKeyStoreContextNative")
	native.store_event.connect(func(e, d): plog("store:" + e, d); get_tree().create_timer(0.5).timeout.connect(func(): get_tree().quit(0)))
	native.probe_async(DisplayServer.window_get_native_handle(DisplayServer.WINDOW_HANDLE))

func _exit_tree() -> void:
	if native and native.has_method("cleanup"):
		native.cleanup()
	plog("exit_tree")
