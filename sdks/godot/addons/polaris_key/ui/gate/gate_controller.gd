class_name PKeyGateController
extends RefCounted
## PKeyGate's headless logic: which screen a licence state renders, mirroring React's
## `screenFor` (packages/sdk-react/src/react/hooks.ts) and Swift's PolarisLoginView, and what each
## screen says. No node and no SDK call here, so a game drawing its own gate reuses it as is.
##
## Screens:
##   loading          the state is not known yet (before start())
##   usable           ok, not-applicable: the gate hides and emits `usable`
##   grace            grace while allow_grace: usable, with a non-blocking PKeyStatusBanner
##   grace-blocked    grace while allow_grace is false: blocks, connect and retry
##   activation       needs-activation: the activation panel
##   revoked          the device was signed out: say so, and offer sign-in / activation again
##   expired          Renew (when the host can renew) and Use another license; never Try again
##   update-required  version-too-old: "update required", with the outlet's action when known
##   not-available    version-too-new, channel-not-entitled: not available on this licence
##   error            needs-activation after an activation or sign-in error the gate describes
##   license-choice   a sign-in found several licenses for this device: PKeyLicenseChoice picks one
##
## A product without License never sees a gate: not-applicable comes first, before any error.

const SCREENS := ["loading", "usable", "grace", "grace-blocked", "activation", "revoked", "expired", "update-required", "not-available", "error", "license-choice"]


static func screen_for(status: String, loading := false, error := "", allow_grace := true, choosing := false) -> String:
	if loading:
		return "loading"
	if status == "not-applicable":
		return "usable"
	# A sign-in that found several licenses asks which this device uses, before anything else.
	if choosing:
		return "license-choice"
	if error != "" and status == "needs-activation":
		return "error"
	match status:
		"ok":
			return "usable"
		"grace":
			return "grace" if allow_grace else "grace-blocked"
		"needs-activation":
			return "activation"
		"revoked":
			return "revoked"
		"expired":
			return "expired"
		"version-too-old":
			return "update-required"
		"version-too-new", "channel-not-entitled":
			return "not-available"
	return "error"


## True when the screen lets the game run (the gate emits `usable`).
static func is_usable_screen(screen: String) -> bool:
	return screen == "usable" or screen == "grace"


## The screen's copy: {title, body, detail} as PKeyUiCopy keys (detail may carry an argument as
## [key, arg]); "" for none. `status` refines not-available's body.
static func copy_for(screen: String, status: String, allowed_range: Variant = null) -> Dictionary:
	# Five refusals, five screens (StatusScreen "Must not"): a channel the license does not include
	# says so under its own title, never "newer than your license allows".
	if screen == "not-available" and status == "channel-not-entitled":
		return {"title": "channel_not_entitled_title", "body": "channel_not_entitled_body", "detail": ""}
	match screen:
		"license-choice":
			# The choice has its own title and words.
			return {"title": "", "body": "", "detail": ""}
		"loading":
			return {"title": "", "body": "gate_loading", "detail": ""}
		"grace-blocked":
			return {"title": "boot_offline_title", "body": "grace_blocked_body", "detail": ""}
		"activation":
			return {"title": "", "body": "", "detail": ""}
		"revoked":
			return {"title": "revoked_title", "body": "", "detail": ""}
		"expired":
			return {"title": "expired_title", "body": "expired_body", "detail": ""}
		"update-required":
			var detail: Variant = ""
			if allowed_range is Dictionary and allowed_range.get("min") is String and allowed_range["min"] != "":
				detail = ["version_min", allowed_range["min"]]
			return {"title": "version_too_old_title", "body": "version_too_old_body", "detail": detail}
		"not-available":
			return {"title": "not_available_title", "body": "version_too_new_body" if status == "version-too-new" else "channel_not_entitled_body", "detail": ""}
		"error":
			return {"title": "gate_error_title", "body": "gate_error_body", "detail": ""}
	return {"title": "", "body": "", "detail": ""}


## Which controls a screen shows: {activation, retry, update_action, banner}.
static func controls_for(screen: String, has_update_action: bool) -> Dictionary:
	return {
		"activation": screen == "activation" or screen == "revoked" or screen == "error" or screen == "not-available",
		"retry": screen in ["grace-blocked", "update-required", "not-available", "error"],
		"update_action": screen == "update-required" and has_update_action,
		"banner": screen == "grace",
	}


# ── Automatic sign-in (I-48.9) ───────────────────────────────────────────────────────────────

## What the gate does with an automatic sign-in's answer: `signed-in` (the session exists: read the
## licence again), `confirm` (show the consent step), `choose` (the licence choice), `device-limit`
## (its own step), or `form` (nothing to show: the regular sign-in form stays).
static func auto_action(result: PKeyAutoSignInResult) -> String:
	if result == null:
		return "form"
	match result.kind:
		PKeyAutoSignInResult.KIND_SIGNED_IN:
			return "signed-in"
		PKeyAutoSignInResult.KIND_CONFIRM:
			return "confirm"
		PKeyAutoSignInResult.KIND_CHOOSE:
			return "choose"
		PKeyAutoSignInResult.KIND_DEVICE_LIMIT:
			return "device-limit"
	return "form"


## The consent step's drawing from the consent view: {email, license_line, anchor, also_gets, claims}.
## `license_line` is `existing` when the licence item names an anchor, `new` when it names none and
## `none` without a licence item; `anchor` is that licence's `{name, tierName, term, position, limit}`
## (`position` and `limit` 0 when it has no free seat to name; {} without an anchor); `also_gets` when
## this is a first sign-in or the consent changed; `claims` are the profile claims to send back with
## Continue.
static func consent_step(consent: Dictionary) -> Dictionary:
	var who = consent.get("as")
	var email: String = String(who.get("email")) if who is Dictionary and who.get("email") is String else ""
	var license_line := "none"
	var anchor := {}
	var claims: Array = []
	var items = consent.get("items")
	for item in (items if items is Array else []):
		if not (item is Dictionary):
			continue
		if item.get("kind") == "license":
			license_line = "existing" if item.get("anchor") is Dictionary else "new"
			if item.get("anchor") is Dictionary:
				anchor = _anchor_of(item["anchor"])
		elif item.get("kind") == "profile" and item.get("claims") is Array:
			for c in item["claims"]:
				if c is String and c != "" and not claims.has(c):
					claims.append(c)
	return {
		"email": email,
		"license_line": license_line,
		"anchor": anchor,
		"also_gets": PKeyClaims.is_true(consent.get("firstTime")) or PKeyClaims.is_true(consent.get("changed")),
		"claims": claims,
	}


## An anchor as the step draws it: the Worker's `{name, tierName, term, seat {position, limit} | null}`.
static func _anchor_of(a: Dictionary) -> Dictionary:
	var seat = a.get("seat")
	return {
		"name": String(a["name"]) if a.get("name") is String else "",
		"tierName": String(a["tierName"]) if a.get("tierName") is String else "",
		"term": a.get("term"),
		"position": int(seat["position"]) if seat is Dictionary and PKeyClaims.is_number(seat.get("position")) else 0,
		"limit": int(seat["limit"]) if seat is Dictionary and PKeyClaims.is_number(seat.get("limit")) else 0,
	}


## The https page "Replace a device" opens, or "" when the answer carries no usable link.
static func manage_link(result: PKeyAutoSignInResult) -> String:
	var url := result.manage_url if result != null else ""
	return url if url.begins_with("https://") and not url.contains(" ") else ""
