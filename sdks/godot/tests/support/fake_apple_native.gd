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
## A reply that is not JSON for this op (tests the facade's bad-reply path).
var garbage_for := ""
## Ops whose result never arrives (tests the facade's timeout).
var never := PackedStringArray()

var keychain := {}
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
			return JSON.stringify({"ok": true, "protocol": 1, "platform": "ios", "appDistributor": true, "appDistributorWeb": true, "managedAssetPacks": packs_supported, "backgroundAssetsConfigured": packs_supported, "storeKit": true, "keychain": true, "entitlementsForID": true})
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
			return JSON.stringify({"ok": true})
		"kc_get":
			var key := "%s/%s" % [q.get("product"), q.get("account")]
			if keychain.get("__fail__", false):
				return JSON.stringify({"ok": false, "error": "keychain", "status": -34018})
			return JSON.stringify({"ok": true, "value": keychain.get(key)})
		"kc_set":
			if keychain.get("__fail__", false):
				return JSON.stringify({"ok": false, "error": "keychain", "status": -34018})
			keychain["%s/%s" % [q.get("product"), q.get("account")]] = q.get("value")
			return JSON.stringify({"ok": true, "op": "add"})
		"kc_delete":
			keychain.erase("%s/%s" % [q.get("product"), q.get("account")])
			return JSON.stringify({"ok": true})
		"packs_ensure", "packs_status", "packs_check_updates", "packs_remove", "packs_url", "packs_watch":
			if not packs_supported:
				return JSON.stringify({"ok": false, "unsupported": true, "reason": packs_reason, "detail": "fake: no Background Assets (%s)" % packs_reason})
			if op == "packs_ensure":
				var results := []
				for p in q.get("packs", []):
					push_event({"ev": "pack_progress", "id": p["id"], "bytes": 512, "total": 1024})
					push_event({"ev": "pack_ready", "id": p["id"], "path": "/staging/" + str(p["path"])})
					results.append({"id": p["id"], "ready": true, "path": "/staging/" + str(p["path"])})
				return _later(op, {"ok": true, "packs": results})
			if op == "packs_watch":
				return JSON.stringify({"ok": true, "id": q.get("id")})
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
