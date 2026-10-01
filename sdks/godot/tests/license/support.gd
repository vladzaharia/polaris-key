class_name PKeyLicenseTestSupport
extends RefCounted
## Shared plumbing for the licence groups: a loopback server driven by a per-path plan, an SDK
## pointed at it with the sync-etag-304 fixtures (real signed documents, pins and clock), and
## request filters. A plan maps a path suffix to an Array of answers; the last answer repeats,
## and an answer may be a Callable(req) -> Dictionary.

var F: Dictionary
var plan := {}
var server: PKeyFakeServer


func _init() -> void:
	F = PKeyTestFixtures.sync_docs()
	server = PKeyTestFixtures.new_server(_answer)


func ready() -> bool:
	return not F.is_empty() and server.port > 0


func free_server() -> void:
	server.queue_free()


func _answer(req: Dictionary) -> Dictionary:
	for suffix in plan:
		if String(req["path"]).ends_with(suffix):
			var q: Array = plan[suffix]
			var a = q[0] if q.size() == 1 else q.pop_front()
			return a.call(req) if a is Callable else a
	return json(404, {"error": {"code": "not_found"}})


static func json(status: int, body: Variant) -> Dictionary:
	return {"status": status, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify(body)}


static func ok_doc(jws: String, etag := "") -> Dictionary:
	return {"status": 200, "headers": {"ETag": etag} if etag != "" else {}, "body": jws}


## A document answer that serves `jws` to a bearer in `good` and 401s every other bearer.
static func doc_for(good: Array, jws: String) -> Callable:
	return func(req: Dictionary) -> Dictionary:
		var auth := String(req["headers"].get("authorization", ""))
		if good.has(auth.trim_prefix("Bearer ")):
			return ok_doc(jws)
		return json(401, {"error": {"code": "unauthorized"}})


## The trust manifest and both documents for bearers in `good`, the report accepted.
func serve_docs(good: Array) -> void:
	plan["polaris-trust.jws"] = [ok_doc(F["trust_jws"])]
	plan["/license/document"] = [doc_for(good, F["license"])]
	plan["/config/document"] = [doc_for(good, F["config"])]
	plan["/devices/report"] = [json(200, {"ok": true})]


## A started SDK over `store`, with `services` expected (empty: the default, licence and config)
## and the linux fingerprint fixture. `tweak(opts)` edits the options first.
func sdk(store: PKeyStore, services := PackedStringArray(), tweak := Callable(), version := "") -> Node:
	var s := PKeyTestFixtures.new_sdk()
	var clock := [F["now"]]
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock, F["product"], F["trust"], version if version != "" else F["version"])
	opts.expected_services = services
	if tweak.is_valid():
		tweak.call(opts)
	var r: PKeyResult = s.configure(opts)
	if r.ok:
		await s.start()
		s.devices.fingerprint_host = PKeyFakeHost.load_host("linux")
	return s


func requests(method: String, suffix: String) -> Array:
	return server.requests.filter(func(r): return r["method"] == method and String(r["path"]).ends_with(suffix))


static func body_text(req: Dictionary) -> String:
	return (req["body"] as PackedByteArray).get_string_from_utf8()


static func bearer(req: Dictionary) -> String:
	return String(req["headers"].get("authorization", "")).trim_prefix("Bearer ")
