extends RefCounted
## Stand-ins for P5-07's GDExtension classes, with the same methods and the same
## `native_event(event, detail)` signal, emitted through call_deferred as the extensions do (their
## callbacks arrive on other threads). Each records its calls.


class Sparkle extends RefCounted:
	signal native_event(event: String, detail: Dictionary)
	var calls: Array = []
	var loaded := true
	var start_answer := {"ok": true, "can_check": true}

	func bundle_info() -> Dictionary:
		return {"sparkle_loaded": loaded, "has_public_key": true, "version": "1", "main_thread": true}

	func start(mode: String, feed: String, headers: Dictionary, channels: PackedStringArray) -> Dictionary:
		calls.append(["start", mode, feed, headers, Array(channels)])
		return start_answer

	func set_feed_url(url: String) -> void:
		calls.append(["set_feed_url", url])

	func set_http_headers(h: Dictionary) -> void:
		calls.append(["set_http_headers", h])

	func check_for_updates() -> void:
		calls.append(["check_for_updates"])

	func check_in_background() -> void:
		calls.append(["check_in_background"])

	func set_automatically_checks(on: bool) -> void:
		calls.append(["set_automatically_checks", on])

	func set_automatically_downloads(on: bool) -> void:
		calls.append(["set_automatically_downloads", on])

	func get_state() -> Dictionary:
		return {"started": true}

	func fire(event: String, detail := {}) -> void:
		call_deferred("emit_signal", "native_event", event, detail)


class Velopack extends RefCounted:
	signal native_event(event: String, detail: Dictionary)
	var calls: Array = []
	var load_answer := {"ok": true}
	var open_answer := {"ok": true, "current_version": "1.0.0", "app_id": "Game"}
	var check_answer := {"status": "available", "target": {"version": "1.0.1", "file": "Game-1.0.1-full.nupkg"}, "deltas": [{"file": "Game-1.0.1-delta.nupkg"}]}
	var download_ok := true
	var download_message := "os error 123"
	var apply_answer := {"ok": true}
	var _next := 0

	func load_library(path: String) -> Dictionary:
		calls.append(["load_library", path])
		return load_answer

	func open(url: String, headers: Dictionary) -> Dictionary:
		calls.append(["open", url, headers])
		return open_answer

	func check_async() -> int:
		_next += 1
		calls.append(["check_async"])
		var d := check_answer.duplicate()
		d["request"] = _next
		call_deferred("emit_signal", "native_event", "checked", d)
		return _next

	func download_async() -> int:
		_next += 1
		calls.append(["download_async"])
		call_deferred("emit_signal", "native_event", "progress", {"request": _next, "percent": 50})
		call_deferred("emit_signal", "native_event", "downloaded" if download_ok else "download_failed", {"request": _next, "ok": download_ok, "message": "" if download_ok else download_message})
		return _next

	func apply_on_exit(restart: bool) -> Dictionary:
		calls.append(["apply_on_exit", restart])
		return apply_answer


class WinSparkle extends RefCounted:
	signal native_event(event: String, detail: Dictionary)
	var calls: Array = []
	var load_answer := {"ok": true}

	func load(path: String) -> Dictionary:
		calls.append(["load", path])
		return load_answer

	func start(url: String, pub: String, company: String, app: String, version: String, headers: Dictionary) -> Dictionary:
		calls.append(["start", url, pub, company, app, version, headers])
		return {"ok": true}

	## Headers set again before each check (kept apart from `calls`).
	var header_sets: Array = []

	func set_headers(h: Dictionary) -> void:
		header_sets.append(h)

	func check(mode: String) -> void:
		calls.append(["check", mode])

	func fire(event: String, detail := {}) -> void:
		call_deferred("emit_signal", "native_event", event, detail)


class StoreContext extends RefCounted:
	signal native_event(event: String, detail: Dictionary)
	var calls: Array = []
	var identity := {"packaged": true, "full_name": "Pub.Game_1.0.0.0_x64__abc", "rc": 0}
	var answer := {"ok": true, "count": 1, "mandatory": false, "updates": [{"package": "Pub.Game_1.0.1.0_x64__abc", "mandatory": false}]}
	var _next := 0

	func package_identity() -> Dictionary:
		calls.append(["package_identity"])
		return identity

	func request_async(op: String, hwnd: int, silent: bool) -> int:
		_next += 1
		calls.append(["request_async", op, hwnd, silent])
		var d := answer.duplicate()
		d["request"] = _next
		d["op"] = op
		call_deferred("emit_signal", "native_event", "store_result", d)
		return _next
