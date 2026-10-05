class_name PKeyDistribution
extends RefCounted
## `PolarisKey.distribution`: where the product can be got (SDK parity §3.8). A typed read of the
## public download model, `GET /<p>/distribution/download.json`, the document the hosted download
## page renders (P2b-06): the stable channel's platforms, the ways to get each (store links,
## direct builds with size and SHA-256, deep links, paste commands) and the newest release.
##
##   var m := await PolarisKey.distribution.download_model()   # PKeyResult, detail = the model
##   var here := PolarisKey.distribution.this_platform(m.detail) # {platform, primary, others, builds}
##
## The document is unsigned and public (no device token): show it, never trust it for an install.
## A verified install goes through PolarisKey.update (the signed feed and release record).
## Refusals: `not-configured`, `service-unavailable` (Distribution off), the server's code (a
## product without a public page answers `not_found`), `invalid-response`.

## The download model's own version this client reads (DOWNLOAD_MODEL_VERSION).
const MODEL_VERSION := 1
## The platforms the model groups by (core/platformDetect.ts PAGE_PLATFORMS).
const PAGE_PLATFORMS := ["ios", "android", "macos", "windows", "linux"]

var _core_ref: WeakRef = null
## The last model download_model() returned, or null.
var last_model: Variant = null


func attach(core: PKeyCore) -> void:
	_core_ref = weakref(core)
	last_model = null


func _core() -> PKeyCore:
	return _core_ref.get_ref() as PKeyCore if _core_ref != null else null


## The public download model. A coroutine.
func download_model() -> PKeyResult:
	var core := _core()
	if core == null:
		return PKeyResult.failure(PKeyErrors.NOT_CONFIGURED, "Call configure() first.")
	var off = core.require_service("distribution", PKeyConstants.Feature.RELEASE_DOWNLOAD)
	if off != null:
		return off
	var r := await core.request("GET", "distribution/download.json")
	if not r.ok:
		return r
	var parsed := PKeyJson.parse_bytes(r.detail["body"])
	var m = parsed["value"] if parsed["ok"] else null
	if not (m is Dictionary) or not PKeyClaims.is_number(m.get("schemaVersion")) or not (m.get("platforms") is Array) or not (m.get("actions") is Array):
		return PKeyResult.failure(PKeyErrors.INVALID_RESPONSE, "distribution/download.json is not a download model.", {"status": r.detail.get("status", 0)})
	if int(m["schemaVersion"]) > MODEL_VERSION:
		# A newer model keeps its old fields' meaning only up to its version: read what we know.
		m["schemaVersionUnread"] = int(m["schemaVersion"])
	last_model = m
	return PKeyResult.success(m)


## The model's view for one platform (default: this device's): {platform, label, primary (the
## action to offer first, or null), others (the rest, best first), builds (newest first)}, or {}
## when the model has nothing for it. `model`: a download_model() detail (default: the last one).
func this_platform(model: Variant = null, platform := "") -> Dictionary:
	var m = model if model is Dictionary else last_model
	if not (m is Dictionary):
		return {}
	var want := platform if platform != "" else page_platform(PKeyHeaders.platform())
	var actions := {}
	for a in m.get("actions", []):
		if a is Dictionary and a.get("id") is String:
			actions[a["id"]] = a
	for g in m.get("platforms", []):
		if not (g is Dictionary) or g.get("platform") != want:
			continue
		var ordered: Array = []
		for id in g.get("actions", []):
			if actions.has(id):
				ordered.append(actions[id])
		var primary = actions.get(g.get("primary")) if g.get("primary") is String else (ordered[0] if not ordered.is_empty() else null)
		var others := ordered.filter(func(a): return a != primary)
		return {"platform": want, "label": String(g.get("label", want)), "primary": primary, "others": others, "builds": g.get("builds", []) if g.get("builds") is Array else []}
	return {}


## The page platform for an X-PKey-Platform value ("" for web and anything unlisted).
static func page_platform(p: String) -> String:
	return p if PAGE_PLATFORMS.has(p) else ""
