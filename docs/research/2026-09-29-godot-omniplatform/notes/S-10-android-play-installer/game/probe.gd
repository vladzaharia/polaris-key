extends Node
## S-10 probe. Reads /sdcard/Android/data/<pkg>/files/plan.json:
##   {"case": "name", "steps": [{"op": ..., ...}, ...]}
## runs each step against the PKeyS10 singleton, records every signal it receives (with whether
## the handler ran on the main thread), and writes result_<case>.json next to the plan plus one
## "S10|{json}" log line.

var plugin: Object = null
var signals: Array = []
var t0 := 0
var main_thread_id := 0


func _ext_dir() -> String:
	return "/sdcard/Android/data/%s/files" % _pkg()


func _pkg() -> String:
	if plugin != null:
		return JSON.parse_string(plugin.installSource()).get("package", "")
	return ""


func _ready() -> void:
	t0 = Time.get_ticks_usec()
	main_thread_id = OS.get_main_thread_id()
	var result := {"engine": Engine.get_version_info().string, "os": OS.get_name()}
	result["has_singleton"] = Engine.has_singleton("PKeyS10")
	if not result.has_singleton:
		print("S10|", JSON.stringify(result))
		return
	plugin = Engine.get_singleton("PKeyS10")
	for s in ["iau_state", "pad_state", "pi_status", "probe"]:
		plugin.connect(s, _on_signal.bind(s))
	var pp := _ext_dir() + "/plan.json"
	var plan: Dictionary = {}
	if FileAccess.file_exists(pp):
		plan = JSON.parse_string(FileAccess.get_file_as_string(pp))
	result["case"] = plan.get("case", "none")
	result["flavor"] = plugin.flavor()
	var steps := []
	for st: Dictionary in plan.get("steps", []):
		var r := await _step(st)
		r["op"] = st.get("op")
		r["t_ms"] = (Time.get_ticks_usec() - t0) / 1000.0
		steps.append(r)
		result["steps"] = steps
		result["signals"] = signals
		_write(result)
	result["steps"] = steps
	result["signals"] = signals
	result["done"] = true
	_write(result)
	print("S10|", JSON.stringify(result))


func _write(result: Dictionary) -> void:
	# Written after every step: a self-update kills the process mid-plan.
	var f := FileAccess.open(_ext_dir() + "/result_%s.json" % result.case, FileAccess.WRITE)
	f.store_string(JSON.stringify(result, " "))
	f.close()


func _on_signal(payload: String, name: String) -> void:
	signals.append({"signal": name, "main_thread": OS.get_thread_caller_id() == main_thread_id,
		"frame": Engine.get_process_frames(), "t_ms": (Time.get_ticks_usec() - t0) / 1000.0,
		"payload": JSON.parse_string(payload)})


func _wait_signal(name: String, count: int, timeout_ms: int) -> bool:
	var start := Time.get_ticks_msec()
	while Time.get_ticks_msec() - start < timeout_ms:
		var n := 0
		for s in signals:
			if s.signal == name:
				n += 1
		if n >= count:
			return true
		await get_tree().process_frame
	return false


func _count(name: String) -> int:
	var n := 0
	for s in signals:
		if s.signal == name:
			n += 1
	return n


func _j(s: String) -> Variant:
	return JSON.parse_string(s)


func _step(st: Dictionary) -> Dictionary:
	match st.op:
		"source":
			return {"r": _j(plugin.installSource())}
		"thread":
			return {"r": _j(plugin.threadInfo()), "gd_main_thread": OS.get_thread_caller_id() == main_thread_id}
		"emitFrom":
			var before := _count("probe")
			var t := Time.get_ticks_usec()
			plugin.emitFrom(st.where)
			var ok := await _wait_signal("probe", before + 1, 3000)
			return {"received": ok, "latency_ms": (Time.get_ticks_usec() - t) / 1000.0}
		"ksWrap":
			var r: Dictionary = _j(plugin.ksWrap(st.alias, st.plain, st.get("strongBox", false)))
			if r.has("blob"):
				var f := FileAccess.open("user://ks_%s.blob" % st.alias, FileAccess.WRITE)
				f.store_string(r.blob)
				f.close()
			return {"r": r}
		"ksUnwrapSaved":
			var p := "user://ks_%s.blob" % st.alias
			if not FileAccess.file_exists(p):
				return {"error": "no_blob"}
			return {"r": _j(plugin.ksUnwrap(st.alias, FileAccess.get_file_as_string(p)))}
		"ksInfo":
			return {"r": _j(plugin.ksInfo(st.alias))}
		"ksDelete":
			return {"r": _j(plugin.ksDelete(st.alias))}
		"call":
			var name: String = st.get("await", "")
			var before := _count(name) if name != "" else 0
			var r: Variant = _j(plugin.op(st.name, JSON.stringify(st.get("args", {}))))
			var out := {"r": r}
			if name != "":
				out["awaited"] = await _wait_signal(name, before + int(st.get("count", 1)), int(st.get("timeout_ms", 10000)))
			return out
		"wait":
			var start := Time.get_ticks_msec()
			while Time.get_ticks_msec() - start < int(st.ms):
				await get_tree().process_frame
			return {}
		"copyIn":
			# Stand-in for the caller's download: copy an APK pushed by adb into app-private storage.
			var dst: String = OS.get_user_data_dir() + "/" + str(st.dst)
			var err := DirAccess.copy_absolute(_ext_dir() + "/" + st.src, dst)
			return {"err": err, "path": dst}
		"mount":
			var loc: Dictionary = _j(plugin.op("pad.location", JSON.stringify({"name": st.pack})))
			var ap: Variant = loc.get("assetsPath")
			if ap == null or str(ap) == "":
				return {"loc": loc, "mounted": false}
			var t := Time.get_ticks_usec()
			var ok := ProjectSettings.load_resource_pack(str(ap) + "/" + st.file)
			var dt := (Time.get_ticks_usec() - t) / 1000.0
			return {"loc": loc, "mounted": ok, "mount_ms": dt, "probe_exists": FileAccess.file_exists(st.get("probe", ""))}
	return {"error": "unknown op"}
