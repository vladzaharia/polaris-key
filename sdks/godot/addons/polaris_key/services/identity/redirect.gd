class_name PKeyIdentityRedirect
extends RefCounted
## The authorization-code redirect core (WIRE-CONTRACT-V4 §12.4, §12.5): everything the SDK does
## around the browser hop, with no I/O of its own. A port of client-core's `identityRedirect.ts`;
## its vectors (packages/client-core/test/identityRedirect.test.ts) are ported in
## tests/identity/test_redirect.gd.
##
##   start(opts)            S256 PKCE, the `state`, and the authorize URL the host opens
##   check_callback(...)    the redirect back to the app: the redirect URI, `state`, then `iss`
##                          (RFC 9207), then `error`, then `code`. A refusal here never reaches
##                          the token endpoint.
##   token_form(...)        the form body of `POST /<p>/identity/token`
##   parse_token_answer()   a token response, `choose` (by its `status` member alone), or a
##                          refusal carrying the Worker's OAuth `error`
##
## S256 only: there is no `plain` path. The verifier lives in the pending request, which the
## session uses for ONE `check_callback` and one token request and then drops. The authorize URL
## carries only the challenge; this file never logs the verifier, the code or the token.

const VERIFIER_MIN := 43
const VERIFIER_MAX := 128
const STATE_MIN := 16
const STATE_MAX := 512
## The scope a sign-in asks for when the host names none.
const DEFAULT_SCOPE := "profile email"
const TOKEN_CONTENT_TYPE := "application/x-www-form-urlencoded"

static var _verifier_re: RegEx
static var _state_re: RegEx
static var _scope_re: RegEx
static var _grant_re: RegEx
static var _origin_re: RegEx
static var _redirect_re: RegEx


static func _static_init() -> void:
	_verifier_re = RegEx.create_from_string("\\A[A-Za-z0-9\\-._~]+\\z")
	_state_re = RegEx.create_from_string("\\A[\\x21-\\x7e]+\\z")
	_scope_re = RegEx.create_from_string("\\A[\\x21-\\x7e]+\\z")
	_grant_re = RegEx.create_from_string("\\Asg_[A-Za-z0-9_-]{43}\\z")
	_origin_re = RegEx.create_from_string("\\A([A-Za-z][A-Za-z0-9+.\\-]*)://([^/?#]*)([^?#]*)")
	_redirect_re = RegEx.create_from_string("\\Ahttps://([^/?#]*)([^#]*)\\z")


# ── PKCE ─────────────────────────────────────────────────────────────────────────────────

## The S256 challenge: base64url(SHA-256(ASCII(verifier))), unpadded (RFC 7636 §4.2).
static func pkce_challenge(verifier: String) -> String:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(verifier.to_utf8_buffer())
	return PKeyB64Url.encode(ctx.finish())


## 32 random bytes as 43 base64url characters (a verifier, or a `state`).
static func random_token() -> String:
	return PKeyB64Url.encode(Crypto.new().generate_random_bytes(32))


# ── Form encoding ────────────────────────────────────────────────────────────────────────

## application/x-www-form-urlencoded, as WHATWG URLSearchParams writes it: UTF-8 bytes, `*-._` and
## alphanumerics kept, space as `+`, everything else (`~` included) as %XX.
static func form_encode(text: String) -> String:
	var out := ""
	for b in text.to_utf8_buffer():
		var c := char(b)
		if (b >= 0x30 and b <= 0x39) or (b >= 0x41 and b <= 0x5a) or (b >= 0x61 and b <= 0x7a) or c in "*-._":
			out += c
		elif b == 0x20:
			out += "+"
		else:
			out += "%%%02X" % b
	return out


static func _form_body(pairs: Array) -> String:
	var parts: PackedStringArray = []
	for p in pairs:
		parts.append("%s=%s" % [form_encode(p[0]), form_encode(p[1])])
	return "&".join(parts)


## `text` form-decoded (a `+` is a space); null on a bad escape or invalid UTF-8.
static func decode(text: String) -> Variant:
	var src := text.replace("+", " ").to_utf8_buffer()
	var out := PackedByteArray()
	var i := 0
	while i < src.size():
		if src[i] == 0x25:
			if i + 2 >= src.size():
				return null
			var hi := _hex(src[i + 1])
			var lo := _hex(src[i + 2])
			if hi < 0 or lo < 0:
				return null
			out.append(hi * 16 + lo)
			i += 3
		else:
			out.append(src[i])
			i += 1
	var s := out.get_string_from_utf8()
	if s.to_utf8_buffer() != out:
		return null
	return s


static func _hex(b: int) -> int:
	if b >= 0x30 and b <= 0x39:
		return b - 0x30
	if b >= 0x41 and b <= 0x46:
		return b - 0x41 + 10
	if b >= 0x61 and b <= 0x66:
		return b - 0x61 + 10
	return -1


# ── The authorize request ────────────────────────────────────────────────────────────────

## The shared rule for a host-supplied redirect URI: absolute `https:`, no userinfo, no fragment,
## no whitespace or control characters. (Loopback, scheme and claimed-HTTPS URIs are I-15's.)
static func is_redirect_uri(raw: Variant) -> bool:
	if not (raw is String) or raw == "" or (raw as String).length() > 2048:
		return false
	for ch in (raw as String):
		var o := ch.unicode_at(0)
		if o <= 0x20 or o == 0x7f or ch == "\\" or (o >= 0x80 and o <= 0x9f) or o == 0xa0 or o == 0x2028 or o == 0x2029 or o == 0xfeff:
			return false
	var m := _redirect_re.search(raw)
	if m == null or m.get_string(1) == "" or m.get_string(1).contains("@"):
		return false
	return not (raw as String).contains("#")


## Scope as a space-delimited string; "" when invalid.
static func _scope_string(scope: Variant) -> String:
	if scope == null:
		return DEFAULT_SCOPE
	var text: String = " ".join(PackedStringArray(scope)) if scope is Array or scope is PackedStringArray else String(scope)
	var parts: PackedStringArray = []
	for p in text.split(" ", false):
		if _scope_re.search(p) == null:
			return ""
		parts.append(p)
	return " ".join(parts)


## Build the authorize request. `opts`: authorize_endpoint, token_endpoint, issuer, client_id,
## redirect_uri (required), scope (String or Array; default "profile email"), login_hint,
## name_hint, purpose ("signin" | "attach"), license_choice ("app"), choice_available, and the
## test hooks state / code_verifier. Query order is fixed so every SDK emits the same bytes:
## `response_type client_id redirect_uri state code_challenge code_challenge_method scope
## [login_hint] [name_hint] [purpose] [license_choice]`. A hint that is empty is not sent; a hint
## is sent verbatim (the Worker normalises, and drops a login hint that is not an email).
## Returns {ok: true, pending: {authorize_url, state, code_verifier, redirect_uri, client_id,
## issuer, token_endpoint}} or {ok: false, message}.
static func start(opts: Dictionary) -> Dictionary:
	if not is_redirect_uri(opts.get("redirect_uri")):
		return _bad("redirect_uri must be an absolute https URL with no fragment.")
	for name in ["authorize_endpoint", "token_endpoint"]:
		var v = opts.get(name)
		if not (v is String) or not (v as String).begins_with("http") or (v as String).contains(" ") or PKeyTransport.parse_url(v).is_empty():
			return _bad("the %s is not an absolute URL." % String(name).trim_suffix("_endpoint"))
	if not (opts.get("issuer") is String) or opts["issuer"] == "":
		return _bad("discovery names no issuer.")
	if not (opts.get("client_id") is String) or opts["client_id"] == "":
		return _bad("client_id is empty.")
	var state: String = opts["state"] if opts.get("state") is String else random_token()
	if state.length() < STATE_MIN or state.length() > STATE_MAX or _state_re.search(state) == null:
		return _bad("state must be 16 to 512 printable characters.")
	var verifier: String = opts["code_verifier"] if opts.get("code_verifier") is String else random_token()
	if verifier.length() < VERIFIER_MIN or verifier.length() > VERIFIER_MAX or _verifier_re.search(verifier) == null:
		return _bad("the PKCE verifier must be 43 to 128 unreserved characters.")
	var scope := _scope_string(opts.get("scope"))
	if scope == "":
		return _bad("scope must be a space-delimited list of printable scopes.")
	var pairs: Array = [
		["response_type", "code"],
		["client_id", opts["client_id"]],
		["redirect_uri", opts["redirect_uri"]],
		["state", state],
		["code_challenge", pkce_challenge(verifier)],
		["code_challenge_method", "S256"],
		["scope", scope],
	]
	for hint in ["login_hint", "name_hint"]:
		if opts.get(hint) is String and opts[hint] != "":
			pairs.append([hint, opts[hint]])
	if opts.get("purpose") in ["signin", "attach"]:
		pairs.append(["purpose", opts["purpose"]])
	if opts.get("license_choice") == "app" and opts.get("choice_available") == true:
		pairs.append(["license_choice", "app"])
	var base: String = opts["authorize_endpoint"]
	return {"ok": true, "pending": {
		"authorize_url": "%s%s%s" % [base, "&" if base.contains("?") else "?", _form_body(pairs)],
		"state": state,
		"code_verifier": verifier,
		"redirect_uri": opts["redirect_uri"],
		"client_id": opts["client_id"],
		"issuer": opts["issuer"],
		"token_endpoint": opts["token_endpoint"],
	}}


static func _bad(message: String) -> Dictionary:
	return {"ok": false, "message": message}


# ── The callback ─────────────────────────────────────────────────────────────────────────

## The query pairs of `url` (before any `#`), names compared decoded; null when a name repeats or
## an escape is bad. A `+` is a space.
static func _query_of(url: String) -> Variant:
	var q := url.find("?")
	if q == -1:
		return {}
	var end := url.find("#")
	var text := "" if (end != -1 and end < q + 1) else (url.substr(q + 1) if end == -1 else url.substr(q + 1, end - q - 1))
	var out := {}
	for part in text.split("&"):
		if part == "":
			continue
		var eq := part.find("=")
		var name = decode(part if eq == -1 else part.substr(0, eq))
		var value = decode("" if eq == -1 else part.substr(eq + 1))
		if name == null or value == null or out.has(name):
			return null
		out[name] = value
	return out


## `scheme://authority/path` with the scheme and host lower-cased, or "" when `url` is not one.
static func _origin_path(url: String) -> String:
	var m := _origin_re.search(url)
	if m == null:
		return ""
	return "%s://%s%s" % [m.get_string(1).to_lower(), m.get_string(2).to_lower(), m.get_string(3)]


static func _fail(reason: String, error := "") -> Dictionary:
	var out := {"kind": "failed", "code": "sign-in-failed", "reason": reason}
	if error != "":
		out["error"] = error
	return out


## Check the redirect back to the app. `pending` needs state, redirect_uri, issuer. The order is
## fixed and the first failure wins: the callback is at the redirect URI; no parameter repeats;
## `state` is this request's; `iss` is the discovery issuer (a callback with no `iss` is refused);
## then `error` (`access_denied` is `cancelled`, any other is `failed`); then `code`.
## {kind: "code", code} | {kind: "cancelled"} | {kind: "failed", code: "sign-in-failed", reason,
## error?}. Reasons: malformed, redirect-mismatch, state-mismatch, issuer-mismatch,
## authorization-error, missing-code.
static func check_callback(pending: Dictionary, callback_url: Variant) -> Dictionary:
	if not (callback_url is String):
		return _fail("malformed")
	var got := _origin_path(callback_url)
	var want := _origin_path(pending["redirect_uri"])
	if got == "" or want == "":
		return _fail("malformed")
	if got != want:
		return _fail("redirect-mismatch")
	var q = _query_of(callback_url)
	if q == null:
		return _fail("malformed")
	if not q.has("state") or q["state"] != pending["state"]:
		return _fail("state-mismatch")
	if not q.has("iss") or q["iss"] != pending["issuer"]:
		return _fail("issuer-mismatch")
	if q.has("error"):
		return {"kind": "cancelled"} if q["error"] == "access_denied" else _fail("authorization-error", q["error"])
	if not q.has("code") or q["code"] == "":
		return _fail("missing-code")
	return {"kind": "code", "code": q["code"]}


# ── The token request and its answer ─────────────────────────────────────────────────────

## The form body of `POST /<p>/identity/token` (§12.5). Member order is fixed:
## `grant_type client_id code code_verifier redirect_uri [device_name]`.
static func token_form(pending: Dictionary, code: String, device_name := "") -> String:
	var pairs: Array = [
		["grant_type", "authorization_code"],
		["client_id", pending["client_id"]],
		["code", code],
		["code_verifier", pending["code_verifier"]],
		["redirect_uri", pending["redirect_uri"]],
	]
	if device_name != "":
		pairs.append(["device_name", device_name])
	return _form_body(pairs)


## Read the token endpoint's answer. `body` is the parsed JSON (anything when it was not JSON).
##   {kind: "token", access_token, scope, subject, schema_version, device, license}
##   {kind: "choose", grant, expires_in, choices}    decided by `status` alone
##   {kind: "refused", error, status, retry_after_seconds?}   a non-200, or a body with no `error`
##                                                  (`server_error`)
##   {kind: "malformed"}                             a 200 that lacks a member the call needs
static func parse_token_answer(status: int, body: Variant) -> Dictionary:
	if status != 200:
		var b: Dictionary = body if body is Dictionary else {}
		var error: String = b["error"] if b.get("error") is String and b["error"] != "" else "server_error"
		var out := {"kind": "refused", "error": error, "status": status}
		var retry = b.get("retryAfter")
		if PKeyClaims.is_number(retry) and not is_nan(float(retry)) and not is_inf(float(retry)) and float(retry) > 0.0:
			out["retry_after_seconds"] = int(ceil(float(retry)))
		return out
	if not (body is Dictionary):
		return {"kind": "malformed"}
	if body.get("status") == "choose":
		var grant = body.get("grant")
		if not (grant is String) or _grant_re.search(grant) == null or not PKeyClaims.is_number(body.get("expiresIn")) or not (body.get("choices") is Dictionary):
			return {"kind": "malformed"}
		return {"kind": "choose", "grant": grant, "expires_in": float(body["expiresIn"]), "choices": body["choices"]}
	var token = body.get("access_token")
	var subject = body.get("subject")
	var license = body.get("license", false)
	if not (token is String) or token == "" or not (body.get("scope") is String) or not (subject is String) or subject == "" \
			or not (body.get("device") is Dictionary) or not (license == null or license is Dictionary):
		return {"kind": "malformed"}
	var schema = body.get("schemaVersion")
	return {
		"kind": "token", "access_token": token, "scope": body["scope"], "subject": subject,
		"schema_version": int(schema) if PKeyClaims.is_number(schema) else 1,
		"device": body["device"], "license": license,
	}
