extends Node
## S-09 probe. Plans (after `--`): binding (default), kc_write, kc_read, stub.
## Every observation is one `PKAP {json}` line.

var apple: PKeyApple
var _updates: Array = []


func _ready() -> void:
	apple = PKeyApple.new()
	add_child(apple)
	apple.transaction_updated.connect(func(jws: String, info: Dictionary): _updates.append(info))
	var plan := "binding"
	for a in OS.get_cmdline_user_args() + OS.get_cmdline_args():
		if a.begins_with("--plan="):
			plan = a.substr(7)
	_log({"ev": "start", "plan": plan, "os": OS.get_name(), "engine": Engine.get_version_info().string,
		"native": ClassDB.class_exists(PKeyApple.NATIVE), "reason": PKeyApple.unsupported_reason()})
	match plan:
		"binding": await _binding()
		"kc_write": _kc_write()
		"kc_read": _kc_read()
		"stub": _stub()
		"nosession": await _nosession()
		"pollcost": _pollcost()
	_log({"ev": "done", "polls": apple.polls, "events": apple.events_seen})
	get_tree().quit()


func _log(d: Dictionary) -> void:
	d["godot_ms"] = Time.get_ticks_msec()
	var line := JSON.stringify(d)
	print("PKAP ", line)
	var f := FileAccess.open("user://pkap_log.jsonl", FileAccess.READ_WRITE if FileAccess.file_exists("user://pkap_log.jsonl") else FileAccess.WRITE)
	if f:
		f.seek_end()
		f.store_line(line)
		f.close()
	var label := get_node_or_null("Label") as Label
	if label:
		label.text += "\n" + line.left(150)


func _strip(d: Dictionary) -> Dictionary:
	# Keep the log readable: the JWS is logged once per kind, by length and prefix.
	var o := d.duplicate()
	if o.has("jws"):
		o["jws_len"] = str(o.jws).length()
		o["jws"] = str(o.jws).left(24) + "..."
	return o


func _stub() -> void:
	for op in ["distributor", "app_transaction", "purchase", "kc_get"]:
		_log({"ev": "stub", "op": op, "result": apple.call_sync({"op": op})})


func _binding() -> void:
	_log({"ev": "ping", "result": apple.call_sync({"op": "ping"})})
	var t0 := Time.get_ticks_msec()
	var r := await apple.call_async({"op": "distributor", "deadline": 2.0})
	_log({"ev": "distributor_2s", "result": r, "frame_ms": Time.get_ticks_msec() - t0})
	r = await apple.call_async({"op": "distributor", "deadline": 10.0})
	_log({"ev": "distributor_10s", "result": r})
	r = await apple.call_async({"op": "eligibility_region", "deadline": 2.0})
	_log({"ev": "eligibility_region", "result": r})
	r = await apple.call_async({"op": "app_transaction"})
	_log({"ev": "app_transaction_no_session", "result": _strip(r)})

	# StoreKit Testing inside the Godot process (probe hook; simulator only).
	var src := FileAccess.get_file_as_bytes("res://Products.storekit")
	var dst := FileAccess.open("user://Products.storekit", FileAccess.WRITE)
	dst.store_buffer(src)
	dst.close()
	r = apple.call_sync({"op": "sk_session", "path": ProjectSettings.globalize_path("user://Products.storekit")})
	_log({"ev": "sk_session", "result": r})
	r = await apple.call_async({"op": "app_transaction"})
	_log({"ev": "app_transaction_session", "result": _strip(r)})
	r = await apple.call_async({"op": "products", "ids": ["dev.polariskey.research.pack.foes", "dev.polariskey.research.gems100"]})
	_log({"ev": "products", "result": r})
	r = await apple.call_async({"op": "listen"})
	r = await apple.call_async({"op": "purchase", "product": "dev.polariskey.research.pack.foes",
		"appAccountToken": "6F2C3B1A-0000-4000-8000-00000000C0DE"})
	_log({"ev": "purchase", "result": _strip(r)})
	var tx_id := str(r.get("id", ""))
	for i in 20:
		r = await apple.call_async({"op": "entitlements"})
		var n: int = r.get("entitlements", []).size()
		_log({"ev": "entitlements_poll", "i": i, "count": n})
		if n > 0:
			break
		await get_tree().create_timer(0.25).timeout
	r = await apple.call_async({"op": "finish", "id": tx_id})
	_log({"ev": "finish", "result": r})
	r = apple.call_sync({"op": "sk_refund", "id": tx_id})
	_log({"ev": "sk_refund", "result": r})
	var t1 := Time.get_ticks_msec()
	var seen := 0
	while Time.get_ticks_msec() - t1 < 10000:
		while seen < _updates.size():
			_log({"ev": "signal_transaction_updated", "info": _strip(_updates[seen]), "after_ms": Time.get_ticks_msec() - t1})
			seen += 1
		if _updates.any(func(u): return u.get("revoked", false)):
			break
		await get_tree().process_frame
	for i in 20:
		r = await apple.call_async({"op": "entitlements"})
		var n: int = r.get("entitlements", []).size()
		_log({"ev": "entitlements_after_refund", "i": i, "count": n, "after_ms": Time.get_ticks_msec() - t1})
		if n == 0:
			break
		await get_tree().create_timer(0.25).timeout


const ACCTS := [
	["device", "afterFirstUnlockThisDeviceOnly"],
	["token", "afterFirstUnlock"],
	["wu", "whenUnlockedThisDeviceOnly"],
]


func _kc_write() -> void:
	for a in ACCTS:
		var s := apple.call_sync({"op": "kc_set", "service": "pkey:probe", "account": a[0], "value": a[0] + "-v1", "accessible": a[1]})
		_log({"ev": "kc_set", "account": a[0], "result": s})
	var g := apple.call_sync({"op": "kc_get", "service": "pkey:probe", "account": "device"})
	_log({"ev": "kc_get", "account": "device", "result": g})
	# Explicit access groups: the App Group id, and a prefix-qualified id not in the entitlements.
	for grp in ["group.dev.polariskey.research.pkap", "ABCDE12345.dev.polariskey.research.shared"]:
		var s2 := apple.call_sync({"op": "kc_set", "service": "pkey:probe", "account": "grp", "value": "x", "accessible": "afterFirstUnlock", "group": grp})
		_log({"ev": "kc_set_group", "group": grp, "result": s2})
	var f := FileAccess.open("user://device_id.txt", FileAccess.WRITE)
	f.store_string("file-v1")
	f.close()


func _kc_read() -> void:
	for a in ACCTS:
		_log({"ev": "kc_get", "account": a[0], "result": apple.call_sync({"op": "kc_get", "service": "pkey:probe", "account": a[0]})})
	_log({"ev": "file", "exists": FileAccess.file_exists("user://device_id.txt")})


func _nosession() -> void:
	# No StoreKit Testing session has ever been created for this bundle id on this simulator.
	var r := await apple.call_async({"op": "app_transaction"}, 30.0)
	_log({"ev": "app_transaction_nosession", "result": _strip(r)})
	r = await apple.call_async({"op": "app_transaction"}, 30.0)
	_log({"ev": "app_transaction_nosession_2", "result": _strip(r)})
	r = await apple.call_async({"op": "products", "ids": ["dev.polariskey.research.pack.foes"]}, 30.0)
	_log({"ev": "products_nosession", "result": r})
	r = await apple.call_async({"op": "entitlements"}, 30.0)
	_log({"ev": "entitlements_nosession", "result": r})


func _pollcost() -> void:
	for n in [1000, 10000]:
		var t0 := Time.get_ticks_usec()
		for i in n:
			apple.call_sync({"op": "poll"})
		var t1 := Time.get_ticks_usec()
		for i in n:
			apple.call_sync({"op": "ping"})
		var t2 := Time.get_ticks_usec()
		_log({"ev": "pollcost", "n": n, "poll_us_each": float(t1 - t0) / n, "ping_us_each": float(t2 - t1) / n})
