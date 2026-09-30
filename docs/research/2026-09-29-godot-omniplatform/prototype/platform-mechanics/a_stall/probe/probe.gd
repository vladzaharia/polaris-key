extends Control
## S-05 (a): how long does ProjectSettings.load_resource_pack block the main thread?
## Reads a plan (JSON) from the first user arg "plan=<path>" or, on Android, from
## /sdcard/Android/data/<package>/files/plan.json, runs it while a spinner animates, and writes
## the result next to the plan (and as one "S05A|{json}" log line).
##
## plan = {
##   "case": "name",
##   "at_frame": 0,              # 0 = in _ready (before the first frame), N = at the Nth _process
##   "prep_copy": [[src, dst]],  # optional: copy files (e.g. res://packs/x.pck -> user://x.pck), then quit
##   "mounts": [{"path": "...", "replace": true, "thread": false}],
##   "verify": true,             # read 3 entries of each data pack and check SHA-256 against its manifest
##   "tail_frames": 30
## }

const PKG := "org.polariskey.s05stall"

var plan: Dictionary = {}
var plan_dir := ""
var frames: PackedInt64Array = []
var t_boot_ms := 0
var started := false
var finished_at := -1
var result := {}
var angle := 0.0
var thread: Thread
var thread_t0 := 0
var thread_ok := false
var mount_idx := 0
var mount_log := []
var phase := "wait"
var pad: Object
var pad_t0 := 0


func _plan_path() -> String:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("plan="):
			return a.substr(5)
	if OS.get_name() == "Android":
		return "/sdcard/Android/data/%s/files/plan.json" % PKG
	return ""


func _ready() -> void:
	t_boot_ms = Time.get_ticks_msec()
	var pp := _plan_path()
	plan_dir = pp.get_base_dir()
	var txt := FileAccess.get_file_as_string(pp)
	plan = JSON.parse_string(txt) if txt != "" else {}
	if plan.is_empty():
		_log({"error": "no plan at " + pp})
		get_tree().quit()
		return
	result = {"case": plan.get("case", "?"), "engine": Engine.get_version_info().string, "os": OS.get_name(),
		"model": OS.get_model_name(), "cpu": OS.get_processor_name(), "cores": OS.get_processor_count(),
		"user_dir": OS.get_user_data_dir(), "exe": OS.get_executable_path(),
		"ticks_at_ready_ms": t_boot_ms}
	if plan.has("pad"):
		# S-05 (b): fetch Play Asset Delivery packs through the S05Pad plugin, then mount each
		# from getAssetsPath(name) + "/<name>.pck" (see b_pad/).
		pad = Engine.get_singleton("S05Pad") if Engine.has_singleton("S05Pad") else null
		result["pad_singleton"] = pad != null
		if pad == null:
			_finish()
			return
		pad_t0 = Time.get_ticks_msec()
		for n: String in plan.pad:
			result["pad_before_%s" % n] = {"status": pad.getStatus(n), "assets_path": pad.getAssetsPath(n)}
			pad.fetch(n)
		phase = "pad"
		return
	if plan.has("diag"):
		# How does the engine see a file at an absolute path? (exists / open / length / magic / mount)
		var dg := []
		for p: String in plan.diag:
			var f := FileAccess.open(p, FileAccess.READ)
			var e := {"path": p, "exists": FileAccess.file_exists(p), "open": error_string(FileAccess.get_open_error()),
				"dir_listing": Array(DirAccess.get_files_at(p.get_base_dir())).slice(0, 8)}
			if f:
				e["length"] = f.get_length()
				e["magic"] = f.get_buffer(4).hex_encode()
				f.seek(f.get_length() - 4)
				e["tail_ok"] = f.get_position() == f.get_length() - 4
				f = null
			var t := Time.get_ticks_usec()
			e["mount"] = ProjectSettings.load_resource_pack(p, true)
			e["mount_ms"] = (Time.get_ticks_usec() - t) / 1000.0
			var man := "res://data/%s/manifest.json" % p.get_file().get_basename()
			e["manifest_visible"] = FileAccess.file_exists(man)
			dg.append(e)
		result["diag"] = dg
		result["user_dir_abs"] = OS.get_user_data_dir()
		_finish()
		return
	if plan.has("prep_copy"):
		var cp := []
		for pair in plan.prep_copy:
			var t := Time.get_ticks_usec()
			var err := _copy(pair[0], pair[1])
			cp.append({"src": pair[0], "dst": pair[1], "err": error_string(err), "ms": (Time.get_ticks_usec() - t) / 1000.0})
		result["prep_copy"] = cp
		_finish()
		return
	if int(plan.get("at_frame", 0)) == 0:
		_start_mounts()


func _copy(src: String, dst: String) -> Error:
	var fi := FileAccess.open(src, FileAccess.READ)
	if fi == null:
		return FileAccess.get_open_error()
	DirAccess.make_dir_recursive_absolute(dst.get_base_dir())
	var fo := FileAccess.open(dst + ".part", FileAccess.WRITE)
	if fo == null:
		return FileAccess.get_open_error()
	while fi.get_position() < fi.get_length():
		fo.store_buffer(fi.get_buffer(1 << 20))
	fo.close()
	return DirAccess.rename_absolute(dst + ".part", dst)


func _start_mounts() -> void:
	started = true
	phase = "mount"
	result["mount_started_frame"] = frames.size()
	_next_mount()


func _next_mount() -> void:
	if mount_idx >= plan.mounts.size():
		_after_mounts()
		return
	var m: Dictionary = plan.mounts[mount_idx]
	if m.get("thread", false):
		thread = Thread.new()
		thread_t0 = Time.get_ticks_usec()
		thread.start(_thread_mount.bind(m.path, m.get("replace", true)))
		phase = "thread"
		return
	var t := Time.get_ticks_usec()
	var ok := ProjectSettings.load_resource_pack(m.path, m.get("replace", true))
	mount_log.append({"path": m.path, "thread": false, "ok": ok, "call_ms": (Time.get_ticks_usec() - t) / 1000.0, "frame": frames.size()})
	mount_idx += 1
	if m.get("one_per_frame", true):
		return  # continue at the next _process
	_next_mount()


func _thread_mount(path: String, rep: bool) -> void:
	thread_ok = ProjectSettings.load_resource_pack(path, rep)


func _after_mounts() -> void:
	phase = "tail"
	result["mounts"] = mount_log
	if plan.get("verify", true):
		var vr := []
		for m in plan.mounts:
			var name: String = m.path.get_file().get_basename()
			var man_path := "res://data/%s/manifest.json" % name
			if not FileAccess.file_exists(man_path):
				vr.append({"pack": name, "manifest": "absent"})
				continue
			var t := Time.get_ticks_usec()
			var man: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(man_path))
			var keys := man.keys()
			keys.sort()
			var ok := 0
			var picks := [keys[0], keys[keys.size() / 2], keys[-1]]
			for k in picks:
				var h := HashingContext.new()
				h.start(HashingContext.HASH_SHA256)
				h.update(FileAccess.get_file_as_bytes(k))
				if h.finish().hex_encode() == man[k]:
					ok += 1
			vr.append({"pack": name, "entries": keys.size(), "sha_ok": "%d/3" % ok, "verify_ms": (Time.get_ticks_usec() - t) / 1000.0})
		result["verify"] = vr
	finished_at = frames.size() + int(plan.get("tail_frames", 30))


func _process(_d: float) -> void:
	frames.append(Time.get_ticks_usec())
	angle += 0.15
	queue_redraw()
	if phase == "wait" and not plan.is_empty() and not plan.has("prep_copy") and frames.size() >= int(plan.get("at_frame", 0)) and not started:
		_start_mounts()
	elif phase == "mount":
		_next_mount()
	elif phase == "thread" and not thread.is_alive():
		thread.wait_to_finish()
		var m: Dictionary = plan.mounts[mount_idx]
		mount_log.append({"path": m.path, "thread": true, "ok": thread_ok, "thread_ms": (Time.get_ticks_usec() - thread_t0) / 1000.0, "frame": frames.size()})
		mount_idx += 1
		phase = "mount"
	elif phase == "pad":
		var done := true
		for n: String in plan.pad:
			var st: int = pad.getStatus(n)
			if st != 4 and st != 5 and st != 6:
				done = false
		if done or Time.get_ticks_msec() - pad_t0 > 180000:
			var pr := []
			for n: String in plan.pad:
				var ap: String = pad.getAssetsPath(n)
				var e := {"pack": n, "status": pad.getStatus(n), "error": pad.getErrorCode(n), "storage": pad.getStorageMethod(n), "assets_path": ap, "fetch_ms": Time.get_ticks_msec() - pad_t0}
				if ap != "":
					var p := ap.path_join(n + ".pck")
					e["dir_listing"] = Array(DirAccess.get_files_at(ap))
					e["exists"] = FileAccess.file_exists(p)
					var t := Time.get_ticks_usec()
					e["mount"] = ProjectSettings.load_resource_pack(p, true)
					e["mount_ms"] = (Time.get_ticks_usec() - t) / 1000.0
					var man := "res://data/%s/manifest.json" % n
					if FileAccess.file_exists(man):
						var m: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(man))
						var ok := 0
						for k in m.keys():
							var h := HashingContext.new()
							h.start(HashingContext.HASH_SHA256)
							h.update(FileAccess.get_file_as_bytes(k))
							ok += 1 if h.finish().hex_encode() == m[k] else 0
						e["sha_ok"] = "%d/%d" % [ok, m.size()]
				pr.append(e)
			result["pad"] = pr
			_finish()
	elif phase == "tail" and frames.size() >= finished_at:
		_finish()


func _finish() -> void:
	phase = "done"
	var deltas := []
	var s0: int = int(result.get("mount_started_frame", 0))
	var mx := 0.0
	var over33 := 0
	var over100 := 0
	for i in range(1, frames.size()):
		var d := (frames[i] - frames[i - 1]) / 1000.0
		if i >= s0:
			deltas.append(snappedf(d, 0.01))
			mx = maxf(mx, d)
			over33 += 1 if d > 33.4 else 0
			over100 += 1 if d > 100.0 else 0
	var pre := []
	for i in range(1, mini(s0, frames.size())):
		pre.append((frames[i] - frames[i - 1]) / 1000.0)
	pre.sort()
	result["first_frame_ms"] = (frames[0] / 1000.0) if frames.size() else -1.0
	result["frames_total"] = frames.size()
	result["median_frame_before_ms"] = pre[pre.size() / 2] if pre.size() else -1.0
	result["max_frame_after_start_ms"] = snappedf(mx, 0.01)
	result["frames_over_33ms"] = over33
	result["frames_over_100ms"] = over100
	result["frame_deltas_after_start_ms"] = deltas.slice(0, 40)
	_log(result)
	if plan_dir != "":
		var f := FileAccess.open(plan_dir.path_join("result_%s.json" % result.case), FileAccess.WRITE)
		if f:
			f.store_string(JSON.stringify(result, "  "))
	get_tree().quit()


func _log(d: Dictionary) -> void:
	print("S05A|" + JSON.stringify(d))


func _draw() -> void:
	var c := size / 2.0
	draw_rect(Rect2(Vector2.ZERO, size), Color(0.08, 0.09, 0.12))
	draw_arc(c, 120.0, angle, angle + 4.2, 48, Color(0.4, 0.8, 1.0), 18.0, true)
	draw_string(ThemeDB.fallback_font, c + Vector2(-160, 220), "S-05 %s %s" % [plan.get("case", ""), phase], HORIZONTAL_ALIGNMENT_LEFT, -1, 28)
