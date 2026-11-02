class_name PKeyIdentityNearbyRoutes
extends RefCounted
## The nearby approval routes for the new device D (WIRE-CONTRACT-V5 section 12.11.5): `nearby/start` and
## `nearby/poll`. The LAN half (adverts, the code, `VOUCH_REQ`) is Cloud Connect's (`cloud_connect.nearby`),
## and the session that joins the two is PKeyNearbySignIn. Ported from sdk-node `identity/nearby.ts`
## (reference: Swift `NearbyRoutes.swift`).
##
## What this file keeps:
##  - an endpoint is used only when discovery names it and it lies inside the product; a product whose
##    discovery names none answers the typed `service-unavailable` N/A before any request;
##  - every route carries a `pkey-proof/1` proof (section 12.11.1) signed through the device key port, so a
##    private key never leaves it. `start`: value `<signKey>.<agreeKey>`; `poll`: the request handle. Line 6
##    is `-`;
##  - D's `poll` is signed by the key D sent on `start`: the handle remembers that `signKey`, and a poll after
##    the device's keys changed is refused locally rather than sent;
##  - `start` sends D's bearer when D holds a credential, and never invents one; `poll` sends none;
##  - `poll` answers the token once. It is held UNCONFIRMED (PKeyTokenManager.set_unconfirmed_token): no
##    sign-in, no stored subject and no `signedIn` event until the person confirms the account. The previous
##    person is no longer the stored subject under it;
##  - a 404 of `poll` is the same bytes whether the request is unknown or the routes went away (N11): it reads
##    as `unavailable` only after a fresh discovery read no longer names nearby approval;
##  - the request handle, the proofs and the token are in no `str()`, log or error message.

const LONGEST_RETRY := 60

static var _request_re: RegEx


## Conformance replay only: a proof by another key or over another value. `func(port, purpose, device_id,
## value) -> String` (the signature) or "" when it could not sign.
var proof_signer: Callable = Callable()

var _identity_ref: WeakRef = null


## `nearby/start`'s answer. `request` is a secret: it prints as nothing.
class Started extends RefCounted:
	## The request handle (`nr_...`): give it to the LAN request and nothing else.
	var request := ""
	## Seconds the request lives (300).
	var expires_in := 0
	## Seconds between polls (3).
	var interval := 0
	## The signing key D sent: `poll` is signed by it, or not sent.
	var sign_key := ""

	func _to_string() -> String:
		return "PKeyNearbyStarted(expires_in=%d, interval=%d)" % [expires_in, interval]


static func _static_init() -> void:
	_request_re = PKeyClaims.whole("nr_[A-Za-z0-9_-]{22}")


func _init(identity: PKeyIdentity) -> void:
	_identity_ref = weakref(identity)


func _to_string() -> String:
	return "PKeyIdentityNearbyRoutes()"


func _identity() -> PKeyIdentity:
	return _identity_ref.get_ref() as PKeyIdentity if _identity_ref != null else null


func _core() -> PKeyCore:
	var identity := _identity()
	return identity._core() if identity != null else null


static func unavailable(detail: String) -> PKeyResult:
	var r := PKeyResult.failure(PKeyErrors.SERVICE_UNAVAILABLE, "Nearby sign-in is not available here.")
	r.detail = {"feature": PKeyConstants.Feature.IDENTITY_NEARBY, "reason": PKeyConstants.UnsupportedReason.PRODUCT, "detail": detail}
	return r


## The endpoint discovery names (read again first when `fresh`), else the typed N/A. Nothing is sent before this
## answers. ok with the URL as detail.
func endpoint(name: String, fresh := false) -> PKeyResult:
	var core := _core()
	if core == null or not core.started:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	if fresh or core.discovery_manifest == null:
		await core.discover()
	var off: Variant = core.require_service("identity", PKeyConstants.Feature.IDENTITY_NEARBY)
	if off is PKeyResult:
		return off
	var fragment := PKeyDiscovery.identity_from(core.discovery_manifest)
	var url: String = String(fragment.get("endpoints", {}).get(name, ""))
	if fragment.is_empty() or not fragment.get("nearby", false) or url == "":
		return unavailable("this product's discovery does not name nearby approval")
	# The device's headers and proof go nowhere but this product.
	if not _identity()._own(url):
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "An identity endpoint points outside this product.")
	return PKeyResult.success(url)


func _proof(port: Object, purpose: String, device_id: String, value: String) -> PKeyResult:
	if proof_signer.is_valid():
		var sig := String(proof_signer.call(port, purpose, device_id, value))
		if sig == "":
			return PKeyResult.failure(PKeyErrors.SIGN_IN_FAILED, "This device could not sign the nearby sign-in proof.")
		return PKeyResult.success(sig)
	var signed := PKeyDeviceKeys.sign_device_proof(port, {"purpose": purpose, "product": _core().product, "device_id": device_id, "value": value})
	if not signed.ok:
		return PKeyResult.failure(PKeyErrors.SIGN_IN_FAILED, "This device could not sign the nearby sign-in proof.")
	return PKeyResult.success(signed.detail["sig"])


## D's device keys and its device id, or the failure. ok with {port, device_id}.
func _signer() -> PKeyResult:
	var identity := _identity()
	var core := _core()
	var port: Object = identity.device_keys
	if port == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Nearby sign-in has no device keys.")
	return PKeyResult.success({"port": port, "device_id": core.device_id})


## The Worker's error code of a refusal: the nested `{error:{code}}` or a flat `{error}`, else the registry
## code of the status.
static func refusal_code(status: int, body: Variant) -> String:
	if body is Dictionary:
		var e: Variant = (body as Dictionary).get("error")
		if e is Dictionary and (e as Dictionary).get("code") is String and (e as Dictionary)["code"] != "":
			return (e as Dictionary)["code"]
		if e is String and e != "":
			return e
	if status == 429:
		return PKeyConstants.ErrorCode.RATE_LIMITED
	if status >= 500:
		return PKeyConstants.ErrorCode.SERVER_ERROR
	match status:
		404:
			return PKeyConstants.ErrorCode.NOT_FOUND
		403:
			return PKeyConstants.ErrorCode.FORBIDDEN
		401:
			return PKeyConstants.ErrorCode.UNAUTHORIZED
		400:
			return PKeyConstants.ErrorCode.BAD_REQUEST
	return PKeyConstants.ErrorCode.HTTP_ERROR


static func _failure(r: PKeyResult) -> PKeyResult:
	return PKeyResult.failure(r.code if r.code == PKeyErrors.LOCAL_ONLY else PKeyErrors.NETWORK, "Nearby sign-in could not reach the Worker.")


static func _whole_seconds(v: Variant) -> int:
	if not PKeyClaims.is_number(v) or is_nan(float(v)) or is_inf(float(v)) or float(v) <= 0.0:
		return 0
	return int(ceil(float(v)))


## `POST nearby/start`: D asks to be approved, sending its two public keys. ok with a Started, or the typed N/A
## when discovery names no nearby approval or the route is off (`404`), and a failure carrying the Worker's
## code and `detail.status` for a refusal (`invalid_grant`, `device_keys_invalid`, `rate_limited`, ...).
## A coroutine.
func start(device_name := "") -> PKeyResult:
	var prepared := await _start_request(device_name)
	if not prepared.ok:
		return prepared
	var core := _core()
	var p: Dictionary = prepared.detail
	var sent := await core.transport.request("POST", p["url"], p["headers"], PKeyJson.stringify(p["body"]).to_utf8_buffer())
	return _start_answer(sent, p["sign_key"])


## The request `start` sends: ok with {url, headers, body, sign_key}, or the first thing that stops it.
func _start_request(device_name: String) -> PKeyResult:
	var core := _core()
	var url_r := await endpoint("nearbyStart")
	if not url_r.ok:
		return url_r
	var poll_r := await endpoint("nearbyPoll")
	if not poll_r.ok:
		return poll_r
	var who := _signer()
	if not who.ok:
		return who
	var port: Object = who.detail["port"]
	var keys: PKeyResult = port.ensure()
	if not keys.ok:
		return PKeyResult.failure(PKeyErrors.SIGN_IN_FAILED, "This device has no keys to sign in with.")
	var sign_key: String = keys.detail["sign_key"]
	var agree_key: String = keys.detail["agree_key"]
	var body := {"signKey": sign_key, "agreeKey": agree_key}
	# Section 12.7.1: the per-call name, else the client's, else the platform default; "" sends none.
	var label := PKeyDeviceLabel.resolve(device_name, core.options)
	if label != "":
		body["deviceName"] = label
	var proof := _proof(port, "nearby-start", who.detail["device_id"], "%s.%s" % [sign_key, agree_key])
	if not proof.ok:
		return proof
	body["proof"] = proof.detail
	# A device id that already holds a credential proves it by that bearer; none is ever invented.
	var headers := core.headers({"Content-Type": "application/json"})
	if core.tokens.has_token():
		headers["Authorization"] = "Bearer %s" % core.tokens.current()
	return PKeyResult.success({"url": url_r.detail, "headers": headers, "body": body, "sign_key": sign_key})


## `start`'s answer as a Started, the typed N/A or the refusal.
func _start_answer(sent: PKeyResult, sign_key: String) -> PKeyResult:
	if not sent.ok:
		return _failure(sent)
	var status: int = sent.detail["status"]
	# The gate is off (the Worker rolled back after our discovery): start has no other 404.
	if status == 404:
		return unavailable("this product does not serve nearby approval")
	var parsed := PKeyJson.parse_bytes(sent.detail["body"])
	var answer: Variant = parsed["value"] if parsed["ok"] else null
	if status != 201:
		var refused := PKeyResult.failure(StringName(refusal_code(status, answer)), "Nearby sign-in could not start.")
		refused.detail = {"status": status}
		return refused
	var members: Dictionary = answer if answer is Dictionary else {}
	var req: Variant = members.get("request")
	var expires := _whole_seconds(members.get("expiresIn"))
	var interval := _whole_seconds(members.get("interval"))
	if not PKeyClaims.matches_whole_re(_request_re, req) or expires == 0 or interval == 0:
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "Nearby start answered without a complete request.")
	var started := Started.new()
	started.request = req
	started.expires_in = expires
	started.interval = interval
	started.sign_key = sign_key
	return PKeyResult.success(started)


## `POST nearby/poll`: one poll of D's request, signed by the key D started it with. Answers a Dictionary with
## `kind`:
##   pending
##   slow-down {interval}
##   timeout
##   denied
##   unavailable                  the routes went away (a 404 after a fresh discovery lost `nearby`)
##   transient {retry_after}      no answer, or a 5xx: says nothing about the request; `retry_after` seconds
##                                (0 when the Worker named none)
##   superseded                   a ready answer arrived after the held token changed: nothing was stored
##   ready {token, subject, scope, license_id, identity}
##                                the token is held UNCONFIRMED (see above) and answered once
##   error {code, message, status} a refusal (status above 0) or a failure
## Pacing is the caller's. A coroutine.
func poll(started: Started) -> Dictionary:
	var prepared := await _poll_request(started)
	if not prepared.ok:
		return _error(prepared.code, prepared.message, 0, prepared.detail)
	var core := _core()
	var p: Dictionary = prepared.detail
	var held_at_start: String = core.tokens.current()
	var body := PKeyJson.stringify({"request": started.request, "proof": p["proof"]}).to_utf8_buffer()
	var sent := await core.transport.request("POST", p["url"], core.headers({"Content-Type": "application/json"}), body)
	return await _poll_answer(sent, started, held_at_start)


## The poll's endpoint and proof: ok with {url, proof}, or the first thing that stops it (the failure's detail is
## the typed N/A's when discovery names no routes).
func _poll_request(started: Started) -> PKeyResult:
	var url_r := await endpoint("nearbyPoll")
	if not url_r.ok:
		return url_r
	var who := _signer()
	if not who.ok:
		return who
	var port: Object = who.detail["port"]
	var keys: PKeyResult = port.public_keys()
	if not keys.ok or keys.detail == null or keys.detail["sign_key"] != started.sign_key:
		return PKeyResult.failure(PKeyErrors.SIGN_IN_FAILED, "This device's keys changed since nearby sign-in started.")
	var proof := _proof(port, "nearby-poll", who.detail["device_id"], started.request)
	if not proof.ok:
		return proof
	return PKeyResult.success({"url": url_r.detail, "proof": proof.detail})


## What the Worker's answer to a poll means.
func _poll_answer(sent: PKeyResult, started: Started, held_at_start: String) -> Dictionary:
	if not sent.ok:
		if sent.code == PKeyErrors.LOCAL_ONLY:
			return _error(PKeyErrors.LOCAL_ONLY, sent.message, 0)
		return {"kind": "transient", "retry_after": 0}
	var status: int = sent.detail["status"]
	if status == 404:
		return await _poll_not_found()
	var parsed := PKeyJson.parse_bytes(sent.detail["body"])
	var answer: Variant = parsed["value"] if parsed["ok"] else null
	var plain := _poll_plain(status, answer, sent, started)
	if not plain.is_empty():
		return plain
	return await _poll_body(answer, status, held_at_start)


## N11: a 404 is the same bytes whether the request is unknown or the routes went away.
func _poll_not_found() -> Dictionary:
	var again := await endpoint("nearbyPoll", true)
	if not again.ok and again.code == PKeyErrors.SERVICE_UNAVAILABLE:
		return {"kind": "unavailable"}
	return _error(PKeyConstants.ErrorCode.NOT_FOUND, "Nearby sign-in was not found.", 404)


## The answers that say nothing about the token: a 5xx, a 429, a refusal, a body that is no object. {} for a
## 200 object, which `_poll_body` reads.
func _poll_plain(status: int, answer: Variant, sent: PKeyResult, started: Started) -> Dictionary:
	if status >= 500:
		return {"kind": "transient", "retry_after": _retry_after(sent)}
	if status == 429:
		var n := _whole_seconds((answer as Dictionary).get("interval")) if answer is Dictionary else 0
		return {"kind": "slow-down", "interval": n if n > 0 else started.interval + 5}
	if status != 200:
		return _error(StringName(refusal_code(status, answer)), "Nearby sign-in was refused.", status)
	if not answer is Dictionary:
		return _error(PKeyErrors.INVALID_RESPONSE, "Nearby poll answered without a body.", status)
	return {}


## The seconds a 5xx asked to wait (`Retry-After`), at most LONGEST_RETRY; 0 when it named none.
static func _retry_after(sent: PKeyResult) -> int:
	var header: Variant = sent.detail["headers"].get("retry-after") if sent.detail["headers"] is Dictionary else null
	if header is String and (header as String).strip_edges().is_valid_int():
		return clampi(int((header as String).strip_edges()), 0, LONGEST_RETRY)
	return 0


## A 200 poll answer: pending, timeout, a denial or failure, or the token.
func _poll_body(answer: Dictionary, status: int, held_at_start: String) -> Dictionary:
	var state: Variant = answer.get("status")
	if state == "pending" or state == "timeout":
		return {"kind": state}
	if state == "error" and answer.get("reason") == "access_denied":
		return {"kind": "denied"}
	if state != null:
		return _error(PKeyErrors.SIGN_IN_FAILED, "Nearby sign-in failed.", status)
	return await _poll_token(answer, status, held_at_start)


## A poll answer that carries the token: held unconfirmed, answered once.
func _poll_token(answer: Dictionary, status: int, held_at_start: String) -> Dictionary:
	var core := _core()
	var token := PKeyIdentityRedirect.parse_token_answer(200, answer)
	if token["kind"] != "token" or not PKeyClaims.matches_whole(PKeyConstants.PAIRWISE_SUBJECT_PATTERN, token["subject"]):
		return _error(PKeyErrors.INVALID_RESPONSE, "Nearby poll answered without a complete sign-in.", status)
	# A late answer never replaces a newer token: the held one changed while this request was in flight.
	if core.tokens.current() != held_at_start:
		return {"kind": "superseded"}
	# Held unconfirmed (V5 section 15.6.1 rule 12): not a sign-in, no stored subject and no `signedIn` event
	# until the person confirms the account, so Cloud Sync and Connect do not start for an account nobody
	# accepted. A mark that cannot be written fails the poll and stores nothing.
	if not core.tokens.set_unconfirmed_token(token["access_token"]):
		return _error(PKeyErrors.SIGN_IN_FAILED, "Nearby sign-in could not store the sign-in.", status)
	# The previous person is no longer the stored subject under the new, unconfirmed token. No sync runs yet:
	# the account's licence is not the device's until the person confirms it.
	core.cache.set_subject("")
	var lic: Variant = token["license"]
	var license_id := ""
	if lic is Dictionary and (lic as Dictionary).get("id") is String:
		license_id = (lic as Dictionary)["id"]
	elif core.cache.license != null:
		license_id = String(core.cache.license["doc"].get("licenseId", ""))
	return {
		"kind": "ready", "token": token["access_token"], "subject": token["subject"], "scope": token["scope"],
		"license_id": license_id, "identity": PKeyIdentity._shown(lic),
	}


static func _error(code: Variant, message: String, status: int, detail: Variant = null) -> Dictionary:
	return {"kind": "error", "code": StringName(code), "message": message, "status": status, "detail": detail}
