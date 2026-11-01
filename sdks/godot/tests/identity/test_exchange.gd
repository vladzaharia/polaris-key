extends RefCounted
# @pkey-feature identity.exchange
# `identity.exchange.*` (I-48.1): the discovery decode (unknown kinds ignored), the nonce, the
# `exchange` proof over the subject token hash, the five answers, consent on `choice.complete`
# and the one device key store the key ring shares. The recorded conversations are the
# transcripts suite's.

const B := preload("res://tests/identity/support.gd")

const GRANT := "sg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const HANDLE := "lh_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const NONCE := "NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN"
const PLATFORM_TOKEN := "platform.id.token.SECRET"
const TOKEN_NEW := "pkeyt_EXCHANGEDEXCHANGEDEXCHANGEDEXCHANGED00"
const TOKEN_OK := {
	"access_token": TOKEN_NEW, "token_type": "Bearer", "scope": "profile email", "schemaVersion": 1,
	"device": {"id": "D"}, "license": {"id": "lic_a"}, "subject": "ps_abc",
	"issued_token_type": "urn:polaris-key:token-type:device",
}
const CONSENT := {
	"client": {"appName": "djdl", "developerName": null, "iconUrl": null, "nameVerified": false},
	"as": {"provider": "google", "email": "a@example.com"}, "items": [{"claim": "email"}],
	"scopeHash": "h", "firstTime": true, "changed": false,
}
const VIEW := {"state": "choose", "choices": [{"id": "lic_a"}], "keep": false, "preselected": null, "create": null, "getLicense": null}


func run(t: PKeyTestContext) -> void:
	_discovery(t)
	await _nonce(t)
	await _signed_in(t)
	await _answers(t)
	await _refusals(t)
	await _unavailable(t)
	await _consent(t)
	await _shared_store(t)


func _store() -> PKeyDeviceKeyStore:
	return PKeyDeviceKeyStore.for_tests("djdl", "user://pkey_test_exchange_%d" % Time.get_ticks_usec())


func _bed(kinds := ["google", "apple"], with_keys := true) -> B:
	var bed := B.new()
	if with_keys:
		bed.device_keys = _store()
	var sdk := await bed.make_sdk()
	sdk.identity.redirect_acquisition_sync = false
	var root := "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]
	sdk.core.discovery_manifest = {"product": bed.F["product"], "services": {"identity": {
		"enabled": true, "configured": true, "issuer": root,
		"exchange": {"kinds": kinds, "google": {"serverClientId": "g.apps"}},
		"endpoints": {"token": root + "/token", "nonce": root + "/nonce", "choiceLicenses": root + "/choice/licenses",
			"choiceDevices": root + "/choice/devices", "choiceComplete": root + "/choice/complete", "choiceCancel": root + "/choice/cancel"},
	}}}
	bed.nonces = [B.json(200, {"nonce": NONCE, "expiresIn": 300})]
	return bed


func _form(text: String) -> Dictionary:
	var out := {}
	for part in text.split("&"):
		out[part.get_slice("=", 0).uri_decode()] = part.get_slice("=", 1).uri_decode()
	return out


func _discovery(t: PKeyTestContext) -> void:
	var m := {"services": {"identity": {"enabled": true, "exchange": {
		"kinds": ["google", "teleport", "gamecenter", 7, "google", "pgs", "apple"],
		"google": {"serverClientId": "g"}, "pgs": {"serverClientId": "p"}},
		"endpoints": {"nonce": "https://k/n", "link": "https://k/l"}}}}
	var f := PKeyDiscovery.identity_from(m)
	t.check("exchange: kinds keep the known ones, once, in order", f["exchange"]["kinds"] == ["google", "gamecenter", "pgs", "apple"], str(f["exchange"]))
	t.check(
		"exchange: the client ids, nonce and link are decoded",
		f["exchange"]["google_server_client_id"] == "g" and f["exchange"]["pgs_server_client_id"] == "p" and f["nonce"] == "https://k/n" and f["link"] == "https://k/l",
		str(f))
	m["services"]["identity"]["exchange"] = {"kinds": ["teleport"]}
	t.check("exchange: only unknown kinds is an empty list, not a failure", PKeyDiscovery.identity_from(m)["exchange"]["kinds"] == [], "")
	m["services"]["identity"]["exchange"] = {"kinds": "google"}
	t.check("exchange: a kinds member that is not a list is no exchange", PKeyDiscovery.identity_from(m)["exchange"] == {}, "")
	m["services"]["identity"].erase("exchange")
	m["services"]["identity"]["endpoints"] = {}
	var none := PKeyDiscovery.identity_from(m)
	t.check("exchange: no member and no endpoints decode empty", none["exchange"] == {} and none["nonce"] == "" and none["link"] == "", str(none))


func _nonce(t: PKeyTestContext) -> void:
	var bed := await _bed()
	var keys: Dictionary = bed.device_keys.ensure().detail
	var n: PKeyExchangeResult = await bed.sdk.identity.exchange.nonce("google")
	t.check("exchange: nonce() is the Worker's value", n.ok and n.kind == PKeyExchangeResult.KIND_NONCE and n.nonce == NONCE and n.expires_in == 300, str(n))
	var req: Dictionary = bed.nonce_requests[0]
	t.check(
		"exchange: nonce posts the device's two public keys, no bearer, with X-PKey-Device",
		req["body"] == {"signKey": keys["sign_key"], "agreeKey": keys["agree_key"]} and not req["headers"].has("authorization") and req["headers"].has("x-pkey-device"),
		str(req))
	t.check("exchange: the nonce is in no string", not (str(n) + n.message).contains(NONCE))
	var bad: PKeyExchangeResult = await bed.sdk.identity.exchange.nonce("bogus")
	t.check("exchange: an unknown kind argument is invalid-argument, nothing sent", bad.code == &"invalid-argument" and bed.nonce_requests.size() == 1, str(bad))
	bed.nonces = [B.json(200, {"nonce": "short", "expiresIn": 300})]
	var malformed: PKeyExchangeResult = await bed.sdk.identity.exchange.nonce("google")
	t.check("exchange: a malformed nonce is invalid-response", malformed.kind == PKeyExchangeResult.KIND_FAILED and malformed.code == PKeyErrors.INVALID_RESPONSE, str(malformed))
	bed.nonces = [B.json(404, {"error": "not_found"})]
	var gone: PKeyExchangeResult = await bed.sdk.identity.exchange.nonce("google")
	t.check("exchange: a 404 nonce route is unavailable (not_found)", gone.kind == PKeyExchangeResult.KIND_UNAVAILABLE and gone.code == &"not_found", str(gone))
	bed.free_all()


func _signed_in(t: PKeyTestContext) -> void:
	var bed := await _bed()
	bed.tokens = [B.json(200, TOKEN_OK)]
	var r: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check(
		"exchange: a token answer is signed_in with subject, scope and licence",
		r.ok and r.kind == PKeyExchangeResult.KIND_SIGNED_IN and r.subject == "ps_abc" and r.scope == "profile email" and r.license_id == "lic_a",
		str(r))
	t.check(
		"exchange: the device token is stored with sign_in provenance and the subject kept",
		bed.sdk.core.tokens.current() == TOKEN_NEW and bed.sdk.core.tokens._source == PKeyTokenManager.SOURCE_SIGNIN and bed.sdk.core.cache.subject == "ps_abc")
	t.check("exchange: a supplied nonce is not fetched again", bed.nonce_requests.is_empty())
	var req: Dictionary = bed.token_requests[0]
	var f := _form(req["body"])
	var keys: Dictionary = bed.device_keys.public_keys().detail
	t.check("exchange: the form is the V5 token-exchange grant", f["grant_type"] == PKeyIdentityExchange.GRANT_TYPE and f["client_id"] == "djdl" and f["subject_token"] == PLATFORM_TOKEN \
			and f["subject_token_type"] == "urn:ietf:params:oauth:token-type:id_token" and f["nonce"] == NONCE and f["device_key"] == keys["sign_key"], str(f))
	t.check("exchange: no bearer is sent", not req["headers"].has("authorization") and req["headers"].has("x-pkey-device"))
	var proof := {
		"purpose": "exchange", "product": "djdl", "device_id": bed.sdk.core.device_id, "value": "%s.%s" % [NONCE, keys["sign_key"]],
		"token_hash": PKeyB64Url.encode(PLATFORM_TOKEN.sha256_buffer()), "sign_key": keys["sign_key"], "sig": f["proof"],
	}
	t.check("exchange: the proof verifies over <nonce>.<device_key> and the SHA-256 of the subject token", PKeyDeviceProof.verify(proof, int(bed.clock[0])), str(proof))
	proof["token_hash"] = PKeyB64Url.encode("other".sha256_buffer())
	t.check("exchange: the proof binds the token (another token's hash fails)", not PKeyDeviceProof.verify(proof, int(bed.clock[0])))
	t.check("exchange: the platform token is in no string", not (str(r) + r.message + str(r.detail)).contains(PLATFORM_TOKEN) and not str(r).contains(TOKEN_NEW))
	bed.free_all()
	# No nonce given: a fresh one is taken first (tests and the game kinds).
	bed = await _bed(["gamecenter", "pgs"])
	bed.tokens = [B.json(200, TOKEN_OK)]
	var gc: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("gamecenter", "gc1.x.y", "", {"device_name": "Den PC"})
	var g := _form(bed.token_requests[0]["body"])
	t.check("exchange: no nonce takes a fresh one first", gc.ok and bed.nonce_requests.size() == 1 and g["nonce"] == NONCE, str(gc))
	t.check("exchange: Game Center's subject_token_type and device_name", g["subject_token_type"] == "urn:polaris-key:token-type:gamecenter-signature" and g["device_name"] == "Den PC", str(g))
	bed.tokens = [B.json(200, TOKEN_OK)]
	await bed.sdk.identity.exchange.exchange("pgs", "4/code", NONCE)
	t.check("exchange: Play Games' subject_token_type", _form(bed.token_requests[1]["body"])["subject_token_type"] == "urn:polaris-key:token-type:pgs-server-auth-code")
	bed.free_all()


func _answers(t: PKeyTestContext) -> void:
	var bed := await _bed()
	bed.tokens = [B.json(200, {"status": "confirm", "grant": GRANT, "expiresIn": 300, "consent": CONSENT})]
	var c: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check(
		"exchange: confirm is a pending consent and stores nothing",
		c.ok and c.kind == PKeyExchangeResult.KIND_CONFIRM and c.grant == GRANT and c.expires_in == 300 and c.consent["as"]["provider"] == "google" and bed.sdk.core.tokens.current() == "",
		str(c))
	bed.tokens = [B.json(200, {"status": "choose", "grant": GRANT, "expiresIn": 300, "choices": VIEW})]
	var ch: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check(
		"exchange: choose is a pending choice with the view",
		ch.ok and ch.kind == PKeyExchangeResult.KIND_CHOOSE and ch.grant == GRANT and ch.view.has("choices") and bed.sdk.core.tokens.current() == "",
		str(ch))
	bed.tokens = [B.json(403, {"error": "interstitial_required", "reason": "no_link", "url": "https://key.plrs.im/card", "linkHandle": HANDLE, "expiresIn": 600})]
	var n: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check(
		"exchange: interstitial_required no_link carries the handle and the card",
		n.ok and n.kind == PKeyExchangeResult.KIND_NEEDS_SIGN_IN and n.reason == "no_link" and n.link_handle == HANDLE and n.url.ends_with("/card") and n.expires_in == 600,
		str(n))
	bed.tokens = [B.json(403, {"error": "interstitial_required", "reason": "terms", "url": "https://key.plrs.im/card", "linkHandle": HANDLE, "expiresIn": 600})]
	var terms: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: terms carries no handle", terms.kind == PKeyExchangeResult.KIND_NEEDS_SIGN_IN and terms.reason == "terms" and terms.link_handle == "", str(terms))
	bed.tokens = [B.json(403, {"error": "interstitial_required", "reason": "future", "url": "https://key.plrs.im/card", "linkHandle": HANDLE, "expiresIn": 600})]
	var odd: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: an unknown reason reads as no_link without a handle", odd.reason == "no_link" and odd.link_handle == "", str(odd))
	bed.tokens = [B.json(403, {"error": "interstitial_required", "reason": "no_link", "url": "http://evil.example/card"})]
	var http: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: a non-https, non-loopback card url is invalid-response", http.kind == PKeyExchangeResult.KIND_FAILED and http.code == PKeyErrors.INVALID_RESPONSE, str(http))
	for r in [c, ch, n]:
		t.check("exchange: the grant and handle are in no message, detail or string", not (str(r) + r.message + str(r.detail)).contains(GRANT) and not (str(r) + r.message).contains(HANDLE))
	bed.tokens = [B.json(200, {"status": "confirm", "grant": "bad", "expiresIn": 300, "consent": CONSENT})]
	var bad: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: a malformed confirm is invalid-response", bad.kind == PKeyExchangeResult.KIND_FAILED and bad.code == PKeyErrors.INVALID_RESPONSE, str(bad))
	bed.free_all()


func _refusals(t: PKeyTestContext) -> void:
	var bed := await _bed()
	bed.tokens = [B.json(400, {"error": "invalid_grant"})]
	var g: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check(
		"exchange: a flat invalid_grant is refused with its code and changes nothing",
		g.kind == PKeyExchangeResult.KIND_REFUSED and g.code == &"invalid_grant" and g.http_status == 400 and bed.sdk.core.tokens.current() == "",
		str(g))
	bed.tokens = [{"status": 429, "headers": {"Content-Type": "application/json", "Retry-After": "9"}, "body": "{\"error\":\"rate_limited\"}"}]
	var rl: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: rate_limited carries retry_after_seconds", rl.code == &"rate_limited" and rl.retry_after_seconds == 9, str(rl))
	bed.tokens = [{"status": 429, "headers": {"Content-Type": "application/json", "Retry-After": "999999"}, "body": "{\"error\":\"rate_limited\"}"}]
	var rh: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check(
		"exchange: a Retry-After header is capped at 3600 s",
		rh.code == &"rate_limited" and rh.retry_after_seconds == 3600 and bed.sdk.core.tokens.current() == "",
		str(rh),
	)
	bed.tokens = [B.json(429, {"error": "rate_limited", "retryAfter": 86400})]
	var rb: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check(
		"exchange: a body retryAfter is capped at 3600 s, a refusal and no token",
		rb.kind == PKeyExchangeResult.KIND_REFUSED and rb.code == &"rate_limited" and rb.retry_after_seconds == 3600 and bed.sdk.core.tokens.current() == "",
		str(rb),
	)
	bed.tokens = [B.json(409, {"error": {"code": "license_choice_required"}, "view": VIEW})]
	var lc: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: a nested code and the fresh view are read", lc.code == &"license_choice_required" and lc.view.has("choices"), str(lc))
	bed.tokens = [B.json(403, {"error": "device_limit", "manageUrl": "https://key.plrs.im/portal"})]
	var dl: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: device_limit carries the https manage_url", dl.code == &"device_limit" and dl.manage_url.ends_with("/portal"), str(dl))
	bed.tokens = [B.json(500, {"error": "internal_error"})]
	var s: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: a 5xx is failed (server-error)", s.kind == PKeyExchangeResult.KIND_FAILED and s.code == PKeyErrors.SERVER_ERROR, str(s))
	# V5 §12.11.7 (exchange-pgs-errors, exchange-gamecenter-errors): the Worker's typed 503 is a refusal to retry later.
	bed.tokens = [B.json(503, {"error": "unavailable"})]
	var down: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: a typed 503 unavailable is refused (unavailable)", down.kind == PKeyExchangeResult.KIND_REFUSED and down.code == &"unavailable", str(down))
	bed.tokens = [B.json(503, {"error": "overloaded"})]
	var other: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: any other 503 is failed (server-error)", other.kind == PKeyExchangeResult.KIND_FAILED and other.code == PKeyErrors.SERVER_ERROR, str(other))
	bed.tokens = [B.json(404, {"error": "not_found"})]
	var nf: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: a 404 is unavailable", nf.kind == PKeyExchangeResult.KIND_UNAVAILABLE and nf.code == &"not_found", str(nf))
	var empty: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", "", NONCE)
	var shape: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, "short")
	t.check(
		"exchange: an empty token or a malformed nonce is invalid-argument, unsent",
		empty.code == &"invalid-argument" and shape.code == &"invalid-argument" and bed.token_requests.size() == 10,
		str(bed.token_requests.size()))
	bed.free_all()


func _unavailable(t: PKeyTestContext) -> void:
	var bed := await _bed(["apple"])
	var r: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check(
		"exchange: a kind the product does not accept is unavailable and unsent",
		r.kind == PKeyExchangeResult.KIND_UNAVAILABLE and r.code == &"platform-identity-unavailable" and bed.token_requests.is_empty() and bed.nonce_requests.is_empty(),
		str(r))
	bed.sdk.core.discovery_manifest["services"]["identity"].erase("exchange")
	var none: PKeyExchangeResult = await bed.sdk.identity.exchange.nonce("apple")
	t.check("exchange: no exchange member is unavailable", none.kind == PKeyExchangeResult.KIND_UNAVAILABLE, str(none))
	bed.free_all()
	bed = await _bed(["teleport", "google"])
	var ok: PKeyExchangeResult = await bed.sdk.identity.exchange.nonce("google")
	t.check("exchange: an unknown kind beside a known one does not break the known one", ok.ok, str(ok))
	bed.free_all()
	bed = await _bed(["google"])
	bed.sdk.identity.device_keys = PKeyDeviceKeyStore.memory_only()
	var mem: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: keys that die with the process are unavailable, unsent", mem.kind == PKeyExchangeResult.KIND_UNAVAILABLE and bed.token_requests.is_empty(), str(mem))
	bed.free_all()
	bed = await _bed(["google"])
	bed.sdk.core.discovery_manifest["services"]["identity"]["endpoints"]["token"] = "https://evil.example/djdl/identity/token"
	var away: PKeyExchangeResult = await bed.sdk.identity.exchange.exchange("google", PLATFORM_TOKEN, NONCE)
	t.check("exchange: an endpoint off the product's origin is refused unsent", not away.ok and bed.token_requests.is_empty(), str(away))
	bed.free_all()


func _consent(t: PKeyTestContext) -> void:
	var bed := await _bed()
	bed.choice_answers = {"complete": B.json(200, TOKEN_OK)}
	var done: PKeyChoiceResult = await bed.sdk.identity.choice.complete(GRANT, null, {"claims": ["email"]})
	var body: Dictionary = bed.choice_requests[0]["body"]
	t.check("consent: complete sends {grant, consent} alone for a confirm grant", body == {"grant": GRANT, "consent": {"claims": ["email"]}}, str(body))
	t.check("consent: the token is stored", done.ok and bed.sdk.core.tokens.current() == TOKEN_NEW and done.subject == "ps_abc", str(done))
	await bed.sdk.identity.choice.complete(GRANT, {"kind": "keep"}, {"claims": []})
	t.check(
		"consent: a choice and a consent travel together",
		bed.choice_requests[1]["body"] == {"grant": GRANT, "choice": {"kind": "keep"}, "consent": {"claims": []}},
		str(bed.choice_requests[1]["body"]))
	await bed.sdk.identity.choice.complete(GRANT, {"kind": "create"})
	t.check("consent: without a consent the body has none (a redirect grant)", bed.choice_requests[2]["body"] == {"grant": GRANT, "choice": {"kind": "create"}}, str(bed.choice_requests[2]["body"]))
	var no_choice: PKeyChoiceResult = await bed.sdk.identity.choice.complete(GRANT, null)
	var bad: PKeyChoiceResult = await bed.sdk.identity.choice.complete(GRANT, null, {"claims": "email"})
	var bad_claim: PKeyChoiceResult = await bed.sdk.identity.choice.complete(GRANT, null, {"claims": [1]})
	t.check(
		"consent: a null choice without consent, or a malformed consent, is invalid-argument and unsent",
		no_choice.code == &"invalid-argument" and bad.code == &"invalid-argument" and bad_claim.code == &"invalid-argument" and bed.choice_requests.size() == 3)
	bed.choice_answers = {"complete": B.json(400, {"error": {"code": "bad_request"}})}
	var refused: PKeyChoiceResult = await bed.sdk.identity.choice.complete(GRANT, null, {"claims": ["email"]})
	t.check("consent: the Worker's bad_request is a refusal", refused.kind == PKeyChoiceResult.KIND_REFUSED and refused.code == &"bad_request", str(refused))
	bed.free_all()


func _shared_store(t: PKeyTestContext) -> void:
	var bed := await _bed(["google"], false)
	var sdk: Node = bed.sdk
	t.check("keys: the default store is one instance, held by identity and by the key ring", sdk.identity.device_keys is PKeyDeviceKeyStore and sdk.identity.device_keys == sdk.keyring._keys)
	bed.free_all()
	bed = await _bed(["google"])
	t.check("keys: the options' device_keys wins and is shared too", bed.sdk.identity.device_keys == bed.device_keys and bed.sdk.keyring._keys == bed.device_keys)
	bed.free_all()
