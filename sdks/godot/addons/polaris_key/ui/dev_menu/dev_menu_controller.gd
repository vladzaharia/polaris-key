class_name PKeyDevMenuController
extends RefCounted
## PKeyDevMenuSection's headless logic: the facts a developer or tester needs about this build,
## the channel picker's choices and lock, and the COPY DIAGNOSTICS text.
##
## The channel is locked when the build's outlet does not allow a channel switch
## (PKeyDecision.effective_capabilities(kind).channelSwitch: only a direct build may; a store,
## Steam or itch build takes its channel from the outlet). The editor has no outlet, so it is
## never locked there.
##
## Diagnostics carry the device id, outlet, channel, build, SDK and engine versions, the gate
## status and the last sync time. NEVER a token, a licence key, a secret or a document body.

const DIAGNOSTIC_KEYS := ["device", "outlet", "channel", "build", "sdk", "engine", "gate", "last_sync"]


## The facts: {device, outlet, channel, version, build, sdk, engine, platform, gate, last_sync}
## (last_sync: epoch seconds or null). Works before configure().
static func facts(sdk: Node) -> Dictionary:
	var info: Dictionary = sdk.build_info() if sdk != null and sdk.has_method("build_info") else {}
	var core = sdk.get("core") if sdk != null else null
	var gate := "needs-activation"
	var last_sync = null
	if sdk != null and sdk.has_method("status"):
		gate = String(sdk.status().get("status", gate))
	if core != null and core.started and core.cache != null:
		last_sync = core.cache.last_verified_at
	var engine := Engine.get_version_info()
	var outlet = info.get("outlet")
	return {
		"device": core.device_id if core != null else "",
		"outlet": outlet if outlet is String else "",
		"channel": String(core.channel) if core != null else String(info.get("channel", "")),
		"version": String(info.get("version", "")),
		"build": str(info.get("build", 0)),
		"sdk": _sdk_version(sdk),
		"engine": "%d.%d.%d" % [engine["major"], engine["minor"], engine["patch"]],
		"platform": String(info.get("platform", OS.get_name())),
		"gate": gate,
		"last_sync": last_sync,
	}


static func _sdk_version(sdk: Node) -> String:
	if sdk == null or sdk.get_script() == null:
		return ""
	return str(sdk.get_script().get_script_constant_map().get("SDK_VERSION", ""))


## The lock reason's outlet, or "" when the channel may be switched.
static func channel_lock(outlet: String, platform := "") -> String:
	if outlet == "" or outlet == "direct":
		return ""
	var caps := PKeyDecision.effective_capabilities(outlet, {"platform": platform})
	return "" if caps.get("channelSwitch") == true else outlet


## The channels to offer: the current one, stable, and every channel the licence entitles, in
## that order, without repeats.
static func channels(current: String, entitled: Array) -> Array:
	var out: Array = []
	for ch in [current, "stable"] + entitled:
		if ch is String and ch != "" and not out.has(ch):
			out.append(ch)
	return out


## The text COPY DIAGNOSTICS puts on the clipboard: one `key: value` line per fact, in
## DIAGNOSTIC_KEYS order. Never a credential.
static func diagnostics(f: Dictionary) -> String:
	var lines: PackedStringArray = []
	for k in PackedStringArray(DIAGNOSTIC_KEYS):
		var v = f.get(k)
		if k == "build":
			v = "%s (%s)" % [f.get("version", ""), f.get("build", "")]
		elif k == "last_sync":
			v = Time.get_datetime_string_from_unix_time(int(v), true) + "Z" if PKeyClaims.is_number(v) else "never"
		lines.append("%s: %s" % [k, str(v) if v != null and str(v) != "" else "-"])
	return "\n".join(lines)
