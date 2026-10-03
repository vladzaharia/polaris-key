extends Node
## The P5-06 device probe: drives PKeyAndroid (the real PolarisKeyAndroid plugin) on an emulator or a
## device. Reads /sdcard/Android/data/<pkg>/files/plan.json, {"case": name, "steps": [...]}, runs each
## step, and writes result_<case>.json beside it after EVERY step (a self-update kills the process
## mid-plan). Steps:
##
##   caps | source | outcome            capabilities(), install_source(), launch_install_outcome()
##   keystore                           set, get, info, delete through the real AndroidKeyStore
##   update_check                       PKeyAndroid.update_check()
##   pack_status:<n> | pack_fetch:<n>   one pack; pack_fetch waits for pack_progress COMPLETED (30 s)
##   pack_mount:<n>                     pack_location → load_resource_pack → res://data/<n>/manifest.json
##   verify_wrong_hash                  apk_verify(ext/update.apk copied private, a wrong hash)
##   apk_install                        copy ext/update.apk into user://, hash it, apk_install(vc)
##   verify_public                      apk_verify straight from external storage (path_not_private)

var android: PKeyAndroid
var result := {}
var events: Array = []
var ext := ""


func _ready() -> void:
	android = PKeyAndroid.shared()
	result = {"engine": Engine.get_version_info().string, "os": OS.get_name(), "available": android.is_available()}
	if not android.is_available():
		print("PKEYPROBE|", JSON.stringify(result))
		return
	android.pack_progress.connect(func(n: String, s: Dictionary) -> void: events.append({"pack": n, "status": s.get("status")}))
	android.install_status.connect(func(s: Dictionary) -> void: events.append({"install": s.get("name")}))
	var src := android.install_source()
	ext = "/sdcard/Android/data/%s/files" % str(src.detail.get("package", ""))
	var plan: Dictionary = {}
	if FileAccess.file_exists(ext + "/plan.json"):
		var parsed = JSON.parse_string(FileAccess.get_file_as_string(ext + "/plan.json"))
		if parsed is Dictionary:
			plan = parsed
	result["case"] = plan.get("case", "none")
	# The launch reads run when the shared facade enters the tree; give them a frame.
	await get_tree().process_frame
	var steps: Array = []
	for st in plan.get("steps", []):
		var t0 := Time.get_ticks_usec()
		var r: Dictionary = await _step(str(st), plan)
		r["step"] = st
		r["ms"] = (Time.get_ticks_usec() - t0) / 1000.0
		steps.append(r)
		result["steps"] = steps
		result["events"] = events
		_write()
	result["events"] = events
	result["done"] = true
	_write()
	print("PKEYPROBE|", JSON.stringify(result))


func _write() -> void:
	var f := FileAccess.open(ext + "/result_%s.json" % result.get("case", "none"), FileAccess.WRITE)
	if f != null:
		f.store_string(JSON.stringify(result, " "))


static func _r(r: PKeyResult) -> Dictionary:
	return {"ok": r.ok, "code": String(r.code), "message": r.message, "detail": r.detail}


func _private_copy() -> String:
	var dst := "user://pkey_probe_update.apk"
	var src := ext + "/update.apk"
	if not FileAccess.file_exists(src):
		return ""
	DirAccess.copy_absolute(src, ProjectSettings.globalize_path(dst))
	return ProjectSettings.globalize_path(dst)


static func _sha256(path: String) -> String:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var h := HashingContext.new()
	h.start(HashingContext.HASH_SHA256)
	while not f.eof_reached():
		h.update(f.get_buffer(1 << 16))
	return h.finish().hex_encode()


func _step(st: String, plan: Dictionary) -> Dictionary:
	var arg := st.get_slice(":", 1) if st.contains(":") else ""
	match st.get_slice(":", 0):
		"caps":
			return _r(android.capabilities())
		"source":
			return _r(android.install_source())
		"outcome":
			return {"ok": true, "last": PKeyAndroid.launch_install_outcome(), "abandoned": PKeyAndroid.launch_abandoned_sessions()}
		"keystore":
			var s := android.keystore_set("probe", "token", "pkeyt_probe_123")
			var g := android.keystore_get("probe", "token")
			var i := android.keystore_info("probe")
			var d := android.keystore_delete("probe", "token")
			var g2 := android.keystore_get("probe", "token")
			return {"ok": s.ok and g.ok and g.detail.get("value") == "pkeyt_probe_123" and d.ok and g2.ok and g2.detail.get("value") == null, "set": _r(s), "get": _r(g), "info": _r(i), "after_delete": _r(g2)}
		"update_check":
			return _r(await android.update_check())
		"pack_status":
			return _r(await android.pack_status(arg))
		"pack_fetch":
			var r := _r(await android.pack_fetch(arg))
			var t0 := Time.get_ticks_msec()
			while Time.get_ticks_msec() - t0 < 30000:
				var done := false
				for e in events:
					if e.get("pack") == arg and e.get("status") == PKeyAndroid.PACK_COMPLETED:
						done = true
				if done:
					break
				await get_tree().process_frame
			r["completed_ms"] = Time.get_ticks_msec() - t0
			return r
		"pack_mount":
			var loc := android.pack_location(arg)
			var pck = loc.detail.get("location", {}).get("pck") if loc.ok and loc.detail.get("location") is Dictionary else null
			var t0 := Time.get_ticks_usec()
			var mounted := pck is String and ProjectSettings.load_resource_pack(pck)
			return {"ok": mounted and FileAccess.file_exists("res://data/%s/manifest.json" % arg), "location": _r(loc), "mount_ms": (Time.get_ticks_usec() - t0) / 1000.0}
		"verify_wrong_hash":
			var p := _private_copy()
			return _r(await android.apk_verify(p, "0".repeat(64), int(plan.get("versionCode", -1))))
		"verify_public":
			var p := ext + "/update.apk"
			return _r(await android.apk_verify(p, _sha256(p), int(plan.get("versionCode", -1))))
		"apk_install":
			var p := _private_copy()
			var r := _r(await android.apk_install(p, _sha256(p), int(plan.get("versionCode", -1))))
			r["can_install"] = _r(android.apk_can_install())
			return r
	return {"ok": false, "error": "unknown step"}
