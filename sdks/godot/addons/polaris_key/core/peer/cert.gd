@tool
class_name PKeyPeerCert
extends RefCounted
## The Cloud Connect device certificate (`pkey-peer+jws`) and roster (`pkey-ring+jws`):
## WIRE-CONTRACT-V5 section 15.2 and 15.3, ported from `packages/client-core/src/peer/cert.ts` and
## the Python `polaris_key.core.peer_cert`.
##
## Pure functions over bytes and a clock; nothing here does I/O. Both documents are signed by the
## product key and verified against the effective product set (section 1) through the strict
## `PKeyJws.verify`, which keeps the JWS, Ed25519 and JSON rules. A refused check names the step
## that refused it, in the order section 15.2 lists them. The reasons are verifier outcomes, not
## error codes: the session maps every one of them to `peer-cert-invalid`.
##
## Results are Dictionaries. `verify_peer_cert`: {ok, cert} or {ok = false, reason}. `verify_ring`:
## {ok, ring} or {ok = false, reason}. `replace_ring`: {replace, ring} or {replace = false, reason}.
## `admit_peer`: {admit, cert, ring_sync} or {admit = false, reason}. A cert is {sub, device_id,
## sign_key, agree_key, ring_epoch, issued_at, expires_at}; a ring is {sub, epoch, issued_at,
## expires_at, devices: [{device_id, sign_key, agree_key}]}. Times are whole epoch seconds.

const PEER_CERT_TYP := "pkey-peer+jws"
const RING_TYP := "pkey-ring+jws"
## One week, in seconds: a certificate's and a roster's longest life.
const MAX_PEER_CERT_SECONDS := 604800
const PEER_CERT_RENEW_SECONDS := 302400
const RING_SECONDS := 604800
const MAX_RING_DEVICES := 128

const _DEVICE_PATTERN := "[A-Za-z0-9_-]{32}"
const _KEY_PATTERN := "[A-Za-z0-9_-]{43}"

static var _sub_re: RegEx
static var _device_re: RegEx
static var _key_re: RegEx


static func _static_init() -> void:
	_sub_re = PKeyClaims.whole(PKeyConstants.PAIRWISE_SUBJECT_PATTERN)
	_device_re = PKeyClaims.whole(_DEVICE_PATTERN)
	_key_re = PKeyClaims.whole(_KEY_PATTERN)


## Section 15.2 steps 1 to 7, in order; the first failing step names the reason. `session` is
## null to check the certificate alone (steps 1 to 6); otherwise {mode: "a"|"v"|"p", remote_static
## (the Noise remote static key, canonical base64url), own_sub, own_device_id}: mode `a` also checks
## the account and refuses the verifier's own device, modes `v` and `p` check the key only.
## `now` is the effective clock in seconds (0 or less: the system clock).
static func verify_peer_cert(jws: String, trust: Dictionary, expected_aud: String, now := 0, session: Variant = null) -> Dictionary:
	var v: Variant = PKeyJws.verify(jws, trust, PEER_CERT_TYP)
	if v == null:
		return _cert_fail("jws-rejected")
	var d: Dictionary = v["payload"]
	var nonwire: PKeyJson.PointerSet = v["non_wire_integers"]
	if not _eq(d.get("iss"), PKeyClaims.ISSUER) or not _eq(d.get("aud"), expected_aud):
		return _cert_fail("issuer-or-audience")
	if not PKeyClaims.is_wire_integer(d.get("ringEpoch"), "/ringEpoch", 1, nonwire) \
			or not PKeyClaims.is_wire_integer(d.get("issuedAt"), "/issuedAt", 0, nonwire) \
			or not PKeyClaims.is_wire_integer(d.get("expiresAt"), "/expiresAt", 0, nonwire):
		return _cert_fail("integer")
	if not PKeyClaims.matches_whole_re(_sub_re, d.get("sub")) or not PKeyClaims.matches_whole_re(_device_re, d.get("deviceId")):
		return _cert_fail("subject-or-device")
	if not _keys_ok(d.get("signKey"), d.get("agreeKey")):
		return _cert_fail("keys")
	var iat := int(d["issuedAt"])
	var exp := int(d["expiresAt"])
	if exp - iat < 1 or exp - iat > MAX_PEER_CERT_SECONDS:
		return _cert_fail("lifetime")
	var at := now if now > 0 else PKeyClaims.system_now()
	if iat > at + PKeyClaims.CLOCK_SKEW_SECONDS or at > exp + PKeyClaims.CLOCK_SKEW_SECONDS:
		return _cert_fail("clock")
	if session is Dictionary:
		var s: Dictionary = session
		if _eq(s.get("mode"), "a"):
			if not _eq(d["sub"], s.get("own_sub")):
				return _cert_fail("sub-mismatch")
			if _eq(d["deviceId"], s.get("own_device_id")):
				return _cert_fail("own-device")
		if not _eq(d["agreeKey"], s.get("remote_static")):
			return _cert_fail("static-mismatch")
	return {
		"ok": true,
		"cert": {
			"sub": d["sub"],
			"device_id": d["deviceId"],
			"sign_key": d["signKey"],
			"agree_key": d["agreeKey"],
			"ring_epoch": int(d["ringEpoch"]),
			"issued_at": iat,
			"expires_at": exp,
		},
	}


## Section 15.3: the roster's own checks. The clock is a separate question (`ring_expired`).
static func verify_ring(jws: String, trust: Dictionary, expected_aud: String) -> Dictionary:
	var v: Variant = PKeyJws.verify(jws, trust, RING_TYP)
	if v == null:
		return _ring_fail("jws-rejected")
	var d: Dictionary = v["payload"]
	var nonwire: PKeyJson.PointerSet = v["non_wire_integers"]
	if not _eq(d.get("iss"), PKeyClaims.ISSUER) or not _eq(d.get("aud"), expected_aud):
		return _ring_fail("issuer-or-audience")
	if not PKeyClaims.is_wire_integer(d.get("epoch"), "/epoch", 1, nonwire) \
			or not PKeyClaims.is_wire_integer(d.get("issuedAt"), "/issuedAt", 0, nonwire) \
			or not PKeyClaims.is_wire_integer(d.get("expiresAt"), "/expiresAt", 0, nonwire):
		return _ring_fail("integer")
	if not PKeyClaims.matches_whole_re(_sub_re, d.get("sub")):
		return _ring_fail("subject")
	var iat := int(d["issuedAt"])
	var exp := int(d["expiresAt"])
	if exp - iat < 1 or exp - iat > RING_SECONDS:
		return _ring_fail("lifetime")
	var devices: Variant = d.get("devices")
	if not (devices is Array) or (devices as Array).size() < 1 or (devices as Array).size() > MAX_RING_DEVICES:
		return _ring_fail("devices-size")
	for e in devices:
		if not (e is Dictionary) or not PKeyClaims.matches_whole_re(_device_re, e.get("deviceId")):
			return _ring_fail("device")
		if not _keys_ok(e.get("signKey"), e.get("agreeKey")):
			return _ring_fail("keys")
	var list: Array = devices
	for k in range(1, list.size()):
		var prev: String = list[k - 1]["deviceId"]
		var cur: String = list[k]["deviceId"]
		if cur == prev:
			return _ring_fail("duplicate-id")
		# A device id is ASCII, so code-point order is the byte order.
		if not prev < cur:
			return _ring_fail("unsorted")
	for field in ["signKey", "agreeKey"]:
		var seen := {}
		for e in list:
			seen[e[field]] = true
		if seen.size() != list.size():
			return _ring_fail("duplicate-key")
	var out: Array = []
	for e in list:
		out.append({"device_id": e["deviceId"], "sign_key": e["signKey"], "agree_key": e["agreeKey"]})
	return {"ok": true, "ring": {"sub": d["sub"], "epoch": int(d["epoch"]), "issued_at": iat, "expires_at": exp, "devices": out}}


## Section 15.3: a roster is expired once `now > expires_at + 300`, the certificate's clock rule.
## `ring` is a verified ring. `now` 0 or less: the system clock.
static func ring_expired(ring: Dictionary, now := 0) -> bool:
	var at := now if now > 0 else PKeyClaims.system_now()
	return at > int(ring["expires_at"]) + PKeyClaims.CLOCK_SKEW_SECONDS


## Section 15.3 "Held ring and replacement": the held ring is replaced only by a roster that
## verifies, has the same `aud` and `sub`, a higher epoch and is not expired. An expired held ring
## counts as no ring at all. `held_jws` is "" or null for none.
static func replace_ring(held_jws: Variant, new_jws: String, trust: Dictionary, expected_aud: String, now := 0) -> Dictionary:
	var next := verify_ring(new_jws, trust, expected_aud)
	if not next["ok"]:
		return {"replace": false, "reason": "new-rejected"}
	var ring: Dictionary = next["ring"]
	var held: Variant = _live_ring(held_jws, trust, expected_aud, now)
	if held != null:
		if ring["sub"] != held["sub"]:
			return {"replace": false, "reason": "other-product-or-subject"}
		if int(ring["epoch"]) <= int(held["epoch"]):
			return {"replace": false, "reason": "epoch-not-higher"}
	if ring_expired(ring, now):
		return {"replace": false, "reason": "new-expired"}
	return {"replace": true, "ring": ring}


## Section 15.3 "Peer admission". `ring_sync == "request"` means the certificate is on a newer
## epoch than the held roster: ask the peer for `RING`. A refusal is `cert-invalid` or
## `peer_revoked`. `session` is as for `verify_peer_cert`.
static func admit_peer(cert_jws: String, held_ring_jws: Variant, trust: Dictionary, expected_aud: String, now := 0, session: Variant = null) -> Dictionary:
	var c := verify_peer_cert(cert_jws, trust, expected_aud, now, session)
	if not c["ok"]:
		return {"admit": false, "reason": "cert-invalid"}
	var cert: Dictionary = c["cert"]
	var ring: Variant = _live_ring(held_ring_jws, trust, expected_aud, now)
	if ring == null:
		return {"admit": true, "cert": cert, "ring_sync": "none"}
	# A certificate of another account is judged by the session's own checks, never by this ring's
	# epoch: its numbers belong to a different roster.
	if cert["sub"] != ring["sub"]:
		return {"admit": false, "reason": "cert-invalid"}
	if int(ring["epoch"]) > int(cert["ring_epoch"]):
		for e in ring["devices"]:
			if e["device_id"] == cert["device_id"] and e["sign_key"] == cert["sign_key"] and e["agree_key"] == cert["agree_key"]:
				return {"admit": true, "cert": cert, "ring_sync": "none"}
		return {"admit": false, "reason": "peer_revoked"}
	return {"admit": true, "cert": cert, "ring_sync": "request" if int(cert["ring_epoch"]) > int(ring["epoch"]) else "none"}


## Two values are equal strings. A claim read from JSON can be any type, and comparing mismatched
## types with `==` is not safe in GDScript.
static func _eq(a: Variant, b: Variant) -> bool:
	return a is String and b is String and a == b


static func _cert_fail(reason: String) -> Dictionary:
	return {"ok": false, "reason": reason}


static func _ring_fail(reason: String) -> Dictionary:
	return {"ok": false, "reason": reason}


## The held ring, or null when there is none, it does not verify, or it is expired.
static func _live_ring(held_jws: Variant, trust: Dictionary, aud: String, now: int) -> Variant:
	if not (held_jws is String) or held_jws == "":
		return null
	var held := verify_ring(held_jws, trust, aud)
	if not held["ok"] or ring_expired(held["ring"], now):
		return null
	return held["ring"]


## A canonical base64url string of exactly 32 bytes, decoded; null otherwise.
static func _key_bytes(v: Variant) -> Variant:
	if not PKeyClaims.matches_whole_re(_key_re, v):
		return null
	var b: Variant = PKeyB64Url.decode_strict(v)
	if b == null or (b as PackedByteArray).size() != 32:
		return null
	return b


## Section 15.2 step 4 for one (signKey, agreeKey) pair. A verifier is lenient about non-canonical
## X25519 spellings (bit 255, u >= p) but not about low-order points.
static func _keys_ok(sign_key: Variant, agree_key: Variant) -> bool:
	var s: Variant = _key_bytes(sign_key)
	var a: Variant = _key_bytes(agree_key)
	return s != null and a != null and _point_acceptable(s) and not PKeyCurve25519.is_low_order(a)


## The Ed25519 encoding checks of V4 section 1.1 for one key: a canonical y, and neither of small
## order nor x = 0 with the sign bit set.
static func _point_acceptable(enc: PackedByteArray) -> bool:
	if enc.size() != 32 or not PKeyEd25519.y_is_canonical(enc):
		return false
	var h := enc.hex_encode()
	return not PKeyEd25519.NEGATIVE_ZERO_ENCODINGS.has(h) and not PKeyEd25519.SMALL_ORDER_ENCODINGS.has(h)
