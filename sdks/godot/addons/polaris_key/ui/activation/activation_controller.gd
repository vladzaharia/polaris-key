class_name PKeyActivationController
extends RefCounted
## PKeyActivationPanel's headless logic: which ways to activate this build offers, and the human
## copy for every PKeyActivationResult kind (Swift's PolarisLoginView is the model).
##
##   key entry          only when License is enabled (a key activates a licence), and never on
##                      an App Store, TestFlight or Play build (store rules; STORE_OUTLETS)
##   Sign in            only when PolarisKey.identity.is_available()
##   Continue free      only when the game offers keyless enrolment, License is enabled, and
##                      never on web (a browser has no machine anchor)
##   Offline activation only when License is enabled (a bundle carries a licence), and not on a
##                      store build either


## The outlet kinds whose store rules forbid unlocking with an externally bought key (App Store
## 3.1.1, Google Play's payments policy): key entry and offline activation are hidden there
## automatically. `PKeyActivationPanel.allow_key_entry_on_store` overrides it (a game sold only
## outside the store, a B2B build).
const STORE_OUTLETS := ["app-store", "testflight", "play", "play-testing"]


## True when this build's outlet is a store whose rules hide key entry.
static func store_hides_key_entry(outlet_kind: String) -> bool:
	return STORE_OUTLETS.has(outlet_kind)


## {key_entry, sign_in, continue_free, offline} for these capabilities.
static func capabilities(license_enabled: bool, identity_available: bool, offer_enrollment: bool, web: bool, store_outlet := false) -> Dictionary:
	return {
		"key_entry": license_enabled and not store_outlet,
		"sign_in": identity_available,
		"continue_free": license_enabled and offer_enrollment and not web,
		"offline": license_enabled and not store_outlet,
	}


## The capabilities read from a configured PolarisKey node (D-21: discovery, else
## expected_services). Without one (or before configure()) nothing is offered.
static func capabilities_from(sdk: Node, offer_enrollment: bool, web := OS.has_feature("web"), allow_key_on_store := false) -> Dictionary:
	if sdk == null or sdk.get("core") == null:
		return capabilities(false, false, false, web)
	var core: PKeyCore = sdk.core
	var store := not allow_key_on_store and store_hides_key_entry(String(core.update_outlet().get("kind", "")))
	return capabilities(core.enabled("license"), sdk.identity.is_available(), offer_enrollment, web, store)


## [copy key, args] for an activation result: activation_ok, or the error copy for its kind.
static func message_for(r: PKeyActivationResult) -> Array:
	if r == null:
		return ["activation_error", null]
	match r.kind:
		PKeyActivationResult.KIND_OK:
			return ["activation_ok", null]
		PKeyActivationResult.KIND_DEVICE_LIMIT:
			if r.limit != null and r.device_count != null:
				return ["activation_device_limit_count", [str(r.device_count), str(r.limit)]]
			return ["activation_device_limit", null]
		PKeyActivationResult.KIND_UNAUTHORIZED:
			return ["activation_unauthorized", null]
		PKeyActivationResult.KIND_FINGERPRINT_REQUIRED:
			return ["activation_fingerprint_required", null]
		PKeyActivationResult.KIND_ENROLL_DISABLED:
			return ["activation_enroll_disabled", null]
		PKeyActivationResult.KIND_ENROLL_CLAIMED:
			return ["activation_enroll_claimed", null]
		PKeyActivationResult.KIND_LICENSE_DISABLED:
			return ["activation_license_disabled", null]
		PKeyActivationResult.KIND_HARDWARE_MISMATCH:
			return ["activation_hardware_mismatch", null]
		PKeyActivationResult.KIND_RATE_LIMITED:
			return ["activation_rate_limited", null]
		PKeyActivationResult.KIND_UNSUPPORTED:
			return ["activation_unsupported", null]
		PKeyActivationResult.KIND_LICENSE_EXPIRED:
			return ["activation_license_expired", null]
		PKeyActivationResult.KIND_ATTESTATION_REQUIRED:
			return ["activation_attestation_required", null]
		PKeyActivationResult.KIND_REFUSED:
			return PKeyUiCopy.code_key(r.code)
	return ["activation_error", null]
