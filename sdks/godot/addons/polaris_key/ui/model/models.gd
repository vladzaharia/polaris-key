extends RefCounted
## The kit's headless layer (UI-KITS.md §1.3 layer (c)): one view model per §4.1 component behind
## one entry point, the port of ui-core's `models/index.ts`. Every model is a pure function of the
## input Dictionary (ui-matrix.json `vocabulary.inputs`); the stateful sign-in form
## (`sign_in_session.gd`) feeds the SignIn, SignInHandoff and LicenseChoice models.
##
##   const Models := preload("res://addons/polaris_key/ui/model/models.gd")
##   var view := Models.view_of("PolarisKeyGate", {"gate": {"status": "revoked"}})
##   view["state"]   # "blocked"
##
## The drop-in screens and a game's own UI read the same views, so both show the same states,
## copy keys and actions (`suite_ui_core` runs every ui-matrix.json row through them).

const Context := preload("res://addons/polaris_key/ui/model/context.gd")

const _DIR := "res://addons/polaris_key/ui/model/"

## Component → [model script, its static view function].
const MODELS := {
	"PolarisKeyGate": ["gate.gd", "gate_view"],
	"Boot": ["gate.gd", "boot_view"],
	"StatusScreen": ["gate.gd", "status_screen_view"],
	"GraceBanner": ["gate.gd", "grace_banner_view"],
	"Toast": ["gate.gd", "toast_view"],
	"Welcome": ["activate.gd", "welcome_view"],
	"Activate": ["activate.gd", "activate_view"],
	"OfflineActivation": ["activate.gd", "offline_activation_view"],
	"DeviceLimit": ["devices.gd", "device_limit_view"],
	"Devices": ["devices.gd", "devices_view"],
	"SignIn": ["sign_in.gd", "sign_in_view"],
	"SignInHandoff": ["sign_in.gd", "sign_in_handoff_view"],
	"LicenseChoice": ["sign_in.gd", "license_choice_view"],
	"UpdatePrompt": ["update.gd", "update_prompt_view"],
	"UpdateProgress": ["update.gd", "update_progress_view"],
	"ReleaseNotes": ["update.gd", "release_notes_view"],
	"AccountAndLicense": ["settings.gd", "account_view"],
	"Settings": ["settings.gd", "settings_view"],
	"Paywall": ["settings.gd", "paywall_view"],
	"EntitlementGate": ["settings.gd", "entitlement_gate_view"],
	"CloudSyncStatus": ["settings.gd", "cloud_sync_status_view"],
	"About": ["settings.gd", "about_view"],
	"ChannelPicker": ["settings.gd", "channel_picker_view"],
}


## The view of `component` for `input`, or {} for a component this layer does not know.
static func view_of(component: String, input: Dictionary) -> Dictionary:
	return view_in(component, Context.new(input))


## The view of `component` for an already-built context.
static func view_in(component: String, ctx: RefCounted) -> Dictionary:
	var entry = MODELS.get(component)
	if entry == null:
		return {}
	var script: GDScript = load(_DIR + entry[0])
	if script == null:
		return {}
	return script.call(entry[1], ctx)
