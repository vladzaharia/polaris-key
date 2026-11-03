class_name PKeyFakeAndroidNative
extends RefCounted
## A stand-in for the PolarisKeyAndroid plugin: `cmd(json) -> String` with the request and reply
## shapes of sdks/godot/native/android's Commands, PlayCommands and DirectCommands, so PKeyAndroid's
## polling, request matching, signals, outlet gating and error mapping run headless.
##
## Asynchronous ops answer {"ok":true,"req":N} and queue {"ev":"result","req":N,…}, delivered by the
## NEXT {"op":"poll"} (as the native queue does). push_event() queues an unsolicited event
## (update_state, pack_state, install_status, …). JSON numbers come back as floats, as on a device.

const PLAY_OPS := [
	"iau_check", "iau_start", "iau_complete", "pad_state", "pad_fetch", "pad_location", "pad_remove", "pad_cancel", "pad_confirm",
	"integrity_prepare", "integrity_token", "pgs_code", "pgs_sign_in",
]
const DIRECT_OPS := ["pi_can_install", "pi_open_settings", "pi_verify", "pi_install", "pi_last", "pi_abandon_stale", "pi_constraints"]

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
## Where a completed pack's files live: `<assets_root>/<name>/11/11/assets`.
var assets_root := "/data/data/gg.vlad.diceroll/files/assetpacks"
## Per pack name, the statuses pad_fetch reports instead of DOWNLOADING then COMPLETED (the last
## one stays the pack's status), e.g. [2, 9] for a download that needs the user's confirmation.
var fetch_statuses := {}
## Whether pad_confirm completes a pack waiting for confirmation (else it fails, as on a sideload).
var confirm_completes := false
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

## Google sign-in (I-48.5a): whether the export carries the Credential Manager libraries, the next
## gid_* answer (without ev/req), and how often gid_sign_out ran.
var google_libraries := true
var google_result := {"ok": true, "token": "eyJ.google.token"}
var google_signed_out := 0
## Play Games (I-48.7a): whether the export carries the Play Games library, the next pgs_code answer
## (without ev/req), and what the row's pgs_sign_in answers.
var pgs_libraries := true
var pgs_result := {"ok": true, "code": "4/transcript-server-auth-code"}
var pgs_sign_in_result := {"ok": true, "authenticated": true}

## The native redirect sign-in (I-48.17b), modelling Commands' auth_open / auth_cancel: `auth_filters` are the
## redirect URIs the manifest routes to the redirect activity (the export's intent filters); `auth_opened` records
## the pages opened ({url, scheme, claimedUri, issuerHost}); `auth_launch_ok` is whether a browser starts.
## `auth_deliver(url)` is the OS handing the redirect over: queued as `auth_done` once, only while a sign-in waits.
var auth_redirect := true
var auth_filters: Array = []
var auth_opened: Array = []
var auth_launch_ok := true
var _auth_waiting: Array = []
var _auth_last := ""

## The bulk-body channel (U-41.6b): the plugin's byte[] ops, recorded. `bulk_open_ok` and `bulk_put_ok` set the
## status byte of sbOpen and of sbPut/sbGet; `sb_ops` lists `[name, header (parsed), piece size]` per call.
var bulk_open_ok := true
var bulk_put_ok := true
var sb_ops: Array = []
## Staged bytes by spool name, and the bodies sbTake gives by req.
var sb_files := {}
var sb_answers := {}

var calls: Array[Dictionary] = []
var _queue: Array[Dictionary] = []
var _req := 0
var _sb_names := 0



func _sb(name: String, header: PackedByteArray, piece := -1) -> Dictionary:
	var q = JSON.parse_string(header.get_string_from_utf8())
	var h: Dictionary = q if q is Dictionary else {}
	sb_ops.append([name, h, piece])
	return h


## A JNI singleton answers has_method() false for every plugin method (measured on an API 34 emulator,
## Godot 4.7.2) while a call works: the fake models that, so the SDK must find the methods by a call.
@warning_ignore("native_method_override")
func has_method(_name: StringName) -> bool:
	return false


# gdlint:ignore=function-name
func sbOpen(header: PackedByteArray) -> PackedByteArray:
	if header.is_empty():
		return PackedByteArray([3])
	_sb("sbOpen", header)
	return PackedByteArray([1 if bulk_open_ok else 0])


# gdlint:ignore=function-name
func sbStage(header: PackedByteArray, piece: PackedByteArray) -> PackedByteArray:
	if header.is_empty():
		return PackedByteArray([3])
	var h := _sb("sbStage", header, piece.size())
	var name: String = h.get("file", "")
	if name == "":
		_sb_names += 1
		name = "%032x" % _sb_names
		sb_files[name] = PackedByteArray()
	if not sb_files.has(name):
		return PackedByteArray([0])
	sb_files[name].append_array(piece)
	return PackedByteArray([1]) + JSON.stringify({"file": name, "size": sb_files[name].size()}).to_utf8_buffer()


# gdlint:ignore=function-name
func sbPut(header: PackedByteArray) -> PackedByteArray:
	if header.is_empty():
		return PackedByteArray([3])
	_sb("sbPut", header)
	return PackedByteArray([1 if bulk_put_ok else 0])


# gdlint:ignore=function-name
func sbGet(header: PackedByteArray) -> PackedByteArray:
	if header.is_empty():
		return PackedByteArray([3])
	_sb("sbGet", header)
	return PackedByteArray([1 if bulk_put_ok else 0])


# gdlint:ignore=function-name
func sbTake(header: PackedByteArray) -> PackedByteArray:
	if header.is_empty():
		return PackedByteArray([3])
	var h := _sb("sbTake", header)
	var req := int(h.get("req", -1))
	if not sb_answers.has(req):
		return PackedByteArray([0])
	var out: PackedByteArray = sb_answers[req]
	sb_answers.erase(req)
	return PackedByteArray([1]) + out


# gdlint:ignore=function-name
func sbCancel(header: PackedByteArray) -> PackedByteArray:
	if header.is_empty():
		return PackedByteArray([3])
	_sb("sbCancel", header)
	return PackedByteArray([1])


# gdlint:ignore=function-name
func sbEnd(header: PackedByteArray) -> PackedByteArray:
	if header.is_empty():
		return PackedByteArray([3])
	_sb("sbEnd", header)
	return PackedByteArray([1])


# gdlint:ignore=function-name
func sbClose() -> PackedByteArray:
	sb_ops.append(["sbClose", {}, -1])
	return PackedByteArray([1])


## The ops named `name`, with their parsed headers.
func sb_calls(name: String) -> Array:
	return sb_ops.filter(func(o: Array) -> bool: return o[0] == name).map(func(o: Array) -> Dictionary: return o[1])


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
			var caps := {"ok": true, "protocol": 1, "flavor": flavor, "sdk": 34, "package": "gg.vlad.diceroll", "keystore": true}
			caps.merge({"inAppUpdates": flavor == "play", "assetPacks": flavor == "play", "packageInstaller": flavor == "direct"})
			caps.merge({"playIntegrity": flavor == "play", "playGames": flavor == "play" and pgs_libraries, "googleId": flavor == "play" and google_libraries, "authRedirect": auth_redirect})
			return JSON.stringify(caps)
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
		"gid_silent", "gid_sheet", "gid_provider":
			if flavor != "play" or not google_libraries:
				return _later(op, {"ok": false, "error": "unavailable", "reason": "outlet" if flavor != "play" else "dependency"})
			return _later(op, google_result.duplicate(true))
		"auth_open":
			return JSON.stringify(_auth_open(q))
		"auth_cancel":
			_auth_waiting = []
			_auth_last = ""
			return JSON.stringify({"ok": true})
		"pgs_code", "pgs_sign_in":
			if not pgs_libraries:
				return _later(op, {"ok": false, "error": "unavailable", "reason": "dependency"})
			return _later(op, (pgs_result if op == "pgs_code" else pgs_sign_in_result).duplicate(true))
		"gid_sign_out":
			google_signed_out += 1
			return _later(op, {"ok": true, "cleared": true})
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
			var seq: Array = fetch_statuses.get(name, [2, 4])
			for st in seq:
				push_event(_ev("pack_state", _state(name, int(st))))
			packs[name] = int(seq[-1])
			return r
		"pad_location":
			var name := str(q.get("name"))
			if name == "assetPackInstallTime":
				return JSON.stringify({"ok": true, "location": {"name": name, "storageMethod": 1, "assetsPath": null, "path": null, "installTime": true, "pck": null}})
			if packs.get(name) != 4:
				return JSON.stringify({"ok": true, "location": null})
			var dir := "%s/%s/11/11/assets" % [assets_root, name]
			return JSON.stringify({"ok": true, "location": {"name": name, "storageMethod": 0, "assetsPath": dir, "path": dir.get_base_dir(), "installTime": false, "pck": "%s/%s.pck" % [dir, name]}})
		"pad_remove":
			packs[str(q.get("name"))] = 8
			return _later(op, {"ok": true})
		"pad_cancel":
			var cn := str(q.get("name"))
			if packs.has(cn) and int(packs[cn]) in [1, 2, 3, 7, 9]:
				packs[cn] = 6
				return JSON.stringify({"ok": true, "state": _state(cn, 6)})
			return JSON.stringify({"ok": true, "state": null})
		"pad_confirm":
			if confirm_completes:
				for n in packs:
					if packs[n] == 7 or packs[n] == 9:
						packs[n] = 4
						push_event(_ev("pack_state", _state(n, 4)))
				return _later(op, {"ok": true, "result": "accepted"})
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


func _auth_open(q: Dictionary) -> Dictionary:
	var url := str(q.get("url", ""))
	var host := str(q.get("issuerHost", "")).to_lower()
	var m := RegEx.create_from_string("^https://([^/?#:@]+)(/[^#]*)?$").search(url)
	if m == null or host == "" or m.get_string(1).to_lower() != host:
		return {"ok": false, "error": "auth_refused", "reason": "url"}
	var uris: Array = []
	if str(q.get("scheme", "")) != "":
		uris.append("%s:/pkey/callback" % q["scheme"])
	if str(q.get("claimedUri", "")) != "":
		uris.append(q["claimedUri"])
	if uris.is_empty():
		return {"ok": false, "error": "auth_refused", "reason": "unregistered"}
	if not uris.any(func(u): return u in auth_filters):
		return {"ok": false, "error": "auth_refused", "reason": "not-registered"}
	if not auth_launch_ok:
		return {"ok": false, "error": "auth_unavailable", "reason": "no-browser"}
	auth_opened.append({"url": url, "scheme": q.get("scheme", ""), "claimedUri": q.get("claimedUri", ""), "issuerHost": host})
	_auth_waiting = uris
	_auth_last = ""
	return {"ok": true}


func auth_deliver(url: String) -> bool:
	var base := url.get_slice("?", 0)
	if _auth_waiting.is_empty() or not (base in _auth_waiting) or not url.contains("?") or url.contains("#") or url.length() > 4096 or url == _auth_last:
		return false
	_auth_last = url
	_queue.append({"ev": "auth_done", "url": url})
	return true


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
