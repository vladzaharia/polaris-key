extends RefCounted
## What a view model reads: the GDScript port of ui-core's `input.ts`. A screen maps the SDK's
## state onto one input Dictionary (ui-matrix.json `vocabulary.inputs`: `gate`, `activation`,
## `signIn`, `devices`, `update`, `config`, …) and every model reads only this context of it.
##
##   var ctx := Context.new({"gate": {"status": "needs-activation"}})
##   ctx.on("license")      # true: every service is on unless `services` lists them
##   ctx.caps["keyEntry"]   # true: a capability the input omits takes its default

const Vocabulary := preload("res://addons/polaris_key/ui/model/vocabulary.gd")

## What the build offers; a member the input leaves out takes this value.
const DEFAULT_CAPABILITIES := {
	"signIn": true,
	"keyEntry": true,
	"deviceCode": true,
	"offlineActivation": false,
	"trial": false,
	"restore": false,
	"purchase": false,
	"enroll": false,
}

## The raw input (never written).
var input: Dictionary
## The capabilities, defaults filled in.
var caps: Dictionary
## `{os, formFactor}`, or null when the input names no platform.
var platform: Variant
## `open`, `requires-identity` or `requires-license` (the default).
var registration: String
var _enabled: Dictionary = {}


func _init(raw: Dictionary = {}) -> void:
	input = raw
	caps = DEFAULT_CAPABILITIES.duplicate()
	var c = raw.get("capabilities")
	if c is Dictionary:
		for k in c:
			caps[k] = c[k]
	var p = raw.get("platform")
	platform = p if p is Dictionary else null
	var r = raw.get("registration")
	registration = r if r is String else "requires-license"
	var services = raw.get("services")
	for s in (services if services is Array else Vocabulary.service_slugs()):
		_enabled[String(s)] = true


## True when the service `slug` is enabled.
func on(slug: String) -> bool:
	return _enabled.has(slug)


## `input[key]` when it is a Dictionary, else {} (a member the input omits).
func member(key: String) -> Dictionary:
	var v = input.get(key)
	return v if v is Dictionary else {}


## `input[key]` when it is present and not null.
func has(key: String) -> bool:
	return input.get(key) != null


## The enabled services left when `off` are turned off, closed under `requires` (ST-38).
static func services_without(off: Array) -> Array:
	var down := {}
	for s in off:
		down[s] = true
	var changed := true
	while changed:
		changed = false
		for s in Vocabulary.SERVICES:
			if down.has(s["slug"]):
				continue
			for r in s["requires"]:
				if down.has(r):
					down[s["slug"]] = true
					changed = true
					break
	var out := []
	for slug in Vocabulary.service_slugs():
		if not down.has(slug):
			out.append(slug)
	return out


# ── Platform ────────────────────────────────────────────────────────────────────────────────
#
# How a platform is laid out:
#
#   desktop   a Mac, Windows or Linux computer: the browser is one click away, no QR
#   web       a page in a browser
#   handheld  a phone or tablet: browses, coarse pointer, no QR (DL14)
#   tv        a TV that cannot browse: a QR beside the code, the address on its own line
#   console   a pad-only screen (Godot on a TV, a handheld in game mode): a QR the person can
#             enlarge, the address inside the sentence


static func platform_class(p: Variant) -> String:
	if not (p is Dictionary):
		return "desktop"
	var os := String(p.get("os", ""))
	var ff := String(p.get("formFactor", ""))
	if ff == "tv":
		return "tv" if os == "android" or os == "tvos" else "console"
	if os == "web":
		return "web"
	if ff in ["iphone", "ipad", "phone", "tablet"] or os in ["ios", "android", "watchos", "visionos"]:
		return "handheld"
	return "desktop"


## True where the device can open a browser itself (never a TV or a pad-only screen).
static func can_browse(p: Variant) -> bool:
	var c := platform_class(p)
	return c != "tv" and c != "console"


## True where a pointer is coarse: a text field is never focused on appear (DL9).
static func coarse_pointer(p: Variant) -> bool:
	var c := platform_class(p)
	return c == "handheld" or c == "tv" or c == "console"


## True where a destructive Replace opens the platform's own confirmation (SIGN-IN.md §3.6 step
## 3b, D-80): macOS, iOS, iPadOS, Android and GNOME; on Windows only inline, and never on the
## web, on a TV or on a pad-only screen.
static func system_confirm(p: Variant, presentation: String) -> bool:
	var c := platform_class(p)
	if c == "web" or c == "tv" or c == "console":
		return false
	if p is Dictionary and p.get("os") == "windows":
		return presentation == "inline"
	return true
