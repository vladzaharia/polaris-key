class_name PKeyTrust
extends RefCounted
## The trust set (WIRE-CONTRACT-V3 §1): a port of `client-core/src/trust.ts`. Two tiers only:
##
##   pinned    compiled into the game (PKeyOptions.pinned_trust_keys). Terminal.
##   manifest  keys from a `pkey-trust+jws` verified AGAINST THE PINS ONLY, re-verified on every
##             load and REPLACED wholesale on every refresh, so absence is revocation.
##
## Never pinned from discovery's `trust.pinnedKeys` (that would be trust on first use).
##
## The instance is Core's custodian (sdk-node `core/trust.ts`): it holds the discovered tier and
## the last accepted manifest, whose `issuedAt` is the in-memory anti-rollback floor and raises
## the clock floor. Nothing here is ever persisted except the manifest's compact JWS.

var _pinned: Dictionary
var _discovered: Dictionary = {}
var _manifest = null


func _init(pinned: Dictionary = {}) -> void:
	_pinned = pinned.duplicate()


## `{...discovered, ...pinned}`: a manifest key can never shadow a pin.
static func merge(pinned: Dictionary, discovered: Dictionary) -> Dictionary:
	var out := discovered.duplicate()
	out.merge(pinned, true)
	return out


## Verify a trust manifest against `opts.pinned` and derive the keys it publishes. A coroutine.
## Returns {"doc": Dictionary or null, "discovered": Dictionary}. Options: pinned, expected_aud,
## expected_iss, last_trust_issued_at, now, check_freshness (default true), offload.
static func verify_manifest(jws: String, opts: Dictionary) -> Dictionary:
	var rejected := {"doc": null, "discovered": {}}
	var pinned: Dictionary = opts.get("pinned", {})
	var v = await PKeyJws.verify_async(jws, pinned, PKeyClaims.TYP_TRUST, 0, opts.get("offload", false) == true)
	if v == null or not (v["payload"] is Dictionary):
		return rejected
	var doc: Dictionary = v["payload"]
	var now = opts.get("now")
	now = float(now) if now != null else float(PKeyClaims.system_now())

	# Supported schema versions: {1}. Unknown fails closed.
	var sv = doc.get("schemaVersion")
	if not (PKeyClaims.is_number(sv) and float(sv) == 1.0):
		return rejected
	if not (doc.get("aud") is String and opts.get("expected_aud") is String and doc["aud"] == opts["expected_aud"]):
		return rejected
	var iss = opts.get("expected_iss")
	if not (doc.get("iss") is String and doc["iss"] == (iss if iss != null else PKeyClaims.ISSUER)):
		return rejected
	var issued = doc.get("issuedAt")
	var expires = doc.get("expiresAt")
	if not (PKeyClaims.is_number(issued) and PKeyClaims.is_number(expires)):
		return rejected
	var floor_at = opts.get("last_trust_issued_at")
	if floor_at != null and issued <= floor_at:
		return rejected
	if opts.get("check_freshness", true) != false:
		if issued > now + PKeyClaims.CLOCK_SKEW_SECONDS:
			return rejected
		if expires <= now - PKeyClaims.CLOCK_SKEW_SECONDS:
			return rejected
	if not (doc.get("keys") is Array):
		return rejected

	var discovered := {}
	for key in doc["keys"]:
		if not (key is Dictionary):
			return rejected
		if not (key.get("kid") is String and key.get("publicKey") is String):
			return rejected
		var kid: String = key["kid"]
		# A pinned kid with different bytes is a substitution attempt: refuse the manifest.
		if pinned.has(kid) and pinned[kid] != key["publicKey"]:
			return rejected
		if key.get("status") is String and key["status"] == "revoked":
			continue
		if not (_eq(key.get("alg"), "EdDSA") and _eq(key.get("kty"), "OKP") and _eq(key.get("crv"), "Ed25519")):
			continue
		discovered[kid] = key["publicKey"]
	return {"doc": doc, "discovered": discovered}


static func _eq(a: Variant, b: String) -> bool:
	return a is String and a == b


# ── The custodian ──────────────────────────────────────────────────────────────────────────

## The effective set: manifest keys, then the pins over them.
func effective() -> Dictionary:
	return merge(_pinned, _discovered)


func pinned() -> Dictionary:
	return _pinned.duplicate()


## The last accepted manifest payload, or null.
func manifest() -> Variant:
	return _manifest


## Forget everything learned: on deactivate, and at the top of every cache load.
func reset() -> void:
	_discovered = {}
	_manifest = null


## Re-verify a CACHED manifest against the pins, freshness off, and install it. Returns its
## `issuedAt` (a signed lower bound on real time, for the clock floor) or -1 when it failed.
func load_cached(jws: String, product: String, now: float) -> float:
	var r := await verify_manifest(jws, {"pinned": _pinned, "expected_aud": product, "now": now, "check_freshness": false})
	if r["doc"] == null:
		return -1.0
	_manifest = r["doc"]
	_discovered = r["discovered"]
	return float(_manifest["issuedAt"])


## Install a manifest fetched from the network: pins only, freshness on, anti-rollback against
## the manifest held in memory. Returns its `issuedAt`, or -1 when it was not accepted (the
## previous set stays).
func accept_network(jws: String, product: String, now: float, offload := false) -> float:
	var opts := {"pinned": _pinned, "expected_aud": product, "now": now, "offload": offload}
	if _manifest != null:
		opts["last_trust_issued_at"] = _manifest["issuedAt"]
	var r := await verify_manifest(jws, opts)
	if r["doc"] == null:
		return -1.0
	_manifest = r["doc"]
	_discovered = r["discovered"]
	return float(_manifest["issuedAt"])
