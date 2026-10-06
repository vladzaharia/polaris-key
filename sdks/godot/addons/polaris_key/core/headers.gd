class_name PKeyHeaders
extends RefCounted
## The seven `X-PKey-*` headers every product-scoped call carries (shared-protocol `core.ts`).
##
## Platform and arch are the canonical values of WIRE-CONTRACT-V3 §5.2: this runtime's own report
## (`OS.get_name()`, `Engine.get_architecture_name()`) looked up in the generated
## `PKeyConstants.PLATFORM_SPELLINGS` / `ARCH_SPELLINGS` after ASCII case folding. A spelling the
## table lacks has no value and its header is omitted rather than invented. `headers.json` pins
## the tables (tests/suite_conformance.gd runs every row).

const DEVICE := "X-PKey-Device"
const VERSION := "X-PKey-Version"
const CHANNEL := "X-PKey-Channel"
const SDK := "X-PKey-SDK"
const SDK_VERSION_HEADER := "X-PKey-SDK-Version"
const PLATFORM := "X-PKey-Platform"
const ARCH := "X-PKey-Arch"

## The short SDK id sent as `X-PKey-SDK` (§5.2); the version is `X-PKey-SDK-Version`.
const SDK_NAME := PKeyConstants.SdkId.GODOT


## A-Z become a-z; every other character is unchanged (never a locale-dependent lowercase).
static func _fold_ascii(raw: String) -> String:
	var out := ""
	for i in raw.length():
		var c := raw.unicode_at(i)
		out += String.chr(c + 32) if c >= 65 and c <= 90 else String.chr(c)
	return out


## A platform spelling to its canonical value, or "" when it has none (`macOS` -> `macos`).
static func canonical_platform(raw: String) -> String:
	return PKeyConstants.PLATFORM_SPELLINGS.get(_fold_ascii(raw), "")


## An architecture spelling to its canonical value, or "" when it has none (`arm32` -> `armv7`).
static func canonical_arch(raw: String) -> String:
	return PKeyConstants.ARCH_SPELLINGS.get(_fold_ascii(raw), "")


## This OS's canonical value; "" when it has none. The `X-PKey-Platform` header and the device
## metadata; build-target logic reads update_platform().
static func platform() -> String:
	return canonical_platform(OS.get_name())


## This OS's update platform (WIRE-CONTRACT-V4 §5.2 rule 5): platform() when it is a build target
## (`PKeyDecision.OUTLET_PLATFORMS["unknown"]`), else "". `tvos`, `visionos` and `watchos` are
## header values only, so on visionOS every build-target path behaves as it did before SP-08.
static func update_platform() -> String:
	return update_platform_for(platform())


## update_platform() for a given header value; split out so a test can check every value.
static func update_platform_for(header: String) -> String:
	return header if header != "" and PKeyDecision.OUTLET_PLATFORMS["unknown"].has(header) else ""


## This build's canonical architecture; "" when it has none.
static func arch() -> String:
	return canonical_arch(Engine.get_architecture_name())


## The headers as a name -> value Dictionary; unknown platform or arch are left out.
static func build(device_id: String, version: String, channel: String, sdk_version: String) -> Dictionary:
	var h := {
		DEVICE: device_id,
		VERSION: version,
		CHANNEL: channel,
		SDK: SDK_NAME,
		SDK_VERSION_HEADER: sdk_version,
	}
	if platform() != "":
		h[PLATFORM] = platform()
	if arch() != "":
		h[ARCH] = arch()
	return h
