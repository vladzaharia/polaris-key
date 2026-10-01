class_name PKeyBundle
extends RefCounted
## Offline activation bundles (WIRE-CONTRACT-V3 §7): a port of `client-core/src/bundle.ts`.
##
## This is the VERIFIER: it touches no store. A refusal returns no documents at all, so the
## host physically cannot write half a bundle (all-or-nothing). Refusals name the numbered step,
## because the corpus pins the attribution and the operator's remedy differs per step:
##
##   bundle-jws-rejected     1. signature, typ or the 262 144-byte cap, against the PINS only
##   bundle-claims-rejected  2. bundleId/trust shape, aud, deviceId, the import window on
##                              NETWORK freshness, docs an object of strings, not both absent
##   bundle-trust-rejected   3. the inner trust manifest against the PINS, reload profile
##   inner-doc-rejected      4. each inner document against the effective set, reload profile,
##                              bound to the LOCAL device id
##
## Step 5, the atomic cache write, is the host's (PKeyCore.import_bundle).

const JWS_REJECTED := "bundle-jws-rejected"
const CLAIMS_REJECTED := "bundle-claims-rejected"
const TRUST_REJECTED := "bundle-trust-rejected"
const INNER_DOC_REJECTED := "inner-doc-rejected"
const REASONS := [JWS_REJECTED, CLAIMS_REJECTED, TRUST_REJECTED, INNER_DOC_REJECTED]


## Walk §7 over one bundle. Options: pinned, product, device_id, now (required). A coroutine.
## Returns {"ok": true, "bundle": {bundle_id, trust_jws, effective_trust, docs: {license?: {jws,
## doc}, config?: {jws, doc}}}} or {"ok": false, "reason": <step>}.
static func inspect(jws: String, opts: Dictionary) -> Dictionary:
	var pinned: Dictionary = opts.get("pinned", {})
	var product = opts.get("product")
	var device_id = opts.get("device_id")
	var now := float(opts.get("now", 0))

	# 1. The bundle JWS against the pins, with its typ and the protocol's cap (never the caller's).
	var v = await PKeyJws.verify_async(jws, pinned, PKeyClaims.TYP_BUNDLE, PKeyClaims.MAX_BUNDLE_BYTES)
	if v == null or not (v["payload"] is Dictionary):
		return _refuse(JWS_REJECTED)
	var bundle: Dictionary = v["payload"]

	# 2. The bundle's own claims, on network-path freshness (the operator's import window).
	if not (bundle.get("bundleId") is String) or bundle["bundleId"] == "":
		return _refuse(CLAIMS_REJECTED)
	if not (bundle.get("trust") is String):
		return _refuse(CLAIMS_REJECTED)
	if not (bundle.get("aud") is String and product is String and bundle["aud"] == product):
		return _refuse(CLAIMS_REJECTED)
	if not (bundle.get("deviceId") is String and device_id is String and bundle["deviceId"] == device_id):
		return _refuse(CLAIMS_REJECTED)
	var issued = bundle.get("issuedAt")
	var expires = bundle.get("expiresAt")
	if not (PKeyClaims.is_number(issued) and PKeyClaims.is_number(expires)):
		return _refuse(CLAIMS_REJECTED)
	if issued > now + PKeyClaims.CLOCK_SKEW_SECONDS:
		return _refuse(CLAIMS_REJECTED)
	if now > expires + PKeyClaims.CLOCK_SKEW_SECONDS:
		return _refuse(CLAIMS_REJECTED)
	if not (bundle.get("docs") is Dictionary):
		return _refuse(CLAIMS_REJECTED)
	var docs_in: Dictionary = bundle["docs"]
	if docs_in.has("license") and not (docs_in["license"] is String):
		return _refuse(CLAIMS_REJECTED)
	if docs_in.has("config") and not (docs_in["config"] is String):
		return _refuse(CLAIMS_REJECTED)
	if not docs_in.has("license") and not docs_in.has("config"):
		return _refuse(CLAIMS_REJECTED)

	# 3. The inner manifest against the PINS, reload profile.
	var manifest := await PKeyTrust.verify_manifest(bundle["trust"], {
		"pinned": pinned, "expected_aud": product, "now": now, "check_freshness": false,
	})
	if manifest["doc"] == null:
		return _refuse(TRUST_REJECTED)
	var effective := PKeyTrust.merge(pinned, manifest["discovered"])

	# 4. Each inner document against the effective set, reload profile, local device id. No
	# anti-replay floor: an import establishes state on a device that has none.
	var reload := {
		"trust": effective, "expected_aud": product, "device_id": device_id, "now": now,
		"check_freshness": false,
	}
	var docs := {}
	if docs_in.has("license"):
		var doc = await PKeyVerify.verify_license_doc(docs_in["license"], reload)
		if doc == null:
			return _refuse(INNER_DOC_REJECTED)
		docs["license"] = {"jws": docs_in["license"], "doc": doc}
	if docs_in.has("config"):
		var doc = await PKeyVerify.verify_config_doc(docs_in["config"], reload)
		if doc == null:
			return _refuse(INNER_DOC_REJECTED)
		docs["config"] = {"jws": docs_in["config"], "doc": doc}

	return {
		"ok": true,
		"bundle": {
			"bundle_id": bundle["bundleId"],
			"trust_jws": bundle["trust"],
			"effective_trust": effective,
			"docs": docs,
		},
	}


static func _refuse(reason: String) -> Dictionary:
	return {"ok": false, "reason": reason}
