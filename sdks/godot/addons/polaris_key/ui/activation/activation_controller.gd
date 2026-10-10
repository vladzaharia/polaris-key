class_name PKeyActivationController
extends RefCounted
## PKeyActivationPanel's headless logic: which ways to activate this build offers, and the human
## copy for every PKeyActivationResult kind (Swift's PolarisLoginView is the model).
##
##   key entry          only when License is enabled (a key activates a licence), and never on
##                      a build whose outlet sells through its own store (the effective
##                      capabilities' commerce `store-iap`: App Store, TestFlight, Play, Microsoft
##                      Store; store rules)
##   Sign in            only when PolarisKey.identity.is_available()
##   Continue free      only when the game offers keyless enrolment, License is enabled, and
##                      never on web (a browser has no machine anchor)
##   Offline activation only when License is enabled (a bundle carries a licence), and not on a
##                      store build either
##   Replace a device   only after a device-limit result that carries `manage_url` (PX-W8): a
##                      button that opens the portal, or a QR code where the player has no
##                      browser at hand (manage_presentation)


## Outlets whose store rules forbid unlocking with an externally bought key (App Store 3.1.1, Google
## Play's payments policy, the Microsoft Store's): key entry and offline activation are hidden there
## automatically, decided by the outlet's effective capabilities (`commerce: store-iap`, narrowed by
## platform and subkind), never by a list of its own. `PKeyActivationPanel.allow_key_entry_on_store`
## overrides it (a game sold only outside the store, a B2B build).
const STORE_COMMERCE := "store-iap"

## Runtimes whose players have a browser on the same device.
const _BROWSER_OS := ["Windows", "macOS", "Linux", "FreeBSD", "NetBSD", "OpenBSD", "BSD", "Web", "Android", "iOS"]


## True when an outlet of this kind (on `platform`, with `subkind`) is a store whose rules hide key
## entry: its effective capabilities' commerce is the store's own.
static func store_hides_key_entry(outlet_kind: String, platform := "", subkind: Variant = null) -> bool:
	var caps := PKeyDecision.effective_capabilities(outlet_kind, {"platform": platform, "subkind": subkind, "server": null})
	return caps.get("commerce") == STORE_COMMERCE


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
	var outlet: Dictionary = core.update_outlet()
	var store := not allow_key_on_store and store_hides_key_entry(String(outlet.get("kind", "")), core.update_platform(), outlet.get("subkind"))
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
		PKeyActivationResult.KIND_ERROR:
			# A transport or verification failure reads by its code where the kit has a line for it
			# (no connection, a timeout, a license document that did not verify).
			if r.code != &"" and PKeyUiCopy.DEFAULTS.has("error_" + String(r.code)):
				return PKeyUiCopy.code_key(r.code)
	return ["activation_error", null]


## The link "Replace a device" opens for a result, or "" when it offers none: the served
## `manage_url` with the key as a fragment (on an `/activate` link only) and the game's return URL
## added (PX-W8, WIRE-CONTRACT-V4 §5.3). A QR link (`for_qr`) never carries the key: a code on a
## shared screen can be scanned by anyone in the room, so the phone's page asks for the key.
static func manage_link(r: PKeyActivationResult, key := "", return_url := "", for_qr := false) -> String:
	if r == null or r.kind != PKeyActivationResult.KIND_DEVICE_LIMIT or not PKeyManage.is_valid(r.manage_url):
		return ""
	var url: String = r.manage_url if for_qr else PKeyManage.with_key(r.manage_url, key)
	return PKeyManage.with_return(url, return_url)


## "button" where the player can open a browser on this device; "qr" where a joypad is the only
## input (a console, or a TV: a phone-class OS with no touchscreen and a joypad connected).
static func manage_presentation(os_name: String, touchscreen: bool, joypads: int) -> String:
	if not os_name in _BROWSER_OS:
		return "qr"
	if (os_name == "Android" or os_name == "iOS") and not touchscreen and joypads > 0:
		return "qr"
	return "button"


## manage_presentation for the running device.
static func manage_presentation_here() -> String:
	return manage_presentation(OS.get_name(), DisplayServer.is_touchscreen_available(), Input.get_connected_joypads().size())
