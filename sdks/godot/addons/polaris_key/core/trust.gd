class_name PKeyTrust
extends RefCounted
## The trust set (WIRE-CONTRACT-V4 §1, §2.3, §4.1): a port of `client-core/src/trust.ts`. Two tiers:
##
##   pinned    compiled into the game (PKeyOptions.pinned_trust_keys). Terminal unless TOMBSTONED:
##             a verified manifest signed by another usable pin that lists the pin's exact bytes
##             as `revoked` removes it from the usable pins, permanently, on this install. The
##             tombstone is kept as SIGNED EVIDENCE (the revoking manifest, verbatim, in the cache's
##             `pinRevocations` slice) and re-derived on every load by `load_pin_revocations`.
##   manifest  keys from a `pkey-trust+jws` verified AGAINST THE USABLE PINS ONLY, re-verified on
##             every load and REPLACED wholesale on every refresh, so absence is revocation.
##
## Never pinned from discovery's `trust.pinnedKeys` (that would be trust on first use).
##
## The instance is Core's custodian (sdk-node `core/trust.ts`): it holds the discovered tier, the
## last accepted manifest (whose `issuedAt` is the in-memory anti-rollback floor and raises the
## clock floor) and the tombstones with their evidence. Nothing here is ever persisted except
## compact JWSs.

## The statuses that keep a published key; anything else (a case variant, a non-string, an
## absent status, `revoked`) drops it.
const LIVE_STATUSES := ["active", "staged", "retired"]

var _pinned: Dictionary
var _discovered: Dictionary = {}
var _manifest = null
## The tombstoned pinned kids, re-derived from `_evidence` on every load (ascending byte order).
var _tombstones: Array = []
## The `pinRevocations` slice as it should be written: kid -> the revoking manifest's compact JWS.
var _evidence: Dictionary = {}


func _init(pinned: Dictionary = {}) -> void:
	_pinned = pinned.duplicate()


## Ascending byte order of the UTF-8 encodings (GDScript's String order is by code point, which
## is not the order every SDK can reproduce). <0, 0 or >0.
static func compare_kid_bytes(a: String, b: String) -> int:
	var x := a.to_utf8_buffer()
	var y := b.to_utf8_buffer()
	var n := mini(x.size(), y.size())
	for i in n:
		if x[i] != y[i]:
			return x[i] - y[i]
	return x.size() - y.size()


## `kids` sorted in ascending UTF-8 byte order (a copy).
static func sort_kids(kids: Array) -> Array:
	var out := kids.duplicate()
	out.sort_custom(func(a, b): return compare_kid_bytes(a, b) < 0)
	return out


## `{...discovered, ...pinned}`: a manifest key can never shadow a pin. Pass the USABLE pins
## (`usable_pins`): a tombstoned pin is in no set at all.
static func merge(pinned: Dictionary, discovered: Dictionary) -> Dictionary:
	var out := discovered.duplicate()
	out.merge(pinned, true)
	return out


## The pins minus the tombstoned kids (§1 tombstone rule 4).
static func usable_pins(pinned: Dictionary, tombstones: Array = []) -> Dictionary:
	var out := {}
	for kid in pinned:
		if not tombstones.has(kid):
			out[kid] = pinned[kid]
	return out


## Verify a trust manifest against the USABLE pins (`opts.pinned` minus `opts.tombstones`) and
## derive the keys it publishes. A coroutine.
## Returns {"doc": Dictionary or null, "discovered": Dictionary, "revoked_pins": Array}:
## `revoked_pins` are the pinned kids this manifest NEWLY tombstones (listed `revoked` with their
## exact pinned bytes by another usable pin), ascending byte order, empty when rejected.
## Options: pinned, tombstones, expected_aud, expected_iss, last_trust_issued_at, now,
## check_freshness (default true), offload.
##
##  1. A pinned kid (tombstoned or not) presenting other key bytes is a substitution attempt: the
##     whole manifest is refused.
##  2. `status` is an allow-list: exactly "active", "staged" or "retired" keeps a key. "revoked"
##     drops it; anything else (absent, unknown, a case variant, a non-string) skips the entry and
##     is never fatal. A non-canonical `publicKey` is skipped the same way.
##  3. A usable pinned kid listed `revoked` with its exact bytes by ANOTHER pin is tombstoned. A
##     manifest that lists its own signer as `revoked` is refused in full.
static func verify_manifest(jws: String, opts: Dictionary) -> Dictionary:
	var rejected := {"doc": null, "discovered": {}, "revoked_pins": []}
	var pinned: Dictionary = opts.get("pinned", {})
	var tombstones: Array = opts.get("tombstones", [])
	var v = await PKeyJws.verify_async(jws, usable_pins(pinned, tombstones), PKeyClaims.TYP_TRUST, 0, PKeyClaims.is_true(opts.get("offload", false)))
	if v == null or not (v["payload"] is Dictionary):
		return rejected
	var doc: Dictionary = v["payload"]
	var now = opts.get("now")
	now = float(now) if now != null else float(PKeyClaims.system_now())

	# V4 §3: integer claims decided from their tokens. Supported schema versions: {1}.
	var nw: PKeyJson.PointerSet = v.get("non_wire_integers")
	var sv = doc.get("schemaVersion")
	if not (PKeyClaims.is_wire_integer(sv, "/schemaVersion", 1, nw) and float(sv) == 1.0):
		return rejected
	if not (doc.get("aud") is String and opts.get("expected_aud") is String and doc["aud"] == opts["expected_aud"]):
		return rejected
	var iss = opts.get("expected_iss")
	if not (doc.get("iss") is String and doc["iss"] == (iss if iss != null else PKeyClaims.ISSUER)):
		return rejected
	var issued = doc.get("issuedAt")
	var expires = doc.get("expiresAt")
	if not (PKeyClaims.is_wire_integer(issued, "/issuedAt", 0, nw) and PKeyClaims.is_wire_integer(expires, "/expiresAt", 0, nw)):
		return rejected
	var floor_at = opts.get("last_trust_issued_at")
	if floor_at != null and issued <= floor_at:
		return rejected
	if not PKeyClaims.is_false(opts.get("check_freshness", true)):
		if issued > now + PKeyClaims.CLOCK_SKEW_SECONDS:
			return rejected
		if expires <= now - PKeyClaims.CLOCK_SKEW_SECONDS:
			return rejected
	if not (doc.get("keys") is Array):
		return rejected

	var discovered := {}
	var revoked: Array = []
	for key in doc["keys"]:
		if not (key is Dictionary):
			return rejected
		if not (key.get("kid") is String and key.get("publicKey") is String):
			return rejected
		var kid: String = key["kid"]
		# A pinned kid with different bytes is a substitution attempt: refuse the manifest.
		var is_pinned := pinned.has(kid)
		if is_pinned and pinned[kid] != key["publicKey"]:
			return rejected
		var status = key.get("status")
		if status is String and status == "revoked":
			if is_pinned:
				# A manifest cannot revoke the key that signed it: refused in full (§1 rule 2).
				if kid == v["kid"]:
					return rejected
				if not tombstones.has(kid) and not revoked.has(kid):
					revoked.append(kid)
			continue
		if not (status is String and LIVE_STATUSES.has(status)):
			continue
		if not (_eq(key.get("alg"), "EdDSA") and _eq(key.get("kty"), "OKP") and _eq(key.get("crv"), "Ed25519")):
			continue
		if not PKeyB64Url.is_canonical(key["publicKey"]):
			continue
		discovered[kid] = key["publicKey"]
	# A tombstoned kid leaves every set; a later manifest cannot restore it (§1 rule 3).
	for kid in tombstones:
		discovered.erase(kid)
	for kid in revoked:
		discovered.erase(kid)
	return {"doc": doc, "discovered": discovered, "revoked_pins": sort_kids(revoked)}


static func _eq(a: Variant, b: String) -> bool:
	return a is String and a == b


## Re-derive the tombstones from the cache's `pinRevocations` slice (§4.1): kid -> the revoking
## manifest's compact JWS. Each entry is re-verified on the RELOAD profile (no freshness, no
## anti-rollback floor), in ascending manifest `issuedAt` (ties: the revoked kid's byte order),
## against the pins minus the tombstones already applied. An entry that does not verify, whose
## signer is already tombstoned, or that does not revoke the kid it is filed under, is dropped.
## Options: pinned, expected_aud, expected_iss. A coroutine.
## Returns {"tombstones": Array (ascending byte order), "kept": Dictionary kid -> jws}.
static func load_pin_revocations(evidence: Variant, opts: Dictionary) -> Dictionary:
	var pinned: Dictionary = opts.get("pinned", {})
	var cands: Array = []
	if evidence is Dictionary:
		for kid in evidence:
			var jws = evidence[kid]
			if not (kid is String and jws is String and pinned.has(kid)):
				continue
			var pre := await verify_manifest(jws, {
				"pinned": pinned, "expected_aud": opts.get("expected_aud"), "expected_iss": opts.get("expected_iss"),
				"check_freshness": false,
			})
			if pre["doc"] == null:
				continue
			cands.append({"kid": kid, "jws": jws, "issued_at": float(pre["doc"]["issuedAt"])})
	cands.sort_custom(func(a, b) -> bool:
		if a["issued_at"] != b["issued_at"]:
			return a["issued_at"] < b["issued_at"]
		return compare_kid_bytes(a["kid"], b["kid"]) < 0)
	var tombstones: Array = []
	var kept := {}
	for c in cands:
		var r := await verify_manifest(c["jws"], {
			"pinned": pinned, "tombstones": tombstones, "expected_aud": opts.get("expected_aud"),
			"expected_iss": opts.get("expected_iss"), "check_freshness": false,
		})
		if r["doc"] == null or not (r["revoked_pins"] as Array).has(c["kid"]):
			continue
		tombstones.append(c["kid"])
		kept[c["kid"]] = c["jws"]
	return {"tombstones": sort_kids(tombstones), "kept": kept}


## The header `kid` of a compact JWS, unverified, or "" when it has none. For the signer retry only.
static func jws_header_kid(jws: String) -> String:
	var raw = PKeyB64Url.decode_strict(jws.get_slice(".", 0))
	if raw == null:
		return ""
	var parsed := PKeyJson.parse_bytes(raw)
	if not parsed["ok"] or not (parsed["value"] is Dictionary):
		return ""
	var kid = parsed["value"].get("kid")
	return kid if kid is String else ""


## The `?signer=<kid>` retry order (§2.3). When the default manifest's header `kid` is a usable
## pin there is nothing to retry: empty. Otherwise each usable pin in ascending kid byte order, at
## most `MAX_TRUST_SIGNER_ATTEMPTS`; the client stops at the first manifest it accepts.
static func signer_order(usable: Dictionary, header_kid: String) -> Array:
	if header_kid != "" and usable.has(header_kid):
		return []
	var kids: Array = []
	for kid in usable:
		if kid != header_kid:
			kids.append(kid)
	return sort_kids(kids).slice(0, PKeyConstants.MAX_TRUST_SIGNER_ATTEMPTS)


# ── The custodian ──────────────────────────────────────────────────────────────────────────

## The pins minus the tombstones: the ONLY keys a manifest or bundle verifies against.
func usable() -> Dictionary:
	return usable_pins(_pinned, _tombstones)


## The tombstoned pins (ascending byte order).
func revoked_pins() -> Array:
	return _tombstones.duplicate()


## The `pinRevocations` slice to persist (a copy). Empty when no pin was revoked.
func pin_revocations() -> Dictionary:
	return _evidence.duplicate()


## The effective set: manifest keys, then the USABLE pins over them.
func effective() -> Dictionary:
	return merge(usable(), _discovered)


func pinned() -> Dictionary:
	return _pinned.duplicate()


## The last accepted manifest payload, or null.
func manifest() -> Variant:
	return _manifest


## Forget the learned keys: on deactivate, and at the top of every cache load. The tombstones are
## NOT forgotten: they are security state, re-derived from the evidence by `load_evidence`.
func reset() -> void:
	_discovered = {}
	_manifest = null


## Re-derive the tombstones from the cached `pinRevocations` slice (§4.1). Entries that no longer
## verify are absent from `pin_revocations()`, so the next write removes them. A coroutine.
func load_evidence(slice: Variant, product: String) -> void:
	var r := await load_pin_revocations(slice, {"pinned": _pinned, "expected_aud": product})
	_tombstones = r["tombstones"]
	_evidence = r["kept"]


## Record a verified manifest's new tombstones, with the manifest as their evidence.
func note_revocations(jws: String, revoked: Array) -> void:
	if revoked.is_empty():
		return
	for kid in revoked:
		_evidence[kid] = jws
		if not _tombstones.has(kid):
			_tombstones.append(kid)
	_tombstones = sort_kids(_tombstones)


## Re-verify a CACHED manifest against the usable pins, freshness off, and install it. Returns
## its `issuedAt` (a signed lower bound on real time, for the clock floor) or -1 when it failed.
func load_cached(jws: String, product: String, now: float) -> float:
	var r := await verify_manifest(jws, {
		"pinned": _pinned, "tombstones": _tombstones, "expected_aud": product, "now": now, "check_freshness": false,
	})
	if r["doc"] == null:
		return -1.0
	return _install(jws, r)


## Install a manifest fetched from the network: usable pins only, freshness on, anti-rollback
## against the manifest held in memory. Returns its `issuedAt`, or -1 when it was not accepted
## (the previous set stays). A manifest that tombstoned a pin also changed `pin_revocations()`,
## which the caller writes in the same patch.
func accept_network(jws: String, product: String, now: float, offload := false) -> float:
	var opts := {"pinned": _pinned, "tombstones": _tombstones, "expected_aud": product, "now": now, "offload": offload}
	if _manifest != null:
		opts["last_trust_issued_at"] = _manifest["issuedAt"]
	var r := await verify_manifest(jws, opts)
	if r["doc"] == null:
		return -1.0
	return _install(jws, r)


func _install(jws: String, r: Dictionary) -> float:
	note_revocations(jws, r["revoked_pins"])
	_manifest = r["doc"]
	_discovered = r["discovered"]
	return float(_manifest["issuedAt"])
