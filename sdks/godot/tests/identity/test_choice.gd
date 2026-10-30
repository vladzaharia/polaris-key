extends RefCounted
# @pkey-feature identity.choice
# `identity.choice.*` (I-10b.6): the redirect sign-in that asked `license_choice = "app"` settles
# `license_choice` with a grant; `licenses / devices / complete / cancel` then dial only discovery's
# choice endpoints, send no bearer, return the Worker's refusals as results and never print the grant.
# The recorded conversations are the transcripts suite's.

const B := preload("res://tests/identity/support.gd")

const REDIRECT := "https://app.example/auth/callback"
const GRANT := "sg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const TOKEN_NEW := "pkeyt_NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW"
const VIEW := {"state": "choose", "choices": [{"id": "lic_a"}, {"id": "lic_b"}], "keep": false, "preselected": null, "create": null, "getLicense": null}
const OK := {
	"access_token": TOKEN_NEW, "token_type": "Bearer", "scope": "profile email", "schemaVersion": 1,
	"device": {"id": "D"}, "license": {"id": "lic_a"}, "subject": "ps_abc", "keyEntries": {"used": 1, "limit": 10},
}


func run(t: PKeyTestContext) -> void:
	await _outcome(t)
	await _calls(t)
	await _refusals(t)
	await _unavailable(t)


func _bed(token := "", with_choice := true) -> B:
	var bed := B.new()
	var sdk := await bed.make_sdk(token)
	sdk.identity.redirect_acquisition_sync = false
	var root := "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]
	var endpoints := {"authorize": root + "/authorize", "token": root + "/token"}
	if with_choice:
		endpoints.merge({"choiceLicenses": root + "/choice/licenses", "choiceDevices": root + "/choice/devices", "choiceComplete": root + "/choice/complete", "choiceCancel": root + "/choice/cancel"})
	sdk.core.discovery_manifest = {"product": bed.F["product"], "services": {"identity": {"enabled": true, "configured": true, "issuer": root, "endpoints": endpoints}}}
	return bed


func _param(url: String, name: String) -> String:
	for part in url.substr(url.find("?") + 1).split("&"):
		if part.begins_with(name + "="):
			return part.substr(name.length() + 1).uri_decode()
	return ""


func _callback(bed: B, state: String) -> String:
	return "%s?code=C0DE&state=%s&iss=%s" % [REDIRECT, state, ("%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]).uri_encode()]


func _chosen(bed: B) -> PKeySignInOutcome:
	bed.tokens = [B.json(200, {"status": "choose", "grant": GRANT, "expiresIn": 300, "choices": VIEW})]
	var s: PKeySignInSession = await bed.sdk.identity.sign_in.start({"channel": "redirect", "redirect_uri": REDIRECT, "license_choice": "app"})
	return await s.complete(_callback(bed, _param(s.authorize_url, "state")))


func _outcome(t: PKeyTestContext) -> void:
	var bed := await _bed()
	var s: PKeySignInSession = await bed.sdk.identity.sign_in.start({"channel": "redirect", "redirect_uri": REDIRECT, "license_choice": "app"})
	t.check("choice: the authorize URL asks license_choice=app", _param(s.authorize_url, "license_choice") == "app", s.authorize_url)
	bed.tokens = [B.json(200, {"status": "choose", "grant": GRANT, "expiresIn": 300, "choices": VIEW})]
	var o := await s.complete(_callback(bed, _param(s.authorize_url, "state")))
	t.check(
		"choice: the choose answer is the license_choice outcome",
		o.ok and o.kind == PKeySignInOutcome.KIND_LICENSE_CHOICE and o.grant == GRANT and o.expires_in == 300.0 and o.choices.has("choices"),
		str(o),
	)
	t.check("choice: nothing is stored and the grant is not printed", bed.sdk.core.tokens.current() == "" and not str(o).contains(GRANT))
	bed.free_all()
	# Without choice endpoints the request does not ask, and a choose answer is refused.
	bed = await _bed("", false)
	var plain: PKeySignInSession = await bed.sdk.identity.sign_in.start({"channel": "redirect", "redirect_uri": REDIRECT, "license_choice": "app"})
	t.check("choice: license_choice is withheld when discovery names no choice endpoints", _param(plain.authorize_url, "license_choice") == "")
	bed.tokens = [B.json(200, {"status": "choose", "grant": GRANT, "expiresIn": 300, "choices": VIEW})]
	var refused := await plain.complete(_callback(bed, _param(plain.authorize_url, "state")))
	t.check("choice: a choose answer nobody asked for is invalid-response", refused.code == PKeyErrors.INVALID_RESPONSE, str(refused))
	bed.free_all()


func _calls(t: PKeyTestContext) -> void:
	var bed := await _bed(B.TOKEN)
	bed.choice_answers = {
		"licenses": B.json(200, VIEW),
		"devices": B.json(200, {"licenseId": "lic_a", "devices": [{"id": "D1"}]}),
		"complete": B.json(200, OK),
		"cancel": {"status": 204},
	}
	var choice: PKeyIdentityChoice = bed.sdk.identity.choice
	var l := await choice.licenses(GRANT)
	t.check("choice: licenses() is the view", l.ok and l.kind == PKeyChoiceResult.KIND_OK and l.view["choices"].size() == 2, str(l))
	var req: Dictionary = bed.choice_requests[0]
	t.check("choice: the body is the grant alone and no bearer is sent", req["body"] == {"grant": GRANT} and not req["headers"].has("authorization") and req["headers"].has("x-pkey-device"), str(req))
	var d := await choice.devices(GRANT, "lic_a")
	t.check("choice: devices() is the view and sends licenseId", d.ok and d.view["devices"].size() == 1 and bed.choice_requests[1]["body"] == {"grant": GRANT, "licenseId": "lic_a"}, str(d))
	var c := await choice.complete(GRANT, {"kind": "license", "license_id": "lic_a", "replace_device_id": "D1"})
	t.check(
		"choice: complete() sends the choice in wire spelling",
		bed.choice_requests[2]["body"] == {"grant": GRANT, "choice": {"kind": "license", "licenseId": "lic_a", "replaceDeviceId": "D1"}},
		str(bed.choice_requests[2]["body"]),
	)
	t.check(
		"choice: complete() is ok with licence, subject and entries",
		c.ok and c.license_id == "lic_a" and c.subject == "ps_abc" and c.key_entries == {"used": 1, "limit": 10} and not c.attachable,
		str(c),
	)
	t.check("choice: complete() stored the token and the subject", bed.sdk.core.tokens.current() == TOKEN_NEW and bed.sdk.core.cache.subject == "ps_abc")
	var keep := await choice.complete(GRANT, {"kind": "keep"})
	t.check("choice: keep gives attachable", keep.ok and keep.attachable, str(keep))
	t.check(
		"choice: keep sends the device's bearer and the other choices send none",
		bed.choice_requests[3]["headers"].get("authorization", "") == "Bearer " + TOKEN_NEW,
		str(bed.choice_requests[3]["headers"]),
	)
	t.check("choice: a licence choice sent no bearer", not bed.choice_requests[2]["headers"].has("authorization"), str(bed.choice_requests[2]["headers"]))
	var bad := await choice.complete(GRANT, {"kind": "license"})
	t.check("choice: a license choice without an id is invalid-argument and sends nothing", bad.code == &"invalid-argument" and bed.choice_requests.size() == 4, str(bad))
	var x := await choice.cancel(GRANT)
	t.check("choice: cancel() is ok on a 204", x.ok, str(x))
	bed.free_all()


func _refusals(t: PKeyTestContext) -> void:
	var bed := await _bed(B.TOKEN)
	bed.choice_answers = {
		"licenses": B.json(409, {"error": {"code": "license_choice_required"}, "view": VIEW}),
		"devices": {"status": 429, "headers": {"Content-Type": "application/json"}, "body": "{\"error\":{\"code\":\"rate_limited\"},\"retryAfter\":7.2}"},
		"complete": B.json(409, {"error": {"code": "key_entry_limit"}, "manageUrl": "https://key.plrs.im/portal", "keyEntries": {"used": 10, "limit": 10}, "signInUrl": "https://key.plrs.im/in"}),
		"cancel": B.json(500, {"error": {"code": "boom"}}),
	}
	var choice: PKeyIdentityChoice = bed.sdk.identity.choice
	var l := await choice.licenses(GRANT)
	t.check(
		"choice: a refusal is a result carrying the fresh view",
		not l.ok and l.kind == PKeyChoiceResult.KIND_REFUSED and l.code == &"license_choice_required" and l.view.has("choices") and l.http_status == 409,
		str(l),
	)
	var d := await choice.devices(GRANT, "lic_a")
	t.check("choice: rate_limited carries retry_after_seconds", d.kind == PKeyChoiceResult.KIND_REFUSED and d.code == &"rate_limited" and d.retry_after_seconds == 8, str(d))
	var c := await choice.complete(GRANT, {"kind": "key", "key": "pkey_abc"})
	t.check(
		"choice: key_entry_limit carries entries, manage_url and sign_in_url",
		c.code == &"key_entry_limit" and c.key_entries == {"used": 10, "limit": 10} and c.manage_url.ends_with("/portal") and c.sign_in_url.ends_with("/in"),
		str(c),
	)
	t.check("choice: a refused complete keeps the token and stores nothing", bed.sdk.core.tokens.current() == B.TOKEN)
	var x := await choice.cancel(GRANT)
	t.check("choice: a 5xx is failed (server-error), not a refusal", x.kind == PKeyChoiceResult.KIND_FAILED and x.code == PKeyErrors.SERVER_ERROR, str(x))
	for r in [l, d, c, x]:
		t.check("choice: the grant is in no message, detail or string", not (str(r) + r.message + str(r.detail)).contains(GRANT))
	bed.free_all()


func _unavailable(t: PKeyTestContext) -> void:
	var bed := await _bed(B.TOKEN, false)
	var l: PKeyChoiceResult = await bed.sdk.identity.choice.licenses(GRANT)
	t.check(
		"choice: no choice endpoint is service-unavailable and nothing is sent",
		l.kind == PKeyChoiceResult.KIND_FAILED and l.code == PKeyErrors.SERVICE_UNAVAILABLE and bed.choice_requests.is_empty(),
		str(l),
	)
	bed.free_all()
	bed = await _bed(B.TOKEN)
	var root := "https://evil.example/djdl/identity"
	bed.sdk.core.discovery_manifest["services"]["identity"]["endpoints"]["choiceLicenses"] = root + "/choice/licenses"
	var away: PKeyChoiceResult = await bed.sdk.identity.choice.licenses(GRANT)
	t.check("choice: an endpoint off the product's origin is refused unsent", not away.ok and bed.choice_requests.is_empty(), str(away))
	bed.free_all()
	bed = await _bed(B.TOKEN)
	bed.choice_answers = {"licenses": B.json(200, VIEW)}
	var prim: Dictionary = bed.sdk.identity.choice.primitives()
	var view = await prim["licenses"].call(GRANT)
	t.check("choice: the form's licenses primitive returns the view Dictionary", view is Dictionary and view.has("choices"))
	bed.free_all()
