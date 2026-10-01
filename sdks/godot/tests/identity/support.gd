class_name PKeyIdentityTestBed
extends RefCounted
## A fake Worker for the identity groups: a PKeyFakeServer whose `/identity/auth/device/*`
## answers come from a queue (`starts`, `polls`; the last answer repeats), and whose sync
## endpoints serve the documents recorded in sync-etag-304. Time is a fake clock cell the SDK
## reads (`clock[0]`), advanced by the injected sleeper, which records every sleep.

var F: Dictionary
var server: PKeyFakeServer
var clock := [0.0]
## Seconds slept between polls, in order.
var sleeps: Array = []
## Answers for `POST …/device/start` and `POST …/device/poll`: Dictionaries (or Callables
## `func(req) -> Dictionary`); the last one repeats.
var starts: Array = []
var polls: Array = []
## Every device-flow request with the clock reading when it arrived: {path, at, body, headers}.
var flow_requests: Array = []
var sdk: Node = null


func _init() -> void:
	F = PKeyTestFixtures.sync_docs()
	clock[0] = F.get("now", 0.0)
	server = PKeyTestFixtures.new_server(_answer)


func free_all() -> void:
	if sdk != null:
		sdk.queue_free()
		sdk = null
	server.queue_free()


static func json(status: int, body: Variant) -> Dictionary:
	return {"status": status, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify(body)}


static func started(interval: Variant = 2, expires_in: Variant = 600) -> Dictionary:
	return json(200, {
		"status": "pending",
		"deviceCode": "SECRETDEVICECODE0000001",
		"userCode": "WDJB-MJHT",
		"verificationUri": "https://key.plrs.im/djdl/identity/auth/device",
		"verificationUriComplete": "https://key.plrs.im/djdl/identity/auth/device?user_code=WDJB-MJHT",
		"expiresIn": expires_in,
		"interval": interval,
		"pollUrl": "https://key.plrs.im/djdl/identity/auth/device/poll",
	})


static func state(s: String, extra: Dictionary = {}) -> Dictionary:
	var b := {"status": s}
	b.merge(extra)
	return json(200, b)


const TOKEN := "pkeyt_SIGNEDINSIGNEDINSIGNEDINSIGNEDINSIGNEDIN0"


func _answer(req: Dictionary) -> Dictionary:
	var path := String(req["path"])
	if path.ends_with("/identity/auth/device/start") or path.ends_with("/identity/auth/device/poll"):
		var parsed := PKeyJson.parse_bytes(req["body"])
		flow_requests.append({"path": path, "at": clock[0], "body": parsed["value"] if parsed["ok"] else null, "headers": req["headers"]})
		var q: Array = starts if path.ends_with("/start") else polls
		if q.is_empty():
			return {"status": 500}
		var a = q[0] if q.size() == 1 else q.pop_front()
		return a.call(req) if a is Callable else a
	if path.ends_with("/.well-known/polaris-trust.jws"):
		return {"status": 200, "headers": {"Content-Type": "application/jose"}, "body": F["trust_jws"]}
	if path.ends_with("/license/document"):
		return {"status": 200, "headers": {"Content-Type": "application/jwt", "ETag": F["license_etag"]}, "body": F["license"]}
	if path.ends_with("/config/document"):
		return {"status": 200, "headers": {"Content-Type": "application/jwt", "ETag": F["config_etag"]}, "body": F["config"]}
	if path.ends_with("/devices/report"):
		return json(200, {"ok": true})
	return json(404, {"error": {"code": "not_found"}})


## A started SDK on the fake Worker. `services`: the expected services (no discovery).
func make_sdk(token := "", services := PackedStringArray(["license", "config", "identity"]), fake_time := true) -> Node:
	if sdk != null:
		sdk.queue_free()
	sdk = PKeyTestFixtures.new_sdk()
	var store := PKeyMemoryStore.new(F["device_id"], token)
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock, F["product"], F["trust"], F["version"])
	opts.expected_services = services
	sdk.configure(opts)
	await sdk.start()
	sdk.devices.fingerprint_host = PKeyFakeHost.load_host("linux")
	if fake_time:
		sdk.identity.sleeper = func(seconds: float) -> void:
			sleeps.append(seconds)
			clock[0] += seconds
			await (Engine.get_main_loop() as SceneTree).process_frame
	return sdk


func polls_sent() -> Array:
	return flow_requests.filter(func(r): return String(r["path"]).ends_with("/poll"))


func count(method: String, suffix: String) -> int:
	return server.requests.filter(func(r): return r["method"] == method and String(r["path"]).ends_with(suffix)).size()


## Every `sign_in_finished` result `identity` emits, appended to the returned Array. Connect it
## BEFORE begin_sign_in: a start that fails emits during the call.
static func record(identity: PKeyIdentity) -> Array:
	var box := []
	identity.sign_in_finished.connect(func(r: PKeySignInResult) -> void: box.append(r))
	return box


## Lets frames pass until `cond` is true (or `max_frames` passed). Returns `cond`'s last value.
static func until(cond: Callable, max_frames := 600) -> bool:
	var tree := Engine.get_main_loop() as SceneTree
	for i in max_frames:
		if cond.call():
			return true
		await tree.process_frame
	return cond.call()
