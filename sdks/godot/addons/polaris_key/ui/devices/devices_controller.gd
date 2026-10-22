class_name PKeyDevicesController
extends RefCounted
## PKeyDeviceList's headless logic: the roster PolarisKey.devices.list() returns as the rows the
## Devices model reads (ui-matrix.json `devices`: `{name, platform, formFactor, lastSeenDays,
## current}`), how long ago a device was last used, and which device a row names. No node and no SDK
## call here, so a game drawing its own device list reuses it as is.

const Models := preload("res://addons/polaris_key/ui/model/models.gd")
const Vocabulary := preload("res://addons/polaris_key/ui/model/vocabulary.gd")

## The form factor a canonical platform implies (the roster carries no form factor of its own).
const FORM_FACTORS := {
	"macos": "mac",
	"windows": "computer",
	"linux": "computer",
	"steamos": "computer",
	"chromeos": "computer",
	"freebsd": "computer",
	"ios": "iphone",
	"ipados": "ipad",
	"android": "phone",
	"tvos": "tv",
	"visionos": "other",
	"watchos": "other",
	"web": "computer",
}


## The rows of a roster answer: `detail` is PKeyDevices.list()'s `{current_device_id, devices,
## roster}`; `now` is epoch seconds. A device without a label has no name (the row says
## "Unnamed device", never an id).
static func rows(detail: Dictionary, now: float) -> Array:
	var out: Array = []
	var devices = detail.get("devices")
	var current_id := String(detail.get("current_device_id", ""))
	for d in (devices if devices is Array else []):
		if not (d is Dictionary):
			continue
		var platform := String(d.get("platform", ""))
		var label = d.get("label")
		var seen = d.get("last_seen")
		out.append({
			"id": d.get("id"),
			"name": label if label is String and label != "" else null,
			"platform": platform,
			"formFactor": FORM_FACTORS.get(platform, "other"),
			"lastSeenDays": days_ago(seen, now),
			"current": bool(d.get("current", false)) or (current_id != "" and d.get("id") == current_id),
		})
	return out


## Whole days between `seen` (epoch seconds) and `now`; null when the device was never seen.
static func days_ago(seen: Variant, now: float) -> Variant:
	if not PKeyClaims.is_number(seen):
		return null
	return maxi(0, int(floor((now - float(seen)) / 86400.0)))


## The Devices model's input (ui-matrix.json `devices` family): the rows, the edit in flight, an
## error, the loading flag and how long it has been loading.
static func input(list: Array, edit: Dictionary = {}, error: Variant = null, loading := false, browser_mode := false, elapsed_ms: Variant = null, extra: Dictionary = {}) -> Dictionary:
	var out := {"devices": _plain(list)}
	if not edit.is_empty():
		out["edit"] = edit
	if error != null:
		out["error"] = error if error is Dictionary else {"code": str(error)}
	if loading:
		out["loading"] = true
	if browser_mode:
		out["browserMode"] = true
	if elapsed_ms != null:
		out["elapsedMs"] = elapsed_ms
	for k in extra:
		out[k] = extra[k]
	return out


## The model view of an input.
static func view(inp: Dictionary) -> Dictionary:
	return Models.view_of("Devices", inp)


## The rows with only the members the model reads (an `id` is the view's own).
static func _plain(list: Array) -> Array:
	var out: Array = []
	for r in list:
		if r is Dictionary:
			var row := (r as Dictionary).duplicate()
			row.erase("id")
			out.append(row)
	return out


## The form factor a row is drawn with (an unknown one is `other`).
static func form_factor(row: Dictionary) -> String:
	var f := String(row.get("formFactor", "other"))
	return f if Vocabulary.FORM_FACTORS.has(f) else "other"


## The row's copy key for "This <form factor>".
static func this_device_key(row: Dictionary) -> String:
	return "this_device_" + form_factor(row)


## The row's copy key for its form factor's name (a screen reader reads it for the glyph).
static func form_factor_key(row: Dictionary) -> String:
	return "form_factor_" + form_factor(row)


## The copy key naming a platform, or "" for one the catalog has no word for.
static func platform_key(platform: String) -> String:
	return "platform_" + platform if PKeyUiCopy.DEFAULTS.has("platform_" + platform) else ""
