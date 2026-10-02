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
##   expired          ask the player to connect, and retry (sync(true))
##   update-required  version-too-old: "update required", with the outlet's action when known
##   not-available    version-too-new, channel-not-entitled: not available on this licence
##   error            needs-activation after an activation or sign-in error the gate describes
##
## A product without License never sees a gate: not-applicable comes first, before any error.

const SCREENS := ["loading", "usable", "grace", "grace-blocked", "activation", "revoked", "expired", "update-required", "not-available", "error"]


static func screen_for(status: String, loading := false, error := "", allow_grace := true) -> String:
	if loading:
		return "loading"
	if status == "not-applicable":
		return "usable"
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
	match screen:
		"loading":
			return {"title": "", "body": "gate_loading", "detail": ""}
		"grace-blocked":
			return {"title": "grace_title", "body": "grace_blocked_body", "detail": ""}
		"activation":
			return {"title": "", "body": "", "detail": ""}
		"revoked":
			return {"title": "revoked_title", "body": "revoked_body", "detail": ""}
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
		"activation": screen == "activation" or screen == "revoked" or screen == "error",
		"retry": screen in ["grace-blocked", "expired", "update-required", "not-available", "error"],
		"update_action": screen == "update-required" and has_update_action,
		"banner": screen == "grace",
	}
