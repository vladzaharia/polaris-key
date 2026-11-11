extends RefCounted
# @pkey-feature identity.accesstoken
# `identity.access_token()` beyond what identity-access-token.json pins (that file replays in the transcripts suite,
# every step with `refresh`): the discovery gate, no token, the exchange form, the 60 second reuse margin, the cache
# bound to the device token (a held token and an exchange in flight both carry it), single flight, failures not
# cached, a 429's wait honoured without a request, the own-origin pin, no redirect, the 8 KiB cap and the clear at
# sign-out. The clock is a cell the SDK reads; nothing here reads the wall clock.

const S := preload("res://tests/license/support.gd")
const PRODUCT := "djdl"

var h: PKeyLicenseTestSupport
## The exchange's answers, in order (the last repeats): Dictionaries or Callables `func(req) -> Dictionary`.
var exchanges: Array = []
var clock := [1000.0]


func run(t: PKeyTestContext) -> void:
	h = PKeyLicenseTestSupport.new()
	if not t.check("access token: fixtures present", h.ready()):
		return
	await _form_and_reuse(t)
	await _gate(t)
	await _key_binding(t)
	await _failures(t)
	await _wire_limits(t)
	await _sign_out(t)
	# The plan's and the exchanges' lambdas refer to this suite: drop them, or the cycle outlives the run.
	h.plan.clear()
	exchanges.clear()
	h.free_server()


func _root() -> String:
	return "%s/%s/identity" % [h.server.base_url(), PRODUCT]


func _discovery(access_token := true, endpoint := "") -> Dictionary:
	var ep := endpoint if endpoint != "" else _root() + "/token"
	return {"product": PRODUCT, "services": {"identity": {"enabled": true, "account": true, "accessToken": access_token, "endpoints": {"token": ep, "signout": _root() + "/signout"}}}}


static func _jws(n := 40) -> String:
	return "a".repeat(n - 4) + ".b.c"


static func _grant(token := _jws(), expires_in: Variant = 600) -> Dictionary:
	return S.json(200, {"access_token": token, "issued_token_type": "urn:ietf:params:oauth:token-type:access_token", "token_type": "Bearer", "expires_in": expires_in, "scope": ""})


## A started SDK holding `token` (empty: none) over the plan; the exchange answers come from `exchanges`.
func _world(doc: Dictionary, token := "pkeyt_A") -> Node:
	h.plan.clear()
	h.server.requests.clear()
	clock[0] = 1000.0
	exchanges = [_grant()]
	h.plan["polaris.json"] = [S.json(200, doc)]
	h.plan["/identity/token"] = [func(req: Dictionary) -> Dictionary:
		var a = exchanges[0] if exchanges.size() == 1 else exchanges.pop_front()
		return a.call(req) if a is Callable else a]
	h.plan["/identity/signout"] = [S.json(200, {"released": false})]
	var store := PKeyMemoryStore.new(h.F["device_id"], token)
	var s := PKeyTestFixtures.new_sdk()
	var opts := PKeyTestFixtures.options(h.server.base_url(), store, clock, PRODUCT, {}, "1.0.0")
	opts.expected_services = PackedStringArray(["identity"])
	s.configure(opts)
	await s.start()
	return s


func _posts() -> Array:
	return h.requests("POST", "/identity/token")


## Run `access_token(refresh)` as its own coroutine; its result lands in `out`.
func _spawn(sdk: Node, out: Array, refresh := false) -> void:
	out.append(await sdk.identity.access_token(refresh))


func _wait_for(out: Array, n: int) -> void:
	var tree := Engine.get_main_loop() as SceneTree
	while out.size() < n:
		await tree.process_frame


func _form_and_reuse(t: PKeyTestContext) -> void:
	var sdk := await _world(_discovery())
	var r: PKeyResult = await sdk.identity.access_token()
	var fresh: bool = r.ok and r.detail["token_type"] == "Bearer" and r.detail["expires_in"] == 600 and r.detail["expires_at"] == 1600
	t.check("access token: a fresh exchange answers the token", fresh and String(r.detail["access_token"]).length() == 40, str(r))
	var sent: Array = _posts()
	var form := S.body_text(sent[0]) if sent.size() == 1 else ""
	var expected := "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&client_id=djdl&subject_token=pkeyt_A"
	expected += "&subject_token_type=urn%3Apolaris-key%3Atoken-type%3Adevice"
	expected += "&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token"
	t.check("access token: the form is exact and in order", form == expected, form)
	var headers: Dictionary = sent[0]["headers"]
	var plain: bool = headers.get("content-type") == "application/x-www-form-urlencoded" and headers.has("x-pkey-device")
	t.check("access token: form content type, the device id, no Authorization", plain and not headers.has("authorization"))
	clock[0] = 1000.0 + 539.0
	r = await sdk.identity.access_token()
	t.check("access token: a held token is reused until 60 s before expiry", r.ok and r.detail["expires_in"] == 61 and _posts().size() == 1, str(r))
	clock[0] = 1000.0 + 540.0
	r = await sdk.identity.access_token()
	t.check("access token: from 60 s before expiry it asks again", r.ok and _posts().size() == 2, str(_posts().size()))
	r = await sdk.identity.access_token(true)
	t.check("access token: refresh skips the held token", r.ok and _posts().size() == 3, str(_posts().size()))
	sdk.queue_free()


func _gate(t: PKeyTestContext) -> void:
	var sdk := await _world(_discovery(false))
	var r: PKeyResult = await sdk.identity.access_token()
	var gated: bool = not r.ok and r.code == PKeyErrors.SERVICE_UNAVAILABLE and r.detail["kind"] == "unavailable"
	t.check("access token: discovery without accessToken is unavailable and sends nothing", gated and _posts().is_empty(), str(r))
	sdk.queue_free()
	sdk = await _world(_discovery(), "")
	r = await sdk.identity.access_token()
	t.check("access token: no device token is no-token, nothing sent", not r.ok and r.code == PKeyErrors.NO_TOKEN and _posts().is_empty(), str(r))
	sdk.queue_free()
	for other in ["https://evil.example/djdl/identity/token", "http://127.0.0.1:1/djdl/identity/token"]:
		sdk = await _world(_discovery(true, other))
		r = await sdk.identity.access_token()
		t.check("access token: an endpoint outside the Worker's origin is unavailable (%s)" % other, not r.ok and r.code == PKeyErrors.SERVICE_UNAVAILABLE and _posts().is_empty(), str(r))
		sdk.queue_free()


func _key_binding(t: PKeyTestContext) -> void:
	var sdk := await _world(_discovery())
	exchanges = [func(req: Dictionary) -> Dictionary: return _grant(_jws(41 if S.body_text(req).contains("pkeyt_B") else 40))]
	var a: PKeyResult = await sdk.identity.access_token()
	sdk.core.tokens.set_token("pkeyt_B", PKeyTokenManager.SOURCE_SIGNIN, true)
	var b: PKeyResult = await sdk.identity.access_token()
	var own: bool = a.ok and b.ok and String(a.detail["access_token"]).length() == 40 and String(b.detail["access_token"]).length() == 41
	t.check("access token: a replaced device token is a miss with its own token", own and _posts().size() == 2, str(b))
	sdk.queue_free()

	# Callers with the same key share one exchange.
	sdk = await _world(_discovery())
	var shared: Array = []
	for i in 3:
		_spawn(sdk, shared)
	await _wait_for(shared, 3)
	t.check("access token: callers with the same key share one exchange", shared.all(func(r): return r.ok) and _posts().size() == 1, str(_posts().size()))
	sdk.queue_free()

	# An exchange in flight for another key is not joined, and its late answer is not stored.
	sdk = await _world(_discovery())
	exchanges = [func(req: Dictionary) -> Dictionary: return _grant(_jws(41 if S.body_text(req).contains("pkeyt_B") else 40))]
	# Discovery first: the call reads its device token after it, so the exchange is in flight when the token changes.
	await sdk.discover()
	var out: Array = []
	_spawn(sdk, out)
	sdk.core.tokens.set_token("pkeyt_B", PKeyTokenManager.SOURCE_SIGNIN, true)
	_spawn(sdk, out)
	await _wait_for(out, 2)
	t.check("access token: another key does not join an exchange in flight", _posts().size() == 2 and out.all(func(r): return r.ok), str(_posts().size()))
	sdk.core.tokens.set_token("pkeyt_A", PKeyTokenManager.SOURCE_SIGNIN, true)
	var again: PKeyResult = await sdk.identity.access_token()
	t.check("access token: the old key's late answer was not stored", again.ok and _posts().size() == 3, str(_posts().size()))
	sdk.queue_free()


func _failures(t: PKeyTestContext) -> void:
	var refusals := [
		[400, {"error": "invalid_grant"}, &"invalid_grant"],
		[400, {"error": "invalid_request", "error_description": "x"}, &"invalid_request"],
		[400, {"error": {"code": "invalid_grant"}}, &"invalid_grant"],
	]
	for case in refusals:
		var sdk := await _world(_discovery())
		exchanges = [S.json(case[0], case[1]), _grant()]
		var r: PKeyResult = await sdk.identity.access_token()
		t.check("access token: a refusal keeps the wire code (%s)" % case[2], not r.ok and r.code == case[2] and r.detail["status"] == case[0], str(r))
		r = await sdk.identity.access_token()
		t.check("access token: a failure is not cached", r.ok and _posts().size() == 2, str(_posts().size()))
		sdk.queue_free()
	var down := await _world(_discovery())
	exchanges = [S.json(503, {"error": "x"})]
	var d: PKeyResult = await down.identity.access_token()
	t.check("access token: a 5xx is server-error", not d.ok and d.code == PKeyErrors.SERVER_ERROR, str(d))
	down.queue_free()

	# A 429's wait is remembered per key and fails fast, refresh included.
	var sdk := await _world(_discovery())
	exchanges = [S.json(429, {"error": "rate_limited", "retryAfter": 60}), _grant()]
	var first: PKeyResult = await sdk.identity.access_token()
	var limited: bool = not first.ok and first.code == PKeyErrors.RATE_LIMITED and first.detail["status"] == 429
	t.check("access token: a 429 is rate_limited with the body's wait", limited and first.detail["retry_after_seconds"] == 60, str(first))
	clock[0] = 1030.0
	for refresh in [false, true]:
		var r: PKeyResult = await sdk.identity.access_token(refresh)
		var fast: bool = not r.ok and r.code == PKeyErrors.RATE_LIMITED and r.detail["retry_after_seconds"] == 30
		t.check("access token: inside the wait it fails fast with no request (refresh %s)" % refresh, fast and _posts().size() == 1, str(r))
	sdk.core.tokens.set_token("pkeyt_B", PKeyTokenManager.SOURCE_SIGNIN, true)
	var other: PKeyResult = await sdk.identity.access_token()
	t.check("access token: another device token is not held to the wait", other.ok and _posts().size() == 2, str(other))
	sdk.core.tokens.set_token("pkeyt_A", PKeyTokenManager.SOURCE_SIGNIN, true)
	clock[0] = 1060.0
	var after: PKeyResult = await sdk.identity.access_token()
	t.check("access token: past the wait it asks again", after.ok and _posts().size() == 3, str(after))
	sdk.queue_free()

	var hdr := await _world(_discovery())
	exchanges = [{"status": 429, "headers": {"Content-Type": "application/json", "Retry-After": "7"}, "body": JSON.stringify({"error": "rate_limited"})}]
	var hr: PKeyResult = await hdr.identity.access_token()
	t.check("access token: the Retry-After header is read when the body has none", not hr.ok and hr.detail["retry_after_seconds"] == 7, str(hr))
	hdr.queue_free()


func _wire_limits(t: PKeyTestContext) -> void:
	var sdk := await _world(_discovery())
	exchanges = [{"status": 307, "headers": {"Location": "https://evil.example/"}, "body": ""}]
	var r: PKeyResult = await sdk.identity.access_token()
	t.check("access token: a redirect is never followed", not r.ok and r.code == PKeyErrors.NETWORK and _posts().size() == 1 and h.server.requests.size() == 2, str(r))
	sdk.queue_free()

	sdk = await _world(_discovery())
	exchanges = [_grant(_jws(PKeyIdentityAccessToken.MAX_LENGTH))]
	r = await sdk.identity.access_token()
	t.check("access token: 8 KiB exactly is accepted", r.ok and String(r.detail["access_token"]).length() == PKeyIdentityAccessToken.MAX_LENGTH, str(r))
	sdk.queue_free()
	sdk = await _world(_discovery())
	exchanges = [_grant(_jws(PKeyIdentityAccessToken.MAX_LENGTH + 1))]
	r = await sdk.identity.access_token()
	t.check("access token: over 8 KiB is bad_response", not r.ok and r.code == &"bad_response", str(r))
	sdk.queue_free()

	var bad: Array = [
		{"status": 200, "headers": {}, "body": "not json"},
		_grant(_jws(), 0),
		_grant(_jws(), "600"),
		_grant(_jws(), 600.5),
		_grant("not-a-jws"),
		S.json(200, {"access_token": _jws(), "issued_token_type": "x", "token_type": "Bearer", "expires_in": 600}),
		S.json(200, {"access_token": _jws(), "issued_token_type": "urn:ietf:params:oauth:token-type:access_token", "token_type": "DPoP", "expires_in": 600}),
	]
	for i in bad.size():
		sdk = await _world(_discovery())
		exchanges = [bad[i]]
		r = await sdk.identity.access_token()
		t.check("access token: an answer that is not an access token is bad_response (%d)" % i, not r.ok and r.code == &"bad_response", str(r))
		sdk.queue_free()


func _sign_out(t: PKeyTestContext) -> void:
	var sdk := await _world(_discovery())
	var r: PKeyResult = await sdk.identity.access_token()
	var out: PKeyResult = await sdk.identity.sign_out()
	var again: PKeyResult = await sdk.identity.access_token()
	t.check("access token: sign-out drops the held token", r.ok and out.ok and again.ok and _posts().size() == 2, str(out))
	sdk.queue_free()
