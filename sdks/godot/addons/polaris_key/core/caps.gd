class_name PKeyCaps
extends RefCounted
## `supports(feature)` (P1b-10, PARITY §2.2): whether a parity feature works here, and why not.
##
## Backed by the capability table generated from sdks/godot/parity.json into
## `PKeyConstants.capabilities()` (tools/capabilities.ts): per feature the manifest's status, the
## owning service and every declared (runtime, reason) N/A. The order is the same in every SDK:
##
##   1. an unknown feature id                         -> `version` (this SDK predates it)
##   2. a `runtime` N/A on this runtime (any declared  -> that reason
##      reason when the feature is `na` here)
##   3. a `planned` feature                           -> `version`
##   4. an opt-in service the product runs no longer   -> `product` (discovery, else
##                                                       expected_services, else the default)
##   5. a declared N/A with another reason here       -> its detector's answer, when non-empty
##   6. otherwise                                     -> supported
##
## The answer is a PKeyResult: ok with detail {feature}, or `code == &"unsupported"` with detail
## {feature, reason, detail}. Side-effect free and offline: nothing is probed by calling it.
## Main-thread API: it never iterates a const Array (the table is a fresh Dictionary per call).

## This runtime's id in the parity registry: web, android, ios, macos, windows or linux.
var runtime := ""
## slug -> {"enabled": bool}, the client's current capability map.
var services_provider: Callable
## "feature|reason" -> Callable() -> String: the detail when unsupported, "" when supported.
## PKeyCore registers devices.attest's `outlet` detector (PKeyDevices.attest_outlet_detail).
var detectors: Dictionary = {}
## The SDK version named in a `version` detail.
var sdk_version := ""
## feature -> row; defaults to the generated table (tests replace it).
var table: Dictionary = {}


func _init(p_services_provider: Callable = Callable(), p_sdk_version := "", p_runtime := "") -> void:
	services_provider = p_services_provider
	sdk_version = p_sdk_version
	runtime = p_runtime if p_runtime != "" else detect_runtime()
	table = PKeyConstants.capabilities()


## The canonical platform is the runtime id (linuxbsd -> linux, …).
static func detect_runtime() -> String:
	return PKeyHeaders.update_platform()


func supports(feature: String) -> PKeyResult:
	return supports_on(feature, runtime)


## `supports` as if on `on_runtime` (a service whose host is replaced in tests).
func supports_on(feature: String, on_runtime: String) -> PKeyResult:
	if not table.has(feature):
		return PKeyResult.unsupported(feature, PKeyConstants.UnsupportedReason.VERSION, "%s %s does not know the feature %s." % [PKeyHeaders.SDK_NAME, sdk_version, feature])
	var row: Dictionary = table[feature]
	var here: Array = []
	for na in row["na"]:
		if na["runtime"] == on_runtime:
			here.append(na)
	for na in here:
		if na["reason"] == PKeyConstants.UnsupportedReason.RUNTIME or row["status"] == "na":
			return PKeyResult.unsupported(feature, na["reason"], "%s is not available on %s." % [feature, on_runtime])
	if row["status"] == "planned":
		return PKeyResult.unsupported(feature, PKeyConstants.UnsupportedReason.VERSION, "%s %s does not implement %s yet." % [PKeyHeaders.SDK_NAME, sdk_version, feature])
	var services := _services()
	var service: String = row["service"]
	if services.has(service) and not PKeyClaims.is_true(services[service].get("enabled", false)):
		return PKeyResult.unsupported(feature, PKeyConstants.UnsupportedReason.PRODUCT, "The product does not run the %s service." % service)
	for na in here:
		var detector = detectors.get("%s|%s" % [feature, na["reason"]])
		var detail := String(detector.call()) if detector is Callable and detector.is_valid() else ""
		if detail != "":
			return PKeyResult.unsupported(feature, na["reason"], detail)
	return PKeyResult.success({"feature": feature})


## The feature ids supported right now, in registry order: the report's `caps`.
func caps() -> Array:
	var out: Array = []
	for feature in table:
		if supports(feature).ok:
			out.append(feature)
	return out


## Why the detectors and the table disagree ("" entries: none). Every conditional N/A declared
## for this runtime needs a detector, and every detector must name a conditional N/A the table
## declares on some runtime.
func validate() -> PackedStringArray:
	var problems := PackedStringArray()
	var conditional := {}
	for feature in table:
		var row: Dictionary = table[feature]
		if row["status"] == "na":
			continue
		for na in row["na"]:
			if na["reason"] == PKeyConstants.UnsupportedReason.RUNTIME:
				continue
			var key := "%s|%s" % [feature, na["reason"]]
			conditional[key] = true
			if na["runtime"] == runtime and not detectors.has(key):
				problems.append("%s declares %s on %s, but no detector decides it." % [feature, na["reason"], runtime])
	for key in detectors:
		if not conditional.has(key):
			problems.append("detector %s names no conditional N/A in the capability table." % key)
	return problems


func _services() -> Dictionary:
	if services_provider.is_valid():
		var s = services_provider.call()
		if s is Dictionary:
			return s
	return PKeyDiscovery.default_services()
