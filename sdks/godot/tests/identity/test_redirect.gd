extends RefCounted
# @pkey-feature identity.redirect.web identity.signin.hints
# The redirect channel (I-10b.5): PKeyIdentityRedirect on the vectors client-core ships
# (packages/client-core/test/identityRedirect.test.ts: RFC 7636 appendix B, the transcripts'
# conversation, the callback checks, the token answers), then the session on a fake Worker:
# single use, refusals that never wipe, the token endpoint on the product's origin only.

const B := preload("res://tests/identity/support.gd")
const R := preload("res://addons/polaris_key/services/identity/redirect.gd")

const ISS := "https://key.plrs.im/djdl/identity"
const STATE := "tidewater-state-0123456789"
const VERIFIER := "transcript-verifier-0123456789-abcdefghijklmnopqrst"
const REDIRECT := "https://app.example/auth/callback"
const AUTH_BASE := "https://key.plrs.im/djdl/identity/authorize"
const CHALLENGE := "-583Jx3Gn4AKAj7xr5NSDQ3V6snyKHhZUDKua28Tp10"
const GRANT := "sg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"


func run(t: PKeyTestContext) -> void:
	_pkce(t)
	_authorize(t)
	_callbacks(t)
	_token_form(t)
	_answers(t)
	await _session(t)


func _opts(extra := {}) -> Dictionary:
	var o := {
		"authorize_endpoint": AUTH_BASE, "token_endpoint": "https://key.plrs.im/djdl/identity/token", "issuer": ISS,
		"client_id": "djdl", "redirect_uri": REDIRECT, "state": STATE, "code_verifier": VERIFIER,
	}
	o.merge(extra, true)
	return o


func _pkce(t: PKeyTestContext) -> void:
	t.check("redirect: RFC 7636 appendix B challenge", R.pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
	t.check("redirect: the transcript conversation's challenge", R.pkce_challenge(VERIFIER) == CHALLENGE)
	var a := R.random_token()
	var re := RegEx.create_from_string("\\A[A-Za-z0-9_-]{43}\\z")
	t.check("redirect: random verifiers are 43 base64url characters and differ", re.search(a) != null and R.random_token() != a, a)


func _authorize(t: PKeyTestContext) -> void:
	var auth := "%s?response_type=code&client_id=djdl&redirect_uri=https%%3A%%2F%%2Fapp.example%%2Fauth%%2Fcallback&state=%s&code_challenge=%s&code_challenge_method=S256&scope=profile+email" % [AUTH_BASE, STATE, CHALLENGE]
	var table := [
		["the plain request", {}, auth],
		["hints, verbatim and form-encoded", {"login_hint": "Ada@Example.com", "name_hint": "Ada", "purpose": "attach"}, auth + "&login_hint=Ada%40Example.com&name_hint=Ada&purpose=attach"],
		["a hint that is not an email is still sent as given", {"login_hint": "not an email"}, auth + "&login_hint=not+an+email"],
		["license_choice=app when asked and the choice endpoints exist", {"license_choice": "app", "choice_available": true}, auth + "&license_choice=app"],
		["license_choice withheld without choice endpoints", {"license_choice": "app", "choice_available": false}, auth],
		["license_choice=card is never sent", {"license_choice": "card", "choice_available": true}, auth],
		["a scope list", {"scope": ["profile", "cloudSync"]}, auth.replace("scope=profile+email", "scope=profile+cloudSync")],
		["empty hints are dropped", {"login_hint": "", "name_hint": ""}, auth],
		["UTF-8, * and ~ in a hint", {"name_hint": "Zoë * ~"}, auth + "&name_hint=Zo%C3%AB+*+%7E"],
	]
	for row in table:
		var r := R.start(_opts(row[1]))
		t.check("redirect: authorize URL, %s" % row[0], r["ok"] and r["pending"]["authorize_url"] == row[2], str(r))
		if r["ok"]:
			t.check("redirect: the URL never carries the verifier (%s)" % row[0], not String(r["pending"]["authorize_url"]).contains(VERIFIER) and r["pending"]["state"] == STATE)
	var fresh := R.start(_opts({"state": null, "code_verifier": null}))
	t.check("redirect: random entropy yields a request that satisfies its own rules", fresh["ok"] and String(fresh["pending"]["authorize_url"]).contains("code_challenge=" + R.pkce_challenge(fresh["pending"]["code_verifier"])))
	var refusals := [
		["http redirect", {"redirect_uri": "http://app.example/cb"}],
		["loopback http (I-15's)", {"redirect_uri": "http://127.0.0.1:8080/cb"}],
		["a fragment", {"redirect_uri": REDIRECT + "#x"}],
		["userinfo", {"redirect_uri": "https://u:p@app.example/cb"}],
		["a relative URI", {"redirect_uri": "/cb"}],
		["a short state", {"state": "short"}],
		["a short verifier", {"code_verifier": "too-short"}],
		["a verifier outside the unreserved set", {"code_verifier": "a".repeat(42) + "+"}],
		["no issuer", {"issuer": ""}],
		["a relative token endpoint", {"token_endpoint": "/djdl/identity/token"}],
		["an empty scope", {"scope": "  "}],
	]
	for row in refusals:
		t.check("redirect: refuses %s before anything is built" % row[0], not R.start(_opts(row[1]))["ok"])
	t.check("redirect: is_redirect_uri", R.is_redirect_uri(REDIRECT) and R.is_redirect_uri("https://app.example") and not R.is_redirect_uri("https://app.example/a b") \
		and not R.is_redirect_uri("https://app.example\\@evil.example/") and not R.is_redirect_uri(5))


func _callbacks(t: PKeyTestContext) -> void:
	var p := {"state": STATE, "redirect_uri": REDIRECT, "issuer": ISS}
	var iss := "https%3A%2F%2Fkey.plrs.im%2Fdjdl%2Fidentity"
	var ok := "%s?code=abc_DEF-123&state=%s&iss=%s" % [REDIRECT, STATE, iss]
	var failed := func(reason: String) -> Dictionary: return {"kind": "failed", "code": "sign-in-failed", "reason": reason}
	var table := [
		["a valid callback", ok, {"kind": "code", "code": "abc_DEF-123"}],
		["parameters in another order, with an extra one", "%s?iss=%s&x=1&state=%s&code=c" % [REDIRECT, iss, STATE], {"kind": "code", "code": "c"}],
		["access_denied is cancelled", "%s?error=access_denied&state=%s&iss=%s" % [REDIRECT, STATE, iss], {"kind": "cancelled"}],
		["another error is a failure, naming it", "%s?error=server_error&state=%s&iss=%s" % [REDIRECT, STATE, iss], {"kind": "failed", "code": "sign-in-failed", "reason": "authorization-error", "error": "server_error"}],
		["a wrong state", ok.replace(STATE, "another-state-0123456789"), failed.call("state-mismatch")],
		["no state", "%s?code=c&iss=%s" % [REDIRECT, iss], failed.call("state-mismatch")],
		["a wrong issuer (mix-up, RFC 9207)", "%s?code=c&state=%s&iss=%s" % [REDIRECT, STATE, "https%3A%2F%2Fevil.example%2Fdjdl%2Fidentity"], failed.call("issuer-mismatch")],
		["no issuer", "%s?code=c&state=%s" % [REDIRECT, STATE], failed.call("issuer-mismatch")],
		["state is checked before iss, and iss before error", "%s?error=access_denied&state=bad-state-0123456789&iss=x" % REDIRECT, failed.call("state-mismatch")],
		["an access_denied from the wrong issuer is not a cancel", "%s?error=access_denied&state=%s&iss=x" % [REDIRECT, STATE], failed.call("issuer-mismatch")],
		["no code", "%s?state=%s&iss=%s" % [REDIRECT, STATE, iss], failed.call("missing-code")],
		["an empty code", "%s?code=&state=%s&iss=%s" % [REDIRECT, STATE, iss], failed.call("missing-code")],
		["a repeated code", ok + "&code=other", failed.call("malformed")],
		["another redirect URI path", ok.replace("/auth/callback", "/other"), failed.call("redirect-mismatch")],
		["another origin", ok.replace("app.example", "evil.example"), failed.call("redirect-mismatch")],
		["a fragment carrying the code is not read", "%s#code=c&state=%s&iss=%s" % [REDIRECT, STATE, iss], failed.call("state-mismatch")],
		["not a URL", "code=c&state=x", failed.call("malformed")],
		["a malformed percent escape is malformed, not a crash", "%s?code=%%E0%%A4%%A&state=%s" % [REDIRECT, STATE], failed.call("malformed")],
		["a percent escape that is not UTF-8", "%s?code=%%FF&state=%s&iss=%s" % [REDIRECT, STATE, iss], failed.call("malformed")],
	]
	for row in table:
		var got := R.check_callback(p, row[1])
		t.check("redirect: callback, %s" % row[0], got == row[2], "%s -> %s" % [row[1], got])


func _token_form(t: PKeyTestContext) -> void:
	var pending := {"client_id": "djdl", "code_verifier": VERIFIER, "redirect_uri": REDIRECT}
	t.check("redirect: token form, fixed member order", R.token_form(pending, "pql7NwTrZq8ADBYf14sz1sjf4BSnZl-AaWyCGWs9TX0") \
		== "grant_type=authorization_code&client_id=djdl&code=pql7NwTrZq8ADBYf14sz1sjf4BSnZl-AaWyCGWs9TX0&code_verifier=%s&redirect_uri=https%%3A%%2F%%2Fapp.example%%2Fauth%%2Fcallback" % VERIFIER)
	var named := R.token_form(pending, "c", "Ada's PC")
	t.check("redirect: token form adds device_name last", named.ends_with("&device_name=Ada%27s+PC") and named.contains("&redirect_uri="), named)


func _answers(t: PKeyTestContext) -> void:
	var device := {"id": "D", "status": "authorized"}
	var token := R.parse_token_answer(200, {"access_token": "pkeyt_x", "token_type": "Bearer", "scope": "profile email", "schemaVersion": 1.0, "device": device, "license": null, "subject": "ps_abc"})
	t.check("redirect: a token response", token == {"kind": "token", "access_token": "pkeyt_x", "scope": "profile email", "subject": "ps_abc", "schema_version": 1, "device": device, "license": null}, str(token))
	var choose := R.parse_token_answer(200, {"status": "choose", "grant": GRANT, "expiresIn": 300.0, "choices": {"state": "choose"}, "access_token": "pkeyt_ignored"})
	t.check("redirect: choose is decided by status alone, even beside other members", choose["kind"] == "choose" and choose["grant"] == GRANT and choose["choices"] == {"state": "choose"}, str(choose))
	var malformed := [
		["a bad grant", {"status": "choose", "grant": "sg_short", "expiresIn": 1.0, "choices": {}}],
		["no access_token", {"scope": "x", "subject": "s", "device": device, "license": null}],
		["no subject", {"access_token": "t", "scope": "x", "device": device, "license": null}],
		["no license member", {"access_token": "t", "scope": "x", "subject": "s", "device": device}],
		["not an object", "x"],
	]
	for row in malformed:
		t.check("redirect: 200 with %s is malformed" % row[0], R.parse_token_answer(200, row[1]) == {"kind": "malformed"})
	var refused := [
		[400, {"error": "invalid_grant"}, {"kind": "refused", "error": "invalid_grant", "status": 400}],
		[401, {"error": "invalid_client"}, {"kind": "refused", "error": "invalid_client", "status": 401}],
		[429, {"error": "rate_limited", "retryAfter": 2.2}, {"kind": "refused", "error": "rate_limited", "status": 429, "retry_after_seconds": 3}],
		[500, "oops", {"kind": "refused", "error": "server_error", "status": 500}],
		[502, {"error": ""}, {"kind": "refused", "error": "server_error", "status": 502}],
	]
	for row in refused:
		t.check("redirect: %d %s" % [row[0], row[1]], R.parse_token_answer(row[0], row[1]) == row[2], str(R.parse_token_answer(row[0], row[1])))


# ── The session ──────────────────────────────────────────────────────────────────────────

const TOKEN_OK := {
	"access_token": "pkeyt_NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW", "token_type": "Bearer", "scope": "profile email",
	"schemaVersion": 1, "device": {"id": "D"}, "license": {"id": "lic_1"}, "subject": "ps_abc",
}


func _bed(t: PKeyTestContext, token := "", identity_override: Variant = null, services := PackedStringArray(["license", "config", "identity"])) -> B:
	var bed := B.new()
	var sdk := await bed.make_sdk(token, services)
	sdk.identity.redirect_acquisition_sync = false
	var root := "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]
	var fragment: Dictionary = identity_override if identity_override is Dictionary else {
		"enabled": true, "configured": true, "issuer": root,
		"endpoints": {"authorize": root + "/authorize", "token": root + "/token"},
	}
	sdk.core.discovery_manifest = {"product": bed.F["product"], "services": {"identity": fragment}}
	return bed


func _begin(bed: B, extra := {}) -> PKeySignInSession:
	var opts := {"channel": "redirect", "redirect_uri": REDIRECT}
	opts.merge(extra, true)
	return await bed.sdk.identity.sign_in.start(opts)


func _param(url: String, name: String) -> String:
	var q := url.substr(url.find("?") + 1)
	for part in q.split("&"):
		if part.begins_with(name + "="):
			return part.substr(name.length() + 1).uri_decode()
	return ""


func _callback(bed: B, state: String, q := "code=C0DE") -> String:
	return "%s?%s&state=%s&iss=%s" % [REDIRECT, q, state, ("%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]).uri_encode()]


func _session(t: PKeyTestContext) -> void:
	var bed := await _bed(t)
	bed.tokens = [B.json(200, TOKEN_OK)]
	var seen := []
	var s := await _begin(bed, {"login_hint": "ada@example.com"})
	s.outcome.connect(func(o): seen.append(o))
	t.check("redirect session: starts on the redirect channel with an authorize URL", s.ok and s.channel == &"redirect" and s.authorize_url.begins_with(bed.server.base_url()) and s.user_code == "", str(s))
	t.check("redirect session: the URL carries the challenge and the hint, never the verifier", _param(s.authorize_url, "code_challenge_method") == "S256" and _param(s.authorize_url, "login_hint") == "ada@example.com" and not s.authorize_url.contains("code_verifier"))
	t.check("redirect session: sends nothing at start", bed.token_requests.is_empty() and bed.flow_requests.is_empty())
	var state := _param(s.authorize_url, "state")
	var o := await s.complete(_callback(bed, state))
	t.check("redirect session: complete() signs in", o.kind == PKeySignInOutcome.KIND_SIGNED_IN and o.subject == "ps_abc" and o.scope == "profile email" and o.license_id == "lic_1", str(o))
	t.check("redirect session: the outcome signal fired once with it", seen.size() == 1 and seen[0] == o)
	t.check("redirect session: the token is stored", bed.sdk.core.tokens.current() == TOKEN_OK["access_token"])
	var req: Dictionary = bed.token_requests[0] if bed.token_requests.size() == 1 else {}
	var body := String(req.get("body", ""))
	t.check("redirect session: one form POST, no bearer", bed.token_requests.size() == 1 and String(req["headers"].get("content-type", "")).begins_with("application/x-www-form-urlencoded") and not req["headers"].has("authorization"), str(req))
	t.check("redirect session: the form body", body.begins_with("grant_type=authorization_code&client_id=djdl&code=C0DE&code_verifier=") and body.contains("&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback"), body)
	var again := await s.complete(_callback(bed, state))
	t.check("redirect session: single use, a replay is refused without a request", again.code == PKeyErrors.SIGN_IN_FAILED and bed.token_requests.size() == 1, str(again))
	t.check("redirect session: a settled session answers the same outcome", await s.wait() == o)
	bed.free_all()

	# A callback that is refused locally sends nothing and keeps the token.
	bed = await _bed(t, B.TOKEN)
	for url in ["%s?code=c&state=wrong-state-0123456789&iss=x" % REDIRECT, "https://evil.example/cb?code=c"]:
		var s2 := await _begin(bed)
		var r := await s2.complete(url)
		t.check("redirect session: refuses %s locally" % url.left(30), r.kind == PKeySignInOutcome.KIND_ERROR and r.code == PKeyErrors.SIGN_IN_FAILED, str(r))
	t.check("redirect session: refused callbacks sent nothing and kept the token", bed.token_requests.is_empty() and bed.sdk.core.tokens.current() == B.TOKEN)
	var s3 := await _begin(bed)
	var denied := await s3.complete(_callback(bed, _param(s3.authorize_url, "state"), "error=access_denied"))
	t.check("redirect session: access_denied is cancelled", denied.kind == PKeySignInOutcome.KIND_CANCELLED and bed.token_requests.is_empty(), str(denied))
	var s4 := await _begin(bed)
	var st4 := _param(s4.authorize_url, "state")
	s4.cancel()
	var cancelled := await s4.complete(_callback(bed, st4))
	t.check("redirect session: cancel drops the pending request", s4.is_waiting() == false and cancelled.code == PKeyErrors.SIGN_IN_FAILED and await s4.wait() != null and (await s4.wait()).kind == PKeySignInOutcome.KIND_CANCELLED and bed.token_requests.is_empty())
	bed.free_all()

	# The Worker's refusals are typed and never wipe the token.
	var cases := [
		["invalid_grant", B.json(400, {"error": "invalid_grant"}), &"invalid_grant", -1],
		["rate_limited with Retry-After", {"status": 429, "headers": {"Content-Type": "application/json", "Retry-After": "7"}, "body": "{\"error\":\"rate_limited\"}"}, &"rate_limited", 7],
		["a 502", {"status": 502, "body": "bad gateway"}, PKeyErrors.SERVER_ERROR, -1],
		["a choose answer (no choice yet)", B.json(200, {"status": "choose", "grant": GRANT, "expiresIn": 300, "choices": {}}), PKeyErrors.INVALID_RESPONSE, -1],
		["a 200 without a token", B.json(200, {"scope": "x"}), PKeyErrors.INVALID_RESPONSE, -1],
	]
	for c in cases:
		bed = await _bed(t, B.TOKEN)
		bed.tokens = [c[1]]
		var s5 := await _begin(bed)
		var r5 := await s5.complete(_callback(bed, _param(s5.authorize_url, "state")))
		var retry: int = r5.detail.get("retry_after_seconds", -1) if r5.detail is Dictionary else -1
		t.check("redirect session: %s is %s" % [c[0], c[2]], r5.kind == PKeySignInOutcome.KIND_ERROR and r5.code == c[2] and retry == c[3], str(r5))
		t.check("redirect session: %s keeps the token" % c[0], bed.sdk.core.tokens.current() == B.TOKEN)
		bed.free_all()

	# start() refusals.
	bed = await _bed(t)
	var bad := await _begin(bed, {"redirect_uri": "http://app.example/cb"})
	t.check("redirect start: an http redirect_uri is invalid-argument", not bad.ok and bad.code == &"invalid-argument", str(bad))
	var missing := await _begin(bed, {"redirect_uri": null})
	t.check("redirect start: a missing redirect_uri is invalid-argument", not missing.ok and missing.code == &"invalid-argument")
	var device: PKeySignInSession = await bed.sdk.identity.sign_in.start()
	var misuse: PKeySignInOutcome = await device.complete(REDIRECT)
	t.check("redirect: complete() on a device-code session is invalid-argument", misuse.code == &"invalid-argument", str(misuse))
	bed.free_all()
	bed = await _bed(t)
	var rs := await _begin(bed)
	var waited := await rs.wait()
	t.check("redirect: wait() on a redirect session is invalid-argument", waited.code == &"invalid-argument", str(waited))
	bed.free_all()
	bed = await _bed(t, "", {"enabled": true, "configured": true})
	var none := await _begin(bed)
	t.check("redirect start: no endpoints in discovery is sign-in-unavailable", not none.ok and none.code == &"sign-in-unavailable", str(none))
	bed.free_all()
	var root := "https://evil.example/djdl/identity"
	bed = await _bed(t, "", {"enabled": true, "configured": true, "issuer": root, "endpoints": {"authorize": root + "/authorize", "token": root + "/token"}})
	var away := await _begin(bed)
	t.check("redirect start: a token endpoint off the product is refused", not away.ok and away.code == PKeyErrors.INVALID_RESPONSE, str(away))
	bed.free_all()
	bed = await _bed(t, "", {"enabled": false}, PackedStringArray(["license", "config"]))
	var off := await _begin(bed)
	t.check("redirect start: Identity off is service-unavailable", not off.ok and off.code == PKeyErrors.SERVICE_UNAVAILABLE, str(off))
	bed.free_all()
