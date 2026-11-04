extends RefCounted
# @pkey-feature identity.nearby sync.keyring
# Nearby sign-in end to end (I-48.16): two SDKs in one process, D (no sign-in) and M (signed in, holding the key ring's
# root), on one fake discovery lane and one scripted Worker. D starts a request, lists M, picks it and reads the code;
# M shows three codes and picks the matching one; `nearby/approve` carries D's ids and keys from the verified request;
# D's poll collects the token, held unconfirmed; the person confirms the account and D adopts the wrap M sent over the
# LAN, with no server copy to fall back on. A decline adopts nothing and signs D out.

const A := preload("res://tests/identity/test_nearby_approve.gd")
const B := preload("res://tests/identity/support.gd")
const N := preload("res://tests/identity/test_nearby.gd")
const R := preload("res://tests/suite_sync_ring.gd")
const E := preload("res://tests/connect/nearby_e2e.gd")

const M_DEVICE := "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM"


## The scripted Worker both devices talk to: discovery, nearby start/approve/poll, sign-out and the key ring.
class Bed extends PKeyIdentityTestBed:
	var worker := R.FakeWorker.new()
	var start_seen: Dictionary = {}
	var approved := false
	var approve_body: Dictionary = {}
	var approve_bearer := ""
	var order: Array = []
	var put_wraps := false

	func _answer(req: Dictionary) -> Dictionary:
		var path := String(req["path"])
		var parsed := PKeyJson.parse_bytes(req["body"])
		var body: Variant = parsed["value"] if parsed["ok"] else null
		if path.ends_with("/.well-known/polaris.json"):
			return json(200, discovery_doc())
		if path.contains("/identity/nearby/"):
			return _nearby(path.get_file(), req, body)
		if path.contains("/devices/keyring"):
			return _ring(req, body)
		return super._answer(req)

	func _nearby(route: String, req: Dictionary, body: Variant) -> Dictionary:
		order.append(route)
		if route == "start":
			start_seen = {"device": req["headers"].get("x-pkey-device", ""), "signKey": body["signKey"], "agreeKey": body["agreeKey"]}
			return json(201, {"request": N.REQUEST, "expiresIn": 300, "interval": 1})
		if route == "poll":
			return N.ready_answer() if approved else N.pending()
		approve_body = body
		approve_bearer = String(req["headers"].get("authorization", ""))
		var same: bool = body["request"] == N.REQUEST and body["deviceId"] == start_seen["device"]
		same = same and body["signKey"] == start_seen["signKey"] and body["agreeKey"] == start_seen["agreeKey"]
		if not (same and approve_bearer == "Bearer " + A.M_TOKEN):
			return json(404, {"error": {"code": "not_found"}})
		approved = true
		return json(200, {"status": "approved", "deviceLabel": "Den"})

	func _ring(req: Dictionary, body: Variant) -> Dictionary:
		var path := String(req["path"])
		var rel := path.substr(path.find("devices/keyring"))
		if String(req["method"]) == "PUT" and rel.contains("/wraps/") and not put_wraps:
			order.append("put-refused")
			return json(500, {"error": {"code": "server_error"}})
		var r: PKeyResult = worker._handle(String(req["headers"].get("x-pkey-device", "")), String(req["method"]), rel, body)
		if r.ok:
			return {"status": int(r.detail["status"]), "headers": {"Content-Type": "application/json"}, "body": (r.detail["body"] as PackedByteArray).get_string_from_utf8()}
		var status := int(r.detail.get("status", 500)) if r.detail is Dictionary else 500
		return json(status, {"error": {"code": String(r.code)}})

	func discovery_doc() -> Dictionary:
		var root := "%s/%s/identity" % [server.base_url(), F["product"]]
		return {"product": F["product"], "services": {"license": {"enabled": true}, "config": {"enabled": true}, "identity": {
			"enabled": true, "configured": true, "nearby": true,
			"endpoints": {"nearbyStart": root + "/nearby/start", "nearbyPoll": root + "/nearby/poll", "nearbyApprove": root + "/nearby/approve"},
		}}}


func run(t: PKeyTestContext) -> void:
	await _approve_and_confirm(t)
	await _decline(t)


func _tree() -> SceneTree:
	return Engine.get_main_loop() as SceneTree


func _until(cond: Callable, frames := 1500) -> bool:
	for i in frames:
		if cond.call():
			return true
		await _tree().process_frame
	return cond.call()


## A started SDK on the shared Worker with its own memory-only device keys.
func _device(bed: Bed, device_id: String, token: String) -> Node:
	var store := PKeyMemoryStore.new(device_id, token)
	var opts := PKeyTestFixtures.options(bed.server.base_url(), store, bed.clock, bed.F["product"], bed.F["trust"], bed.F["version"])
	opts.expected_services = PackedStringArray(["license", "config", "identity"])
	opts.device_keys = PKeyDeviceKeyStore.memory_only()
	opts.ring_vault = PKeySyncRingVault.new(bed.F["product"], "user://pkey", true)
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(opts)
	await sdk.start()
	sdk.core.discovery_manifest = bed.discovery_doc()
	sdk.identity.nearby_acquisition_sync = false
	sdk.identity.sleeper = func(seconds: float) -> void:
		bed.clock[0] += seconds
		await (Engine.get_main_loop() as SceneTree).process_frame
	return sdk


func _up(t: PKeyTestContext, put_wraps: bool) -> Dictionary:
	var bed := Bed.new()
	bed.put_wraps = put_wraps
	var lane := E.NativeBus.new()
	var m := await _device(bed, M_DEVICE, A.M_TOKEN)
	# M is signed in: a subject, and the root of the key ring.
	m.core.cache.set_subject(N.SUBJECT)
	var made: PKeyResult = await m.keyring.create(false)
	t.check("e2e: M holds the key ring's root", made.ok and m.keyring.unlocked(), str(made))
	var d := await _device(bed, bed.F["device_id"], "")
	var asks: Array = []
	var on: PKeyResult = await m.identity.nearby.on_request(func(a: PKeyNearbyAsk) -> void: asks.append(a), {"mdns": lane, "prompt": true, "allow_loopback": true})
	t.check("e2e: M advertises", on.ok, str(on))
	var made_d: PKeyResult = await d.identity.sign_in.start_nearby({"lan": {"mdns": lane, "allow_loopback": true}})
	t.check("e2e: D starts nearby sign-in", made_d.ok, str(made_d))
	return {"bed": bed, "m": m, "d": d, "asks": asks, "approver": on.detail, "session": made_d.detail}


func _pick_through(t: PKeyTestContext, up: Dictionary) -> PKeyNearbyStep:
	var s: PKeyNearbySignIn = up["session"]
	var asks: Array = up["asks"]
	t.check("e2e: D lists M", await _until(func() -> bool: return s.approvers().size() == 1))
	var chosen: PKeyResult = await s.choose(str(s.approvers()[0]["id"]))
	t.check("e2e: D shows a code", chosen.ok and s.code != "", str(chosen))
	t.check("e2e: M shows three codes, one of them D's", await _until(func() -> bool: return asks.size() == 1) and asks[0].codes.size() == 3 and asks[0].codes.has(s.code), str(asks))
	return await (asks[0] as PKeyNearbyAsk).pick(s.code)


func _approve_and_confirm(t: PKeyTestContext) -> void:
	var up := await _up(t, false)
	var bed: Bed = up["bed"]
	var s: PKeyNearbySignIn = up["session"]
	var d: Node = up["d"]
	var m: Node = up["m"]
	var step := await _pick_through(t, up)
	t.check("e2e: the matched code approves", step.kind == PKeyNearbyStep.KIND_APPROVED, str(step))
	t.check("e2e: approve carries D's device id and keys from the verified request, with M's bearer", bed.approved
		and bed.approve_body["deviceId"] == bed.start_seen["device"]
		and bed.approve_body["signKey"] == bed.start_seen["signKey"]
		and bed.approve_bearer == "Bearer " + A.M_TOKEN)
	var out: PKeySignInOutcome = await s.wait()
	t.check("e2e: D's poll collects the token, held unconfirmed", out.kind == PKeySignInOutcome.KIND_SIGNED_IN and d.core.tokens.unconfirmed(), str(out))
	t.check("e2e: before the confirmation D holds no root", not d.keyring.unlocked())
	var c: PKeyResult = await s.confirm_account()
	t.check("e2e: the confirmation signs D in", c.ok and not d.core.tokens.unconfirmed(), str(c))
	var applied := await _until(func() -> bool: return s.wrap == "applied")
	t.check("e2e: D adopts the wrap M sent over the LAN, with the Worker's copy refused", applied and d.keyring.unlocked() and not bed.worker.wraps.has(bed.start_seen["device"]), "wrap=%s" % s.wrap)
	t.check("e2e: D reads what M seals", d.keyring.codec.kid() == m.keyring.codec.kid() and d.keyring.codec.open("$settings", "v", m.keyring.codec.seal("$settings", "v", 5)).get("value") == 5.0)
	t.check("e2e: M's store of the same wrap was tried after the channel copy", bed.order.has("put-refused"), str(bed.order))
	up["approver"].stop()
	d.queue_free()
	m.queue_free()
	bed.free_all()


func _decline(t: PKeyTestContext) -> void:
	var up := await _up(t, true)
	var bed: Bed = up["bed"]
	var s: PKeyNearbySignIn = up["session"]
	var d: Node = up["d"]
	var step := await _pick_through(t, up)
	t.check("e2e decline: the approval went through", step.kind == PKeyNearbyStep.KIND_APPROVED)
	var out: PKeySignInOutcome = await s.wait()
	t.check("e2e decline: D holds the token unconfirmed", out.kind == PKeySignInOutcome.KIND_SIGNED_IN and d.core.tokens.unconfirmed())
	await s.decline_account()
	var late: PKeyResult = await s.confirm_account()
	for i in 20:
		await _tree().process_frame
	t.check("e2e decline: nothing is adopted, D is signed out and cannot confirm", not d.keyring.unlocked() and s.wrap == "none" and not late.ok and not d.core.tokens.has_token())
	t.check("e2e decline: the stored copy for D exists on the Worker (the fallback), and D did not take it", bed.worker.wraps.has(bed.start_seen["device"]) and not d.keyring.unlocked())
	up["approver"].stop()
	d.queue_free()
	(up["m"] as Node).queue_free()
	bed.free_all()
