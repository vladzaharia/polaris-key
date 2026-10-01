extends Node
## S-01 probe: obtains asset packs through AssetPackManager (via the PKAppleBA GDExtension shim)
## and mounts the .pck inside each with ProjectSettings.load_resource_pack.
##
## Plans (pass after `--` on the command line, e.g. `-- --plan=update`):
##   install  (default) contents-before-ensure probe, then ensure → url → mount for every pack
##   update   check_updates, then ensure(latest) → url → mount, reporting the marker's version
##   mount    url → mount only (no ensure): does a previous session's download resolve?
##   live     mount the three small packs, then check_updates + ensure(latest) while they stay
##            mounted, then re-read hello.json from the old mount, then remount: what happens
##            to a mounted .pck when the system replaces it at the same path?
##   emulate  no Background Assets download: mount packs that the harness copied into the App Group
##            container (<container>/pkba-emul/<pack-id>/pkba/<role>/content.pck). Measures the
##            GDScript half (load_resource_pack from a path outside the bundle) on the simulator.
##
## Every event is printed as one `PKBA {json}` line and appended to user://pkba_log.jsonl.

const PACKS := [
	{"role": "essential", "id": "pkba-essential-c1"},
	{"role": "prefetch", "id": "pkba-prefetch-c1"},
	{"role": "ondemand", "id": "pkba-ondemand-c1"},
	# The A6 36 MiB v1/v2 pair (onDemand). It carries a whole project, so it is mounted with
	# replace_files=false and only probed for presence.
	{"role": "big", "id": "pkba-big-c1"},
]
const SHIM := "PKAppleBA"

var _done := {}
var _log_file: FileAccess
var _lines: PackedStringArray = []


func _ready() -> void:
	_log_file = FileAccess.open("user://pkba_log.jsonl", FileAccess.READ_WRITE if FileAccess.file_exists("user://pkba_log.jsonl") else FileAccess.WRITE)
	if _log_file:
		_log_file.seek_end()
	var plan := "install"
	for a in OS.get_cmdline_user_args() + OS.get_cmdline_args():
		if a.begins_with("--plan="):
			plan = a.substr(7)
	_log({"ev": "start", "plan": plan, "os": OS.get_name(), "model": OS.get_model_name(),
		"engine": Engine.get_version_info().string, "shim": ClassDB.class_exists(SHIM)})
	if not ClassDB.class_exists(SHIM):
		_log({"ev": "fatal", "error": "PKAppleBA shim not loaded"})
		_finish()
		return
	await _run(plan)
	_finish()


func _run(plan: String) -> void:
	var ag := _cmd({"op": "app_group"})
	_log(ag.merged({"ev": "app_group"}))
	if plan == "emulate":
		_emulate(str(ag.get("container", "")))
		return
	if plan == "live":
		await _live()
		return
	await _req({"op": "all_packs"})
	for p in PACKS:
		await _req({"op": "local_status", "id": p.id})
		_log({"ev": "is_local", "id": p.id, "local": _cmd({"op": "is_local", "id": p.id}).get("local")})

	if plan == "install":
		# notes/E8 §6 Q1: can the marker of a prefetch pack be read before ensureLocalAvailability returns?
		var early := await _req({"op": "contents", "id": "pkba-prefetch-c1", "path": "pkba/prefetch/.pkey/pack.json"})
		_log({"ev": "early_marker", "ok": early.get("ok"), "error": early.get("error", "")})
	if plan == "update":
		await _req({"op": "check_updates"})

	for p in PACKS:
		if plan != "mount":
			await _req({"op": "ensure", "id": p.id, "latest": plan == "update"})
		await _req({"op": "local_status", "id": p.id})
		var marker := await _req({"op": "contents", "id": p.id, "path": "pkba/%s/.pkey/pack.json" % p.role})
		var u := await _req({"op": "url", "path": "pkba/%s/content.pck" % p.role})
		var rec := {"ev": "mount", "id": p.id, "url_ok": u.get("ok"), "fs_path": u.get("fs_path", ""),
			"url_ms": u.get("dt_ms"), "marker": marker.get("head", "")}
		if u.get("ok"):
			var t0 := Time.get_ticks_usec()
			var ok := ProjectSettings.load_resource_pack(u.fs_path, p.role != "big")
			rec["mount_ok"] = ok
			rec["mount_ms"] = (Time.get_ticks_usec() - t0) / 1000.0
			var probe := "res://pkba/%s/hello.json" % p.role if p.role != "big" else "res://assets/data/level_005.json"
			rec["probe_exists"] = FileAccess.file_exists(probe)
			rec["probe"] = FileAccess.get_file_as_string(probe) if rec.probe_exists else ""
		_log(rec)
	await _req({"op": "all_packs"})


func _live() -> void:
	var small := PACKS.slice(0, 3)
	for p in small:
		var u := await _req({"op": "url", "path": "pkba/%s/content.pck" % p.role})
		var ok := ProjectSettings.load_resource_pack(u.get("fs_path", ""), true)
		var f := "res://pkba/%s/hello.json" % p.role
		_log({"ev": "live_before", "id": p.id, "mount_ok": ok, "probe": FileAccess.get_file_as_string(f)})
	await _req({"op": "check_updates"})
	for p in small:
		await _req({"op": "ensure", "id": p.id, "latest": true})
		var f := "res://pkba/%s/hello.json" % p.role
		var pad := FileAccess.open("res://pkba/%s/padding.bin" % p.role, FileAccess.READ)
		_log({"ev": "live_after_update", "id": p.id, "probe": FileAccess.get_file_as_string(f),
			"open_err": FileAccess.get_open_error(), "pad_len": pad.get_length() if pad else -1,
			"pad_head": pad.get_buffer(8).hex_encode() if pad else ""})
		var u := await _req({"op": "url", "path": "pkba/%s/content.pck" % p.role})
		var ok := ProjectSettings.load_resource_pack(u.get("fs_path", ""), true)
		_log({"ev": "live_remount", "id": p.id, "mount_ok": ok, "probe": FileAccess.get_file_as_string(f)})


func _emulate(container: String) -> void:
	for p in PACKS:
		var path := "%s/pkba-emul/%s/pkba/%s/content.pck" % [container, p.id, p.role]
		var rec := {"ev": "mount", "id": p.id, "fs_path": path, "exists": FileAccess.file_exists(path)}
		var t0 := Time.get_ticks_usec()
		rec["mount_ok"] = ProjectSettings.load_resource_pack(path, p.role != "big")
		rec["mount_ms"] = (Time.get_ticks_usec() - t0) / 1000.0
		var probe := "res://pkba/%s/hello.json" % p.role if p.role != "big" else "res://assets/data/level_005.json"
		rec["probe_exists"] = FileAccess.file_exists(probe)
		rec["probe"] = FileAccess.get_file_as_string(probe).left(80) if rec.probe_exists else ""
		_log(rec)


func _cmd(q: Dictionary) -> Dictionary:
	var s: String = ClassDB.class_call_static(SHIM, "cmd", JSON.stringify(q))
	var r = JSON.parse_string(s)
	return r if r is Dictionary else {"ok": false, "error": "bad reply", "raw": s}


func _req(q: Dictionary, timeout_ms := 900000) -> Dictionary:
	var r := _cmd(q)
	if not r.has("req"):
		return r
	var req := int(r.req)
	var start := Time.get_ticks_msec()
	while Time.get_ticks_msec() - start < timeout_ms:
		_drain()
		if _done.has(req):
			return _done[req]
		await get_tree().process_frame
	var t := {"ev": "timeout", "op": q.op, "req": req}
	_log(t)
	return t


func _drain() -> void:
	var r := _cmd({"op": "poll"})
	for ev in r.get("events", []):
		_log(ev)
		if ev.has("req"):
			_done[int(ev.req)] = ev


func _log(d: Dictionary) -> void:
	d["godot_ms"] = Time.get_ticks_msec()
	var line := JSON.stringify(d)
	print("PKBA ", line)
	if _log_file:
		_log_file.store_line(line)
		_log_file.flush()
	_lines.append(line.left(160))
	var label := get_node_or_null("Label") as Label
	if label:
		label.text = "\n".join(_lines.slice(max(0, _lines.size() - 40)))


func _finish() -> void:
	_drain()
	_log({"ev": "done"})
	if _log_file:
		_log_file.close()
	get_tree().quit()
