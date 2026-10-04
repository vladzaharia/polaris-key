class_name PKeyFakeAndroidNative
extends RefCounted
## A stand-in for the PolarisKeyAndroid plugin: `cmd(json) -> String` with the request and reply
## shapes of sdks/godot/native/android's Commands, PlayCommands and DirectCommands, so PKeyAndroid's
## polling, request matching, signals, outlet gating and error mapping run headless.
##
## Asynchronous ops answer {"ok":true,"req":N} and queue {"ev":"result","req":N,…}, delivered by the
## NEXT {"op":"poll"} (as the native queue does). push_event() queues an unsolicited event
## (update_state, pack_state, install_status, …). JSON numbers come back as floats, as on a device.

## `play` or `direct`: which flavour's ops answer (the other's are unsupported, reason outlet).
var flavor := "play"
## getInstallSourceInfo's installing package.
var installer: Variant = "com.android.vending"
## The iau_check result (without ev/req), or a failure when `check_fails`.
var update := {"availability": 2, "availableVersionCode": 11, "installStatus": 0, "priority": 4, "stalenessDays": null, "flexibleAllowed": true, "immediateAllowed": true, "bytesDownloaded": 0, "totalBytes": 0, "readyToComplete": false, "inProgress": false}
var check_fails := false
## Whether iau_start starts a flow.
var start_ok := true
## Pack statuses by name; a fetched pack goes PENDING then COMPLETED (listener events).
var packs := {"foes": 8}
## What pi_verify refuses (empty: ok).
var refuse: Array = []
## The journaled last install (pi_last), or null.
var last_install: Variant = null
var abandoned := 0
## Keystore values by "<product>/<account>"; `ks_fail` makes every ks op fail; `ks_reset` answers
## that reset on the next ks_get.
var keystore := {}
var ks_fail := false
var ks_reset := ""
## Ops whose result never arrives (tests the facade's timeout).
var never := PackedStringArray()
## A reply that is not JSON for this op.
var garbage_for := ""
## Play Integrity (P6-02): the StandardIntegrityErrorCode the next integrity_token fails with (0:
## success, which answers `token:<cloudProjectNumber>:<requestHash>`).
var integrity_error := 0

var calls: Array[Dictionary] = []
var _queue: Array[Dictionary] = []
var _req := 0

const PLAY_OPS := ["iau_check", "iau_start", "iau_complete", "pad_state", "pad_fetch", "pad_location", "pad_remove", "pad_cancel", "pad_confirm", "integrity_prepare", "integrity_token"]
const DIRECT_OPS := ["pi_can_install", "pi_open_settings", "pi_verify", "pi_install", "pi_last", "pi_abandon_stale", "pi_constraints"]


func push_event(ev: Dictionary) -> void:
	_queue.append(ev)


func ops_called(op: String) -> int:
	var n := 0
	for c in calls:
		if c.get("op") == op:
			n += 1
	return n


## The last request with `op`, or {}.
func last_call(op: String) -> Dictionary:
	for i in range(calls.size() - 1, -1, -1):
		if calls[i].get("op") == op:
			return calls[i]
	return {}


func cmd(json: String) -> String:
	var q = JSON.parse_string(json)
	if not (q is Dictionary):
		return JSON.stringify({"ok": false, "error": "bad_request"})
	calls.append(q)
	var op := str(q.get("op", ""))
	if op == garbage_for:
		return "not json"
	if (PLAY_OPS.has(op) and flavor != "play") or (DIRECT_OPS.has(op) and flavor != "direct"):
		return JSON.stringify({"ok": false, "unsupported": true, "reason": "outlet", "detail": "%s needs the other build" % op})
	match op:
		"poll":
			var out := _queue.duplicate()
			_queue.clear()
			return JSON.stringify({"ok": true, "dropped": 0, "events": out})
		"capabilities":
			return JSON.stringify({"ok": true, "protocol": 1, "flavor": flavor, "sdk": 34, "package": "gg.vlad.diceroll", "keystore": true, "inAppUpdates": flavor == "play", "assetPacks": flavor == "play", "packageInstaller": flavor == "direct", "playIntegrity": flavor == "play"})
		"install_source":
			return JSON.stringify({"ok": true, "installer": installer, "initiator": installer, "initiatorCertSha256": null, "packageSource": 0, "updateOwner": null, "selfUpdated": false, "sdk": 34})
		"ks_get":
			if ks_fail:
				return JSON.stringify({"ok": false, "error": "keystore", "reason": "keystore", "message": "AndroidKeyStore unavailable"})
			var reset := ks_reset
			ks_reset = ""
			if reset != "":
				keystore.clear()
			return JSON.stringify({"ok": true, "value": keystore.get(_k(q)), "reset": reset if reset != "" else null})
		"ks_set":
			if ks_fail:
				return JSON.stringify({"ok": false, "error": "keystore", "reason": "keystore", "message": "AndroidKeyStore unavailable"})
			keystore[_k(q)] = q["value"]
			return JSON.stringify({"ok": true})
		"ks_delete":
			if ks_fail:
				return JSON.stringify({"ok": false, "error": "keystore", "reason": "io", "message": "cannot delete"})
			var existed := keystore.has(_k(q))
			keystore.erase(_k(q))
			return JSON.stringify({"ok": true, "existed": existed})
		"ks_info":
			return JSON.stringify({"ok": true, "alias": "pkey:%s:device" % q.get("product"), "backend": "AndroidKeyStore", "exists": true, "securityLevel": 1})
		"iau_check":
			if check_fails:
				return _later(op, {"ok": false, "error": "unavailable", "exception": "com.google.android.play.core.appupdate.internal.zzy", "message": "Failed to bind to the service.", "installErrorCode": null})
			var r := update.duplicate()
			r["ok"] = true
			return _later(op, r)
		"iau_start":
			return _later(op, {"ok": true, "started": start_ok, "reason": null if start_ok else "refused", "preconditions": []})
		"iau_complete":
			return _later(op, {"ok": true})
		"pad_state":
			var name := str(q.get("name"))
			if not packs.has(name):
				return _later(op, {"ok": false, "error": "pack_failed", "exception": "LocalTestingException", "message": "No APKs available for pack", "errorCode": null})
			return _later(op, {"ok": true, "state": _state(name, packs[name])})
		"pad_fetch":
			var name := str(q.get("name"))
			var r := _later(op, {"ok": true, "state": _state(name, 1)})
			packs[name] = 4
			push_event(_ev("pack_state", _state(name, 2)))
			push_event(_ev("pack_state", _state(name, 4)))
			return r
		"pad_location":
			var name := str(q.get("name"))
			if name == "assetPackInstallTime":
				return JSON.stringify({"ok": true, "location": {"name": name, "storageMethod": 1, "assetsPath": null, "path": null, "installTime": true, "pck": null}})
			if packs.get(name) != 4:
				return JSON.stringify({"ok": true, "location": null})
			var dir := "/data/data/gg.vlad.diceroll/files/assetpacks/%s/11/11/assets" % name
			return JSON.stringify({"ok": true, "location": {"name": name, "storageMethod": 0, "assetsPath": dir, "path": dir.get_base_dir(), "installTime": false, "pck": "%s/%s.pck" % [dir, name]}})
		"pad_remove":
			packs[str(q.get("name"))] = 8
			return _later(op, {"ok": true})
		"pad_cancel":
			return JSON.stringify({"ok": true, "state": null})
		"pad_confirm":
			return _later(op, {"ok": false, "error": "pack_failed", "exception": "AssetPackException", "message": "not installed by Play", "errorCode": -14})
		"integrity_prepare":
			return _later(op, {"ok": true, "prepared": true})
		"integrity_token":
			if integrity_error != 0:
				var code := integrity_error
				integrity_error = 0
				return _later(op, {"ok": false, "error": "integrity", "exception": "StandardIntegrityException", "message": "fake", "errorCode": code})
			return _later(op, {"ok": true, "token": "token:%s:%s" % [q.get("cloudProjectNumber"), q.get("requestHash")], "prepared": true, "reprepared": false})
		"pi_can_install":
			return JSON.stringify({"ok": true, "canInstall": true})
		"pi_open_settings":
			return _later(op, {"ok": true, "started": true})
		"pi_verify":
			return _later(op, {"ok": true, "verify": {"ok": refuse.is_empty(), "refused": refuse, "path": q.get("path"), "sha256": q.get("sha256")}})
		"pi_install":
			if not refuse.is_empty():
				return _later(op, {"ok": true, "committed": false, "session": null, "applied": {}, "error": null, "verify": {"ok": false, "refused": refuse}})
			return _later(op, {"ok": true, "committed": true, "session": 7, "applied": {"userActionNotRequired": true}, "error": null, "verify": {"ok": true, "refused": []}})
		"pi_last":
			var r := {"ok": true, "last": last_install}
			if q.get("clear", false):
				last_install = null
			return JSON.stringify(r)
		"pi_abandon_stale":
			return JSON.stringify({"ok": true, "abandoned": abandoned})
		"pi_constraints":
			return _later(op, {"ok": true, "satisfied": null})
	return JSON.stringify({"ok": false, "error": "unknown_op", "message": op})


static func _k(q: Dictionary) -> String:
	return "%s/%s" % [q.get("product"), q.get("account")]


static func _state(name: String, status: int) -> Dictionary:
	return {"name": name, "status": status, "errorCode": 0, "bytesDownloaded": 5000000 if status >= 2 else 0, "totalBytes": 5000000, "transferPercent": 100 if status == 4 else 0, "needsConfirmation": status == 7 or status == 9}


static func _ev(name: String, body: Dictionary) -> Dictionary:
	var e := body.duplicate()
	e["ev"] = name
	return e


func _later(op: String, result: Dictionary) -> String:
	_req += 1
	if not never.has(op):
		var e := result.duplicate()
		e["ev"] = "result"
		e["req"] = _req
		_queue.append(e)
	return JSON.stringify({"ok": true, "req": _req})
