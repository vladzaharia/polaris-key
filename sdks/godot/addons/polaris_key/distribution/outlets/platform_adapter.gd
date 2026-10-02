class_name PKeyPlatformAdapter
extends PKeyOutletAdapter
## The platform outlets (`binaryUpdates: none`): Steam, itch, Flathub, Snap, App Installer, winget
## and the web. The platform installs a new build without the app, so a `platform` answer stays
## silent and shows the outlet's own message (`body_key`); only the web offers an action, a
## reload (README §6.3: "always current", PWA "new version, reload"). Steam and itch builds run
## no updater of their own, whatever the game asks (README §4.7).

## The PKeyUiCopy key of this outlet's message for a `platform` answer.
var body_key := "update_platform_body"


func describe(decision: Dictionary, ctx: Dictionary) -> Dictionary:
	if decision.get("action") == "platform":
		return plan(PKeyApplyResult.SILENT, "", "", body_key)
	return super(decision, ctx)
