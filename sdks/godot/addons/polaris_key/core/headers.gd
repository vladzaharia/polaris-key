class_name PKeyHeaders
extends RefCounted
## The seven `X-PKey-*` headers every product-scoped call carries (shared-protocol `core.ts`).
##
## No canonical platform or arch vocabulary exists yet (report §9.1 #17), so this is the one
## table, in the report's vocabulary (§3.1); anything else is omitted rather than invented.
## P1b-02 generates `core/constants_generated.gd` to replace it and P1b-04's `headers.json` pins
## the mapping.

const DEVICE := "X-PKey-Device"
const VERSION := "X-PKey-Version"
const CHANNEL := "X-PKey-Channel"
const SDK := "X-PKey-SDK"
const SDK_VERSION_HEADER := "X-PKey-SDK-Version"
const PLATFORM := "X-PKey-Platform"
const ARCH := "X-PKey-Arch"

## The SDK id (notes/A2 §5.4) until P1b-04 settles the short ids.
const SDK_NAME := "polaris-key-godot"

## OS.get_name() -> X-PKey-Platform.
const PLATFORMS := {
	"Windows": "windows",
	"macOS": "macos",
	"Linux": "linux",
	"iOS": "ios",
	"Android": "android",
	"Web": "web",
}

## Engine.get_architecture_name() -> X-PKey-Arch.
const ARCHS := {
	"x86_64": "x86_64",
	"arm64": "arm64",
	"arm32": "armv7",
	"wasm32": "wasm32",
}


## "" when this OS is outside the table.
static func platform() -> String:
	return PLATFORMS.get(OS.get_name(), "")


## "" when this architecture is outside the table.
static func arch() -> String:
	return ARCHS.get(Engine.get_architecture_name(), "")


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
