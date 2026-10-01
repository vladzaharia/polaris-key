class_name PKeyUpdateTestSupport
extends RefCounted
## Shared plumbing for the update groups: a loopback server driven by a per-path plan, and a
## started SDK pointed at it. A plan maps a path suffix (query excluded) to an Array of answers;
## the last answer repeats, and an answer may be a Callable(req) -> Dictionary.

const TOKEN := "pkeyt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const VECTORS := "res://tests/fixtures/release-urls.json"

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
	var path := String(req["path"]).get_slice("?", 0)
	for suffix in plan:
		if path.ends_with(suffix):
			var q: Array = plan[suffix]
			var a = q[0] if q.size() == 1 else q.pop_front()
			return a.call(req) if a is Callable else a
	return json(404, {"error": {"code": "not_found"}})


static func json(status: int, body: Variant) -> Dictionary:
	return {"status": status, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify(body)}


static func raw(status: int, body: String) -> Dictionary:
	return {"status": status, "headers": {"Content-Type": "application/json"}, "body": body}


## A started SDK. `services`: the expected services (no discovery); `version`: the host
## application's version; `token`: a held device token, or "".
func sdk(services: PackedStringArray, version := "1.2.3", token := "", product := "", tweak := Callable()) -> Node:
	var s := PKeyTestFixtures.new_sdk()
	var store := PKeyMemoryStore.new(F["device_id"], token)
	var clock := [F["now"]]
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock, product if product != "" else F["product"], F["trust"], version)
	opts.expected_services = services
	if tweak.is_valid():
		tweak.call(opts)
	var r: PKeyResult = s.configure(opts)
	if r.ok:
		await s.start()
	return s


func requests(suffix: String) -> Array:
	return server.requests.filter(func(r): return String(r["path"]).get_slice("?", 0).ends_with(suffix))


static func vectors() -> Variant:
	return PKeyTestFixtures.read_json(VECTORS)
