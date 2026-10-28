class_name PKeyAccountController
extends RefCounted
## PKeyAccountTab's headless logic: what the Account and license pane knows (the tier, who is signed
## in, the seats, the update channel and version) read off the SDK, and the model input
## (ui-matrix.json `settings` family, AccountAndLicense) a view reads. No node here, so a game
## drawing its own account page reuses it as is.

const Models := preload("res://addons/polaris_key/ui/model/models.gd")

## The enforced entitlements that name the tier and the seats (`license.tierLabel`, `license.tier`,
## `deviceLimit`; shared-protocol/src/license.ts).
const TIER_KEYS := ["license.tierLabel", "license.tier"]

## The channels the pane offers beside the current one.
const CHANNELS := ["stable", "beta"]


## The enabled services (tools/services.json slugs) of this SDK: the opt-in services the product runs.
static func services(sdk: Node) -> Array:
	var out: Array = []
	if sdk == null or sdk.get("core") == null or sdk.core == null:
		return ["license", "config", "release", "distribution", "update", "identity", "commerce"]
	for slug in ["license", "config", "release", "distribution", "update", "identity", "commerce", "sync"]:
		if sdk.core.enabled(slug):
			out.append(slug)
	return out


## What the pane shows, read off the SDK: `{tier, holder, signed_in, status, devices_limit, channel,
## channel_locked, version}`. Anything the SDK does not know is empty or null.
static func facts(sdk: Node) -> Dictionary:
	var out := {"tier": "", "holder": "", "signed_in": false, "status": "", "devices_limit": null, "channel": "", "channel_locked": "", "version": ""}
	if sdk == null:
		return out
	var st: Dictionary = sdk.status() if sdk.has_method("status") else {}
	out["status"] = String(st.get("status", ""))
	if sdk.get("entitlements") != null:
		var ents: Dictionary = sdk.entitlements.all()
		for k in TIER_KEYS:
			if ents.get(k) is String and ents[k] != "":
				out["tier"] = ents[k]
				break
		if PKeyClaims.is_number(ents.get("deviceLimit")):
			out["devices_limit"] = int(ents["deviceLimit"])
	if sdk.get("identity") != null:
		var who = sdk.identity.current()
		if who is Dictionary:
			out["signed_in"] = true
			out["holder"] = String(who["name"]) if who.get("name") is String else String(who.get("email", ""))
	if sdk.get("update") != null:
		out["channel"] = sdk.update.get_channel()
		out["channel_locked"] = sdk.update.channel_lock()
	if sdk.has_method("build_info"):
		out["version"] = String(sdk.build_info().get("version", ""))
	return out


## The model input for the pane. `state`: `{signed_in, status, loading, elapsed_ms, services,
## powered_by, platform}`.
static func input(state: Dictionary) -> Dictionary:
	var out := {"account": {"signedIn": bool(state.get("signed_in", false)), "holder": "account"}}
	if state.get("status", "") != "":
		var gate := {"status": state["status"]}
		out["gate"] = gate
	if bool(state.get("loading", false)):
		out["loading"] = true
		if state.get("elapsed_ms") != null:
			out["elapsedMs"] = state["elapsed_ms"]
	var services = state.get("services")
	if services is Array and not services.is_empty():
		out["services"] = services
	if bool(state.get("powered_by", false)):
		out["integrator"] = {"poweredBy": "line"}
	if state.get("platform") is Dictionary:
		out["platform"] = state["platform"]
	return out


static func view(inp: Dictionary) -> Dictionary:
	return Models.view_of("AccountAndLicense", inp)


## The word for a license status (`part.status.*`), or "" for one the catalog has no word for.
static func status_key(status: String) -> String:
	match status:
		"ok":
			return "status_ok"
		"grace":
			return "status_grace"
		"expired":
			return "status_expired"
		"revoked":
			return "status_revoked"
		"needs-activation":
			return "status_inactive"
		"version-too-old", "version-too-new", "channel-not-entitled":
			return "status_blocked"
	return ""


## An email masked for a screen others can see (`m•••@fennick.studio`) and revealed on focus.
static func mask_email(email: String) -> String:
	var at := email.find("@")
	if at < 1:
		return email
	return email.substr(0, 1) + "•••" + email.substr(at)
