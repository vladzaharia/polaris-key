extends RefCounted
# @pkey-feature identity.autosignin
# `identity.auto_sign_in()` (I-48.2): the ladder over fake providers (order, cancel, one sheet, the
# exchange answers), the sign-out rules (flag, generation race, provenance, revoked at launch) and the
# cache record's fail-closed reads. No real platform and no real Worker.

const B := preload("res://tests/identity/support.gd")
const X := preload("res://tests/identity/test_exchange.gd")


## A scripted platform provider. `log` is shared across providers so the tests read the call order.
class Fake extends PKeyPlatformIdentityProvider:
	var log: Array
	var silent_answer: Variant = {"unavailable": "none"}
	var sheet_answer: Variant = {"unavailable": "none"}
	var silent_hook := Callable()
	var can_silent := true
	var can_sheet := true
	var revoked := false
	var started: Array = []
	var cleaned := 0
	var seen_nonce := ""
	var seen_audience := ""

	func _init(p_kind: String, p_log: Array) -> void:
		kind = p_kind
		log = p_log

	func has_silent() -> bool:
		return can_silent

	func has_sheet() -> bool:
		return can_sheet

	func silent(nonce: String, audience: String) -> Dictionary:
		log.append("%s.silent" % kind)
		seen_nonce = nonce
		seen_audience = audience
		if silent_hook.is_valid():
			await silent_hook.call()
		return silent_answer

	func sheet(nonce: String, audience: String) -> Dictionary:
		log.append("%s.sheet" % kind)
		seen_nonce = nonce
		seen_audience = audience
		return sheet_answer

	func session_started(info: Dictionary) -> void:
		started.append(info)

	func sign_out_cleanup() -> void:
		cleaned += 1
		log.append("%s.cleanup" % kind)

	func credential_revoked() -> bool:
		log.append("%s.revoked?" % kind)
		return revoked


func run(t: PKeyTestContext) -> void:
	await _rung_one(t)
	await _order_and_nonce(t)
	await _prompt_and_cancel(t)
	await _answers(t)
	await _sign_out_rules(t)
	await _generation_race(t)
	await _revoked(t)
	await _fail_closed(t)
	await _linux(t)


func _bed(kinds := ["google", "apple", "gamecenter", "pgs"], token := "") -> B:
	var bed := B.new()
	bed.device_keys = PKeyDeviceKeyStore.for_tests("djdl", "user://pkey_test_auto_%d" % Time.get_ticks_usec())
	var sdk = await bed.make_sdk(token, PackedStringArray(["license", "config", "identity"]))
	sdk.identity.redirect_acquisition_sync = false
	var root := "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]
	sdk.core.discovery_manifest = {"product": bed.F["product"], "services": {"identity": {
		"enabled": true, "configured": true, "account": true, "issuer": root,
		"exchange": {"kinds": kinds, "google": {"serverClientId": "g.apps"}, "pgs": {"serverClientId": "p.apps"}},
		"endpoints": {"token": root + "/token", "nonce": root + "/nonce", "signout": root + "/signout",
			"choiceLicenses": root + "/choice/licenses", "choiceDevices": root + "/choice/devices",
			"choiceComplete": root + "/choice/complete", "choiceCancel": root + "/choice/cancel"},
	}}}
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	return bed


func _form(text: String) -> Dictionary:
	var out := {}
	for part in text.split("&"):
		out[part.get_slice("=", 0).uri_decode()] = part.get_slice("=", 1).uri_decode()
	return out


func _signed_in_bed(origin_source := PKeyTokenManager.SOURCE_SIGNIN) -> B:
	var bed := await _bed(["google"], B.TOKEN)
	await bed.sdk.sync()
	bed.sdk.core.tokens.set_token(B.TOKEN, origin_source)
	return bed


func _rung_one(t: PKeyTestContext) -> void:
	var bed := await _signed_in_bed()
	var log := []
	var g := Fake.new("google", log)
	bed.sdk.identity.install_platform_provider(g)
	bed.server.requests.clear()
	var r = await bed.sdk.identity.auto_sign_in()
	t.check(
		"ladder: a sign_in token with a licence is rung 1, no network",
		r.ok and r.kind == PKeyAutoSignInResult.KIND_SIGNED_IN and r.via == "stored" and bed.server.requests.is_empty() and bed.nonce_requests.is_empty(),
		str(r))
	t.check("ladder: rung 1 names the subject-less session and asks no provider for a token", log == ["google.revoked?"], str(log))
	t.check("ladder: the provenance is in the cache record", bed.sdk.core.cache.record()["tokenOrigin"] == "sign_in")
	var again := PKeyCache.new(bed.sdk.core.store, bed.sdk.core.trust, bed.sdk.core.clock, bed.F["product"], bed.F["device_id"])
	await again.load_record()
	t.check("ladder: the provenance survives a restart", again.token_origin == "sign_in" and not again.explicit_sign_out)
	bed.free_all()
	for source in [PKeyTokenManager.SOURCE_ACTIVATE, PKeyTokenManager.SOURCE_ENROLL, PKeyTokenManager.SOURCE_REGISTER]:
		bed = await _signed_in_bed(source)
		var other = await bed.sdk.identity.auto_sign_in()
		t.check(
			"ladder: a %s token is not a sign-in (rung 1 skipped, no provider: needs_sign_in)" % source,
			other.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and other.reason == "no_credential",
			str(other))
		bed.free_all()
	bed = await _signed_in_bed()
	bed.sdk.core.tokens.set_token("pkeyt_REACQUIREDREACQUIREDREACQUIREDREAC", PKeyTokenManager.SOURCE_REACQUIRE)
	t.check("ladder: a re-acquire keeps the provenance", bed.sdk.core.tokens.origin() == "sign_in")
	bed.sdk.core.tokens.set_token("pkeyt_KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYK", PKeyTokenManager.SOURCE_ACTIVATE)
	t.check("ladder: a key activation replaces it", bed.sdk.core.tokens.origin() == "key")
	bed.free_all()
	# No licence in the cache: not a session.
	bed = await _bed(["google"], B.TOKEN)
	bed.sdk.core.tokens.set_token(B.TOKEN, PKeyTokenManager.SOURCE_SIGNIN)
	var nolic = await bed.sdk.identity.auto_sign_in()
	t.check("ladder: a sign_in token without a verified licence is not rung 1", nolic.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN, str(nolic))
	bed.free_all()


func _order_and_nonce(t: PKeyTestContext) -> void:
	var bed := await _bed()
	var log := []
	var apple := Fake.new("apple", log)
	apple.can_silent = false
	var google := Fake.new("google", log)
	var gc := Fake.new("gamecenter", log)
	var pgs := Fake.new("pgs", log)
	for p in [apple, google, pgs, gc]:
		bed.sdk.identity.install_platform_provider(p)
	bed.nonces = [B.json(200, {"nonce": "A".repeat(43), "expiresIn": 300}), B.json(200, {"nonce": "B".repeat(43), "expiresIn": 300}), B.json(200, {"nonce": "C".repeat(43), "expiresIn": 300})]
	google.silent_answer = {"token": X.PLATFORM_TOKEN, "user_id": "u1"}
	bed.tokens = [B.json(200, X.TOKEN_OK)]
	var r = await bed.sdk.identity.auto_sign_in()
	var silent_calls := log.filter(func(e): return e.ends_with(".silent"))
	t.check(
		"ladder: rung 3 walks games first (gamecenter, pgs, google), then stops at the token; apple has no silent rung",
		silent_calls == ["gamecenter.silent", "pgs.silent", "google.silent"],
		str(log))
	t.check(
		"ladder: a fresh nonce for each attempt",
		bed.nonce_requests.size() == 3 and google.seen_nonce == "C".repeat(43) and gc.seen_nonce == "A".repeat(43) and pgs.seen_nonce == "B".repeat(43),
		str(bed.nonce_requests.size()))
	t.check(
		"ladder: the exchange carries the attempt's own nonce, the token and no bearer",
		_form(bed.token_requests[0]["body"])["nonce"] == "C".repeat(43)
		and _form(bed.token_requests[0]["body"])["subject_token"] == X.PLATFORM_TOKEN
		and not bed.token_requests[0]["headers"].has("authorization"))
	t.check("ladder: the audience is discovery's serverClientId for the kind", google.seen_audience == "g.apps" and pgs.seen_audience == "p.apps" and gc.seen_audience == "")
	t.check(
		"ladder: signed_in via platform with the provider, subject and licence",
		r.ok and r.kind == PKeyAutoSignInResult.KIND_SIGNED_IN and r.via == "platform" and r.provider == "google" and r.subject == "ps_abc" and r.license_id == "lic_a",
		str(r))
	t.check(
		"ladder: the token is stored as a sign_in, and the provider hears of the session",
		bed.sdk.core.tokens.current() == X.TOKEN_NEW and bed.sdk.core.tokens.origin() == "sign_in" and google.started == [{"user_id": "u1"}] and gc.started.is_empty())
	t.check("ladder: the ladder's own exchange did not touch the flag", not bed.sdk.core.cache.explicit_sign_out)
	t.check("ladder: no secret in the result's strings", not (str(r) + r.message).contains(X.PLATFORM_TOKEN) and not str(r).contains(X.TOKEN_NEW))
	bed.free_all()
	# discovery's kinds ∩ installed ∩ opts.kinds
	bed = await _bed(["google", "apple"])
	log = []
	var gc2 := Fake.new("gamecenter", log)
	var g2 := Fake.new("google", log)
	bed.sdk.identity.install_platform_provider(gc2)
	bed.sdk.identity.install_platform_provider(g2)
	var none = await bed.sdk.identity.auto_sign_in()
	t.check(
		"ladder: a kind discovery does not publish is not tried",
		log.filter(func(e): return e.ends_with(".silent")) == ["google.silent"] and none.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and none.reason == "no_credential",
		str(log))
	log.clear()
	await bed.sdk.identity.auto_sign_in({"kinds": ["apple"]})
	t.check("ladder: opts.kinds narrows the walk (apple is not installed: nothing asked)", log.filter(func(e): return e.ends_with(".silent")).is_empty())
	var off = await bed.sdk.identity.auto_sign_in({"kinds": ["gamecenter"]})
	t.check("ladder: no candidate is unavailable (platform-identity-unavailable)", off.kind == PKeyAutoSignInResult.KIND_UNAVAILABLE and off.code == &"platform-identity-unavailable", str(off))
	bed.free_all()
	# A product without the exchange member.
	bed = await _bed(["google"])
	bed.sdk.core.discovery_manifest["services"]["identity"].erase("exchange")
	bed.sdk.identity.install_platform_provider(Fake.new("google", []))
	var nox = await bed.sdk.identity.auto_sign_in()
	t.check("ladder: a product with no exchange is unavailable, nothing sent", nox.kind == PKeyAutoSignInResult.KIND_UNAVAILABLE and bed.nonce_requests.is_empty(), str(nox))
	bed.free_all()


func _prompt_and_cancel(t: PKeyTestContext) -> void:
	var bed := await _bed(["google", "apple", "pgs"])
	var log := []
	var apple := Fake.new("apple", log)
	apple.can_silent = false
	apple.sheet_answer = {"cancelled": true}
	var google := Fake.new("google", log)
	google.sheet_answer = {"cancelled": true}
	bed.sdk.identity.install_platform_provider(apple)
	bed.sdk.identity.install_platform_provider(google)
	var r = await bed.sdk.identity.auto_sign_in()
	t.check(
		"prompt: the default never shows a sheet",
		not log.any(func(e): return e.ends_with(".sheet")) and r.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and r.reason == "no_credential",
		str(log))
	log.clear()
	var c = await bed.sdk.identity.auto_sign_in({"prompt": "optional"})
	t.check("prompt: optional runs the sheet after rung 3; a dismissed sheet ends rung 4 (one sheet at most)", log.filter(func(e): return e.ends_with(".sheet")) == ["google.sheet"], str(log))
	t.check("prompt: a dismissal is needs_sign_in(no_credential)", c.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and c.reason == "no_credential", str(c))
	t.check("prompt: rung 4 follows rung 3 (silent first, then the sheet), google before apple", log.filter(func(e): return not e.ends_with("?")) == ["google.silent", "google.sheet"], str(log))
	log.clear()
	google.sheet_answer = {"unavailable": "no account"}
	await bed.sdk.identity.auto_sign_in({"prompt": "optional"})
	t.check("prompt: a provider with no sheet to show does not use up the one sheet", log.filter(func(e): return e.ends_with(".sheet")) == ["google.sheet", "apple.sheet"], str(log))
	log.clear()
	google.sheet_answer = {"token": X.PLATFORM_TOKEN}
	bed.tokens = [B.json(200, X.TOKEN_OK)]
	var ok = await bed.sdk.identity.auto_sign_in({"prompt": "optional"})
	t.check(
		"prompt: a sheet's token is exchanged and signs in, and apple's sheet never shows",
		ok.kind == PKeyAutoSignInResult.KIND_SIGNED_IN and log.filter(func(e): return e.ends_with(".sheet")) == ["google.sheet"],
		str(log))
	bed.free_all()
	# Silent cancel: the next provider is still asked.
	bed = await _bed(["gamecenter", "google"])
	log = []
	var gc := Fake.new("gamecenter", log)
	gc.silent_answer = {"cancelled": true}
	var g := Fake.new("google", log)
	bed.sdk.identity.install_platform_provider(gc)
	bed.sdk.identity.install_platform_provider(g)
	bed.nonces = [B.json(200, {"nonce": X.NONCE, "expiresIn": 300})]
	await bed.sdk.identity.auto_sign_in()
	t.check("cancel: a silent cancel falls through to the next provider", log.filter(func(e): return e.ends_with(".silent")) == ["gamecenter.silent", "google.silent"], str(log))
	bed.free_all()


func _answers(t: PKeyTestContext) -> void:
	var bed := await _bed(["google"])
	var log := []
	var g := Fake.new("google", log)
	g.silent_answer = {"token": X.PLATFORM_TOKEN, "user_id": "u9"}
	bed.sdk.identity.install_platform_provider(g)
	bed.tokens = [B.json(200, {"status": "confirm", "grant": X.GRANT, "expiresIn": 300, "consent": X.CONSENT})]
	var c = await bed.sdk.identity.auto_sign_in()
	t.check(
		"answers: confirm carries the pending consent and stores nothing",
		c.ok and c.kind == PKeyAutoSignInResult.KIND_CONFIRM and c.pending["grant"] == X.GRANT and c.pending["consent"]["as"]["provider"] == "google" and not bed.sdk.core.tokens.has_token(),
		str(c))
	t.check("answers: the provider has not heard of a session yet", g.started.is_empty())
	bed.choice_answers = {"complete": B.json(200, X.TOKEN_OK)}
	var done: PKeyChoiceResult = await bed.sdk.identity.choice.complete(c.pending["grant"], null, {"claims": ["email"]})
	t.check("answers: choice.complete finishes it and the provider hears of the session then", done.ok and g.started == [{"user_id": "u9"}], str(done))
	t.check("answers: complete is a person-started sign-in", not bed.sdk.core.cache.explicit_sign_out and bed.sdk.core.tokens.origin() == "sign_in")
	bed.tokens = [B.json(200, {"status": "choose", "grant": X.GRANT, "expiresIn": 300, "choices": X.VIEW})]
	var ch = await bed.sdk.identity.auto_sign_in()
	t.check("answers: choose carries the view", ch.kind == PKeyAutoSignInResult.KIND_CHOOSE and ch.pending["view"].has("choices"), str(ch))
	t.check("answers: the grant is in no string", not (str(c) + c.message + str(c.detail) + str(ch)).contains(X.GRANT))
	bed.tokens = [B.json(403, {"error": "interstitial_required", "reason": "no_link", "url": "https://key.plrs.im/card", "linkHandle": X.HANDLE, "expiresIn": 600})]
	var n = await bed.sdk.identity.auto_sign_in()
	t.check(
		"answers: no_link carries the link handle, redacted from strings",
		n.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and n.reason == "no_link" and n.link_handle == X.HANDLE and not (str(n) + n.message).contains(X.HANDLE),
		str(n))
	bed.tokens = [B.json(403, {"error": "interstitial_required", "reason": "terms", "url": "https://key.plrs.im/card", "linkHandle": X.HANDLE, "expiresIn": 600})]
	var terms = await bed.sdk.identity.auto_sign_in()
	t.check("answers: terms", terms.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and terms.reason == "terms" and terms.link_handle == "", str(terms))
	bed.tokens = [B.json(403, {"error": "device_limit", "manageUrl": "https://key.plrs.im/portal"})]
	var dl = await bed.sdk.identity.auto_sign_in()
	t.check("answers: device_limit with the manage url", dl.kind == PKeyAutoSignInResult.KIND_DEVICE_LIMIT and not dl.ok and dl.manage_url.ends_with("/portal") and dl.code == &"device_limit", str(dl))
	bed.tokens = [B.json(400, {"error": "invalid_grant"})]
	var refused = await bed.sdk.identity.auto_sign_in()
	t.check("answers: a refusal is unavailable with the Worker's code", refused.kind == PKeyAutoSignInResult.KIND_UNAVAILABLE and refused.code == &"invalid_grant", str(refused))
	bed.tokens = [B.json(404, {"error": "not_found"})]
	var gone = await bed.sdk.identity.auto_sign_in()
	t.check("answers: a 404 is unavailable", gone.kind == PKeyAutoSignInResult.KIND_UNAVAILABLE, str(gone))
	bed.nonces = [B.json(404, {"error": "not_found"})]
	log.clear()
	var nonce_gone = await bed.sdk.identity.auto_sign_in()
	t.check(
		"answers: no nonce route is unavailable and the provider is not asked",
		nonce_gone.kind == PKeyAutoSignInResult.KIND_UNAVAILABLE and nonce_gone.code == &"not_found" and log.filter(func(e): return e.ends_with(".silent")).is_empty(),
		str(nonce_gone))
	bed.free_all()


func _sign_out_rules(t: PKeyTestContext) -> void:
	var bed := await _signed_in_bed()
	var log := []
	var g := Fake.new("google", log)
	g.silent_answer = {"token": X.PLATFORM_TOKEN}
	bed.sdk.identity.install_platform_provider(g)
	bed.device_keys.ensure()
	var keys_before: Dictionary = bed.device_keys.public_keys().detail.duplicate()
	bed.signouts = [B.json(200, {"released": true})]
	var gen = bed.sdk.core.tokens.sign_out_generation
	var so = await bed.sdk.identity.sign_out()
	t.check("sign-out: the Worker accepted it", so.ok and so.detail["released"] and bed.signout_requests.size() == 1, str(so))
	t.check(
		"sign-out: the generation moved, the flag is set and persisted, the provider cleaned up",
		bed.sdk.core.tokens.sign_out_generation > gen and bed.sdk.core.cache.explicit_sign_out and bed.sdk.core.cache.record()["explicitSignOut"] == true and g.cleaned == 1)
	t.check("sign-out: the token and its provenance went with the released seat", not bed.sdk.core.tokens.has_token() and bed.sdk.core.cache.token_origin == "")
	t.check("sign-out: device keys survive", bed.device_keys.public_keys().detail == keys_before)
	log.clear()
	bed.nonce_requests.clear()
	var quiet = await bed.sdk.identity.auto_sign_in({"prompt": "optional"})
	t.check(
		"flag: rungs 3 and 4 do not run (needs_sign_in signed_out, no nonce, no prompt)",
		quiet.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN
		and quiet.reason == "signed_out"
		and bed.nonce_requests.is_empty()
		and not log.any(func(e): return e.ends_with(".silent") or e.ends_with(".sheet")),
		str(quiet) + str(log))
	var again := PKeyCache.new(bed.sdk.core.store, bed.sdk.core.trust, bed.sdk.core.clock, bed.F["product"], bed.F["device_id"])
	await again.load_record()
	t.check("flag: it survives a restart", again.explicit_sign_out)
	# The atomic store.
	t.check(
		"flag: the ladder's store is refused while it is set",
		bed.sdk.core.tokens.set_token_unless_signed_out("pkeyt_LADDER", bed.sdk.core.tokens.sign_out_generation) == null and not bed.sdk.core.tokens.has_token())
	# Only a person-started sign-in lowers it.
	bed.tokens = [B.json(200, X.TOKEN_OK)]
	var person = await bed.sdk.identity.exchange.exchange("google", X.PLATFORM_TOKEN, X.NONCE)
	t.check("flag: a sign-in the person started lowers it and the ladder then runs again", person.ok and not bed.sdk.core.cache.explicit_sign_out and bed.sdk.core.tokens.origin() == "sign_in")
	bed.free_all()
	# opts.explicit lowers it, then the ladder runs.
	bed = await _bed(["google"])
	var g2 := Fake.new("google", [])
	g2.silent_answer = {"token": X.PLATFORM_TOKEN}
	bed.sdk.identity.install_platform_provider(g2)
	bed.sdk.core.cache.set_explicit_sign_out(true)
	bed.tokens = [B.json(200, X.TOKEN_OK)]
	var explicit = await bed.sdk.identity.auto_sign_in({"explicit": true})
	var lowered: bool = explicit.kind == PKeyAutoSignInResult.KIND_SIGNED_IN and not bed.sdk.core.cache.explicit_sign_out
	t.check("flag: opts.explicit runs past the flag and lowers it once a token is stored", lowered, str(explicit))
	bed.free_all()
	# A dismissed explicit sheet leaves the flag set; the next boot's ladder stays quiet (B1).
	bed = await _bed(["google"])
	var g2b := Fake.new("google", [])
	g2b.sheet_answer = {"cancelled": true}
	bed.sdk.identity.install_platform_provider(g2b)
	bed.sdk.core.cache.set_explicit_sign_out(true)
	var dismissed = await bed.sdk.identity.auto_sign_in({"explicit": true, "row": "google"})
	t.check("flag: a dismissed explicit sheet leaves the flag set",
		dismissed.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and bed.sdk.core.cache.explicit_sign_out and bed.sdk.core.cache.record()["explicitSignOut"] == true, str(dismissed))
	var again_boot = await bed.sdk.identity.auto_sign_in({"prompt": "optional"})
	t.check("flag: the next boot does not sign in silently",
		again_boot.reason == PKeyAutoSignInResult.REASON_SIGNED_OUT and not bed.sdk.core.tokens.has_token() and bed.sdk.core.cache.explicit_sign_out)
	bed.free_all()
	# released: false leaves the token; it is no longer a sign-in.
	bed = await _signed_in_bed()
	var g3 := Fake.new("google", [])
	bed.sdk.identity.install_platform_provider(g3)
	bed.signouts = [B.json(200, {"released": false})]
	var kept = await bed.sdk.identity.sign_out()
	t.check(
		"sign-out: released=false keeps the token as a key activation, flag set",
		kept.ok and not kept.detail["released"] and bed.sdk.core.tokens.has_token() and bed.sdk.core.tokens.origin() == "key" and bed.sdk.core.cache.explicit_sign_out and g3.cleaned == 1)
	var after = await bed.sdk.identity.auto_sign_in()
	t.check("sign-out: rung 1 does not count the device an account sign-out left activated", after.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and after.reason == "signed_out", str(after))
	bed.free_all()
	# deactivate() sets the same flag, so a launch does not sign the device back in.
	bed = await _signed_in_bed()
	bed.sdk.identity.install_platform_provider(Fake.new("google", []))
	var gone = await bed.sdk.license.deactivate()
	t.check("deactivate: sets the flag and wipes the token, whatever the seat release answered", bed.sdk.core.cache.explicit_sign_out and not bed.sdk.core.tokens.has_token(), str(gone))
	var launch = await bed.sdk.identity.auto_sign_in()
	var held_back: bool = launch.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and launch.reason == PKeyAutoSignInResult.REASON_SIGNED_OUT
	t.check("deactivate: a launch does not sign in silently", held_back and not bed.sdk.core.tokens.has_token(), str(launch))
	bed.free_all()
	# A refused sign-out sets nothing.
	bed = await _signed_in_bed()
	bed.signouts = [B.json(500, {"error": "unavailable"})]
	var fail = await bed.sdk.identity.sign_out()
	t.check("sign-out: a refused sign-out leaves the flag and the session alone", not fail.ok and not bed.sdk.core.cache.explicit_sign_out and bed.sdk.core.tokens.origin() == "sign_in")
	bed.free_all()


func _generation_race(t: PKeyTestContext) -> void:
	# A sign-out while the platform prompts.
	var bed := await _bed(["google"])
	var g := Fake.new("google", [])
	g.silent_answer = {"token": X.PLATFORM_TOKEN}
	g.silent_hook = func() -> void: bed.sdk.core.tokens.bump_sign_out_generation()
	bed.sdk.identity.install_platform_provider(g)
	bed.tokens = [B.json(200, X.TOKEN_OK)]
	var r = await bed.sdk.identity.auto_sign_in()
	t.check(
		"race: a sign-out during the prompt wins: nothing exchanged or stored",
		r.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and r.reason == "signed_out" and bed.token_requests.is_empty() and not bed.sdk.core.tokens.has_token(),
		str(r))
	bed.free_all()
	# A sign-out while the exchange is in flight: the store is refused (check and store are one step).
	bed = await _bed(["google"])
	var g2 := Fake.new("google", [])
	g2.silent_answer = {"token": X.PLATFORM_TOKEN}
	bed.sdk.identity.install_platform_provider(g2)
	bed.tokens = [func(_req) -> Dictionary:
		bed.sdk.core.tokens.bump_sign_out_generation()
		return B.json(200, X.TOKEN_OK)]
	var r2 = await bed.sdk.identity.auto_sign_in()
	t.check(
		"race: a sign-out during the exchange stores nothing and answers signed_out",
		r2.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and r2.reason == "signed_out" and not bed.sdk.core.tokens.has_token() and bed.sdk.core.tokens.origin() == "",
		str(r2))
	t.check("race: the store is untouched too", (bed.sdk.core.store as PKeyMemoryStore).token == "")
	# The same race with the flag instead of the generation.
	bed.tokens = [func(_req) -> Dictionary:
		bed.sdk.core.cache.set_explicit_sign_out(true)
		return B.json(200, X.TOKEN_OK)]
	var r3 = await bed.sdk.identity.auto_sign_in()
	t.check("race: a flag raised during the exchange refuses the store too", r3.reason == "signed_out" and not bed.sdk.core.tokens.has_token(), str(r3))
	bed.free_all()
	# identity.sign_out() bumps the generation before the pre-sign-out hooks and the POST run.
	bed = await _signed_in_bed()
	var gen = bed.sdk.core.tokens.sign_out_generation
	var seen := []
	bed.sdk.identity.add_before_sign_out(func() -> void: seen.append(bed.sdk.core.tokens.sign_out_generation))
	bed.signouts = [B.json(200, {"released": false})]
	await bed.sdk.identity.sign_out()
	t.check("race: sign_out() moves the generation before its hooks and the POST", seen.size() == 1 and seen[0] > gen, str(seen))
	bed.free_all()


func _revoked(t: PKeyTestContext) -> void:
	var bed := await _signed_in_bed()
	var log := []
	var apple := Fake.new("apple", log)
	apple.revoked = true
	bed.sdk.identity.install_platform_provider(apple)
	bed.signouts = [B.json(200, {"released": true})]
	var r = await bed.sdk.identity.auto_sign_in()
	t.check(
		"revoked: a revoked credential at launch runs sign_out()",
		bed.signout_requests.size() == 1 and bed.sdk.core.cache.explicit_sign_out and apple.cleaned == 1 and not bed.sdk.core.tokens.has_token(),
		str(log))
	t.check("revoked: the ladder then answers signed_out", r.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and r.reason == "signed_out", str(r))
	bed.free_all()
	# Not revoked (any other state): nothing happens.
	bed = await _signed_in_bed()
	var calm := Fake.new("apple", [])
	bed.sdk.identity.install_platform_provider(calm)
	var ok = await bed.sdk.identity.auto_sign_in()
	t.check("revoked: only a revoked credential signs out", ok.kind == PKeyAutoSignInResult.KIND_SIGNED_IN and bed.signout_requests.is_empty() and not bed.sdk.core.cache.explicit_sign_out)
	bed.free_all()
	# The Worker cannot be reached: the flag stays unset and the check repeats at the next launch.
	bed = await _signed_in_bed()
	var again := Fake.new("apple", [])
	again.revoked = true
	bed.sdk.identity.install_platform_provider(again)
	bed.signouts = [B.json(503, {"error": "unavailable"})]
	await bed.sdk.identity.auto_sign_in()
	t.check("revoked: an unreachable Worker leaves the flag unset", bed.signout_requests.size() == 1 and not bed.sdk.core.cache.explicit_sign_out and again.cleaned == 0)
	bed.signouts = [B.json(200, {"released": true})]
	await bed.sdk.identity.auto_sign_in()
	t.check("revoked: the next launch tries again", bed.signout_requests.size() == 2 and bed.sdk.core.cache.explicit_sign_out)
	bed.free_all()
	# No session at all: only the local state changes.
	bed = await _bed(["apple"])
	var nobody := Fake.new("apple", [])
	nobody.revoked = true
	bed.sdk.identity.install_platform_provider(nobody)
	var local = await bed.sdk.identity.auto_sign_in()
	t.check(
		"revoked: with no session it is a local sign-out, no request",
		bed.signout_requests.is_empty() and bed.sdk.core.cache.explicit_sign_out and nobody.cleaned == 1 and local.reason == "signed_out",
		str(local))
	bed.free_all()


func _fail_closed(t: PKeyTestContext) -> void:
	var store := PKeyMemoryStore.new("D")
	var trust := PKeyTrust.new()
	var clock := PKeyClock.new()
	store.cache = {"v": 3, "explicitSignOut": true, "tokenOrigin": "sign_in"}
	var c := PKeyCache.new(store, trust, clock, "djdl", "D")
	await c.load_record()
	t.check("record: the flag and the provenance are read", c.explicit_sign_out and c.token_origin == "sign_in")
	store.cache = {"v": 3, "explicitSignOut": "yes", "tokenOrigin": "admin"}
	await c.load_record()
	t.check("record: a value of the wrong type or an unknown provenance reads as absent, not as set", not c.explicit_sign_out and c.token_origin == "")
	store.cache = {"v": 2, "explicitSignOut": false}
	await c.load_record()
	t.check("record: a record this client cannot read fails closed (signed out)", c.explicit_sign_out)
	store.cache = null
	await c.load_record()
	t.check("record: no record is not signed out", not c.explicit_sign_out)
	var dir := "user://pkey_test_auto_corrupt_%d" % Time.get_ticks_usec()
	var files := PKeyFileStore.new("djdl", dir)
	files.set_token("x")  # makes the directory
	var f := FileAccess.open(files.path_of(PKeyFileStore.CACHE_FILE), FileAccess.WRITE)
	f.store_string("{not json")
	f.close()
	var fc := PKeyCache.new(files, trust, clock, "djdl", "D")
	await fc.load_record()
	t.check("record: an unparseable cache file fails closed", fc.explicit_sign_out)
	# clear() keeps the flag; replace() carries it.
	store.cache = {"v": 3, "explicitSignOut": true, "tokenOrigin": "key"}
	await c.load_record()
	c.clear()
	t.check(
		"record: clear() wipes the credential's provenance but keeps the sign-out flag",
		c.explicit_sign_out and c.token_origin == "" and store.cache == {"v": 3, "explicitSignOut": true},
		str(store.cache))
	c.replace({"v": 3})
	t.check("record: replace() carries the flag", c.explicit_sign_out and store.cache.get("explicitSignOut") == true)
	c.set_explicit_sign_out(false)
	t.check("record: lowering the flag removes it", store.cache.get("explicitSignOut") == null)


func _linux(t: PKeyTestContext) -> void:
	# No provider (Linux and Windows): rung 1 only, and no request is made at all.
	var bed := await _signed_in_bed()
	bed.server.requests.clear()
	var r = await bed.sdk.identity.auto_sign_in({"prompt": "optional"})
	t.check("linux: with a session it is rung 1", r.kind == PKeyAutoSignInResult.KIND_SIGNED_IN and r.via == "stored" and bed.server.requests.is_empty(), str(r))
	bed.sdk.core.tokens.clear()
	var none = await bed.sdk.identity.auto_sign_in({"prompt": "optional"})
	t.check(
		"linux: without one it is needs_sign_in(no_credential), still no request",
		none.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and none.reason == "no_credential" and bed.server.requests.is_empty() and bed.nonce_requests.is_empty(),
		str(none))
	bed.free_all()
	var cold := PKeyTestFixtures.new_sdk()
	var early = await cold.identity.auto_sign_in()
	t.check("linux: before configure() it is not-configured", early.kind == PKeyAutoSignInResult.KIND_UNAVAILABLE and early.code == PKeyErrors.NOT_CONFIGURED, str(early))
	cold.queue_free()
