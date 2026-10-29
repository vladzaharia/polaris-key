@tool
class_name PKeyConnectClient
extends RefCounted
## The Cloud Connect client side (CC-14.4; WIRE-CONTRACT-V5 sections 15.3, 15.4 and 15.7), ported
## from sdk-node `connect/client.ts` and Kotlin's `Connect.kt`: what the LAN and relay halves read
## of the held identity, the relay ticket, and the roster a peer pushes.
##
##   held()           the state record (a PKeyConnectState.Record), ok with null for none
##   current()        the held identity as a Dictionary, verified again now; null when none is held,
##                    it does not verify any more or its roster expired. Sends nothing, makes no keys
##   discovery_keys() {current, previous} as bytes, newest first; null when none is held or
##                    `keys_stale()`. The previous key is left out 24 hours after it was first seen
##   peer_source()    the snapshot the LAN and relay read (PeerSource), or a LAN failure
##                    (`no_identity`, `no_keys`). The device's static key stays in the key port
##   adopt_ring(jws)  store a roster a peer pushed (G11)
##   keys_stale()     a pushed roster removed a device, so K_disc was replaced at the Worker and the
##                    copy held is not used until a fetch brings the new one (G12)
##   relay_ticket()   `POST /<p>/connect/relay/ticket`: a single-use `pkeyrt_` ticket (G13)
##   hold(record)     store a record as the identity fetch (CC-14.1b) does; a record it writes has
##                    no `keys_stale`, which is how a successful refresh clears it
##   leave()          forget the record (sign-out); the device keys are untouched
##
## Every call here is synchronous except `relay_ticket`, and the state is touched by the main thread
## only, so no queue is needed (Node serialises its async file store). Results are PKeyResults;
## nothing here puts a ticket, K_disc, certificate or key in a result message, `str()` or log (G13,
## G19). `keys` is a key port with `public_keys()` and `dh(peer_public)` (PKeyDeviceKeyStore).

const RELAY_PROTOCOL := "pkey-relay.1"
## The Worker keeps the previous K_disc for 24 hours after a bump (section 15.4).
const PREV_DISC_KEY_SECONDS := 86400

static var _ticket_re: RegEx

## TEST ONLY: the origin a relay URL is checked against, when the Worker is a loopback fake whose
## replies name the recorded host. Empty: the SDK's own base URL.
var home_url := ""

var _core_ref: WeakRef
var _state: PKeyConnectState
var _keys: Object


static func _static_init() -> void:
	_ticket_re = PKeyClaims.whole("pkeyrt_[A-Za-z0-9_-]{32}")


func _init(core: PKeyCore, state: PKeyConnectState, keys: Object = null) -> void:
	_core_ref = weakref(core)
	_state = state
	_keys = keys


func _to_string() -> String:
	return "PKeyConnectClient"


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## Use these device keys from now on.
func use_device_keys(keys: Object) -> void:
	_keys = keys


# ── The held identity ────────────────────────────────────────────────────────────────────

## ok with the record of this product and device, ok with null for none (or one that belongs to
## another product or device), or the store's failure (a record that is unreadable).
func held() -> PKeyResult:
	var core := _core()
	var r := _state.read()
	if not r.ok or r.detail == null:
		return r
	var rec: PKeyConnectState.Record = r.detail
	if core == null or rec.product != core.product or rec.device_id != core.device_id:
		return PKeyResult.success(null)
	return r


## The held identity {sub, device_id, epoch, devices, certificate, certificate_expires_at, ring,
## ring_expires_at}, verified again now; null when there is none (see `held`).
func current() -> Variant:
	var h := held()
	if not h.ok or h.detail == null:
		return null
	var rec: PKeyConnectState.Record = h.detail
	var v := _verify_held(rec)
	if v["ring"] == null or v["cert"] == null or PKeyPeerCert.ring_expired(v["ring"], _now()):
		return null
	return _view(rec, v["ring"], v["cert"])


## True when a pushed roster removed a device and no identity fetch has succeeded since.
func keys_stale() -> bool:
	var h := held()
	return h.ok and h.detail != null and (h.detail as PKeyConnectState.Record).keys_stale


## K_disc as bytes for the advert code: {current, previous} (previous null when none is usable), or
## null when none is held. The previous key is left out once 24 hours have passed since it was first
## seen. After a pushed roster removed a device the Worker replaced K_disc; this copy is not used
## (not for adverts, not for browsing) until an identity fetch brings the new one.
func discovery_keys() -> Variant:
	var h := held()
	if not h.ok or h.detail == null:
		return null
	var rec: PKeyConnectState.Record = h.detail
	if rec.keys_stale:
		return null
	var current_key: Variant = PKeyB64Url.decode_strict(rec.disc_keys[0])
	if current_key == null:
		return null
	var previous: Variant = null
	if rec.disc_keys.size() == 2 and rec.prev_until >= 0 and _now() < rec.prev_until:
		previous = PKeyB64Url.decode_strict(rec.disc_keys[1])
	return {"current": current_key, "previous": previous}


## The held identity as one snapshot for the LAN and relay halves (PeerSource), or a LAN failure:
## `no_identity` when there is none, `no_keys` when K_disc or the device keys are not held. A
## record that cannot be read answers the store's own failure.
func peer_source() -> PKeyResult:
	var h := held()
	if not h.ok:
		return h
	var id: Variant = current()
	if id == null:
		return PKeyConnectErrors.lan("no_identity", "No Cloud Connect identity is held; call identity() first.")
	var disc: Variant = discovery_keys()
	var agree: Variant = _agree_public()
	var core := _core()
	if disc == null or agree == null or core == null:
		return PKeyConnectErrors.lan("no_keys", "The device keys or K_disc are not held.")
	var src := PeerSource.new()
	src.slug = core.product
	src.trust = core.trust.effective()
	src.sub = id["sub"]
	src.device_id = id["device_id"]
	src.certificate = id["certificate"]
	src.certificate_expires_at = id["certificate_expires_at"]
	src.ring = id["ring"]
	src.ring_epoch = id["epoch"]
	for d in id["devices"]:
		src.roster.append(d["device_id"])
	src.disc_current = disc["current"]
	src.disc_previous = disc["previous"] if disc["previous"] != null else PackedByteArray()
	src.agree_public = agree
	src.keys = _keys
	return PKeyResult.success(src)


func _agree_public() -> Variant:
	if _keys == null:
		return null
	var pub: PKeyResult = _keys.public_keys()
	if not pub.ok or not pub.detail is Dictionary:
		return null
	var agree: Variant = PKeyB64Url.decode_strict(String((pub.detail as Dictionary).get("agree_key", "")))
	return agree if agree is PackedByteArray and (agree as PackedByteArray).size() == 32 else null


## Store a record in place of the held one. The identity fetch (CC-14.1b) writes through this; a
## record without `keys_stale` is what ends a stale period.
func hold(rec: PKeyConnectState.Record) -> PKeyResult:
	return _state.write(rec)


## Forget the held roster, certificate and K_disc (sign-out, leaving the person's devices). The
## device keys are untouched, and so is the Worker's roster. Nothing held is nothing to forget. A
## record that cannot be deleted is a failure, so a sign-out stops.
func leave() -> PKeyResult:
	return _state.clear()


# ── A roster a peer pushed ────────────────────────────────────────────────────────────────

## Store a roster a peer pushed, under the identity fetch's rules (section 15.3): it must verify,
## be for the held subject, have a higher epoch than the held one, not be expired, and still list
## this device with the keys it registered. The certificate is kept; the next identity fetch
## brings the one that goes with the new epoch. A roster that drops a device sets `keys_stale`
## and drops the previous K_disc (G11). {stored = true, epoch} or {stored = false, reason}, the
## reason being `no_identity`, `held_unverified`, `other_subject`, `device_not_in_roster`,
## `state_unreadable`, `store_failed` or a replacement refusal of `PKeyPeerCert.replace_ring`.
func adopt_ring(jws: String) -> Dictionary:
	var core := _core()
	var h := held()
	if core == null or not h.ok:
		return {"stored": false, "reason": "state_unreadable"}
	if h.detail == null:
		return {"stored": false, "reason": "no_identity"}
	var rec: PKeyConnectState.Record = h.detail
	var judged := _judge_ring(core, rec, jws)
	if judged.has("reason"):
		return {"stored": false, "reason": judged["reason"]}
	var ring: Dictionary = judged["ring"]
	var prior: Variant = judged["prior"]
	var keys := rec.disc_keys
	var removed := false
	if prior != null:
		keys = keys_after_ring(rec.disc_keys, prior, ring)
		removed = not _intact(prior, ring)
	var next := rec.duplicate_record()
	next.keys_stale = removed or rec.keys_stale
	next.ring = jws
	next.epoch = int(ring["epoch"])
	next.disc_keys = keys
	next.prev_until = rec.prev_until if keys.size() == 2 else -1
	next.stored_at = _now()
	if not _state.write(next).ok:
		return {"stored": false, "reason": "store_failed"}
	return {"stored": true, "epoch": int(ring["epoch"])}


## The identity fetch's rules for a pushed roster: {ring, prior} (prior: the verified held roster or
## null) when it may replace the held one, else {reason}.
func _judge_ring(core: PKeyCore, rec: PKeyConnectState.Record, jws: String) -> Dictionary:
	var held_ok := _verify_held(rec)
	var prior: Variant = held_ok["ring"]
	var subject: Variant = null
	if prior != null:
		subject = prior["sub"]
	elif held_ok["cert"] != null:
		subject = held_ok["cert"]["sub"]
	if subject == null:
		return {"reason": "held_unverified"}
	var r := PKeyPeerCert.replace_ring(rec.ring, jws, core.trust.effective(), core.product, _now())
	if not r["replace"]:
		return {"reason": r["reason"]}
	var ring: Dictionary = r["ring"]
	if ring["sub"] != subject:
		return {"reason": "other_subject"}
	var mine := {"device_id": core.device_id, "sign_key": rec.registered_sign, "agree_key": rec.registered_agree}
	if rec.registered_sign == "" or rec.registered_agree == "" or not _lists(ring, mine):
		return {"reason": "device_not_in_roster"}
	return {"ring": ring, "prior": prior}


## Drops the previous K_disc when the new roster lost a device or changed a device's keys
## (section 15.4). `keys` is the held list, newest first.
static func keys_after_ring(keys: Array[String], prior: Dictionary, next: Dictionary) -> Array[String]:
	if keys.size() != 2 or _intact(prior, next):
		return keys
	return [keys[0]] as Array[String]


# ── The relay ticket ─────────────────────────────────────────────────────────────────────

## `POST /<p>/connect/relay/ticket`: a single-use `pkeyrt_` ticket for the WebSocket, a new one
## every call. ok with a Grant. Failures: relay `disabled`, `paused` (with `retry_after_seconds`),
## `quota` (with the `scope`) and `ticket_invalid` (also for an answer that is not in the contract
## shape or names another host), each with the HTTP `status`; `no-token`, the transport's own codes
## and the Worker's other refusals as the core reports them. A coroutine.
func relay_ticket() -> PKeyResult:
	# The Worker answers `device_keys_required` for a device without registered keys, and 404 when
	# the operator's launch gate is off; the identity fetch is what registers and checks discovery.
	var core := _core()
	if core == null:
		return PKeyConnectErrors.relay("unavailable", "The SDK is gone.")
	var r := await core.request("POST", "connect/relay/ticket", null, true)
	if not r.ok:
		return _ticket_refusal(r)
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	if not parsed["ok"]:
		return _ticket_invalid("The relay ticket answer is not in the contract shape.")
	return _grant(parsed["value"], r.detail.get("status", 200))


func _ticket_refusal(r: PKeyResult) -> PKeyResult:
	if not r.detail is Dictionary or not (r.detail as Dictionary).has("status"):
		return r
	var d: Dictionary = r.detail
	var extra := {"status": int(d["status"])}
	var retry := _retry_after(d.get("headers", {}))
	if retry >= 0:
		extra["retry_after_seconds"] = retry
	match String(r.code):
		PKeyConstants.ErrorCode.RELAY_DISABLED:
			return PKeyConnectErrors.relay("disabled", "This product has its relay off.", extra)
		PKeyConstants.ErrorCode.RELAY_PAUSED:
			return PKeyConnectErrors.relay("paused", "The relay is paused; try again later.", extra)
		PKeyConstants.ErrorCode.RELAY_QUOTA_EXCEEDED:
			var body: Variant = (d.get("error", {}) as Dictionary).get("body", {})
			if body is Dictionary:
				extra["scope"] = (body as Dictionary).get("scope")
			return PKeyConnectErrors.relay("quota", "The relay quota is spent.", extra)
		PKeyConstants.ErrorCode.RELAY_TICKET_INVALID:
			return PKeyConnectErrors.relay("ticket_invalid", "The relay refused the device.", extra)
	return r


## Whole seconds of a `Retry-After` header (lower-case names), capped at an hour; -1 for none or
## anything that is not a plain number.
static func _retry_after(headers: Variant) -> int:
	if not headers is Dictionary:
		return -1
	var v: Variant = (headers as Dictionary).get("retry-after")
	if not v is String:
		return -1
	var text := (v as String).strip_edges()
	if text == "" or text.length() > 9 or not text.is_valid_int() or text.begins_with("-") or text.begins_with("+"):
		return -1
	return mini(text.to_int(), PKeyConnectErrors.RETRY_AFTER_CAP_SECONDS)


## The ticket answer, shape-checked and bound to this Worker: the ticket goes only to the Worker's
## own host over `wss:` and only for the protocol this client speaks (G13).
func _grant(body: Variant, status: int) -> PKeyResult:
	var bad := _ticket_invalid("The relay ticket answer is not in the contract shape.", status)
	if not body is Dictionary:
		return bad
	var o: Dictionary = body
	var ticket: Variant = o.get("ticket")
	var url: Variant = o.get("url")
	if not ticket is String or not PKeyClaims.matches_whole_re(_ticket_re, ticket) \
			or not url is String or o.get("protocol") != RELAY_PROTOCOL \
			or not _safe_integer(o.get("expiresAt")):
		return bad
	var core := _core()
	# `parse_url` reads http(s) only: the same text with `https` has the host and port of the `wss` one.
	var target := PKeyTransport.parse_url("https://" + (url as String).substr(6)) \
			if (url as String).to_lower().begins_with("wss://") else {}
	var home := PKeyTransport.parse_url(home_url if home_url != "" else (core.base_url if core != null else ""))
	if target.is_empty() or home.is_empty() \
			or target["host"] != home["host"] or int(target["port"]) != int(home["port"]):
		return bad
	var grant := Grant.new()
	grant._ticket = ticket
	grant.url = url
	grant.protocol = RELAY_PROTOCOL
	grant.expires_at = int(o["expiresAt"])
	return PKeyResult.success(grant)


## `Number.isSafeInteger`, as Node reads `expiresAt`: a whole number from 0 to 2^53 - 1 by its value,
## whatever its spelling (the replay server writes `1700000060.0`). A time cannot be negative.
static func _safe_integer(v: Variant) -> bool:
	if not (v is float or v is int):
		return false
	var f := float(v)
	return is_finite(f) and f == floorf(f) and f >= 0.0 and f <= float(PKeyClaims.MAX_WIRE_INTEGER)


static func _ticket_invalid(message: String, status := 0) -> PKeyResult:
	return PKeyConnectErrors.relay("ticket_invalid", message, {"status": status} if status > 0 else {})


# ── Verification ─────────────────────────────────────────────────────────────────────────

## Each half of the held record verified on its own: a lapsed certificate must not cost the roster
## that the next replacement is judged against. {ring: Dictionary or null, cert: Dictionary or null}.
func _verify_held(rec: PKeyConnectState.Record) -> Dictionary:
	var core := _core()
	var trust := core.trust.effective()
	var r := PKeyPeerCert.verify_ring(rec.ring, trust, core.product)
	var c := PKeyPeerCert.verify_peer_cert(rec.certificate, trust, core.product, _now())
	return {"ring": r["ring"] if r["ok"] else null, "cert": c["cert"] if c["ok"] else null}


func _view(rec: PKeyConnectState.Record, ring: Dictionary, cert: Dictionary) -> Dictionary:
	return {
		"sub": ring["sub"],
		"device_id": rec.device_id,
		"epoch": int(ring["epoch"]),
		"devices": ring["devices"],
		"certificate": rec.certificate,
		"certificate_expires_at": int(cert["expires_at"]),
		"ring": rec.ring,
		"ring_expires_at": int(ring["expires_at"]),
	}


func _now() -> int:
	var core := _core()
	return int(core.clock.now()) if core != null else PKeyClaims.system_now()


static func _same_device(a: Dictionary, b: Dictionary) -> bool:
	return a["device_id"] == b["device_id"] and a["sign_key"] == b["sign_key"] \
			and a["agree_key"] == b["agree_key"]


## Does `ring` list `device` with the same keys?
static func _lists(ring: Dictionary, device: Dictionary) -> bool:
	for d in ring["devices"]:
		if _same_device(d, device):
			return true
	return false


## Every device of `prior` is in `next` with the same keys.
static func _intact(prior: Dictionary, next: Dictionary) -> bool:
	for d in prior["devices"]:
		if not _lists(next, d):
			return false
	return true


## What the LAN and relay halves read of the held identity, as one snapshot. The device's static
## key stays in `keys`: Noise asks it for `dh` (G1). Never printed.
class PeerSource extends RefCounted:
	var slug := ""
	var trust: Dictionary = {}
	var sub := ""
	var device_id := ""
	var certificate := ""
	var certificate_expires_at := 0
	var ring := ""
	var ring_epoch := 0
	var roster: Array[String] = []
	## K_disc, newest first: `disc_current`, then `disc_previous` (empty when none is usable).
	var disc_current := PackedByteArray()
	var disc_previous := PackedByteArray()
	var agree_public := PackedByteArray()
	var keys: Object = null

	func _to_string() -> String:
		return "PeerSource(redacted)"

	## X25519 of the device's agreement key with `peer_public`, through the key port.
	func dh(peer_public: PackedByteArray) -> PKeyResult:
		if keys == null:
			return PKeyResult.success(null)
		return keys.dh(peer_public)


## A relay ticket answer, shape-checked and bound to the Worker's own host. `str()` shows no ticket
## (G13): read it with `ticket()` at the moment the socket opens.
class Grant extends RefCounted:
	var url := ""
	var protocol := ""
	## Seconds since the epoch.
	var expires_at := 0
	var _ticket := ""

	func ticket() -> String:
		return _ticket

	func _to_string() -> String:
		return "RelayGrant(redacted)"
