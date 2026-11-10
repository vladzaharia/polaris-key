class_name PKeyIdentityExchange
extends RefCounted
## `PolarisKey.identity.exchange` (identity.exchange; WIRE-CONTRACT-V5 §12.11.2-.3, .7): the
## platform exchange. The app gets a token from the platform (Google, Apple, Game Center, Play
## Games) over a nonce the Worker issued, and the Worker answers with the same device token a
## redirect sign-in mints. This file is the primitive; the ladder that calls the platform is
## `auto_sign_in()`. The port of Swift `Exchange.swift` and Kotlin `:identity`.
##
##   var n := await PolarisKey.identity.exchange.nonce("google")       # kind nonce
##   var token := ...                                                   # the platform's, not ours
##   var r := await PolarisKey.identity.exchange.exchange("google", token, n.nonce)
##   match r.kind:
##       &"signed_in": ...                   # the device token is stored
##       &"confirm": ...                     # show r.consent, then identity.choice.complete(
##                                           #   r.grant, null, {claims = [...]})
##       &"choose": ...                      # the licence choice, as a redirect's
##       &"needs_sign_in": ...               # sign in the regular way, then link (r.link_handle)
##       &"unavailable": ...                 # fall to the next rung
##
## Rules:
##  - The nonce route registers the device's two public keys. The `exchange` proof binds the nonce,
##    the signing key and the SHA-256 of the provider token, signed by the device key port that
##    the key ring shares (one store), so no private key is handled here.
##  - A nonce is single use: this client asks for a fresh one per attempt and holds none after it.
##  - Both routes come from discovery, on this product's origin. A product that publishes no
##    `exchange` member, or not the requested kind, is `unavailable` and nothing is sent. So is a
##    device whose keys die with the process.
##  - The token, nonce, grant and link handle travel in a body and never print.
##
## Not instantiated by a game: PKeyIdentity owns one.

const GRANT_TYPE := "urn:ietf:params:oauth:grant-type:token-exchange"
const TOKEN_TYPES := {
	"google": "urn:ietf:params:oauth:token-type:id_token",
	"apple": "urn:ietf:params:oauth:token-type:id_token",
	"gamecenter": "urn:polaris-key:token-type:gamecenter-signature",
	"pgs": "urn:polaris-key:token-type:pgs-server-auth-code",
}

static var _grant_re: RegEx
static var _nonce_re: RegEx
static var _handle_re: RegEx

var _identity_ref: WeakRef = null


static func _static_init() -> void:
	_grant_re = RegEx.create_from_string("\\Asg_[A-Za-z0-9_-]{43}\\z")
	_nonce_re = RegEx.create_from_string("\\A[A-Za-z0-9_-]{43}\\z")
	_handle_re = RegEx.create_from_string("\\Alh_[A-Za-z0-9_-]{43}\\z")


func _init(identity: PKeyIdentity) -> void:
	_identity_ref = weakref(identity)


func _identity() -> PKeyIdentity:
	return _identity_ref.get_ref() as PKeyIdentity if _identity_ref != null else null


## Ask the Worker for a nonce for `kind`, registering this device's public keys with it. Send the
## value to the platform, then pass it to exchange(). A coroutine answering a PKeyExchangeResult
## (kind `nonce`, `unavailable`, `refused` or `failed`).
func nonce(kind: String) -> PKeyExchangeResult:
	var ready = await _ready(kind)
	if ready is PKeyExchangeResult:
		return ready
	return await _fetch_nonce(ready)


## Exchange a platform token for a device token. `nonce` is the value the token was requested with
## (nonce()); "" takes a fresh one after the token exists (Game Center and Play Games have no
## nonce to sign in, and tests). Any answer spends the nonce. `opts`: device_name, license_choice
## ("app" or "card"). A call here is a sign-in the person started: a stored token lowers the
## sign-out flag. (The ladder passes the private `ladder_generation`; it never does.) A coroutine answering a PKeyExchangeResult.
func exchange(kind: String, subject_token: String, p_nonce := "", opts := {}) -> PKeyExchangeResult:
	var invalid := _argument_error(subject_token, p_nonce)
	if invalid != null:
		return invalid
	var ready = await _ready(kind)
	if ready is PKeyExchangeResult:
		return ready
	var ctx: Dictionary = ready
	var value := p_nonce
	if value == "":
		var n := await _fetch_nonce(ctx)
		if n.kind != PKeyExchangeResult.KIND_NONCE:
			return n
		value = n.nonce
	var form = _token_form(kind, subject_token, value, ctx, opts)
	if form is PKeyExchangeResult:
		return form
	var sent = await _send(ctx["token"], PKeyIdentityRedirect.TOKEN_CONTENT_TYPE, form)
	if sent is PKeyExchangeResult:
		return sent
	return await _outcome(sent["status"], sent["body"], sent["response"], opts)


## null when the arguments are usable, else the failure.
func _argument_error(subject_token: String, p_nonce: String) -> PKeyExchangeResult:
	if subject_token == "":
		return PKeyExchangeResult.failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "subject_token is empty.")
	if p_nonce != "" and _nonce_re.search(p_nonce) == null:
		return PKeyExchangeResult.failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "nonce is malformed.")
	return null


## The form body that carries the token and the device's proof (a PackedByteArray), or the
## PKeyExchangeResult that ends the attempt.
func _token_form(kind: String, subject_token: String, value: String, ctx: Dictionary, opts: Dictionary) -> Variant:
	var core := _identity()._core()
	var keys: PKeyResult = ctx["port"].ensure()
	if not keys.ok:
		return PKeyExchangeResult.failed(PKeyConstants.ErrorCode.PLATFORM_IDENTITY_UNAVAILABLE, "The device keys could not be read.")
	var sign_key: String = keys.detail["sign_key"]
	var proof := PKeyDeviceKeys.sign_device_proof(ctx["port"], {
		"purpose": "exchange",
		"product": core.product,
		"device_id": core.device_id,
		"value": "%s.%s" % [value, sign_key],
		"token_hash": PKeyB64Url.encode(subject_token.sha256_buffer()),
	})
	if not proof.ok:
		return PKeyExchangeResult.failed(proof.code, proof.message)
	var pairs: Array = [
		["grant_type", GRANT_TYPE], ["client_id", core.product], ["subject_token", subject_token],
		["subject_token_type", TOKEN_TYPES[kind]], ["nonce", value], ["device_key", sign_key], ["proof", proof.detail["sig"]],
	]
	if opts.get("license_choice") in ["app", "card"]:
		pairs.append(["license_choice", opts["license_choice"]])
	if opts.get("device_name") is String and opts["device_name"] != "":
		pairs.append(["device_name", opts["device_name"]])
	var parts := PackedStringArray()
	for p in pairs:
		parts.append("%s=%s" % [PKeyUri.form(p[0]), PKeyUri.form(p[1])])
	return "&".join(parts).to_utf8_buffer()


# ── Routes and keys ──────────────────────────────────────────────────────────────────────

## {port, nonce, token} for `kind`, or the PKeyExchangeResult that ends the attempt.
func _ready(kind: String) -> Variant:
	var identity := _identity()
	var core := identity._core() if identity != null else null
	if core == null or not core.started:
		return PKeyExchangeResult.failed(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	if not TOKEN_TYPES.has(kind):
		return PKeyExchangeResult.failed(PKeyConstants.ErrorCode.INVALID_ARGUMENT, "kind is google, apple, gamecenter or pgs.")
	if core.discovery_manifest == null:
		await core.discover()
	return _routes(identity, core, kind)


## {port, nonce, token} once discovery is in, or the PKeyExchangeResult that ends the attempt.
func _routes(identity: PKeyIdentity, core: PKeyCore, kind: String) -> Variant:
	var off := PKeyExchangeResult.unavailable(PKeyConstants.ErrorCode.PLATFORM_IDENTITY_UNAVAILABLE, "No %s exchange for %s." % [kind, core.product])
	if not core.enabled("identity"):
		return off
	var fragment := PKeyDiscovery.identity_from(core.discovery_manifest)
	var kinds: Array = fragment.get("exchange", {}).get("kinds", [])
	var nonce_url: String = fragment.get("nonce", "")
	var token_url: String = fragment.get("endpoints", {}).get("token", "")
	if not (kind in kinds) or nonce_url == "" or token_url == "":
		return off
	if not identity._own(nonce_url) or not identity._own(token_url):
		return PKeyExchangeResult.failed(PKeyErrors.INVALID_RESPONSE, "An identity endpoint points outside this product.")
	var port: Object = identity.device_keys
	# Keys that die with the process would bind the device to a key it cannot present again.
	if port == null or port.persistence() == "memory":
		return off
	return {"port": port, "nonce": nonce_url, "token": token_url}


func _fetch_nonce(ctx: Dictionary) -> PKeyExchangeResult:
	var keys: PKeyResult = ctx["port"].ensure()
	if not keys.ok:
		return PKeyExchangeResult.unavailable(PKeyConstants.ErrorCode.PLATFORM_IDENTITY_UNAVAILABLE, "The device keys could not be read.")
	var body := PKeyJson.stringify({"signKey": keys.detail["sign_key"], "agreeKey": keys.detail["agree_key"]}).to_utf8_buffer()
	var sent = await _send(ctx["nonce"], "application/json", body, true)
	if sent is PKeyExchangeResult:
		return sent
	var b = sent["body"]
	var value = b.get("nonce") if b is Dictionary else null
	var life = b.get("expiresIn") if b is Dictionary else null
	if not (value is String) or _nonce_re.search(value) == null or not PKeyClaims.is_number(life) or float(life) <= 0.0:
		return PKeyExchangeResult.failed(PKeyErrors.INVALID_RESPONSE, "The nonce route answered without a nonce.")
	var r := PKeyExchangeResult.made(PKeyExchangeResult.KIND_NONCE)
	r.nonce = value
	r.expires_in = int(life)
	r.expires_at = _identity()._core().clock.system_now() + r.expires_in
	return r


# ── Transport and answers ────────────────────────────────────────────────────────────────

## POST `url` (no bearer: the proof and the nonce are the credentials). A PKeyExchangeResult when the
## call ended; else {status, body, response}. `is_nonce`: a 404 or 4xx on the nonce route.
func _send(url: String, content_type: String, body: PackedByteArray, is_nonce := false, retry_cap := 3600) -> Variant:
	var core := _identity()._core()
	var r := await core.transport.request("POST", url, core.headers({"Content-Type": content_type}), body)
	if not r.ok:
		return PKeyExchangeResult.failed(r.code if r.code == PKeyErrors.LOCAL_ONLY else PKeyErrors.NETWORK, "The exchange request failed.")
	var status: int = r.detail["status"]
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var answer = parsed["value"] if parsed["ok"] else null
	if status == 200 or (status == 403 and answer is Dictionary and answer.get("error") == PKeyConstants.ErrorCode.INTERSTITIAL_REQUIRED and not is_nonce):
		return {"status": status, "body": answer, "response": r}
	if status == 404:
		return PKeyExchangeResult.unavailable(PKeyConstants.ErrorCode.NOT_FOUND, "The exchange route is not served for this product.")
	return _refusal(status, r, answer, retry_cap)


func _outcome(status: int, body: Variant, _response: PKeyResult, opts := {}) -> PKeyExchangeResult:
	var core := _identity()._core()
	var bad := PKeyExchangeResult.failed(PKeyErrors.INVALID_RESPONSE, "The token endpoint answered without a complete exchange.")
	if not (body is Dictionary):
		return bad
	if status == 403:
		return _needs_sign_in(body, bad)
	if body.get("status") == "confirm":
		return _confirm(body, bad)
	var answer := PKeyIdentityRedirect.parse_token_answer(200, body)
	match answer["kind"]:
		"choose":
			var ch := PKeyExchangeResult.made(PKeyExchangeResult.KIND_CHOOSE)
			ch.grant = answer["grant"]
			ch.expires_in = int(answer["expires_in"])
			ch.expires_at = core.clock.system_now() + ch.expires_in
			ch.view = answer["choices"]
			return ch
		"token":
			return await _signed_in(answer, opts)
	return bad


## `200 confirm`: the consent the person approves, or `bad` when the answer is incomplete.
func _confirm(body: Dictionary, bad: PKeyExchangeResult) -> PKeyExchangeResult:
	var grant = body.get("grant")
	var consent = body.get("consent")
	if not (grant is String) or _grant_re.search(grant) == null or not PKeyClaims.is_number(body.get("expiresIn")) \
			or not (consent is Dictionary) or not (consent.get("client") is Dictionary) or not (consent.get("as") is Dictionary) \
			or not (consent.get("items") is Array) or not (consent.get("scopeHash") is String):
		return bad
	var c := PKeyExchangeResult.made(PKeyExchangeResult.KIND_CONFIRM)
	c.grant = grant
	c.expires_in = int(body["expiresIn"])
	c.expires_at = _identity()._core().clock.system_now() + c.expires_in
	c.consent = consent
	return c


## A token answer: store it and report the sign-in. A coroutine.
func _signed_in(answer: Dictionary, opts: Dictionary) -> PKeyExchangeResult:
	var identity := _identity()
	var core := identity._core()
	var out := PKeyExchangeResult.made(PKeyExchangeResult.KIND_SIGNED_IN)
	var ladder = opts.get("ladder_generation")
	if ladder is int:
		# The ladder's own exchange: stored only if no sign-out happened since it started, and
		# it never lowers the sign-out flag.
		var verdict = core.tokens.set_token_unless_signed_out(answer["access_token"], ladder)
		if verdict == null:
			return PKeyExchangeResult.signed_out()
		out.stored = verdict
	else:
		out.stored = core.tokens.set_token(answer["access_token"], PKeyTokenManager.SOURCE_SIGNIN, true)
	out.subject = answer["subject"]
	out.scope = answer["scope"]
	var lic = answer["license"]
	out.license_id = lic["id"] if lic is Dictionary and lic.get("id") is String else ""
	if identity._account != null:
		identity._account.note_signed_in(out.subject)
	if identity.redirect_acquisition_sync and identity.on_acquired.is_valid():
		var synced: PKeySyncResult = await identity.on_acquired.call()
		var problem := PKeyLicense.unverified(core, synced, "the sign-in succeeded")
		if not problem.is_empty():
			return PKeyExchangeResult.failed(problem["code"], problem["message"])
	if not (ladder is int):
		# A sign-in the person started (the ladder enrols for its own rungs).
		await identity.restore.after_sign_in()
	return out


## `403 interstitial_required`. An unknown `reason` reads as `no_link` with no handle; a handle
## comes only with a literal `no_link`.
func _needs_sign_in(body: Dictionary, bad: PKeyExchangeResult) -> PKeyExchangeResult:
	var card = body.get("url")
	if not (card is String) or not _card_url_ok(card):
		return bad
	var r := PKeyExchangeResult.made(PKeyExchangeResult.KIND_NEEDS_SIGN_IN, 403)
	r.url = card
	var raw = body.get("reason")
	r.reason = "terms" if raw == "terms" else "no_link"
	var handle = body.get("linkHandle")
	if raw == "no_link" and handle is String and _handle_re.search(handle) != null and PKeyClaims.is_number(body.get("expiresIn")):
		r.link_handle = handle
		r.expires_in = int(body["expiresIn"])
		r.expires_at = _identity()._core().clock.system_now() + r.expires_in
		_identity().link._hold(handle, r.expires_at)
	return r


## https, or http on loopback: the card is a page the person opens.
static func _card_url_ok(raw: String) -> bool:
	var u := PKeyTransport.parse_url(raw)
	if u.is_empty():
		return false
	if u["scheme"] == "https":
		return true
	return u["host"] in ["localhost", "127.0.0.1", "[::1]", "::1"]


## A 4xx/5xx as its result: the wire code (flat `{error: code}` or nested `{error: {code}}`) and
## only the members the answer carried. A 5xx is `server-error`. Nothing of the request is echoed.
static func _refusal(status: int, r: PKeyResult, body: Variant, retry_cap := 3600) -> PKeyExchangeResult:
	var b: Dictionary = body if body is Dictionary else {}
	var error = b.get("error")
	var code = error.get("code") if error is Dictionary else error
	# `503 unavailable` is the Worker's typed answer when the platform's key host or Google cannot be
	# reached (V5 §12.11.7, Game Center and Play Games): a refusal to retry later, like Kotlin's. Any
	# other 5xx is a server error.
	var typed_unavailable: bool = status == 503 and code == PKeyConstants.ErrorCode.UNAVAILABLE
	if status >= 500 and not typed_unavailable:
		return PKeyExchangeResult.failed(PKeyErrors.SERVER_ERROR, "The exchange failed with status %d." % status, {"status": status})
	var out := PKeyExchangeResult.refused(StringName(code if code is String and code != "" else "http_%d" % status), status)
	var retry = b.get("retryAfter")
	if PKeyClaims.is_number(retry) and not is_nan(float(retry)) and not is_inf(float(retry)) and float(retry) > 0.0:
		out.retry_after_seconds = int(minf(ceilf(float(retry)), float(retry_cap)))
	else:
		var header = r.detail["headers"].get("retry-after") if r.detail["headers"] is Dictionary else null
		if header is String and (header as String).strip_edges().is_valid_int() and int((header as String).strip_edges()) > 0:
			out.retry_after_seconds = mini(int((header as String).strip_edges()), retry_cap)
	var view = b.get("view")
	if view is Dictionary and view.get("state") is String and view.get("choices") is Array:
		out.view = view
	if b.get("manageUrl") is String and _card_url_ok(b["manageUrl"]):
		out.manage_url = b["manageUrl"]
	return out
