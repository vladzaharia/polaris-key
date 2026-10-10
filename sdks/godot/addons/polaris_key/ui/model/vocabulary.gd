extends RefCounted
## The closed vocabularies the kit's view models speak (conformance/corpus/v2/ui-matrix.json
## `vocabulary`, plans/UK-02b.md §4): the GDScript port of ui-core's `vocabulary.ts`. The matrix
## pins them for every language; a screen reads them from here instead of spelling a string.

## The UI matrix version these models implement (the generated `UI_MATRIX_VERSION`).
const UI_MATRIX_VERSION := 3

## UI-KITS.md §4.1: every component, must and should.
const COMPONENTS := [
	"PolarisKeyGate", "Boot", "Welcome", "SignIn", "SignInHandoff", "Activate",
	"OfflineActivation", "DeviceLimit", "LicenseChoice", "Devices", "UpdatePrompt",
	"UpdateProgress", "ReleaseNotes", "StatusScreen", "GraceBanner", "AccountAndLicense",
	"Settings", "Paywall", "EntitlementGate", "CloudSyncStatus", "About", "ChannelPicker", "Toast",
]

## The reserved state of a component its service turns off: the drop-in renders nothing.
const HIDDEN := "hidden"

## The actions a view offers, named by what they do (`vocabulary.actions`).
const ACTIONS := ["open-card", "open-browser", "replace-in-browser", "open-manage-url", "copy-link", "retry", "cancel"]

## Which controls perform each action, by their label's copy key (`vocabulary.actionKeys`).
const ACTION_KEYS := {
	"open-card": ["signin.desktop.continue", "signin.email.continue"],
	"open-browser": ["signin.handoff.again", "signin.handoff.openBrowser"],
	"replace-in-browser": [],
	"open-manage-url": ["deviceLimit.openBrowser", "devices.manage"],
	"copy-link": ["signin.handoff.copyLink", "a11y.copyAddress"],
	"retry": ["common.tryAgain", "common.reconnect", "signin.again", "signInHandoff.newCode"],
	"cancel": ["common.cancel"],
}

## The opt-in services (tools/services.json) and what each requires (ST-38's closure rule).
const SERVICES := [
	{"slug": "license", "requires": []},
	{"slug": "config", "requires": []},
	{"slug": "release", "requires": []},
	{"slug": "distribution", "requires": ["release"]},
	{"slug": "update", "requires": ["distribution"]},
	{"slug": "identity", "requires": []},
	{"slug": "sync", "requires": ["config", "identity"]},
]

const OS_NAMES := ["macos", "ios", "android", "windows", "linux", "web", "tvos", "visionos", "watchos"]
const FORM_FACTORS := ["iphone", "ipad", "mac", "phone", "tablet", "computer", "tv", "other"]
const PRESENTATIONS := ["inline", "sheet", "browser"]
const REPLACE_MODES := ["inline", "browser"]
const CHANNELS := ["browser", "device-code"]
## `session.wait()`'s outcomes (plans/I-04.md §G.9).
const OUTCOMES := ["pending", "choose", "signedIn", "cancelled", "expired"]
## The kit events the sign-in form reacts to.
const EVENTS := ["use-code", "copy-link", "have-key", "open-replace", "confirm-replace", "reopen"]
const DEVICE_CODE_PHASES := ["starting", "waiting", "slow-down", "ok", "denied", "expired", "cancelled"]
const REGISTRATION := ["open", "requires-identity", "requires-license"]
const PENDING := ["sign-in", "activate", "replace", "save", "purchase", "restore"]
const TOASTS := ["update", "copied", "warning", "error", "progress"]
const PROGRESS_PHASES := ["queued", "download", "verify", "paused", "install", "failed", "done"]
## Where a theme's accent came from (UI-KITS.md §1.2, §3.4).
const ACCENT_SOURCES := ["integrator", "product", "icon", "core", "ink", "host"]
const COLOR_SCHEMES := ["system", "dark", "light"]
const PRESETS := ["polaris-key", "native"]
const KITS := ["elements", "react", "swiftui", "compose", "godot", "qt", "terminal"]


## The slugs of every service.
static func service_slugs() -> Array:
	var out := []
	for s in SERVICES:
		out.append(s["slug"])
	return out
