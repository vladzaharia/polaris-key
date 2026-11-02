class_name PKeyIdentityLink
extends RefCounted
## `PolarisKey.identity.link` (identity.link; WIRE-CONTRACT-V5 section 12.11.4): the link offer. After a
## sign-in the person started on this device through the browser (a redirect, native or not), the app can
## offer to add the platform identity (Google, Apple, Game Center, Play Games) an exchange found no
## account for. The port of Swift `Link.swift`.
##
##   if PolarisKey.identity.link.pending:
##       var offer := await PolarisKey.identity.link.offer()        # kind &"offer": offer.kinds
##       ...show the choice...
##       var r := await PolarisKey.identity.link.accept()           # the held handle, else one provider prompt
##       match r.kind:
##           &"linked": ...                  # r.linked_kind, r.reach
##           &"refused": ...                 # r.code: step_up_required (sign in again, ask again),
##                                           #   link_conflict, invalid_grant, not_found
##           &"unavailable": ...
##   PolarisKey.identity.link.decline()      # not again for this account on this device
##
## Rules:
##  - offer() and accept() answer `unavailable`, with no request, until a sign-in this device started has
##    completed with a subject, and after the account's decline. A device-code, exchange, nearby or restore
##    sign-in never opens the offer.
##  - The handle an exchange left (`link_handle` of a `needs_sign_in`) is held in memory for its lifetime and
##    spent by the attempt that uses it, except by a stale step-up, which leaves it.
##  - The proof is `pkey-proof/1` with purpose `link`, signed through the device key port. The handle, the
##    provider token and the proof never reach a log, a description or an error.
##  - The device token goes only to the route discovery names on this product's origin.
##  - A decline is `sha256(issuer || sub)` in a sealed record of its own (PKeyLinkDeclinedStore): the hash
##    only, never the identity.
##
## Not instantiated by a game: PKeyIdentity owns one.

const KINDS := ["google", "apple", "gamecenter", "pgs"]
const REFUSALS := [
	PKeyConstants.ErrorCode.STEP_UP_REQUIRED, PKeyConstants.ErrorCode.LINK_CONFLICT,
	PKeyConstants.ErrorCode.INVALID_GRANT, PKeyConstants.ErrorCode.NOT_FOUND,
]

static var _handle_re: RegEx

## Where the decline record rests. Null: none is kept (every decline lives only until the process ends).
var store: PKeyLinkDeclinedStore = null
## True after a sign-in this device started, until the person answers, dismisses or signs out.
var pending: bool:
	get:
		return _pending_for != null

var _identity_ref: WeakRef = null
## The subject the offer belongs to; null when no offer is open.
var _pending_for: Variant = null
var _handle := ""
var _handle_expires_at := 0
## Grants a redirect left pending a licence choice; completing one opens the offer.
var _choice_grants: Dictionary = {}
## The kinds the last offer() named, for choosing the provider accept() asks.
var _last_kinds: Array = []
var _memory_declined: Array = []


static func _static_init() -> void:
	_handle_re = RegEx.create_from_string("\\Alh_[A-Za-z0-9_-]{43}\\z")


func _init(identity: PKeyIdentity) -> void:
	_identity_ref = weakref(identity)


func _identity() -> PKeyIdentity:
	return _identity_ref.get_ref() as PKeyIdentity if _identity_ref != null else null


# ── The app's calls ──────────────────────────────────────────────────────────────────────

## `GET link`: the kinds the account could add. A coroutine answering a PKeyLinkResult (kind `offer`,
## `unavailable`, `refused` or `failed`).
func offer() -> PKeyLinkResult:
	var ready = await _ready(false)
	if ready is PKeyLinkResult:
		return ready
	var sent = await _send("GET", ready)
	if sent is PKeyLinkResult:
		return sent
	if sent["status"] == 404:
		return PKeyLinkResult.unavailable()
	if sent["status"] != 200:
		return _failure(sent["status"], sent["body"])
	var rows = sent["body"].get("offer") if sent["body"] is Dictionary else null
	if not (rows is Array):
		return PKeyLinkResult.failed(PKeyErrors.INVALID_RESPONSE, "The link offer answered without an offer.")
	var kinds: Array = []
	for row in rows:
		if row is Dictionary and row.get("kind") is String and row["kind"] in KINDS:
			var reach = row.get("reach")
			kinds.append({"kind": row["kind"], "reach": reach if reach == "global" or reach == "developer" else null})
	_last_kinds = kinds.map(func(k): return k["kind"])
	return PKeyLinkResult.offer_of(kinds)


## `POST link`. With the handle the exchange left (or `link_handle`), no second provider prompt;
## otherwise the installed platform provider is asked once, over a fresh nonce. A coroutine answering a
## PKeyLinkResult (kind `linked`, `refused`, `unavailable` or `failed`).
func accept(link_handle := "") -> PKeyLinkResult:
	return await _accept(link_handle, "")


## Conformance replay only: `proof_value` replaces the value the proof covers.
func _accept(link_handle: String, proof_value: String) -> PKeyLinkResult:
	var ready = await _ready(true)
	if ready is PKeyLinkResult:
		return ready
	var url: String = ready
	var port: Object = _identity().device_keys
	if port == null or port.persistence() == "memory":
		return PKeyLinkResult.unavailable("The device keys do not outlive the process.")
	var explicit := link_handle if link_handle != "" else _held_handle()
	var result: PKeyLinkResult
	if explicit != "":
		result = await _post_handle(url, port, explicit, proof_value)
		# A handle that lapsed or was spent is no error for the person: the provider is asked in the same press.
		if link_handle == "" and result.kind == PKeyLinkResult.KIND_REFUSED \
				and result.code in [PKeyConstants.ErrorCode.INVALID_GRANT, PKeyConstants.ErrorCode.NOT_FOUND]:
			_handle = ""
			result = await _via_provider(url, port)
	else:
		result = await _via_provider(url, port)
	# Linking spends the handle and the step-up, so the next offer is empty (the Worker says so); the app
	# closes the offer with dismiss(). An identity another account holds spends them too. Every other
	# answer leaves things where they are: a stale step-up asks the person to sign in again.
	if result.kind == PKeyLinkResult.KIND_LINKED:
		_handle = ""
	elif result.kind == PKeyLinkResult.KIND_REFUSED and result.code == PKeyConstants.ErrorCode.LINK_CONFLICT:
		_handle = ""
		var key := _decline_key()
		if key != "":
			_remember(key)
	return result


## Not again for this account on this device: `sha256(issuer || sub)` is kept. With no known subject the
## offer is only closed. A coroutine.
func decline() -> void:
	var key := _decline_key()
	_close()
	if key != "":
		_remember(key)


## Close the offer for now without remembering a decline.
func dismiss() -> void:
	_close()


# ── What the sign-ins tell this offer ────────────────────────────────────────────────────

## A sign-in this device started has completed for `subject`: open the offer for its account. A completion
## that carries no subject opens nothing.
func _open(subject: String) -> void:
	if subject == "":
		return
	_pending_for = subject


## Hold the handle an exchange left, for its lifetime.
func _hold(handle: String, expires_at: int) -> void:
	_handle = handle
	_handle_expires_at = expires_at


func _choice_pending(grant: String) -> void:
	_choice_grants[grant] = true


## A licence choice completed: it opens the offer when its redirect started on this device.
func _choice_completed(grant: String, subject: String) -> void:
	if _choice_grants.erase(grant):
		_open(subject)


## The offer is answered, dismissed or not this account's: nothing is held for it.
func _close() -> void:
	_pending_for = null
	_handle = ""
	_handle_expires_at = 0
	_last_kinds = []


## Forget everything (sign-out, a new binding).
func _reset() -> void:
	_close()
	_choice_grants.clear()


func _held_handle() -> String:
	var core := _identity()._core()
	if _handle == "" or core == null or core.clock.system_now() >= _handle_expires_at:
		_handle = ""
	return _handle


# ── Readiness and routes ─────────────────────────────────────────────────────────────────

## The link route when an offer may be made now, else the PKeyLinkResult that ends the call: no open offer,
## the offer belongs to another account, the person declined it, the product serves none, or no device
## token is held. Nothing is sent for any of these.
func _ready(declined_allowed: bool) -> Variant:
	var identity := _identity()
	var core := identity._core() if identity != null else null
	if core == null or not core.started:
		return PKeyLinkResult.failed(PKeyErrors.NOT_CONFIGURED, "Call configure() and start() first.")
	var closed := _closed_reason(core, declined_allowed)
	if closed != null:
		return closed
	if core.discovery_manifest == null:
		await core.discover()
	var route: String = PKeyDiscovery.identity_from(core.discovery_manifest).get("link", "")
	# The pending state may have been closed or replaced while discovery ran.
	if _pending_for == null or not core.enabled("identity") or route == "":
		return PKeyLinkResult.unavailable()
	if not identity._own(route):
		return PKeyLinkResult.failed(PKeyErrors.INVALID_RESPONSE, "An identity endpoint points outside this product.")
	return route


## null when this device's state allows an offer, else the unavailable result.
func _closed_reason(core: PKeyCore, declined_allowed: bool) -> PKeyLinkResult:
	if _pending_for == null:
		return PKeyLinkResult.unavailable()
	if core.cache.subject != "" and core.cache.subject != String(_pending_for):
		_close()
		return PKeyLinkResult.unavailable()
	if not core.tokens.has_token():
		return PKeyLinkResult.unavailable()
	if not declined_allowed:
		var key := _decline_key()
		if key != "" and _declined(key):
			return PKeyLinkResult.unavailable()
	return null


## The request with the device token as the bearer (the route is on this product; see _ready). A
## PKeyLinkResult when the call ended, else {status, body}.
func _send(method: String, url: String, body: Variant = null) -> Variant:
	var core := _identity()._core()
	var h := core.headers({"Authorization": "Bearer %s" % core.tokens.current()})
	var bytes := PackedByteArray()
	if body is Dictionary:
		bytes = PKeyJson.stringify(body).to_utf8_buffer()
		h["Content-Type"] = "application/json"
	var r := await core.transport.request(method, url, h, bytes)
	if not r.ok:
		return PKeyLinkResult.failed(r.code if r.code == PKeyErrors.LOCAL_ONLY else PKeyErrors.NETWORK, "The link request failed.")
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	return {"status": int(r.detail["status"]), "body": parsed["value"] if parsed["ok"] else null}


func _post_handle(url: String, port: Object, handle: String, proof_value: String) -> PKeyLinkResult:
	if _handle_re.search(handle) == null:
		return PKeyLinkResult.refused(PKeyConstants.ErrorCode.NOT_FOUND, 404)
	var proof := _proof(port, proof_value if proof_value != "" else handle, "-")
	if proof is PKeyLinkResult:
		return proof
	return await _post(url, {"linkHandle": handle, "proof": proof})


func _via_provider(url: String, port: Object) -> PKeyLinkResult:
	var provider = _provider()
	if provider == null:
		return PKeyLinkResult.unavailable("No platform sign-in is installed.")
	var got = await _platform_token(provider)
	if got is PKeyLinkResult:
		return got
	var keys: PKeyResult = port.ensure()
	if not keys.ok:
		return PKeyLinkResult.unavailable("The device keys could not be read.")
	var sign_key: String = keys.detail["sign_key"]
	var proof := _proof(port, "%s.%s" % [got["nonce"], sign_key], PKeyB64Url.encode(String(got["token"]).sha256_buffer()))
	if proof is PKeyLinkResult:
		return proof
	return await _post(url, {
		"subjectToken": got["token"], "subjectTokenType": PKeyIdentityExchange.TOKEN_TYPES[provider.kind], "nonce": got["nonce"],
		"signKey": sign_key, "agreeKey": keys.detail["agree_key"], "proof": proof,
	})


## {token, nonce}: a fresh nonce and the platform's token over it, or the unavailable result.
func _platform_token(provider: Object) -> Variant:
	var identity := _identity()
	var kind: String = provider.kind
	var routes = await identity.exchange._ready(kind)
	if routes is PKeyExchangeResult:
		return PKeyLinkResult.unavailable()
	var fetched := await identity.exchange._fetch_nonce(routes)
	if fetched.kind != PKeyExchangeResult.KIND_NONCE:
		return PKeyLinkResult.unavailable()
	var fragment := PKeyDiscovery.identity_from(identity._core().discovery_manifest)
	var audience := String(fragment.get("exchange", {}).get("%s_server_client_id" % kind, ""))
	var answer: Variant = await provider.provider_row(fetched.nonce, audience) if provider.has_method("provider_row") else await provider.sheet(fetched.nonce, audience)
	if not (answer is Dictionary) or not (answer.get("token") is String) or answer["token"] == "":
		return PKeyLinkResult.unavailable("The platform gave no token.")
	return {"token": answer["token"], "nonce": fetched.nonce}


## The provider accept() asks: one whose kind the last offer named, else the first installed.
func _provider() -> Variant:
	var all := _identity().platform_providers()
	for p in all:
		if p.get("kind") in _last_kinds and p.get("kind") in KINDS:
			return p
	for p in all:
		if p.get("kind") in KINDS:
			return p
	return null


## The proof signature (base64url), or the PKeyLinkResult that ends the call.
func _proof(port: Object, value: String, token_hash: String) -> Variant:
	var core := _identity()._core()
	var signed := PKeyDeviceKeys.sign_device_proof(port, {
		"purpose": "link", "product": core.product, "device_id": core.device_id, "value": value, "token_hash": token_hash,
	})
	if not signed.ok:
		return PKeyLinkResult.failed(PKeyErrors.SIGN_IN_FAILED, "The device proof could not be signed.")
	return signed.detail["sig"]


func _post(url: String, body: Dictionary) -> PKeyLinkResult:
	var sent = await _send("POST", url, body)
	if sent is PKeyLinkResult:
		return sent
	var status: int = sent["status"]
	var b: Dictionary = sent["body"] if sent["body"] is Dictionary else {}
	if status == 200:
		var linked = b.get("linked")
		if not (linked is Dictionary) or not (linked.get("kind") is String) or not (linked["kind"] in KINDS):
			return PKeyLinkResult.failed(PKeyErrors.INVALID_RESPONSE, "The link answered without a link.")
		return PKeyLinkResult.linked(linked["kind"], linked.get("reach") if linked.get("reach") is String else null)
	var error = b.get("error")
	var code = error.get("code") if error is Dictionary else error
	if status < 500 and code is String and code in REFUSALS:
		return PKeyLinkResult.refused(StringName(code), status)
	return _failure(status, b)


## A refusal that is not one of the link's own: the code and the status only.
func _failure(status: int, body: Variant) -> PKeyLinkResult:
	if status >= 500:
		return PKeyLinkResult.failed(PKeyErrors.SERVER_ERROR, "The link route failed with status %d." % status, status)
	var b: Dictionary = body if body is Dictionary else {}
	var error = b.get("error")
	var code = error.get("code") if error is Dictionary else error
	var named: StringName = StringName(code) if code is String and code != "" else StringName("http_%d" % status)
	return PKeyLinkResult.failed(named, "The link route refused the request (status %d)." % status, status)


# ── The decline record ───────────────────────────────────────────────────────────────────

## `sha256(issuer || sub)`, base64url; "" while the subject is unknown.
func _decline_key() -> String:
	var core := _identity()._core()
	if core == null:
		return ""
	# The account the open offer belongs to, else the one signed in.
	var sub: String = String(_pending_for) if _pending_for != null else core.cache.subject
	if sub == "":
		return ""
	var fragment := PKeyDiscovery.identity_from(core.discovery_manifest)
	var issuer: String = fragment.get("issuer", "")
	if issuer == "":
		issuer = core.url("identity")
	return PKeyB64Url.encode((issuer + sub).sha256_buffer())


func _declined(key: String) -> bool:
	if key in _memory_declined:
		return true
	return store != null and store.is_declined(key)


func _remember(key: String) -> void:
	if not (key in _memory_declined):
		_memory_declined.append(key)
		if _memory_declined.size() > PKeyLinkDeclinedStore.CAP:
			_memory_declined.pop_front()
	if store != null:
		store.remember(key)


func _to_string() -> String:
	return "PKeyIdentityLink(pending=%s)" % pending
