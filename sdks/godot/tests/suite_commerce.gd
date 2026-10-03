extends RefCounted
# @pkey-feature commerce.receipt
# PolarisKey.commerce (P6-01) against a loopback server answering like the Worker: the binding
# (stored, lowercased, its product list kept), the three claim bodies exactly as the Worker reads
# them, refusals keeping the server's code and `reason`, the client-side refusals (no service, no
# token, a bad store or payload) that never reach the network, and App Store 3.1.3(b)'s outlet
# rule (`hidden_on`, `hidden_here` on an app-store outlet). The recorded conversation itself is
# replayed by suite_transcripts (conformance/transcripts/commerce-claim.json).

const TOKEN := "pkeyt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const BINDING := "F8606AE6-C6AF-419A-A7CA-125107444036"
const PRODUCTS := [
	{"store": "app-store", "productId": "gg.acme.djdl.skins", "flag": "extras.diceSkins", "deliverable": "app"},
	{"store": "steam", "productId": "1234560", "flag": "extras.diceSkins", "deliverable": "app"},
	{"store": "play", "productId": "soundtrack", "flag": "extras.ost", "deliverable": "app"},
]

var server: PKeyFakeServer
var plan := {}


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	server = PKeyTestFixtures.new_server(_answer)
	await _binding(t)
	await _claims(t)
	await _refusals(t)
	await _client_side(t)
	await _outlet_rule(t)
	server.queue_free()
	return true


func _answer(req: Dictionary) -> Dictionary:
	var path := String(req["path"])
	for suffix in plan:
		if path.ends_with(suffix):
			var a = plan[suffix]
			return a.call(req) if a is Callable else a
	return {"status": 404, "body": "{\"error\":{\"code\":\"not_found\"}}"}


func _json(status: int, body: Variant) -> Dictionary:
	return {"status": status, "headers": {"Content-Type": "application/json"}, "body": JSON.stringify(body)}


func _sdk(services := PackedStringArray(["license", "config", "release", "distribution"]), token := TOKEN, outlet := "") -> Node:
	var store := PKeyMemoryStore.new("TRANSCRIPTDEVICE0000000000000001", token)
	var clock := [1_700_000_000]
	var opts := PKeyTestFixtures.options(server.base_url(), store, clock)
	opts.expected_services = services
	if outlet != "":
		opts.update_outlet = outlet
	var sdk := PKeyTestFixtures.new_sdk()
	sdk.configure(opts)
	await sdk.start()
	return sdk


func _last(suffix: String) -> Dictionary:
	var hits: Array = server.requests.filter(func(r): return String(r["path"]).ends_with(suffix))
	return hits.back() if not hits.is_empty() else {}


static func _body(req: Dictionary) -> Variant:
	return JSON.parse_string((req["body"] as PackedByteArray).get_string_from_utf8())


func _binding(t: PKeyTestContext) -> void:
	server.requests.clear()
	plan = {"/distribution/commerce/binding": _json(200, {"bindingId": BINDING, "products": PRODUCTS})}
	var sdk = await _sdk()
	var r: PKeyResult = await sdk.commerce.get_binding()
	t.check("binding: ok", r.ok, str(r))
	t.check("binding: lowercased and kept", r.ok and r.detail["bindingId"] == BINDING.to_lower() and sdk.commerce.binding_id == BINDING.to_lower())
	t.check("binding: the product list is kept", sdk.commerce.products.size() == 3)
	var req := _last("/distribution/commerce/binding")
	t.check("binding: GET with the device bearer", req.get("method") == "GET" and String(req.get("headers", {}).get("authorization", "")) == "Bearer %s" % TOKEN, str(req.get("headers")))
	plan = {"/distribution/commerce/binding": _json(200, {"bindingId": "not-a-uuid", "products": []})}
	var bad: PKeyResult = await sdk.commerce.get_binding()
	t.check("binding: a body without a UUID is invalid-response", not bad.ok and bad.code == PKeyErrors.INVALID_RESPONSE, str(bad))
	sdk.queue_free()


func _claims(t: PKeyTestContext) -> void:
	var granted := {"ok": true, "store": "", "productId": "", "flag": "extras.diceSkins", "deliverable": "app", "state": "active", "granted": true, "changed": true}
	plan = {"/distribution/commerce/claim": _json(200, granted)}
	var sdk = await _sdk()
	var cases := [
		["app-store", {"signedTransaction": "h.p.s"}, {"store": "app-store", "signedTransaction": "h.p.s"}],
		["play", {"productId": "soundtrack", "purchaseToken": "tok.en-1"}, {"store": "play", "productId": "soundtrack", "purchaseToken": "tok.en-1"}],
		["steam", {"ticket": "14000000ab", "dlcAppId": 1234560}, {"store": "steam", "ticket": "14000000ab", "dlcAppId": "1234560"}],
	]
	for c in cases:
		server.requests.clear()
		var r: PKeyResult = await sdk.commerce.claim(c[0], c[1])
		t.check("claim %s: ok" % c[0], r.ok and r.detail["granted"] == true and r.detail["flag"] == "extras.diceSkins", str(r))
		var req := _last("/distribution/commerce/claim")
		t.check("claim %s: the exact body" % c[0], req.get("method") == "POST" and _body(req) == c[2], str(_body(req)) if not req.is_empty() else "no request")
	sdk.queue_free()


func _refusals(t: PKeyTestContext) -> void:
	var sdk = await _sdk()
	var cases := [
		[403, {"error": {"code": "forbidden"}, "reason": "binding_mismatch"}, &"forbidden", "binding_mismatch"],
		[403, {"error": {"code": "not_entitled"}, "reason": "no_license"}, &"not_entitled", "no_license"],
		[400, {"error": {"code": "bad_request"}, "reason": "untrusted_chain"}, &"bad_request", "untrusted_chain"],
		[503, {"error": {"code": "unavailable"}, "reason": "store_unavailable"}, &"unavailable", "store_unavailable"],
	]
	for c in cases:
		plan = {"/distribution/commerce/claim": _json(c[0], c[1])}
		var r: PKeyResult = await sdk.commerce.claim("app-store", {"signedTransaction": "h.p.s"})
		var reason: String = r.detail["error"]["reason"] if not r.ok and r.detail is Dictionary and r.detail.get("error") is Dictionary else ""
		t.check("refusal %s/%s: the server's code and reason" % [c[2], c[3]], not r.ok and r.code == c[2] and reason == c[3], "%s reason=%s" % [r, reason])
	sdk.queue_free()


func _client_side(t: PKeyTestContext) -> void:
	server.requests.clear()
	var off = await _sdk(PackedStringArray(["license", "config"]))
	var r: PKeyResult = await off.commerce.get_binding()
	t.check("no Distribution: service-unavailable, product N/A", not r.ok and r.code == PKeyErrors.SERVICE_UNAVAILABLE and r.detail["reason"] == "product", str(r))
	off.queue_free()
	var tokenless = await _sdk(PackedStringArray(["license", "config", "release", "distribution"]), "")
	var n: PKeyResult = await tokenless.commerce.claim("steam", {"ticket": "ab", "dlcAppId": "1"})
	t.check("no token: no-token", not n.ok and n.code == PKeyErrors.NO_TOKEN, str(n))
	var b: PKeyResult = await tokenless.commerce.claim("itch", {})
	t.check("unknown store: invalid-options", not b.ok and b.code == PKeyErrors.INVALID_OPTIONS, str(b))
	var p: PKeyResult = await tokenless.commerce.claim("play", {"productId": "x"})
	t.check("missing payload member: invalid-options", not p.ok and p.code == PKeyErrors.INVALID_OPTIONS, str(p))
	tokenless.queue_free()
	t.check("client-side refusals made no request", server.requests.is_empty(), str(server.requests.size()))
	var bare := PKeyCommerce.new()
	var nc: PKeyResult = await bare.get_binding()
	t.check("before configure(): not-configured", not nc.ok and nc.code == PKeyErrors.NOT_CONFIGURED)


func _outlet_rule(t: PKeyTestContext) -> void:
	t.check("3.1.3(b): a flag also sold on the App Store is not hidden", not PKeyCommerce.hidden_on("extras.diceSkins", PRODUCTS))
	t.check("3.1.3(b): a flag sold only elsewhere is hidden", PKeyCommerce.hidden_on("extras.ost", PRODUCTS))
	t.check("3.1.3(b): a flag sold nowhere (an operator's grant) is not hidden", not PKeyCommerce.hidden_on("polarisVpn", PRODUCTS))
	plan = {"/distribution/commerce/binding": _json(200, {"bindingId": BINDING, "products": PRODUCTS})}
	var apple = await _sdk(PackedStringArray(["license", "config", "release", "distribution"]), TOKEN, "app-store")
	await apple.commerce.get_binding()
	t.check("app-store outlet: hides the Play-only flag", apple.commerce.hidden_here("extras.ost"))
	t.check("app-store outlet: keeps the App Store flag", not apple.commerce.hidden_here("extras.diceSkins"))
	apple.queue_free()
	var steam = await _sdk(PackedStringArray(["license", "config", "release", "distribution"]), TOKEN, "steam")
	await steam.commerce.get_binding()
	t.check("steam outlet: hides nothing", not steam.commerce.hidden_here("extras.ost"))
	steam.queue_free()
