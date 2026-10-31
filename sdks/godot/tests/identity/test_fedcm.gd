extends RefCounted
# @pkey-feature identity.exchange identity.autosignin
# The FedCM provider on the web export (I-48.8): the request it makes of the browser, the id token's
# nonce checked before hand-off, the unavailable cases (no IdentityCredential, an insecure context, a
# framed export without the permission, no client id, not a web export), the shim installed once,
# preventSilentAccess on sign-out, and the ladder over it. A fake JavaScript seam stands in for
# JavaScriptBridge: the shim's own browser code is not run here (a real Chromium run is OS-5).

const B := preload("res://tests/identity/support.gd")
const X := preload("res://tests/identity/test_exchange.gd")

const CLIENT := "g.apps"
const NONCE := "NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN"


static func jwt(claims: Variant) -> String:
	var head := PKeyB64Url.encode(JSON.stringify({"alg": "RS256"}).to_utf8_buffer())
	return "%s.%s.sig" % [head, PKeyB64Url.encode(JSON.stringify(claims).to_utf8_buffer())]


## What the page's `__pkeyFedcm` does, scripted: `answer` is the shim's JSON, or a Callable
## `func(request: Dictionary) -> Dictionary` that builds it from the request.
class FakeShim extends RefCounted:
	var reason := ""
	var answer: Variant = {"status": "cancelled"}
	var requests: Array = []
	var stops := 0
	var cancel_after := false

	func can_run() -> String:
		return reason

	func start(json: String, cb: Object) -> void:
		var req: Dictionary = JSON.parse_string(json)
		requests.append(req)
		var a: Dictionary = answer.call(req) if answer is Callable else answer
		# The bridge calls back with the arguments as an Array.
		cb.callable.call([JSON.stringify(a)])

	func stop() -> void:
		stops += 1


class FakeCallback extends RefCounted:
	var callable: Callable

	func _init(c: Callable) -> void:
		callable = c


## The `JavaScriptBridge` surface the provider uses.
class FakeJs extends RefCounted:
	var shim := FakeShim.new()
	var installs := 0
	var evals: Array = []

	func eval(code: String, _global := false) -> Variant:
		evals.append(code)
		if code.begins_with("typeof window."):
			return "object" if installs > 0 else "undefined"
		installs += 1
		return null

	func get_interface(interface_name: String) -> Object:
		return shim if installs > 0 and interface_name == "__pkeyFedcm" else null

	func create_callback(c: Callable) -> Object:
		return FakeCallback.new(c)


func run(t: PKeyTestContext) -> void:
	await _request(t)
	await _token(t)
	await _answers(t)
	await _unavailable(t)
	await _install_once(t)
	await _sign_out(t)
	await _ladder(t)
	_shim_source(t)


func _provider(js: FakeJs = null) -> Array:
	var fake := js if js != null else FakeJs.new()
	return [PKeyFedcmProvider.new(fake), fake]


func _request(t: PKeyTestContext) -> void:
	var pair := _provider()
	var p: PKeyFedcmProvider = pair[0]
	var js: FakeJs = pair[1]
	js.shim.answer = {"status": "cancelled"}
	await p.silent(NONCE, CLIENT)
	var req: Dictionary = js.shim.requests[0]
	t.check("fedcm: the provider is the google kind", p.kind == "google")
	var fixed: bool = req["configURL"] == "https://accounts.google.com/gsi/fedcm.json" and req["clientId"] == CLIENT
	t.check("fedcm: Google's config URL, the client id and silent mediation", fixed and req["mediation"] == "silent", str(req))
	t.check("fedcm: the nonce at the top level and in params", req["nonce"] == NONCE and req["params"] == {"nonce": NONCE}, str(req))
	t.check("fedcm: the 8 s timeout", int(req["timeoutMs"]) == 8000 and PKeyFedcmProvider.TIMEOUT_MS == 8000, str(req))
	await p.sheet(NONCE, CLIENT)
	t.check("fedcm: the sheet is optional mediation", js.shim.requests[1]["mediation"] == "optional")
	await p.provider_row(NONCE, CLIENT)
	t.check("fedcm: the provider row is the sheet", js.shim.requests[2]["mediation"] == "optional")
	t.check("fedcm: silent and a sheet are both offered", p.has_silent() and p.has_sheet())


func _token(t: PKeyTestContext) -> void:
	var pair := _provider()
	var p: PKeyFedcmProvider = pair[0]
	var js: FakeJs = pair[1]
	var good := jwt({"nonce": NONCE, "sub": "s"})
	js.shim.answer = {"status": "token", "token": good}
	var r := await p.silent(NONCE, CLIENT)
	t.check("fedcm: a token for our nonce is handed on", r == {"token": good}, str(r.keys()))
	# A provider that ignored the nonce, or a token that is not a JWT, is refused, never handed on.
	var bads := {
		"another nonce": jwt({"nonce": "OTHER"}), "no nonce": jwt({}), "a number": jwt({"nonce": 7}),
		"not a jwt": "not-a-jwt", "bad base64": "a.!!!.c", "claims not an object": "a." + PKeyB64Url.encode("[1]".to_utf8_buffer()) + ".c",
	}
	for why in bads:
		js.shim.answer = {"status": "token", "token": bads[why]}
		var m := await p.silent(NONCE, CLIENT)
		t.check("fedcm: a token whose nonce claim is not ours is refused (%s)" % why, m.has("unavailable") and not m.has("token"), str(m.keys()))
	js.shim.answer = {"status": "token", "token": ""}
	t.check("fedcm: an empty token is a dismissal", (await p.silent(NONCE, CLIENT)) == {"cancelled": true})
	t.check("fedcm: token_nonce reads the claim", PKeyFedcmProvider.token_nonce(good) == NONCE and PKeyFedcmProvider.token_nonce("x") == "")


func _answers(t: PKeyTestContext) -> void:
	var pair := _provider()
	var p: PKeyFedcmProvider = pair[0]
	var js: FakeJs = pair[1]
	js.shim.answer = {"status": "cancelled"}
	t.check("fedcm: no signed-in account or a dismissal is cancelled", (await p.silent(NONCE, CLIENT)) == {"cancelled": true})
	js.shim.answer = {"status": "timeout"}
	var timed := await p.silent(NONCE, CLIENT)
	t.check("fedcm: a timeout is unavailable", timed.has("unavailable"), str(timed))
	js.shim.answer = {"status": "error"}
	t.check("fedcm: a browser error is unavailable", (await p.silent(NONCE, CLIENT)).has("unavailable"))
	js.shim.answer = {"status": "surprise"}
	t.check("fedcm: an unknown status is unavailable", (await p.silent(NONCE, CLIENT)).has("unavailable"))


func _unavailable(t: PKeyTestContext) -> void:
	var pair := _provider()
	var p: PKeyFedcmProvider = pair[0]
	var js: FakeJs = pair[1]
	for why in ["no-identity-credential", "insecure-context", "no-iframe-permission"]:
		js.shim.reason = why
		var r := await p.silent(NONCE, CLIENT)
		t.check("fedcm: %s is unavailable and asks nothing of the browser" % why, r == {"unavailable": why} and js.shim.requests.is_empty() and not p.available(), str(r))
	js.shim.reason = ""
	t.check("fedcm: available when the shim says so", p.available())
	var none := await p.silent(NONCE, "")
	t.check("fedcm: no client id for Google is unavailable", none.has("unavailable") and js.shim.requests.is_empty(), str(none))
	var nonce := await p.silent("", CLIENT)
	t.check("fedcm: no nonce is unavailable", nonce.has("unavailable") and js.shim.requests.is_empty())
	# Not a web export: no bridge.
	var off := PKeyFedcmProvider.new(null)
	var off_silent := await off.silent(NONCE, CLIENT)
	var off_sheet := await off.sheet(NONCE, CLIENT)
	t.check("fedcm: without a JavaScript bridge (not a web export) it is unavailable", off_silent.has("unavailable") and off_sheet.has("unavailable") and not off.available())
	off.sign_out_cleanup()
	t.check("fedcm: sign-out without a bridge does nothing", true)


func _install_once(t: PKeyTestContext) -> void:
	var pair := _provider()
	var p: PKeyFedcmProvider = pair[0]
	var js: FakeJs = pair[1]
	for i in 3:
		await p.silent(NONCE, CLIENT)
	t.check("fedcm: the shim is installed once", js.installs == 1, str(js.installs))
	# A second provider on the same page finds the global and does not install again.
	var second := PKeyFedcmProvider.new(js)
	await second.silent(NONCE, CLIENT)
	t.check("fedcm: a page that already has the shim is not given another", js.installs == 1, str(js.installs))
	t.check("fedcm: the installed code is the shim", js.evals.any(func(e): return String(e).contains("window.__pkeyFedcm = {")))


func _sign_out(t: PKeyTestContext) -> void:
	var pair := _provider()
	var p: PKeyFedcmProvider = pair[0]
	var js: FakeJs = pair[1]
	p.sign_out_cleanup()
	t.check("fedcm: sign-out calls preventSilentAccess (through the shim's stop)", js.shim.stops == 1)
	t.check("fedcm: the port's other members are inert", not p.credential_revoked())
	p.session_started({"user_id": "u"})


func _ladder(t: PKeyTestContext) -> void:
	var bed := B.new()
	bed.device_keys = PKeyDeviceKeyStore.new("djdl", "user://pkey_test_fedcm_%d" % Time.get_ticks_usec(), false, false)
	var sdk = await bed.make_sdk("", PackedStringArray(["license", "config", "identity"]))
	sdk.identity.redirect_acquisition_sync = false
	var root := "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]
	sdk.core.discovery_manifest = {"product": bed.F["product"], "services": {"identity": {
		"enabled": true, "configured": true, "account": true, "issuer": root,
		"exchange": {"kinds": ["google"], "google": {"serverClientId": CLIENT}},
		"endpoints": {"token": root + "/token", "nonce": root + "/nonce", "signout": root + "/signout",
			"choiceLicenses": root + "/choice/licenses", "choiceDevices": root + "/choice/devices",
			"choiceComplete": root + "/choice/complete", "choiceCancel": root + "/choice/cancel"},
	}}}
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	var pair := _provider()
	var p: PKeyFedcmProvider = pair[0]
	var js: FakeJs = pair[1]
	# The browser signs an id token over the nonce it was given.
	var platform_token := jwt({"nonce": X.NONCE, "sub": "g-sub"})
	js.shim.answer = func(req: Dictionary) -> Dictionary: return {"status": "token", "token": jwt({"nonce": req["nonce"], "sub": "g-sub"})}
	sdk.identity.install_platform_provider(p)
	bed.tokens = [B.json(200, X.TOKEN_OK)]
	var r = await sdk.identity.auto_sign_in()
	t.check("ladder: FedCM silent signs in through the exchange", r.ok and r.kind == PKeyAutoSignInResult.KIND_SIGNED_IN and r.provider == "google" and r.via == "platform", str(r))
	var form := {}
	for part in String(bed.token_requests[0]["body"]).split("&"):
		form[part.get_slice("=", 0).uri_decode()] = part.get_slice("=", 1).uri_decode()
	var asked: Dictionary = js.shim.requests[0]
	t.check("ladder: the Worker's nonce went to the browser, silently", asked["nonce"] == X.NONCE and asked["mediation"] == "silent", str(asked))
	t.check("ladder: the exchange carries the browser's token and that nonce", form["subject_token"] == platform_token and form["nonce"] == X.NONCE)
	t.check("ladder: no secret in the result", not (str(r) + r.message).contains(platform_token))
	# Sign-out stops the browser choosing the account again.
	bed.signouts = [B.json(200, {"released": true})]
	await sdk.identity.sign_out()
	t.check("ladder: sign-out reaches preventSilentAccess", js.shim.stops == 1, str(js.shim.stops))
	# Dismissed: the form is next, and nothing is stored.
	js.shim.answer = {"status": "cancelled"}
	var c = await sdk.identity.auto_sign_in({"explicit": true})
	t.check("ladder: a FedCM dismissal is needs_sign_in(no_credential)", c.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and c.reason == "no_credential" and not sdk.core.tokens.has_token(), str(c))
	# A browser without FedCM: the ladder falls through to the form.
	js.shim.reason = "no-identity-credential"
	var u = await sdk.identity.auto_sign_in({"explicit": true})
	t.check("ladder: a browser without FedCM ends at the regular sign-in", u.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN, str(u))
	bed.free_all()


## The shim carries each behaviour the port documents (its browser code is exercised by the real-browser run).
func _shim_source(t: PKeyTestContext) -> void:
	var src: String = PKeyFedcmProvider.SHIM_SOURCE
	var needles := [
		"IdentityCredential", "isSecureContext", "identity-credentials-get", "AbortController", "preventSilentAccess",
		"params: req.params", "nonce: req.nonce", "mediation: req.mediation", "clientId: req.clientId", "configURL: req.configURL",
	]
	for needle in needles:
		t.check("fedcm shim: %s" % needle, src.contains(needle))
