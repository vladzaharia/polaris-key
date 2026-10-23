class_name PKeyDeviceLimitController
extends RefCounted
## PKeyDeviceLimit's headless logic: the DeviceLimit model's input from what the game knows (the
## license's seats, the roster, the manage page), the model's view, and the device a Replace
## preselects (the least recently used one that is not this device). No node here.

const Models := preload("res://addons/polaris_key/ui/model/models.gd")
const DevicesModel := preload("res://addons/polaris_key/ui/model/devices.gd")


## The model input (ui-matrix.json `deviceLimit`). `state`: `{used, limit, devices, manage_url,
## pending, outcome, replaced, form_factor, os, pad, license}`; `devices` rows are `{id, name,
## platform, formFactor, lastSeenDays, current}`.
static func input(state: Dictionary) -> Dictionary:
	var activation := {}
	if int(state.get("used", -1)) >= 0:
		activation["deviceCount"] = int(state["used"])
	if int(state.get("limit", -1)) >= 0:
		activation["limit"] = int(state["limit"])
	if String(state.get("manage_url", "")) != "":
		activation["manageUrl"] = String(state["manage_url"])
	var out := {"activation": activation}
	var devices = state.get("devices")
	if devices is Array and not devices.is_empty():
		out["devices"] = devices
	if bool(state.get("pending", false)):
		out["pending"] = "replace"
	var outcome := String(state.get("outcome", ""))
	if outcome != "":
		out["replacement"] = {"outcome": outcome, "device": String(state.get("replaced", ""))}
	var platform := {}
	if String(state.get("os", "")) != "":
		platform["os"] = String(state["os"])
	if String(state.get("form_factor", "")) != "":
		platform["formFactor"] = String(state["form_factor"])
	if bool(state.get("pad", false)):
		platform["os"] = "tvos"
		platform["formFactor"] = "tv"
	if not platform.is_empty():
		out["platform"] = platform
	if not bool(state.get("license", true)):
		out["services"] = ["config", "release", "distribution", "update", "identity", "sync"]
	return out


static func view(inp: Dictionary) -> Dictionary:
	return Models.view_of("DeviceLimit", inp)


## The device Replace preselects, or null.
static func pick(devices: Array) -> Variant:
	return DevicesModel.least_recent(devices)


## The catalog key of the primary button ("" for none).
static func primary_of(v: Dictionary) -> String:
	var p = v.get("decisions", {}).get("primary")
	return "" if p == null else String(p)
