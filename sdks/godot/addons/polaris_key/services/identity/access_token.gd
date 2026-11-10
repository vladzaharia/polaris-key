class_name PKeyIdentityAccessToken
extends RefCounted
## `PolarisKey.identity.access_token()` (identity.accesstoken, D6, WIRE-CONTRACT-V5 §12.13.10): the
## app's own short-lived access token for its own backend, from its device token (the RFC 8693
## exchange). The port of client-core's `identityAccessToken.ts` and Node's `identity/accessToken.ts`.
##
##   var r := await PolarisKey.identity.access_token()
##   if r.ok:
##       send(r.detail["access_token"])   # Authorization: Bearer <it>, to YOUR backend
##
## WHAT IT PROVES: this device holds a sign-in (`sub` is the device's pairwise subject, `client_id` the
## product). It is NOT a licence check: it carries no tier and no entitlement, and a signed-in device
## has one whether or not it holds a valid licence. A backend that sells a licensed feature checks the
## licence as well (the server drop-ins). The SDK never verifies the token: its backend does.
##
## Rules:
##  - Discovery gates it: only a product whose identity fragment carries `accessToken: true` and a
##    `token` endpoint is asked; otherwise `service-unavailable` (detail.kind "unavailable") and
##    nothing is sent. So is an endpoint outside the Worker's own origin (the device token is in the body).
##  - No device token is `no-token`, before the cache.
##  - The token lives in memory only: never stored, never logged. It is bound to the device token it
##    was asked with (a held token and an exchange in flight both carry it; another token is a miss and
##    never joins; a late answer for an old token is not kept), reused until 60 seconds before it
##    expires, and asked for once at a time. A failure is not cached.
##  - After a 429 with a wait, that wait is remembered per device token: until it passes the call
##    fails with `rate_limited` and sends nothing (`refresh` included).
##  - No redirect is followed; an `access_token` over 8 KiB is `bad_response`.
##  - Dropped at sign-out.
##
## ok: detail {access_token, token_type: "Bearer", expires_in (seconds left when handed out; 600 when
## fresh), expires_at (epoch seconds, by the SDK's clock)}. Failures keep the Worker's code
## (`invalid_grant`, `invalid_request`, `rate_limited` with detail.retry_after_seconds) with detail.status.
##
## Not instantiated by a game: PKeyIdentity owns one.

## §12.13.10 rule 4: a held token is reused until this many seconds before it expires.
const REUSE_MARGIN_SECONDS := 60
## The longest `access_token` accepted.
const MAX_LENGTH := 8192
## A 200 is a token of at most 8 KiB in a small object; a larger body is read no further.
const BODY_LIMIT := 16384
const GRANT_TYPE := "urn:ietf:params:oauth:grant-type:token-exchange"
const SUBJECT_TOKEN_TYPE := "urn:polaris-key:token-type:device"
const ACCESS_TOKEN_TYPE := "urn:ietf:params:oauth:token-type:access_token"

static var _jws_re: RegEx

var _identity_ref: WeakRef = null
## {key, access_token, expires_at}: the held token and the device token it is for.
var _held: Dictionary = {}
var _pending: Flight = null
## {key, until}: a 429's wait, per device token.
var _limited: Dictionary = {}


## One exchange in flight: the callers that share it wait on `finished`.
class Flight:
	extends RefCounted
	signal finished
	var key := ""
	var result: PKeyResult = null


static func _static_init() -> void:
	_jws_re = RegEx.create_from_string("\\A[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\z")


func _init(identity: PKeyIdentity) -> void:
	_identity_ref = weakref(identity)


func _identity() -> PKeyIdentity:
	return _identity_ref.get_ref() as PKeyIdentity if _identity_ref != null else null


## Drop the held token, the rate-limit wait and any exchange in flight (sign-out, a new binding).
func clear() -> void:
	_held = {}
	_pending = null
	_limited = {}


## See the file header. `refresh` skips the held token (an app whose backend refused it); it still
## joins an exchange in flight. A coroutine.
func get_token(refresh := false) -> PKeyResult:
	var identity := _identity()
	var core: PKeyCore = identity._core() if identity != null else null
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	var gate: Variant = await _gate(core)
	if gate is PKeyResult:
		return gate
	var endpoint: String = gate
	# The cache is bound to this token: another sign-in or a replaced token is a different key.
	var key := core.tokens.current()
	var t := core.clock.now()
	if not refresh and not _held.is_empty() and _held["key"] == key and float(_held["expires_at"]) - REUSE_MARGIN_SECONDS > t:
		return PKeyResult.success(_shape(_held["access_token"], float(_held["expires_at"]) - t, _held["expires_at"]))
	if _pending != null and _pending.key == key:
		var joined := _pending
		await joined.finished
		return joined.result
	if not _limited.is_empty() and _limited["key"] == key:
		if float(_limited["until"]) > t:
			var left := int(ceil(float(_limited["until"]) - t))
			return PKeyResult.failure(PKeyErrors.RATE_LIMITED, "The access token exchange is rate limited; wait before asking again.", {"status": 429, "retry_after_seconds": left})
		_limited = {}
	var flight := Flight.new()
	flight.key = key
	_pending = flight
	var result := await _exchange(core, endpoint, key, flight)
	if _pending == flight:
		_pending = null
	flight.result = result
	flight.finished.emit()
	return result


## The token endpoint, or the failure that ends the call before any request: discovery's gate, no device token
## (before the cache), an endpoint outside the Worker's own origin (the device token is in the body).
func _gate(core: PKeyCore) -> Variant:
	if core.discovery_manifest == null:
		await core.discover()
	var fragment := PKeyDiscovery.identity_from(core.discovery_manifest)
	var endpoint: String = fragment.get("token", "")
	if not PKeyClaims.is_true(fragment.get("access_token")) or endpoint == "":
		return _unavailable("this product's discovery names no access token exchange: its sign-in issuer is not served")
	if not core.tokens.has_token():
		return PKeyResult.failure(PKeyErrors.NO_TOKEN, "Sign in before asking for an access token.")
	var u := PKeyTransport.parse_url(endpoint)
	var base := PKeyTransport.parse_url(core.base_url)
	if u.is_empty() or base.is_empty() or u["origin"] != base["origin"]:
		return _unavailable("this product's discovery names an access token exchange outside its own origin")
	return endpoint


static func _unavailable(detail: String) -> PKeyResult:
	var d := PKeyResult.product_detail(PKeyConstants.Feature.IDENTITY_ACCESSTOKEN, "identity")
	d["kind"] = "unavailable"
	d["detail"] = detail
	return PKeyResult.failure(PKeyErrors.SERVICE_UNAVAILABLE, "The access token exchange is not available for this product.", d)


static func _shape(token: String, expires_in: float, expires_at: Variant) -> Dictionary:
	return {"access_token": token, "token_type": "Bearer", "expires_in": int(expires_in), "expires_at": int(expires_at)}


## POST the exchange; on a 200 keep the token only while `flight` is still the client's exchange.
func _exchange(core: PKeyCore, endpoint: String, key: String, flight: Flight) -> PKeyResult:
	var form := _form(core.product, key)
	var h := core.headers({"Content-Type": PKeyIdentityRedirect.TOKEN_CONTENT_TYPE})
	var r := await core.transport.request("POST", endpoint, h, form.to_utf8_buffer(), {"follow_redirects": false, "body_limit": BODY_LIMIT})
	if not r.ok:
		if r.code == PKeyErrors.RESPONSE_TOO_LARGE:
			return PKeyResult.failure(StringName(PKeyConstants.ErrorCode.BAD_RESPONSE), "The access token exchange answered more than a token can be.")
		return PKeyResult.failure(r.code if r.code == PKeyErrors.LOCAL_ONLY else PKeyErrors.NETWORK, r.message)
	var status := int(r.detail.get("status", 0))
	if status != 200:
		var failed := _failure(r, status)
		var wait = failed.detail.get("retry_after_seconds") if failed.detail is Dictionary else null
		if _pending == flight and failed.code == PKeyErrors.RATE_LIMITED and wait is int and wait > 0:
			_limited = {"key": key, "until": core.clock.now() + float(wait)}
		return failed
	var grant := _read(r.detail["body"])
	if grant.is_empty():
		return PKeyResult.failure(StringName(PKeyConstants.ErrorCode.BAD_RESPONSE), "The access token exchange answered without a usable access token.")
	var at := core.clock.now()
	var expires_at := at + float(grant["expires_in"])
	# Kept only while this is still the client's exchange: a clear() or a caller with another key took it over.
	if _pending == flight:
		_held = {"key": key, "access_token": grant["access_token"], "expires_at": expires_at}
	return PKeyResult.success(_shape(grant["access_token"], float(grant["expires_in"]), expires_at))


## The form body. Member order is fixed so every SDK sends the same bytes.
static func _form(client_id: String, device_token: String) -> String:
	var pairs: Array = [
		["grant_type", GRANT_TYPE],
		["client_id", client_id],
		["subject_token", device_token],
		["subject_token_type", SUBJECT_TOKEN_TYPE],
		["requested_token_type", ACCESS_TOKEN_TYPE],
	]
	var parts := PackedStringArray()
	for p in pairs:
		parts.append("%s=%s" % [PKeyIdentityRedirect.form_encode(p[0]), PKeyIdentityRedirect.form_encode(p[1])])
	return "&".join(parts)


## A non-200 as a failure: a redirect is never followed (`network-error`), a 5xx is `server-error`, any other
## keeps the wire code (flat `{error: code}` or nested `{error: {code}}`) with detail {status, retry_after_seconds?}.
static func _failure(r: PKeyResult, status: int) -> PKeyResult:
	if status >= 300 and status < 400:
		return PKeyResult.failure(PKeyErrors.NETWORK, "The access token exchange was redirected; it is never followed.", {"status": status})
	if status >= 500:
		return PKeyResult.failure(PKeyErrors.SERVER_ERROR, "The access token exchange failed with status %d." % status, {"status": status})
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var b: Dictionary = parsed["value"] if parsed["ok"] and parsed["value"] is Dictionary else {}
	var error = b.get("error")
	var code = error.get("code") if error is Dictionary else error
	var detail := {"status": status}
	# The wait is in the body when no `Retry-After` header came with it (the recorded 429 has the body's only).
	var retry = b.get("retryAfter")
	if PKeyClaims.is_number(retry) and not is_nan(float(retry)) and not is_inf(float(retry)) and float(retry) > 0.0:
		detail["retry_after_seconds"] = int(minf(ceilf(float(retry)), 3600.0))
	else:
		var header = r.detail["headers"].get("retry-after") if r.detail["headers"] is Dictionary else null
		if header is String and (header as String).strip_edges().is_valid_int() and int((header as String).strip_edges()) > 0:
			detail["retry_after_seconds"] = mini(int((header as String).strip_edges()), 3600)
	var wire := StringName(code) if code is String and code != "" else StringName("http_%d" % status)
	return PKeyResult.failure(wire, "The access token exchange was refused (%s)." % wire, detail)


## A `200` answer: exactly an `access_token` (a compact JWS of at most 8 KiB), `issued_token_type` the access-token
## type, `token_type` `Bearer` and a positive integer `expires_in`; {} for anything else. Nothing is verified.
static func _read(body: PackedByteArray) -> Dictionary:
	var parsed := PKeyJson.parse_bytes(body)
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return {}
	var b: Dictionary = parsed["value"]
	var token = b.get("access_token")
	var expires_in = b.get("expires_in")
	if not (token is String) or (token as String).length() > MAX_LENGTH or _jws_re.search(token) == null:
		return {}
	if b.get("issued_token_type") != ACCESS_TOKEN_TYPE or b.get("token_type") != "Bearer":
		return {}
	if not PKeyClaims.is_number(expires_in) or is_nan(float(expires_in)) or is_inf(float(expires_in)) or float(expires_in) <= 0.0 or float(expires_in) != floorf(float(expires_in)):
		return {}
	return {"access_token": token, "expires_in": int(expires_in)}
