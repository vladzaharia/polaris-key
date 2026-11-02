class_name PKeyNativeRedirect
extends RefCounted
## The native redirect helpers (WIRE-CONTRACT-V5 §12.12): everything the SDK does around a pushed
## authorization request, with no I/O of its own. A port of client-core's `redirect.ts`; its
## vectors (packages/client-core/test/redirect.test.ts) are ported in
## tests/identity/test_native_redirect.gd.
##
##   choose_redirect_class(opts)       loopback, then scheme, then claimed HTTPS, else unavailable
##   native_redirect_uri(cls, opts)    the redirect URI of a class; classify_native_redirect_uri reads one
##   push_request(opts)                the form body of `POST /<p>/identity/request`, PKCE and state
##   parse_pushed_answer(...)          the `201` answer, or the flat refusal
##   authorize_url_for(...)            `authorize?client_id=&request_uri=` and nothing else
##   parse_native_callback(...)        the redirect back: redirect URI, state, iss, then code
##                                     (and `request=` on loopback); any other parameter is refused
##   native_token_request(...)         the token request, with the pusher's `X-PKey-Device`
##
## S256 only. This file never logs the verifier, the code or the token, and never puts them in a
## URL. A pending request is used for ONE callback check and one token request, then dropped.

## The one path of the loopback and scheme redirect URIs (RFC 8252 §7).
const NATIVE_REDIRECT_PATH := "/pkey/callback"
## How long a pushed request lives (RFC 9126 `expires_in`), and the listener with it.
const PUSHED_REQUEST_TTL_SECONDS := 600
const STATE_MIN := 16
const STATE_MAX := 512
const TOKEN_CONTENT_TYPE := "application/x-www-form-urlencoded"
## A URL scheme a native redirect never uses: the web's own.
const RESERVED_SCHEMES := ["http", "https", "javascript", "data", "file"]
## Callback refusals that leave a sign-in waiting: a delivery that is not this sign-in's cannot end it.
const NOT_THIS_SIGN_IN := ["malformed", "redirect-mismatch", "state-mismatch"]

static var _verifier_re: RegEx
static var _printable_re: RegEx
static var _scheme_re: RegEx
static var _request_uri_re: RegEx
static var _handle_re: RegEx
static var _bad_uri_re: RegEx
static var _loopback_re: RegEx
static var _https_re: RegEx
static var _schemed_re: RegEx
static var _endpoint_re: RegEx
static var _base_re: RegEx


static func _static_init() -> void:
	_verifier_re = RegEx.create_from_string("\\A[A-Za-z0-9\\-._~]+\\z")
	_printable_re = RegEx.create_from_string("\\A[\\x21-\\x7e]+\\z")
	_scheme_re = RegEx.create_from_string("\\A[a-z][a-z0-9+.\\-]*\\z")
	_request_uri_re = RegEx.create_from_string("\\Aurn:ietf:params:oauth:request_uri:[A-Za-z0-9_-]{22}\\z")
	_handle_re = RegEx.create_from_string("\\Arq_[A-Za-z0-9_-]{22}\\z")
	_bad_uri_re = RegEx.create_from_string("[\\s\\x00-\\x1f\\x7f\\\\]")
	_loopback_re = RegEx.create_from_string("\\Ahttp://(127\\.0\\.0\\.1|\\[::1\\]):([0-9]{1,5})(/.*)\\z")
	_https_re = RegEx.create_from_string("\\Ahttps://([^/?#@]+)(/[^?#]*)\\z")
	_schemed_re = RegEx.create_from_string("\\A([a-z][a-z0-9+.\\-]*):(/[^?#]*)\\z")
	_endpoint_re = RegEx.create_from_string("\\Ahttps?://[^\\s]+\\z")
	_base_re = RegEx.create_from_string("\\A([A-Za-z][A-Za-z0-9+.\\-]*):(//[^/?#]*)?([^?#]*)")


## String equality without an early exit on the first differing character.
static func constant_time_equal(a: String, b: String) -> bool:
	var x := a.to_utf8_buffer()
	var y := b.to_utf8_buffer()
	var diff := x.size() ^ y.size()
	for i in maxi(x.size(), y.size()):
		diff |= (x[i] if i < x.size() else 0) ^ (y[i] if i < y.size() else 0)
	return diff == 0


# ── 1. The class ─────────────────────────────────────────────────────────────────────────

## SIGN-IN D-68: `SSH_CONNECTION` or `SSH_TTY`, `CI`, a headless display server, or on Linux no
## `DISPLAY` and no `WAYLAND_DISPLAY`. A headless host cannot open a browser for a loopback listener.
static func is_headless() -> bool:
	if DisplayServer.get_name() == "headless":
		return true
	if OS.get_environment("SSH_CONNECTION") != "" or OS.get_environment("SSH_TTY") != "" or OS.get_environment("CI") != "":
		return true
	return OS.get_name() == "Linux" and OS.get_environment("DISPLAY") == "" and OS.get_environment("WAYLAND_DISPLAY") == ""


## True on Windows, macOS and Linux (and the BSDs): the hosts that can bind a loopback listener and
## open the system browser. Android, iOS and the web answer `redirect-unavailable` for now.
static func is_desktop() -> bool:
	return OS.get_name() in ["Windows", "macOS", "Linux", "FreeBSD", "NetBSD", "OpenBSD", "BSD"]


## `opts`: request_endpoint, discovery (the fragment's `nativeRedirect`: {loopback, schemes,
## claimedHttps}), can_listen, registered_schemes, registered_claimed (full redirect URIs).
## {kind: "loopback"} | {kind: "scheme"|"claimed", redirect_uri} |
## {kind: "unavailable", code: "redirect-unavailable", reason: "request-not-served"|"no-class"}.
## The order is fixed, and a class is used only when discovery lists it AND the host has it.
static func choose_redirect_class(opts: Dictionary) -> Dictionary:
	var unavailable := PKeyConstants.ErrorCode.REDIRECT_UNAVAILABLE
	var d = opts.get("discovery")
	if not (opts.get("request_endpoint") is String) or opts["request_endpoint"] == "" or not (d is Dictionary):
		return {"kind": "unavailable", "code": unavailable, "reason": "request-not-served"}
	if opts.get("can_listen") == true and d.get("loopback") == true:
		return {"kind": "loopback"}
	var schemes = d.get("schemes") if d.get("schemes") is Array else []
	for uri in opts.get("registered_schemes", []):
		if uri in schemes:
			return {"kind": "scheme", "redirect_uri": uri}
	var claimed = d.get("claimedHttps") if d.get("claimedHttps") is Array else []
	for uri in opts.get("registered_claimed", []):
		if uri in claimed:
			return {"kind": "claimed", "redirect_uri": uri}
	return {"kind": "unavailable", "code": unavailable, "reason": "no-class"}


# ── The registered redirects (mobile) ────────────────────────────────────────────────────

## Project settings holding the redirect a phone build registered (the Android export reads the same ones for the
## intent filter). They are the defaults; `registered_schemes` / `registered_claimed` in the start options override
## per key.
const SETTING_SCHEME := "polaris_key/native_redirect/scheme"
const SETTING_CLAIMED := "polaris_key/native_redirect/claimed_uri"


## The redirects the project settings register, as full redirect URIs: {schemes: [...], claimed: [...]}. `settings`
## ({scheme, claimed_uri}) stands in for the project settings (tests). A value that is no native redirect URI is dropped.
static func settings_redirects(settings: Variant = null) -> Dictionary:
	var scheme: Variant = ""
	var claimed: Variant = ""
	if settings is Dictionary:
		scheme = settings.get("scheme", "")
		claimed = settings.get("claimed_uri", "")
	else:
		scheme = ProjectSettings.get_setting(SETTING_SCHEME, "") if ProjectSettings.has_setting(SETTING_SCHEME) else ""
		claimed = ProjectSettings.get_setting(SETTING_CLAIMED, "") if ProjectSettings.has_setting(SETTING_CLAIMED) else ""
	var schemes: Array = []
	var links: Array = []
	if scheme is String and scheme != "":
		var uri := native_redirect_uri("scheme", {"scheme": scheme})
		if uri != "":
			schemes.append(uri)
	if claimed is String and claimed != "" and classify_native_redirect_uri(claimed) == "claimed":
		links.append(claimed)
	return {"schemes": schemes, "claimed": links}


## The registration a start uses: each key of `opts` (`registered_schemes`, `registered_claimed`) overrides the default
## from `defaults` ({schemes, claimed}, normally the opener's, i.e. the project settings).
static func merge_registered(opts: Dictionary, defaults: Dictionary) -> Dictionary:
	return {
		"schemes": opts["registered_schemes"] if opts.has("registered_schemes") else defaults.get("schemes", []),
		"claimed": opts["registered_claimed"] if opts.has("registered_claimed") else defaults.get("claimed", []),
	}


# ── 2. The redirect URI ──────────────────────────────────────────────────────────────────

## "loopback", "claimed" or "scheme", or "" when it is none (§12.12: `localhost`, another path, a
## query, a fragment, userinfo, port 80 or no port are all refused).
static func classify_native_redirect_uri(uri: Variant) -> String:
	if not (uri is String) or uri == "" or (uri as String).length() > 2048 or _bad_uri_re.search(uri) != null:
		return ""
	var loop := _loopback_re.search(uri)
	if loop != null:
		var port_text := loop.get_string(2)
		var port := int(port_text)
		var ok := port >= 1 and port <= 65535 and port != 80 and loop.get_string(3) == NATIVE_REDIRECT_PATH \
			and not (port_text.length() > 1 and port_text.begins_with("0"))
		return "loopback" if ok else ""
	var https := _https_re.search(uri)
	if https != null and https.get_string(2) != "/":
		return "claimed"
	var scheme := _schemed_re.search(uri)
	if scheme != null:
		return "scheme" if not (scheme.get_string(1) in RESERVED_SCHEMES) and scheme.get_string(2) == NATIVE_REDIRECT_PATH else ""
	return ""


## The loopback redirect URI of a listener's OS-assigned port (`cls` "loopback", `opts.port`), or a
## registered scheme's `<scheme>:/pkey/callback` (`cls` "scheme", `opts.scheme`). "" when the
## inputs make no native redirect URI.
static func native_redirect_uri(cls: String, opts: Dictionary) -> String:
	var uri := ""
	if cls == "loopback":
		var port = opts.get("port")
		if not (port is int) or port < 1 or port > 65535 or port == 80:
			return ""
		uri = "http://127.0.0.1:%d%s" % [port, NATIVE_REDIRECT_PATH]
	elif cls == "scheme":
		var name := String(opts.get("scheme", ""))
		if _scheme_re.search(name) == null or name in RESERVED_SCHEMES:
			return ""
		uri = "%s:%s" % [name, NATIVE_REDIRECT_PATH]
	else:
		return ""
	return uri if classify_native_redirect_uri(uri) == cls else ""


# ── 3. The pushed request ────────────────────────────────────────────────────────────────

static func _form_body(pairs: Array) -> String:
	var parts: PackedStringArray = []
	for p in pairs:
		parts.append("%s=%s" % [PKeyIdentityRedirect.form_encode(p[0]), PKeyIdentityRedirect.form_encode(p[1])])
	return "&".join(parts)


static func _scope_text(scope: Variant) -> String:
	var text: String = " ".join(PackedStringArray(scope)) if scope is Array or scope is PackedStringArray else String(scope)
	var parts: PackedStringArray = []
	for p in text.split(" ", false):
		if _printable_re.search(p) == null:
			return ""
		parts.append(p)
	return " ".join(parts)


static func _bad(message: String) -> Dictionary:
	return {"ok": false, "message": message}


## Build the pushed request. Nothing here touches the network. `opts`: request_endpoint,
## authorize_endpoint, token_endpoint, issuer, client_id, redirect_uri (a native one, required),
## device_name, return_uri (a registered scheme's, for "Return to <App>"; it never carries a
## code), scope (omitted when not given: the Worker defaults it), nonce, login_hint, name_hint,
## purpose, license_choice ("app", sent only when choice_available), and the test hooks state /
## code_verifier. Member order is fixed: `response_type client_id redirect_uri state
## code_challenge code_challenge_method [scope] [nonce] [login_hint] [name_hint] [purpose]
## [license_choice] [device_name] [return_uri]`.
## {ok: true, url, content_type, body, pending: {redirect_class, redirect_uri, state, code_verifier,
## client_id, issuer, authorize_endpoint, token_endpoint, license_choice}} or {ok: false, message}.
static func push_request(opts: Dictionary) -> Dictionary:
	var redirect_class := classify_native_redirect_uri(opts.get("redirect_uri"))
	if redirect_class == "":
		return _bad("redirect_uri is not a native redirect URI.")
	var return_uri = opts.get("return_uri")
	if return_uri != null and return_uri != "" and classify_native_redirect_uri(return_uri) != "scheme":
		return _bad("return_uri must be a registered scheme's redirect URI.")
	for pair in [["request", "request_endpoint"], ["authorize", "authorize_endpoint"], ["token", "token_endpoint"]]:
		var v = opts.get(pair[1])
		if not (v is String) or _endpoint_re.search(v) == null:
			return _bad("the %s endpoint is not an absolute URL." % pair[0])
	if not (opts.get("issuer") is String) or opts["issuer"] == "":
		return _bad("discovery names no issuer.")
	if not (opts.get("client_id") is String) or opts["client_id"] == "":
		return _bad("client_id is empty.")
	var state: String = opts["state"] if opts.get("state") is String else PKeyIdentityRedirect.random_token()
	if state.length() < STATE_MIN or state.length() > STATE_MAX or _printable_re.search(state) == null:
		return _bad("state must be 16 to 512 printable characters.")
	var verifier: String = opts["code_verifier"] if opts.get("code_verifier") is String else PKeyIdentityRedirect.random_token()
	if verifier.length() < PKeyIdentityRedirect.VERIFIER_MIN or verifier.length() > PKeyIdentityRedirect.VERIFIER_MAX or _verifier_re.search(verifier) == null:
		return _bad("the PKCE verifier must be 43 to 128 unreserved characters.")
	var nonce = opts.get("nonce")
	if nonce != null and (not (nonce is String) or _printable_re.search(nonce) == null):
		return _bad("nonce must be printable characters.")
	var pairs: Array = [
		["response_type", "code"],
		["client_id", opts["client_id"]],
		["redirect_uri", opts["redirect_uri"]],
		["state", state],
		["code_challenge", PKeyIdentityRedirect.pkce_challenge(verifier)],
		["code_challenge_method", "S256"],
	]
	if opts.get("scope") != null:
		var scope := _scope_text(opts["scope"])
		if scope == "":
			return _bad("scope must be a space-delimited list of printable scopes.")
		pairs.append(["scope", scope])
	if nonce is String and nonce != "":
		pairs.append(["nonce", nonce])
	for hint in ["login_hint", "name_hint"]:
		if opts.get(hint) is String and opts[hint] != "":
			pairs.append([hint, opts[hint]])
	if opts.get("purpose") in ["signin", "attach"]:
		pairs.append(["purpose", opts["purpose"]])
	var sent_choice: bool = opts.get("license_choice") == "app" and opts.get("choice_available") == true
	if sent_choice:
		pairs.append(["license_choice", "app"])
	if opts.get("device_name") is String and opts["device_name"] != "":
		pairs.append(["device_name", opts["device_name"]])
	if return_uri is String and return_uri != "":
		pairs.append(["return_uri", return_uri])
	return {
		"ok": true,
		"url": opts["request_endpoint"],
		"content_type": TOKEN_CONTENT_TYPE,
		"body": _form_body(pairs),
		"pending": {
			"redirect_class": redirect_class,
			"redirect_uri": opts["redirect_uri"],
			"state": state,
			"code_verifier": verifier,
			"client_id": opts["client_id"],
			"issuer": opts["issuer"],
			"authorize_endpoint": opts["authorize_endpoint"],
			"token_endpoint": opts["token_endpoint"],
			# The push carried `license_choice=app`: the token endpoint may answer `choose`.
			"license_choice": sent_choice,
		},
	}


## Read the answer of `POST /<p>/identity/request`: `201 {request_uri, expires_in}`.
## {kind: "pushed", request_uri, expires_in} | {kind: "refused", error, status,
## retry_after_seconds?} (a 5xx, or a body with no `error`, is `server_error`) | {kind: "malformed"}.
static func parse_pushed_answer(status: int, body: Variant) -> Dictionary:
	if status != 201:
		var b: Dictionary = body if body is Dictionary else {}
		var error: String = b["error"] if b.get("error") is String and b["error"] != "" else "server_error"
		var out := {"kind": "refused", "error": error, "status": status}
		var retry = b.get("retryAfter")
		if PKeyClaims.is_number(retry) and not is_nan(float(retry)) and not is_inf(float(retry)) and float(retry) > 0.0:
			out["retry_after_seconds"] = int(minf(ceilf(float(retry)), 3600.0))
		return out
	if not (body is Dictionary):
		return {"kind": "malformed"}
	var request_uri = body.get("request_uri")
	var expires_in = body.get("expires_in")
	if not (request_uri is String) or _request_uri_re.search(request_uri) == null or not PKeyClaims.is_number(expires_in):
		return {"kind": "malformed"}
	var seconds := float(expires_in)
	if seconds != floorf(seconds) or seconds < 1.0 or seconds > float(PUSHED_REQUEST_TTL_SECONDS):
		return {"kind": "malformed"}
	return {"kind": "pushed", "request_uri": request_uri, "expires_in": int(seconds)}


# ── 5. The authorize URL ─────────────────────────────────────────────────────────────────

## `authorize?client_id=<id>&request_uri=<uri>`: the only parameters a pushed request takes. ""
## when `request_uri` is not a pushed request URI.
static func authorize_url_for(authorize_endpoint: String, client_id: String, request_uri: String) -> String:
	if _request_uri_re.search(request_uri) == null:
		return ""
	return "%s%sclient_id=%s&request_uri=%s" % [
		authorize_endpoint, "&" if authorize_endpoint.contains("?") else "?",
		PKeyIdentityRedirect.form_encode(client_id), PKeyIdentityRedirect.form_encode(request_uri),
	]


# ── 6. The redirect back ─────────────────────────────────────────────────────────────────

static func _base_of(url: String) -> String:
	var m := _base_re.search(url)
	if m == null:
		return ""
	return "%s:%s%s" % [m.get_string(1).to_lower(), m.get_string(2).to_lower(), m.get_string(3)]


static func _failed(reason: String, error := "") -> Dictionary:
	var out := {"kind": "failed", "code": "sign-in-failed", "reason": reason}
	if error != "":
		out["error"] = error
	return out


## Check the redirect back to the app. `pending` needs state, issuer, redirect_uri (and
## redirect_class, else read off the URI). The first failure wins, in this order: an absolute URL
## with no fragment; at the redirect URI the request named; no repeated parameter; `state` (constant
## time); `iss` (RFC 9207: a callback with no `iss` is refused); a `code` or an `error`; no
## parameter beyond `code state iss request` (or `error error_description state iss request`);
## then `error` (`access_denied` is `cancelled`); on loopback, `request=` an `rq_` handle (a
## scheme or claimed delivery has none, and one that carries it must still hold a valid one).
## {kind: "code", code, request?} | {kind: "cancelled", request?} |
## {kind: "failed", code: "sign-in-failed", reason, error?}. Reasons: malformed,
## redirect-mismatch, state-mismatch, issuer-mismatch, authorization-error, missing-code,
## unexpected-parameter, request-invalid.
static func parse_native_callback(pending: Dictionary, callback_url: Variant) -> Dictionary:
	if not (callback_url is String) or (callback_url as String).contains("#"):
		return _failed("malformed")
	var got := _base_of(callback_url)
	var want := _base_of(String(pending["redirect_uri"]))
	if got == "" or want == "":
		return _failed("malformed")
	if got != want:
		return _failed("redirect-mismatch")
	var q = PKeyIdentityRedirect.query_of(callback_url)
	if q == null:
		return _failed("malformed")
	if not q.has("state") or not constant_time_equal(q["state"], String(pending["state"])):
		return _failed("state-mismatch")
	if not q.has("iss") or not constant_time_equal(q["iss"], String(pending["issuer"])):
		return _failed("issuer-mismatch")
	var has_error: bool = q.has("error")
	if not has_error and (not q.has("code") or q["code"] == ""):
		return _failed("missing-code")
	var allowed: Array = ["error", "error_description", "state", "iss", "request"] if has_error else ["code", "state", "iss", "request"]
	for name in q:
		if not (name in allowed):
			return _failed("unexpected-parameter")
	var redirect_class: String = pending.get("redirect_class", "")
	if redirect_class == "":
		redirect_class = classify_native_redirect_uri(pending["redirect_uri"])
	var request := ""
	if q.has("request"):
		request = q["request"]
		if _handle_re.search(request) == null:
			return _failed("request-invalid")
	elif redirect_class == "loopback" and not has_error:
		return _failed("request-invalid")
	var tail := {"request": request} if request != "" else {}
	if has_error:
		if q["error"] == "access_denied":
			var cancelled := {"kind": "cancelled"}
			cancelled.merge(tail)
			return cancelled
		return _failed("authorization-error", q["error"])
	var out := {"kind": "code", "code": q["code"]}
	out.merge(tail)
	return out


# ── 7. The token request ─────────────────────────────────────────────────────────────────

## `POST /<p>/identity/token` for a code from a pushed request (§12.5): {url, headers, body}. The
## headers hold the pusher's `X-PKey-Device` (a different device is `invalid_grant`) and the
## content type; the caller adds the SDK headers. {} when `device_id` is empty or not printable.
static func native_token_request(pending: Dictionary, code: String, device_id: String, device_name := "") -> Dictionary:
	if _printable_re.search(device_id) == null:
		return {}
	return {
		"url": pending["token_endpoint"],
		"headers": {"X-PKey-Device": device_id, "Content-Type": TOKEN_CONTENT_TYPE},
		"body": PKeyIdentityRedirect.token_form(pending, code, device_name),
	}
