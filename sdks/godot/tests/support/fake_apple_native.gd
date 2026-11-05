class_name PKeyFakeAppleNative
extends RefCounted
## A stand-in for the PolarisKeyApple GDExtension: `cmd(json) -> String` with the same request
## and reply shapes as PolarisKeyPlatform's router (sdks/swift/Sources/PolarisKeyPlatform/
## Host.swift), so PKeyApple's polling, request matching, signals and error mapping run headless.
##
## Asynchronous ops answer {"ok":true,"req":N} and queue their result event, delivered by the
## NEXT {"op":"poll"} (as the native queue does: never in the same call). push_event() queues an
## unsolicited event (transaction_updated, pack_progress, …).

## The distributor answer (the `distributor` op's result, without ev/req).
var distributor := {"ok": true, "signal": "appStore", "ms": 3, "provisioned": false, "altBundleIdentifier": null, "bundleIdentifier": "gg.vlad.diceroll"}
## Products the "store" knows.
var catalog := [
	{"id": "gg.vlad.diceroll.pack.foes", "type": "Non-Consumable", "displayName": "Foes pack", "displayPrice": "$4.99", "price": "4.99"},
]
## Whether managed asset packs answer (false: unsupported with `packs_reason`).
var packs_supported := true
var packs_reason := "outlet"
## Where downloaded asset packs' files live (`packs_ensure`'s paths, `packs_url`'s answers).
var staging_root := "/staging"
## Asset-pack ids `packs_ensure` answers not ready, with this error.
var not_ready := {}
## Asset-pack ids made ready by `packs_ensure` in this run.
var ensured: Array = []
## Whether `capabilities` reports StoreKit.
var store_kit := true
## A reply that is not JSON for this op (tests the facade's bad-reply path).
var garbage_for := ""
## Ops whose result never arrives (tests the facade's timeout).
var never := PackedStringArray()
## Sign in with Apple (I-48.4a): the next `apple_sign_in` answer (without ev/req), the stored user
## id (`apple_remember`) and the state the stored id is in. `apple_supported` false answers unsupported.
var apple_supported := true
var apple_result := {"ok": true, "token": "eyJ.apple.token", "userID": "001234.abcd"}
var apple_user_id := ""
var apple_state := "authorized"
## Game Center (I-48.6a), the opt-in extension: the next `gc_identity` answer (without ev/req).
var gc_result := {
	"ok": true, "publicKeyUrl": "https://static.gc.apple.com/public-key/gc-prod-12.cer", "signature": "AQID", "salt": "UEtleQECAwQ",
	"timestamp": "1699999995000", "teamPlayerId": "T:transcript-team-player-1", "bundleId": "com.acme.mac",
}

## App Attest (P6-02): whether it runs here, the keys the "system" knows (generated ones are added;
## clear it to model a reinstall), and a failure code the next attest answers.
var app_attest_supported := true
var attest_keys: Array[String] = []
var attest_fail := ""
var _key_serial := 0

var keychain := {}
## The backed-up items (bk_* ops), keyed "restore:<product>" / "sync:<product>:<subject>:<ring>". `backup_status` set
## answers every bk_* call {ok:false, error:"unavailable", status} (no entitlement).
var backup := {}
var backup_status := 0
## The `keychain` argument of every kc_* call, in order ("" when absent): SP-27's macOS backend
## asks for the login keychain.
var keychain_flavors: Array[String] = []
var calls: Array[Dictionary] = []
var finished: Array[String] = []
var _queue: Array[Dictionary] = []
var _req := 0


func push_event(ev: Dictionary) -> void:
	_queue.append(ev)


func cmd(json: String) -> String:
	var q = JSON.parse_string(json)
	if not (q is Dictionary):
		return JSON.stringify({"ok": false, "error": "bad_json"})
	calls.append(q)
	var op := str(q.get("op", ""))
	if op == garbage_for:
		return "not json"
	match op:
		"poll":
			var out := _queue.duplicate()
			_queue.clear()
			return JSON.stringify({"ok": true, "dropped": 0, "events": out})
		"ping":
			return JSON.stringify({"ok": true, "mainThread": true, "protocol": 1})
		"capabilities":
			return JSON.stringify({"ok": true, "protocol": 1, "platform": "ios", "appDistributor": true, "appDistributorWeb": true, "managedAssetPacks": packs_supported, "backgroundAssetsConfigured": packs_supported, "storeKit": store_kit, "keychain": true, "entitlementsForID": true, "appAttest": app_attest_supported, "appleSignIn": apple_supported})
		"distributor":
			return _later(op, distributor.duplicate(true))
		"app_transaction":
			return _later(op, {"ok": true, "jws": "a.b.c", "environment": "Xcode", "originalAppVersion": "1", "appTransactionID": "0", "verified": true})
		"products":
			var found := []
			for p in catalog:
				if (q.get("ids", []) as Array).has(p["id"]):
					found.append(p)
			return _later(op, {"ok": true, "products": found})
		"purchase":
			if not catalog.any(func(p): return p["id"] == q.get("product")):
				return _later(op, {"ok": false, "error": "product_not_loaded", "product": q.get("product")})
			var token = q.get("appAccountToken")
			return _later(op, {"ok": true, "result": "success", "confirmIn": "scene", "transaction": {"id": "1000000000000000042", "productID": q["product"], "jws": "h.p.s", "appAccountToken": str(token).to_lower() if token != null else null, "revoked": false}})
		"entitlements":
			return _later(op, {"ok": true, "entitlements": []})
		"finish":
			finished.append(str(q.get("id")))
			return _later(op, {"ok": true, "finished": true})
		"listen":
			return _later(op, {"ok": true})
		"app_attest_supported":
			if not app_attest_supported:
				return JSON.stringify({"ok": false, "unsupported": true, "reason": "runtime", "detail": "fake: App Attest is not supported"})
			return JSON.stringify({"ok": true, "supported": true})
		"app_attest_attest", "app_attest_assert":
			if not app_attest_supported:
				return JSON.stringify({"ok": false, "unsupported": true, "reason": "runtime", "detail": "fake: App Attest is not supported"})
			var key = q.get("keyId")
			var generated := false
			if op == "app_attest_attest" and not (key is String):
				_key_serial += 1
				key = Marshalls.utf8_to_base64("fake-key-%d" % _key_serial)
				attest_keys.append(key)
				generated = true
			if attest_fail != "":
				var code := attest_fail
				attest_fail = ""
				return _later(op, {"ok": false, "error": code, "message": "fake " + code, "keyId": key, "generated": generated})
			if not attest_keys.has(key):
				return _later(op, {"ok": false, "error": "invalid_key", "message": "fake: unknown key", "keyId": key, "generated": generated})
			if op == "app_attest_assert":
				return _later(op, {"ok": true, "keyId": key, "assertion": Marshalls.utf8_to_base64("assertion:%s" % key)})
			return _later(op, {"ok": true, "keyId": key, "attestation": Marshalls.utf8_to_base64("attestation:%s:%s" % [key, q.get("requestHash")]), "generated": generated, "ms": 1})
		"gc_identity":
			return _later(op, gc_result.duplicate(true))
		"apple_sign_in", "apple_credential_state", "apple_remember", "apple_forget":
			if not apple_supported:
				return JSON.stringify({"ok": false, "unsupported": true, "reason": "runtime", "detail": "fake: no Sign in with Apple"})
			if op == "apple_sign_in":
				return _later(op, apple_result.duplicate(true))
			if op == "apple_credential_state":
				return _later(op, {"ok": true, "state": apple_state if apple_user_id != "" else "none"})
			if op == "apple_remember":
				apple_user_id = str(q.get("userID", ""))
			else:
				apple_user_id = ""
			return JSON.stringify({"ok": true})
		"bk_get", "bk_set", "bk_delete":
			if backup_status != 0:
				return JSON.stringify({"ok": false, "error": "unavailable", "status": backup_status})
			var bkey := "%s:%s" % [q.get("item"), q.get("product")]
			if q.get("item") == "sync":
				bkey += ":%s:%s" % [q.get("subject"), q.get("ringId")]
			if op == "bk_get":
				return JSON.stringify({"ok": true, "value": backup.get(bkey)})
			if op == "bk_set":
				backup[bkey] = q.get("value")
			else:
				backup.erase(bkey)
			return JSON.stringify({"ok": true})
		"kc_get":
			keychain_flavors.append(str(q.get("keychain", "")))
			var key := "%s/%s" % [q.get("product"), q.get("account")]
			if keychain.get("__fail__", false):
				return JSON.stringify({"ok": false, "error": "keychain", "status": -34018})
			return JSON.stringify({"ok": true, "value": keychain.get(key)})
		"kc_set":
			keychain_flavors.append(str(q.get("keychain", "")))
			if keychain.get("__fail__", false):
				return JSON.stringify({"ok": false, "error": "keychain", "status": -34018})
			keychain["%s/%s" % [q.get("product"), q.get("account")]] = q.get("value")
			return JSON.stringify({"ok": true, "op": "add"})
		"kc_delete":
			keychain_flavors.append(str(q.get("keychain", "")))
			keychain.erase("%s/%s" % [q.get("product"), q.get("account")])
			return JSON.stringify({"ok": true})
		"packs_ensure", "packs_status", "packs_check_updates", "packs_remove", "packs_url", "packs_watch", "packs_unwatch":
			if not packs_supported:
				return JSON.stringify({"ok": false, "unsupported": true, "reason": packs_reason, "detail": "fake: no Background Assets (%s)" % packs_reason})
			if op == "packs_ensure":
				var results := []
				for p in q.get("packs", []):
					var path := staging_root.path_join(str(p["path"]))
					if not_ready.has(p["id"]):
						push_event({"ev": "pack_failed", "id": p["id"], "err": str(not_ready[p["id"]])})
						results.append({"id": p["id"], "ready": false, "error": str(not_ready[p["id"]])})
						continue
					ensured.append(p["id"])
					push_event({"ev": "pack_progress", "id": p["id"], "bytes": 512, "total": 1024})
					push_event({"ev": "pack_ready", "id": p["id"], "path": path})
					results.append({"id": p["id"], "ready": true, "path": path})
				return _later(op, {"ok": true, "packs": results})
			if op == "packs_url":
				var path := staging_root.path_join(str(q.get("path", "")))
				return _later(op, {"ok": true, "path": path, "exists": FileAccess.file_exists(path) or DirAccess.dir_exists_absolute(path)})
			if op == "packs_watch" or op == "packs_unwatch":
				return _later(op, {"ok": true, "id": q.get("id")})
			return _later(op, {"ok": true})
	return JSON.stringify({"ok": false, "error": "unknown_op", "op": op})


func _later(op: String, result: Dictionary) -> String:
	_req += 1
	if not never.has(op):
		var ev := result.duplicate(true)
		ev["ev"] = op
		ev["req"] = _req
		_queue.append(ev)
	return JSON.stringify({"ok": true, "req": _req})


## A stand-in for the binary entry's Cloud Sync bulk ops (`sb_*`; sdks/swift PolarisKeyPlatform/SyncBulkOps.swift),
## with the same framing, bounds and replies, so PKeyAppleBulk runs headless. Tasks finish when the test says
## (`finish`, `fail`), or at once with `auto_status`. Every payload is kept in `payloads`, so a test can assert
## what crossed the boundary.
class Bulk:
	extends RefCounted

	const OK := 1
	const REFUSED := 0
	const BAD := 3
	const MAX_TASKS := 300

	## Replies 0 (refused) to `sb_open`, or to `sb_put` and `sb_get`.
	var refuse_open := false
	var refuse_requests := false
	## The reconcile report `sb_open` queues; null: none is sent.
	var report: Variant = {"resume": [], "cancelled": 0, "swept": 0}
	## A status that answers every accepted request at once (-1: the test answers).
	var auto_status := -1
	var auto_body := PackedByteArray()
	## Every op in order: [op, payload bytes].
	var payloads: Array = []
	## The buffers as passed, not copies: a caller that zeroes one afterwards shows here. [op, buffer].
	var held: Array = []
	var ops: Array[String] = []
	var open_args: Dictionary = {}
	var staged := {}
	var tasks := {}
	var puts: Array = []
	var gets: Array = []
	var cancels: Array = []
	var closed := 0
	var _events: Array = []
	var _serial := 0

	func cmd_bin(op: String, data: PackedByteArray) -> Variant:
		ops.append(op)
		payloads.append([op, data.duplicate()])
		held.append([op, data])
		match op:
			"sb_open":
				return _open(data)
			"sb_stage":
				return _stage(data)
			"sb_put", "sb_get":
				return _request(op, data)
			"sb_cancel":
				return _cancel(data)
			"sb_close":
				closed += 1
				tasks.clear()
				staged.clear()
				return PackedByteArray([OK])
		return PackedByteArray()

	func _open(data: PackedByteArray) -> PackedByteArray:
		var j: Variant = JSON.parse_string(data.get_string_from_utf8())
		if refuse_open or not (j is Dictionary):
			return PackedByteArray([REFUSED])
		open_args = j
		if report != null:
			_events.append(["sb_reconciled", JSON.stringify(report).to_utf8_buffer()])
		return PackedByteArray([OK])

	func _stage(data: PackedByteArray) -> PackedByteArray:
		if data.size() < 1 or data.size() - 1 > 8 * 1048576 + 36:
			return PackedByteArray([BAD])
		var n := int(data[0])
		var name := ""
		if n == 0:
			_serial += 1
			name = "%032x.bin" % _serial
			staged[name] = PackedByteArray()
		else:
			name = data.slice(1, 37).get_string_from_ascii()
		var cur: Variant = staged.get(name)
		var piece := data.slice(1 + n)
		if cur == null or (cur as PackedByteArray).size() + piece.size() > 16 * 1048576:
			return PackedByteArray([REFUSED])
		var buf: PackedByteArray = cur
		buf.append_array(piece)
		staged[name] = buf
		var out := PackedByteArray([OK])
		out.append_array(name.to_ascii_buffer())
		return out

	func _request(op: String, data: PackedByteArray) -> PackedByteArray:
		var hdr := (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3] if data.size() >= 4 else 0
		if hdr <= 0 or hdr > 16 * 1024 or data.size() != 4 + hdr:
			return PackedByteArray([BAD])
		var h: Variant = JSON.parse_string(data.slice(4).get_string_from_utf8())
		var put := op == "sb_put"
		if not (h is Dictionary) or refuse_requests or tasks.size() >= MAX_TASKS or (put and not staged.has(h.get("spool", ""))):
			return PackedByteArray([REFUSED])
		var req := int(h["req"])
		var rec: Dictionary = (h as Dictionary).duplicate()
		if put:
			rec["body"] = staged[h["spool"]]
			staged.erase(h["spool"])
			puts.append(rec)
		else:
			gets.append(rec)
		tasks[req] = rec
		if auto_status >= 0:
			finish(req, auto_status, {"etag": "\"e\""}, auto_body)
		return PackedByteArray([OK])

	func _cancel(data: PackedByteArray) -> PackedByteArray:
		var c: Variant = JSON.parse_string(data.get_string_from_utf8())
		if not (c is Dictionary):
			return PackedByteArray([BAD])
		cancels.append(c)
		if c.has("req"):
			tasks.erase(int(c["req"]))
		if c.has("transfer"):
			for r in tasks.keys():
				if tasks[r].get("transfer") == c["transfer"]:
					tasks.erase(r)
		if c.has("spool"):
			staged.erase(c["spool"])
		return PackedByteArray([OK])

	## An event left in the native queue, as an earlier session may have left it.
	func queue_event(kind: String, data: PackedByteArray) -> void:
		_events.append([kind, data])

	func poll_bin() -> Variant:
		var out := _events
		_events = []
		return out

	## The task of `req` finishes with an answer: the `sb_done` event (`u32be length ‖ JSON ‖ body`).
	func finish(req: int, status: int, headers := {}, body := PackedByteArray()) -> void:
		tasks.erase(req)
		var json := JSON.stringify({"req": req, "status": status, "headers": headers}).to_utf8_buffer()
		var frame := PackedByteArray([(json.size() >> 24) & 0xff, (json.size() >> 16) & 0xff, (json.size() >> 8) & 0xff, json.size() & 0xff])
		frame.append_array(json)
		frame.append_array(body)
		_events.append(["sb_done", frame])

	func fail(req: int, code: String) -> void:
		tasks.erase(req)
		_events.append(["sb_fail", JSON.stringify({"req": req, "code": code}).to_utf8_buffer()])
