extends RefCounted
# @pkey-feature identity.keyreturn
# The key return (WIRE-CONTRACT-V5 §12.4, §12.5): the opt-in on the web and the pushed requests, the
# strict token answer (`via: "key"` is read only with the opt-in), the activated outcome and its
# stored state, and the flat refusals with their details. The three recorded conversations are
# replayed in suite_transcripts.gd.

const B := preload("res://tests/identity/support.gd")
const R := preload("res://addons/polaris_key/services/identity/redirect.gd")
const N := preload("res://addons/polaris_key/services/identity/native_redirect.gd")

const STATE := "tidewater-state-0123456789"
const VERIFIER := "transcript-verifier-0123456789-abcdefghijklmnopqrst"
const REDIRECT := "https://app.example/auth/callback"
const SUBJECT := "ps_AAAAAAAAAAAAAAAAAAAAAA"
const KEY_BODY := {
	"access_token": "pkeyt_KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKEY", "token_type": "Bearer", "scope": "", "via": "key",
	"schemaVersion": 1, "device": {"id": "D"}, "license": {"id": "lic_1"}, "subject": null, "keyEntries": {"used": 1, "limit": 10},
}


func run(t: PKeyTestContext) -> void:
	_opt_in(t)
	_parse(t)
	await _session(t)


func _web_opts(extra := {}) -> Dictionary:
	var o := {
		"authorize_endpoint": "https://key.plrs.im/djdl/identity/authorize", "token_endpoint": "https://key.plrs.im/djdl/identity/token",
		"issuer": "https://key.plrs.im/djdl/identity", "client_id": "djdl", "redirect_uri": REDIRECT, "state": STATE, "code_verifier": VERIFIER,
	}
	o.merge(extra, true)
	return o


func _native_opts(extra := {}) -> Dictionary:
	var o := {
		"request_endpoint": "https://key.plrs.im/djdl/identity/request", "authorize_endpoint": "https://key.plrs.im/djdl/identity/authorize",
		"token_endpoint": "https://key.plrs.im/djdl/identity/token", "issuer": "https://key.plrs.im/djdl/identity", "client_id": "djdl",
		"redirect_uri": "http://127.0.0.1:49152/pkey/callback", "state": STATE, "code_verifier": VERIFIER, "device_name": "Deck",
	}
	o.merge(extra, true)
	return o


# Rule 1: an opt-in, web and native, never sent unless set.
func _opt_in(t: PKeyTestContext) -> void:
	var off := R.start(_web_opts())
	var on := R.start(_web_opts({"key_return": true}))
	t.check("key return: a bare web start sends nothing about it", off["ok"] and not off["pending"]["authorize_url"].contains("key_return") and not off["pending"].has("key_return"))
	t.check("key return: the web opt-in is sent last and recorded", on["pending"]["authorize_url"].ends_with("&scope=profile+email&key_return=allow")
			and on["pending"]["key_return"] == true, on["pending"]["authorize_url"])
	t.check("key return: only true opts in", not R.start(_web_opts({"key_return": "allow"}))["pending"]["authorize_url"].contains("key_return"))
	var hinted := R.start(_web_opts({"key_return": true, "license_choice": "app", "choice_available": true, "purpose": "signin"}))
	t.check("key return: it follows license_choice", hinted["pending"]["authorize_url"].ends_with("&purpose=signin&license_choice=app&key_return=allow"))
	var p_off := N.push_request(_native_opts())
	var p_on := N.push_request(_native_opts({"key_return": true, "return_uri": "com.tidewater.studio:/pkey/callback"}))
	t.check("key return: a bare pushed request sends nothing about it", p_off["ok"] and not String(p_off["body"]).contains("key_return") and not p_off["pending"].has("key_return"))
	t.check("key return: the pushed request carries it before device_name and return_uri", String(p_on["body"]).contains("&key_return=allow&device_name=Deck&return_uri=")
			and p_on["pending"]["key_return"] == true, p_on["body"])


# Rule 2 and its strictness: the token answer.
func _parse(t: PKeyTestContext) -> void:
	var opted := {"key_return": true}
	var a := R.parse_token_answer(200, KEY_BODY, opted)
	t.check("key return: a via key body is activated with the opt-in", a["kind"] == "activated" and a["subject"] == null and a["license"] == {"id": "lic_1"}
			and a["key_entries"] == {"used": 1, "limit": 10}, str(a))
	var no_subject := KEY_BODY.duplicate(true)
	no_subject.erase("subject")
	t.check("key return: a via key body without a subject member is malformed", R.parse_token_answer(200, no_subject, opted) == {"kind": "malformed"})
	t.check("key return: the same body is malformed without it", R.parse_token_answer(200, KEY_BODY) == {"kind": "malformed"}
			and R.parse_token_answer(200, KEY_BODY, {"key_return": false}) == {"kind": "malformed"})
	var named := KEY_BODY.duplicate(true)
	named["subject"] = SUBJECT
	t.check("key return: a pairwise subject is kept", R.parse_token_answer(200, named, opted)["subject"] == SUBJECT)
	var rows := {
		"another via": {"via": "account"}, "a scope": {"scope": "profile"}, "no scope": {"scope": null}, "a bad subject": {"subject": "ps_short"},
		"an empty subject": {"subject": ""}, "no license": {"license": null}, "no keyEntries": {"keyEntries": null}, "a negative count": {"keyEntries": {"used": -1, "limit": 3}},
		"a fractional count": {"keyEntries": {"used": 1.5, "limit": 3}}, "no device": {"device": null}, "an empty token": {"access_token": ""},
	}
	for name in rows:
		var body := KEY_BODY.duplicate(true)
		body.merge(rows[name], true)
		t.check("key return: %s is malformed" % name, R.parse_token_answer(200, body, opted) == {"kind": "malformed"})
	var plain := {"access_token": "t", "scope": "profile", "subject": SUBJECT, "device": {}, "license": null}
	t.check("key return: a plain token body still reads as a token", R.parse_token_answer(200, plain, opted)["kind"] == "token")
	var limit := R.parse_token_answer(403, {"error": "device_limit", "limit": 1, "deviceCount": 1, "manageUrl": "https://key.plrs.im/activate?product=djdl"})
	t.check("key return: a refusal gains its flat details", limit["error"] == "device_limit"
			and limit["details"] == {"limit": 1, "device_count": 1, "manage_url": "https://key.plrs.im/activate?product=djdl"}, str(limit))
	var owned := R.parse_token_answer(403, {"error": "license_owned", "signInUrl": "https://key.plrs.im/signin?product=djdl"})
	var entries := R.parse_token_answer(403, {"error": "key_entry_limit", "keyEntries": {"used": 1, "limit": 1}, "manageUrl": "http://key.plrs.im/x"})
	t.check("key return: license_owned carries signInUrl, key_entry_limit its count, and a link must be https", owned["details"] == {"sign_in_url": "https://key.plrs.im/signin?product=djdl"}
			and entries["details"] == {"key_entries": {"used": 1, "limit": 1}}, str(entries))
	t.check("key return: a refusal with no members has no details", not R.parse_token_answer(400, {"error": "invalid_grant"}).has("details"))


func _bed(subject := "") -> B:
	var bed := B.new()
	var sdk := await bed.make_sdk("", PackedStringArray(["license", "config", "identity"]))
	sdk.identity.redirect_acquisition_sync = false
	var root := "%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]
	sdk.core.discovery_manifest = {"product": bed.F["product"], "services": {"identity": {
		"enabled": true, "configured": true, "issuer": root, "endpoints": {"authorize": root + "/authorize", "token": root + "/token"},
	}}}
	if subject != "":
		sdk.core.cache.set_subject(subject)
	return bed


func _param(url: String, name: String) -> String:
	for part in url.substr(url.find("?") + 1).split("&"):
		if part.begins_with(name + "="):
			return part.substr(name.length() + 1).uri_decode()
	return ""


func _callback(bed: B, state: String) -> String:
	return "%s?code=C0DE&state=%s&iss=%s" % [REDIRECT, state, ("%s/%s/identity" % [bed.server.base_url(), bed.F["product"]]).uri_encode()]


func _session(t: PKeyTestContext) -> void:
	# The activated outcome: a key activation that clears the account the device held.
	var bed := await _bed(SUBJECT)
	bed.tokens = [B.json(200, KEY_BODY)]
	var events: Array = []
	bed.sdk.event.connect(func(kind, data): events.append([kind, data]))
	var s: PKeySignInSession = await bed.sdk.identity.sign_in.start({"channel": "redirect", "redirect_uri": REDIRECT, "key_return": true})
	t.check("key return session: the authorize URL carries the opt-in", s.ok and _param(s.authorize_url, "key_return") == "allow", str(s))
	var o := await s.complete(_callback(bed, _param(s.authorize_url, "state")))
	t.check("key return session: settles activated with the licence and the entries", o.ok and o.kind == PKeySignInOutcome.KIND_ACTIVATED and o.license_id == "lic_1"
			and o.key_entries == {"used": 1, "limit": 10} and o.subject == "", str(o))
	t.check("key return session: the token is held as a key activation", bed.sdk.core.tokens.current() == KEY_BODY["access_token"] and bed.sdk.core.tokens.origin() == PKeyTokenManager.ORIGIN_KEY)
	t.check("key return session: a null subject clears the stored one", bed.sdk.core.cache.subject == "")
	var kinds: Array = events.filter(func(e): return e[0] == "identity").map(func(e): return e[1]["kind"])
	t.check("key return session: it emits activated, never signedIn", kinds == ["activated"], str(kinds))
	t.check("key return session: automatic sign-in's first rung does not count it", bed.sdk.core.tokens.origin() != PKeyTokenManager.ORIGIN_SIGN_IN)
	bed.free_all()

	# A pairwise subject in the answer becomes the stored subject.
	bed = await _bed()
	var named := KEY_BODY.duplicate(true)
	named["subject"] = SUBJECT
	bed.tokens = [B.json(200, named)]
	s = await bed.sdk.identity.sign_in.start({"channel": "redirect", "redirect_uri": REDIRECT, "key_return": true})
	var o2 := await s.complete(_callback(bed, _param(s.authorize_url, "state")))
	t.check("key return session: a named subject is reported but the stored one is cleared", o2.kind == PKeySignInOutcome.KIND_ACTIVATED and o2.subject == SUBJECT and bed.sdk.core.cache.subject == "")
	bed.free_all()

	# A key return keeps the explicit sign-out flag.
	bed = await _bed(SUBJECT)
	bed.sdk.core.cache.set_explicit_sign_out(true)
	bed.tokens = [B.json(200, KEY_BODY)]
	s = await bed.sdk.identity.sign_in.start({"channel": "redirect", "redirect_uri": REDIRECT, "key_return": true})
	await s.complete(_callback(bed, _param(s.authorize_url, "state")))
	t.check("key return session: the explicit sign-out flag stays set", bed.sdk.core.tokens.explicit_sign_out())
	var again = await bed.sdk.identity.auto_sign_in()
	t.check("key return session: automatic sign-in answers signed out", again.kind == PKeyAutoSignInResult.KIND_NEEDS_SIGN_IN and again.reason == "signed_out", str(again))
	bed.free_all()

	# Without the opt-in the same body is malformed and nothing is stored.
	bed = await _bed(SUBJECT)
	bed.tokens = [B.json(200, KEY_BODY)]
	s = await bed.sdk.identity.sign_in.start({"channel": "redirect", "redirect_uri": REDIRECT})
	t.check("key return session: a bare start sends no opt-in", _param(s.authorize_url, "key_return") == "" and not s.authorize_url.contains("key_return"))
	var o3 := await s.complete(_callback(bed, _param(s.authorize_url, "state")))
	t.check("key return session: without the opt-in the body is an invalid response and nothing changes", o3.code == PKeyErrors.INVALID_RESPONSE
			and bed.sdk.core.tokens.current() == "" and bed.sdk.core.cache.subject == SUBJECT, str(o3))
	bed.free_all()

	# Flat refusals surface with their details and change nothing.
	var refusals := [
		[B.json(403, {"error": "device_limit", "limit": 1, "deviceCount": 1, "manageUrl": "https://key.plrs.im/activate?product=djdl"}), &"device_limit", "manage_url"],
		[B.json(403, {"error": "license_owned", "signInUrl": "https://key.plrs.im/signin?product=djdl"}), &"license_owned", "sign_in_url"],
		[B.json(403, {"error": "key_entry_limit", "keyEntries": {"used": 1, "limit": 1}, "manageUrl": "https://key.plrs.im/activate?product=djdl"}), &"key_entry_limit", "key_entries"],
	]
	for row in refusals:
		bed = await _bed(SUBJECT)
		bed.tokens = [row[0]]
		s = await bed.sdk.identity.sign_in.start({"channel": "redirect", "redirect_uri": REDIRECT, "key_return": true})
		var r := await s.complete(_callback(bed, _param(s.authorize_url, "state")))
		var flat: bool = r.kind == PKeySignInOutcome.KIND_ERROR and r.code == row[1] and r.detail is Dictionary and r.detail.has(row[2])
		t.check("key return session: %s is a flat refusal with its details" % row[1], flat, str(r.detail))
		t.check("key return session: %s keeps the token and the subject" % row[1], bed.sdk.core.tokens.current() == "" and bed.sdk.core.cache.subject == SUBJECT)
		bed.free_all()

	# The device-code channel does not take the option.
	bed = await _bed()
	var device: PKeySignInSession = await bed.sdk.identity.sign_in.start({"key_return": true})
	t.check("key return: the device-code channel refuses it before sending anything", not device.ok and device.code == &"invalid-argument" and bed.flow_requests.is_empty(), str(device))
	bed.free_all()
