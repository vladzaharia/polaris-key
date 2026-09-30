extends Control
## S-05 (c): several packs on a single-threaded web export.
## URL query: mode=idb|mem|cache, n=<pack count>, set=<pack-set prefix>, run=<label>
##   idb: HTTPRequest.download_file into user://packs/ (IDBFS: persisted, loaded into memory at boot)
##   mem: page JS fetch() (browser HTTP cache) + Engine.copyToFS into /tmp/pk/ (MEMFS, not persisted)
##   cache: as mem, but the page keeps each pack in the Cache Storage API and reads it back from there
## Then load_resource_pack on each, verify 3 entries per pack, and POST a report to /report.

var q := {}
var packs: Array[String] = []
var rep := {}
var idx := 0
var phase := "boot"
var http: HTTPRequest
var t_dl := 0
var frames: PackedInt64Array = []
var mount_frame0 := -1
var angle := 0.0
var wait_until := 0


func js(code: String):
	return JavaScriptBridge.eval(code, true)


func _ready() -> void:
	rep["t_ready_js_ms"] = js("performance.now()")
	rep["t_script_js_ms"] = js("window.s05.t_script")
	rep["ticks_at_ready_ms"] = Time.get_ticks_msec()
	rep["ua"] = js("navigator.userAgent")
	for kv in String(js("location.search")).trim_prefix("?").split("&", false):
		var p := kv.split("=")
		q[p[0]] = p[1] if p.size() > 1 else ""
	var n := int(q.get("n", "1"))
	var set_name: String = q.get("set", "w%d" % n)
	for i in n:
		packs.append("%s_%d.pck" % [set_name, i])
	rep["q"] = q
	rep["user_dir"] = OS.get_user_data_dir()
	rep["installed_at_boot"] = _list("user://packs")
	rep["mem_at_boot"] = JSON.parse_string(js("window.s05mem()"))
	DirAccess.make_dir_recursive_absolute("user://packs")
	DirAccess.make_dir_recursive_absolute("/tmp/pk")
	rep["downloads"] = []
	phase = "fetch"
	t_dl = Time.get_ticks_usec()
	rep["t_fetch_start_ms"] = Time.get_ticks_msec()
	_next_fetch()


func _list(dir: String) -> Dictionary:
	var out := {}
	var d := DirAccess.open(dir)
	if d == null:
		return out
	for f in d.get_files():
		var fa := FileAccess.open(dir.path_join(f), FileAccess.READ)
		out[f] = fa.get_length() if fa else -1
	return out


func _target(name: String) -> String:
	return ("user://packs/" if q.get("mode", "idb") == "idb" else "/tmp/pk/") + name


func _next_fetch() -> void:
	if idx >= packs.size():
		rep["fetch_total_ms"] = (Time.get_ticks_usec() - t_dl) / 1000.0
		phase = "mount"
		idx = 0
		return
	var name := packs[idx]
	var dst := _target(name)
	t_dl = Time.get_ticks_usec() if idx == 0 else t_dl
	if q.get("mode", "idb") == "idb":
		if FileAccess.file_exists(dst):
			rep.downloads.append({"pack": name, "skipped": "already in user://"})
			idx += 1
			_next_fetch()
			return
		http = HTTPRequest.new()
		add_child(http)
		http.download_chunk_size = int(q.get("chunk", "65536"))
		# 4.7.2: with download_file set, a body of unknown length (always the case on web) is
		# deleted after a "successful" download (see the S-05 note), so dlfile=1 only demonstrates it.
		if q.get("dlfile", "0") == "1":
			http.download_file = dst + ".part"
		http.request_completed.connect(_on_dl.bind(name, dst, Time.get_ticks_usec()))
		http.request(String(js("location.origin")) + "/packs/" + name)
	else:
		js("window.s05fetch('/packs/%s', '%s', %s)" % [name, dst, "true" if q.get("mode") == "cache" else "false"])
		phase = "jsfetch"


func _on_dl(result: int, code: int, _h, _b, name: String, dst: String, t0: int) -> void:
	var ms := (Time.get_ticks_usec() - t0) / 1000.0
	rep["dbg"] = {"part_exists": FileAccess.file_exists(dst + ".part"), "dir_exists": DirAccess.dir_exists_absolute(dst.get_base_dir()), "dst": dst, "glob": ProjectSettings.globalize_path(dst), "dir_open": DirAccess.open(dst.get_base_dir()) != null, "http_file": http.download_file, "body": http.get_body_size(), "downloaded": http.get_downloaded_bytes()}
	var t1 := Time.get_ticks_usec()
	var err := OK
	if http.download_file != "":
		err = DirAccess.open(dst.get_base_dir()).rename(dst.get_file() + ".part", dst.get_file())
	else:
		var f := FileAccess.open(dst + ".part", FileAccess.WRITE)
		f.store_buffer(_b)
		f.close()
		err = DirAccess.open(dst.get_base_dir()).rename(dst.get_file() + ".part", dst.get_file())
	rep.downloads.append({"pack": name, "result": result, "code": code, "ms": ms, "write_ms": (Time.get_ticks_usec() - t1) / 1000.0, "write": error_string(err), "bytes": _b.size()})
	http.queue_free()
	idx += 1
	_next_fetch()


func _process(_d: float) -> void:
	frames.append(Time.get_ticks_usec())
	angle += 0.15
	queue_redraw()
	match phase:
		"jsfetch":
			var name := packs[idx]
			var st = JSON.parse_string(js("JSON.stringify(window.s05.fetched['%s'])" % _target(name)))
			if st and st.state != "pending":
				st["pack"] = name
				rep.downloads.append(st)
				idx += 1
				phase = "fetch"
				_next_fetch()
		"mount":
			if mount_frame0 < 0:
				mount_frame0 = frames.size()
				rep["mounts"] = []
			if idx < packs.size():
				var t := Time.get_ticks_usec()
				var ok := ProjectSettings.load_resource_pack(_target(packs[idx]), true)
				rep.mounts.append({"pack": packs[idx], "ok": ok, "ms": (Time.get_ticks_usec() - t) / 1000.0})
				idx += 1
			else:
				_verify()
				phase = "settle"
				wait_until = Time.get_ticks_msec() + int(q.get("settle_ms", "2500"))
		"settle":
			if Time.get_ticks_msec() >= wait_until:
				_report()


func _verify() -> void:
	var vr := []
	for p in packs:
		var man_path := "res://data/%s/manifest.json" % p.get_basename()
		var man = JSON.parse_string(FileAccess.get_file_as_string(man_path)) if FileAccess.file_exists(man_path) else null
		if man == null:
			vr.append({"pack": p, "manifest": "absent"})
			continue
		var keys: Array = man.keys()
		keys.sort()
		var ok := 0
		for k in [keys[0], keys[keys.size() / 2], keys[-1]]:
			var h := HashingContext.new()
			h.start(HashingContext.HASH_SHA256)
			h.update(FileAccess.get_file_as_bytes(k))
			ok += 1 if h.finish().hex_encode() == man[k] else 0
		vr.append({"pack": p, "sha_ok": "%d/3" % ok})
	rep["verify"] = vr
	var mx := 0.0
	for i in range(maxi(mount_frame0, 1), frames.size()):
		mx = maxf(mx, (frames[i] - frames[i - 1]) / 1000.0)
	rep["max_frame_during_mount_ms"] = mx


func _report() -> void:
	phase = "done"
	rep["mem_after"] = JSON.parse_string(js("window.s05mem()"))
	rep["files_user"] = _list("user://packs")
	rep["files_tmp"] = _list("/tmp/pk")
	rep["t_report_js_ms"] = js("performance.now()")
	js("window.s05report(%s)" % JSON.stringify(JSON.stringify(rep)))


func _draw() -> void:
	var c := size / 2.0
	draw_arc(c, 80.0, angle, angle + 4.2, 48, Color(0.4, 0.8, 1.0), 12.0, true)
	draw_string(ThemeDB.fallback_font, c + Vector2(-120, 140), "S-05 web %s %s" % [q.get("mode", ""), phase], HORIZONTAL_ALIGNMENT_LEFT, -1, 22)
