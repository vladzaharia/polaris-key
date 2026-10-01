extends RefCounted
# Edge-mint: GET /<p>/config/mint/<recipe>/token with the device bearer. The token and its expiry,
# the memory-only cache (bound to the device token, reused until expires_at - 30 s, shared by
# concurrent asks), one re-acquire on a 401 and nothing else retried, distinct kinds for 401,
# 404, 429 and 5xx, and NOTHING sent when Config is off, when discovery says no recipe is
# approved, when the recipe id fails ^[a-z0-9-]+$, or when no device token is held.

const S := preload("res://tests/config/support.gd")
const TOKEN := "pkeyt_device_one"
const MINTED := "eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJ0ZWFtIn0.c2ln"

var server: PKeyFakeServer
var plan := {}
var clock := [S.NOW]


func run(t: PKeyTestContext) -> void:
	server = PKeyTestFixtures.new_server(_answer)
	await _happy_and_cache(t)
	await _errors(t)
	await _reacquire(t)
	await _refusals(t)
	await _discovery(t)
	await _concurrent(t)
	server.queue_free()


## path suffix -> Array of answers; the last one repeats.
func _answer(req: Dictionary) -> Dictionary:
	for suffix in plan:
		if String(req["path"]).ends_with(suffix):
			var q: Array = plan[suffix]
			var a = q[0] if q.size() == 1 else q.pop_front()
			return a.call(req) if a is Callable else a
	return {"status": 404}


func _minted(token := MINTED, expires := S.NOW + 600) -> Dictionary:
	return {"status": 200, "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"}, "body": JSON.stringify({"token": token, "expiresAt": expires})}


func _err(status: int, code: String, message := "") -> Dictionary:
	var body := {"error": code}
	if message != "":
		body["message"] = message
	return {"status": status, "body": JSON.stringify(body)}


func _sdk(store: PKeyMemoryStore, services := PackedStringArray()) -> Node:
	var sdk := PKeyTestFixtures.new_sdk()
	var o := PKeyTestFixtures.options(server.base_url(), store, clock)
	o.expected_services = services
	sdk.configure(o)
	await sdk.start()
	return sdk


func _mints(recipe := "") -> Array:
	return server.requests.filter(func(r): return String(r["path"]).contains("/config/mint/") and (recipe == "" or String(r["path"]).contains("/%s/" % recipe)))


func _happy_and_cache(t: PKeyTestContext) -> void:
	server.requests.clear()
	clock[0] = S.NOW
	plan = {"/config/mint/leaderboard/token": [_minted()]}
	var store := PKeyMemoryStore.new("", TOKEN)
	var sdk: Node = await _sdk(store)
	var r: PKeyMintResult = await sdk.config.mint_token("leaderboard")
	t.check("mint: returns the token and expires_at", r.ok and r.kind == PKeyMintResult.KIND_OK and r.token == MINTED and r.expires_at == S.NOW + 600 and not r.cached, str(r))
	var req: Dictionary = _mints().back() if not _mints().is_empty() else {}
	t.check("mint: GET /djdl/config/mint/leaderboard/token with the device bearer", req.get("method") == "GET" and req.get("path") == "/djdl/config/mint/leaderboard/token" and req.get("headers", {}).get("authorization") == "Bearer " + TOKEN)
	t.check("mint: the request carries the X-PKey headers", req.get("headers", {}).has("x-pkey-device") and req.get("headers", {}).has("x-pkey-version"))
	t.check("mint: the token never prints", not str(r).contains(MINTED) and str(r).contains(PKeyMintResult.REDACTED), str(r))

	clock[0] = S.NOW + 60
	var again: PKeyMintResult = await sdk.config.mint_token("leaderboard")
	t.check("mint: a second call before expiry is served from memory", again.ok and again.cached and again.token == MINTED and _mints().size() == 1)
	clock[0] = S.NOW + 600 - 31
	again = await sdk.config.mint_token("leaderboard")
	t.check("mint: still cached 31 s before expiry", again.cached and _mints().size() == 1)
	plan["/config/mint/leaderboard/token"] = [_minted(MINTED + "2", S.NOW + 1200)]
	clock[0] = S.NOW + 600 - 30
	again = await sdk.config.mint_token("leaderboard")
	t.check("mint: fetched again inside the 30 s margin", again.ok and not again.cached and again.token == MINTED + "2" and _mints().size() == 2)

	t.check("mint: never persisted", not JSON.stringify(store.cache).contains(MINTED) and store.token == TOKEN)

	# A cached token is bound to the device token it was minted with.
	store.token = ""
	sdk.core.tokens.set_token("pkeyt_device_two")
	plan["/config/mint/leaderboard/token"] = [_minted(MINTED + "3", S.NOW + 1200)]
	again = await sdk.config.mint_token("leaderboard")
	t.check("mint: a different device token does not reuse the cache", again.ok and again.token == MINTED + "3" and _mints().size() == 3 and _mints().back()["headers"]["authorization"] == "Bearer pkeyt_device_two")
	sdk.core.tokens.clear()
	again = await sdk.config.mint_token("leaderboard")
	t.check("mint: no device token: refused before any request", not again.ok and again.code == PKeyErrors.NO_TOKEN and again.kind == PKeyMintResult.KIND_UNAUTHORIZED and _mints().size() == 3)
	sdk.queue_free()


func _errors(t: PKeyTestContext) -> void:
	server.requests.clear()
	clock[0] = S.NOW
	var sdk: Node = await _sdk(PKeyMemoryStore.new("", TOKEN))
	var cases := [
		["404 (unknown or unapproved)", _err(404, "not_found", "no such edge-mint recipe"), PKeyErrors.NOT_FOUND, PKeyMintResult.KIND_NOT_FOUND],
		["429", _err(429, "rate_limited", "too many mint requests"), PKeyErrors.RATE_LIMITED, PKeyMintResult.KIND_RATE_LIMITED],
		["500 misconfigured", _err(500, "misconfigured", "missing mint key"), &"misconfigured", PKeyMintResult.KIND_SERVER_ERROR],
		["500 without a body", {"status": 500, "body": ""}, PKeyErrors.HTTP_ERROR, PKeyMintResult.KIND_SERVER_ERROR],
		["200 without a token", {"status": 200, "body": "{\"expiresAt\": 1}"}, PKeyErrors.INVALID_RESPONSE, PKeyMintResult.KIND_INVALID_RESPONSE],
		["200 with a lenient body", {"status": 200, "body": "{\"token\": \"x\", \"expiresAt\": 1,}"}, PKeyErrors.INVALID_RESPONSE, PKeyMintResult.KIND_INVALID_RESPONSE],
		["403", _err(403, "forbidden"), PKeyErrors.FORBIDDEN, PKeyMintResult.KIND_ERROR],
	]
	var kinds := {}
	for row in cases:
		plan = {"/config/mint/r1/token": [row[1]]}
		var before := _mints().size()
		var r: PKeyMintResult = await sdk.config.mint_token("r1")
		t.check("mint: %s -> %s / %s" % [row[0], row[2], row[3]], not r.ok and r.code == row[2] and r.kind == row[3] and r.status == int(row[1]["status"]), str(r))
		t.check("mint: %s is not retried" % row[0], _mints().size() == before + 1)
		kinds[r.kind] = true
	t.check("mint: 401, 404, 429 and 500 are distinct kinds", kinds.has(PKeyMintResult.KIND_NOT_FOUND) and kinds.has(PKeyMintResult.KIND_RATE_LIMITED) and kinds.has(PKeyMintResult.KIND_SERVER_ERROR) and not [PKeyMintResult.KIND_NOT_FOUND, PKeyMintResult.KIND_RATE_LIMITED, PKeyMintResult.KIND_SERVER_ERROR].has(PKeyMintResult.KIND_UNAUTHORIZED))
	plan = {"/config/mint/r1/token": [_err(404, "not_found")]}
	var r2: PKeyMintResult = await sdk.config.mint_token("r1")
	t.check("mint: a failure is not cached", not r2.ok and _mints().size() == cases.size() + 1)
	sdk.queue_free()

	var dead := PKeyTestFixtures.new_sdk()
	var o := PKeyTestFixtures.options("http://127.0.0.1:1", PKeyMemoryStore.new("", TOKEN), clock)
	dead.configure(o)
	await dead.start()
	var n: PKeyMintResult = await dead.config.mint_token("r1")
	t.check("mint: a network failure is kind network", not n.ok and n.kind == PKeyMintResult.KIND_NETWORK and n.status == 0, str(n))
	dead.queue_free()


func _reacquire(t: PKeyTestContext) -> void:
	server.requests.clear()
	clock[0] = S.NOW
	var store := PKeyMemoryStore.new("", TOKEN)
	var sdk: Node = await _sdk(store)
	var calls := [0]
	sdk.core.tokens.set_reacquire(func(c: PKeyCore, current: String) -> String:
		calls[0] += 1
		var r: PKeyResult = await c.request("POST", "license/token", null, true)
		if not r.ok:
			return ""
		var p := PKeyJson.parse_bytes(r.detail["body"])
		return p["value"].get("token", "") if p["ok"] and p["value"] is Dictionary else "")

	# 401 -> one re-acquire -> one retry with the new token -> ok.
	plan = {
		"/config/mint/r2/token": [func(req): return _minted() if req["headers"]["authorization"] == "Bearer pkeyt_rotated" else _err(401, "unauthorized")],
		"/license/token": [{"status": 200, "body": "{\"token\": \"pkeyt_rotated\"}"}],
	}
	var r: PKeyMintResult = await sdk.config.mint_token("r2")
	t.check("mint: 401 -> one re-acquire -> retried with the new token", r.ok and r.token == MINTED and calls[0] == 1 and _mints("r2").size() == 2 and store.token == "pkeyt_rotated", str(r))
	t.check("mint: the cache is bound to the token the retry presented", (await sdk.config.mint_token("r2")).cached)

	# 401 -> the re-acquire fails -> unauthorized, nothing else.
	plan = {"/config/mint/r3/token": [_err(401, "unauthorized")], "/license/token": [_err(401, "unauthorized")]}
	r = await sdk.config.mint_token("r3")
	t.check("mint: 401 after a failed re-acquire is unauthorized", not r.ok and r.code == PKeyErrors.UNAUTHORIZED and r.kind == PKeyMintResult.KIND_UNAUTHORIZED and r.status == 401 and calls[0] == 2 and _mints("r3").size() == 1)
	t.check("mint: the device token is kept", store.token == "pkeyt_rotated")

	# 401 -> re-acquire ok -> 401 again: still exactly one re-acquire.
	plan = {"/config/mint/r4/token": [_err(401, "unauthorized")], "/license/token": [{"status": 200, "body": "{\"token\": \"pkeyt_third\"}"}]}
	r = await sdk.config.mint_token("r4")
	t.check("mint: a second 401 is final (one re-acquire per call)", not r.ok and r.kind == PKeyMintResult.KIND_UNAUTHORIZED and calls[0] == 3 and _mints("r4").size() == 2)

	# Without a re-acquire route a 401 is a hard 401.
	sdk.core.tokens.set_reacquire(Callable())
	plan = {"/config/mint/r5/token": [_err(401, "unauthorized")]}
	r = await sdk.config.mint_token("r5")
	t.check("mint: no re-acquire route: one request, unauthorized", r.kind == PKeyMintResult.KIND_UNAUTHORIZED and _mints("r5").size() == 1)
	sdk.queue_free()


func _refusals(t: PKeyTestContext) -> void:
	server.requests.clear()
	var sdk: Node = await _sdk(PKeyMemoryStore.new("", TOKEN))
	for bad in ["", "UPPER", "../token", "a/b", "a%2Fb", "spa ce", "dot.ted", "é"]:
		var r: PKeyMintResult = await sdk.config.mint_token(bad)
		t.check("mint: recipe id %s refused before sending" % JSON.stringify(bad), not r.ok and r.code == PKeyErrors.BAD_REQUEST and r.kind == PKeyMintResult.KIND_REFUSED)
	t.check("mint: nothing was sent for a bad id", server.requests.is_empty())
	sdk.queue_free()

	var off: Node = await _sdk(PKeyMemoryStore.new("", TOKEN), PackedStringArray(["license"]))
	var r2: PKeyMintResult = await off.config.mint_token("leaderboard")
	t.check("mint: Config off is service-unavailable, nothing sent", r2.code == PKeyErrors.SERVICE_UNAVAILABLE and r2.kind == PKeyMintResult.KIND_REFUSED and server.requests.is_empty())
	off.queue_free()

	var local := PKeyTestFixtures.new_sdk()
	local.configure(S.options())
	await local.start()
	var r3: PKeyMintResult = await local.config.mint_token("leaderboard")
	t.check("mint: local-only sends nothing", not r3.ok and r3.code == PKeyErrors.LOCAL_ONLY and r3.kind == PKeyMintResult.KIND_NETWORK, str(r3))
	local.queue_free()


func _discovery(t: PKeyTestContext) -> void:
	server.requests.clear()
	var sdk: Node = await _sdk(PKeyMemoryStore.new("", TOKEN))
	var doc := {"product": "djdl", "services": {"license": {"enabled": true}, "config": {"enabled": true, "mint": {"available": false}}}}
	plan = {"/.well-known/polaris.json": [{"status": 200, "body": JSON.stringify(doc)}], "/config/mint/leaderboard/token": [_minted()]}
	var d: PKeyResult = await sdk.discover()
	t.check("mint: discovery loaded", d.ok, str(d))
	t.check("mint: mint_available() follows discovery", not sdk.config.mint_available())
	var r: PKeyMintResult = await sdk.config.mint_token("leaderboard")
	t.check("mint: config.mint.available false sends nothing", not r.ok and r.code == PKeyErrors.MINT_UNAVAILABLE and r.kind == PKeyMintResult.KIND_REFUSED and _mints().is_empty())
	doc["services"]["config"]["mint"]["available"] = true
	plan["/.well-known/polaris.json"] = [{"status": 200, "body": JSON.stringify(doc)}]
	await sdk.discover()
	r = await sdk.config.mint_token("leaderboard")
	t.check("mint: config.mint.available true mints", r.ok and _mints().size() == 1)
	doc["services"]["config"].erase("mint")
	plan["/.well-known/polaris.json"] = [{"status": 200, "body": JSON.stringify(doc)}]
	await sdk.discover()
	t.check("mint: a discovery without the mint fragment does not refuse", sdk.config.mint_available())
	sdk.queue_free()


func _concurrent(t: PKeyTestContext) -> void:
	server.requests.clear()
	clock[0] = S.NOW
	plan = {"/config/mint/shared/token": [_minted()]}
	var sdk: Node = await _sdk(PKeyMemoryStore.new("", TOKEN))
	var join := PKeySync.Join.new()
	join.start("a", func(): return await sdk.config.mint_token("shared"))
	join.start("b", func(): return await sdk.config.mint_token("shared"))
	await join.wait()
	var a: PKeyMintResult = join.results["a"]
	var b: PKeyMintResult = join.results["b"]
	t.check("mint: two concurrent asks share one request", a.ok and b.ok and a.token == MINTED and b.token == MINTED and _mints("shared").size() == 1, "%d requests" % _mints("shared").size())
	sdk.queue_free()
