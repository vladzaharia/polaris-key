class_name PKeyVerify
extends RefCounted
## Signed-document verification with the full v3 claim set (WIRE-CONTRACT-V3 §2–§3): a port of
## `client-core/src/verify.ts`. Cryptography is PKeyJws; this adds the envelope every document
## shares and the per-type claims, so an expired, foreign, far-future or wrong-`typ` document
## never becomes a document at all. Every failure returns null, never an error.
##
## Options (a Dictionary):
##   trust                   kid -> base64url key: the EFFECTIVE set for documents
##   expected_aud            the product slug
##   expected_iss            defaults to PKeyClaims.ISSUER
##   device_id               the LOCAL device id
##   last_accepted_issued_at per-type anti-replay floor (null: none)
##   now                     epoch seconds (null: the system clock)
##   check_freshness         true on the network path (default); false on reload and import
##   offload                 run the signature off the calling thread (PKeyJws.verify_async)


static func _is_valid_schema_version(v: Variant) -> bool:
	return PKeyClaims.is_number(v) and is_finite(float(v)) and float(v) == floorf(float(v)) and float(v) >= 1.0


## `pkey-license+jws` (§2.1): a non-empty licenseId, an object `entitlements`, and a `profile`
## that is an object when present.
static func check_license_claims(doc: Dictionary) -> bool:
	if not (doc.get("licenseId") is String) or doc["licenseId"] == "":
		return false
	if not (doc.get("entitlements") is Dictionary):
		return false
	if doc.has("profile") and not (doc["profile"] is Dictionary):
		return false
	return true


## `pkey-config+jws` (§2.2, D-08): an integer schemaVersion >= 1 (a catalog version, so a shape
## check and not an allow-list), and object `config` and `secrets`. No licence fields needed.
static func check_config_claims(doc: Dictionary) -> bool:
	if not _is_valid_schema_version(doc.get("schemaVersion")):
		return false
	if not (doc.get("config") is Dictionary):
		return false
	if not (doc.get("secrets") is Dictionary):
		return false
	return true


## The shared envelope (§2/§3), checked once so the two documents can never drift apart.
static func check_envelope(doc: Dictionary, opts: Dictionary, now: float) -> bool:
	if not _eq_str(doc.get("aud"), opts.get("expected_aud")):
		return false
	var iss = opts.get("expected_iss")
	if not _eq_str(doc.get("iss"), iss if iss != null else PKeyClaims.ISSUER):
		return false
	if not _eq_str(doc.get("deviceId"), opts.get("device_id")):
		return false
	var issued = doc.get("issuedAt")
	var expires = doc.get("expiresAt")
	var grace = doc.get("graceUntil")
	if not (PKeyClaims.is_number(issued) and PKeyClaims.is_number(expires) and PKeyClaims.is_number(grace)):
		return false
	var floor_at = opts.get("last_accepted_issued_at")
	if floor_at != null and issued <= floor_at:
		return false
	if grace < expires:
		return false
	if grace > issued + PKeyClaims.MAX_GRACE_SECONDS:
		return false
	if not PKeyClaims.is_false(opts.get("check_freshness", true)):
		if issued > now + PKeyClaims.CLOCK_SKEW_SECONDS:
			return false
		if expires <= now - PKeyClaims.CLOCK_SKEW_SECONDS:
			return false
	return true


## Verify one signed document of type `typ`: the payload Dictionary, or null. A coroutine.
static func verify_doc(jws: String, typ: String, opts: Dictionary) -> Variant:
	var v = await PKeyJws.verify_async(jws, opts.get("trust", {}), typ, 0, PKeyClaims.is_true(opts.get("offload", false)))
	if v == null or not (v["payload"] is Dictionary):
		return null
	var doc: Dictionary = v["payload"]
	var now = opts.get("now")
	if not check_envelope(doc, opts, float(now) if now != null else float(PKeyClaims.system_now())):
		return null
	match typ:
		PKeyClaims.TYP_LICENSE:
			return doc if check_license_claims(doc) else null
		PKeyClaims.TYP_CONFIG:
			return doc if check_config_claims(doc) else null
	return null


static func verify_license_doc(jws: String, opts: Dictionary) -> Variant:
	return await verify_doc(jws, PKeyClaims.TYP_LICENSE, opts)


static func verify_config_doc(jws: String, opts: Dictionary) -> Variant:
	return await verify_doc(jws, PKeyClaims.TYP_CONFIG, opts)


## Strict equality of two strings (JS `===` where one side may be absent or another type).
static func _eq_str(a: Variant, b: Variant) -> bool:
	return a is String and b is String and a == b
