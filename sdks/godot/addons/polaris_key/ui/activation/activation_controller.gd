class_name PKeyActivationController
extends RefCounted
## PKeyActivationPanel's headless logic: which ways to activate this build offers, and the human
## copy for every PKeyActivationResult kind (Swift's PolarisLoginView is the model).
##
##   key entry          only when License is enabled (a key activates a licence)
##   Sign in            only when PolarisKey.identity.is_available()
##   Continue free      only when the game offers keyless enrolment, License is enabled, and
##                      never on web (a browser has no machine anchor)
##   Offline activation only when License is enabled (a bundle carries a licence)


## {key_entry, sign_in, continue_free, offline} for these capabilities.
static func capabilities(license_enabled: bool, identity_available: bool, offer_enrollment: bool, web: bool) -> Dictionary:
	return {
		"key_entry": license_enabled,
		"sign_in": identity_available,
		"continue_free": license_enabled and offer_enrollment and not web,
		"offline": license_enabled,
	}


## The capabilities read from a configured PolarisKey node (D-21: discovery, else
## expected_services). Without one (or before configure()) nothing is offered.
static func capabilities_from(sdk: Node, offer_enrollment: bool, web := OS.has_feature("web")) -> Dictionary:
	if sdk == null or sdk.get("core") == null:
		return capabilities(false, false, false, web)
	var core: PKeyCore = sdk.core
	return capabilities(core.enabled("license"), sdk.identity.is_available(), offer_enrollment, web)


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
	return ["activation_error", null]
